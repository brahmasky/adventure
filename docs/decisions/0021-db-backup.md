# ADR 0021: DB backup — periodic snapshots via VACUUM INTO (journal-mode-agnostic)

- **Status:** accepted
- **Date:** 2026-07-17
- **Deciders:** Paco
- **Relates to:** ROADMAP backlog #3; `houge.sqlite` is the single source of truth
  (conversations, lessons, episodic facts, wiki pages, ledger, approvals) and had NO
  backup; fail-open posture mirrors the decay ticks (ADR 0012 §3);
  restore depends on the launchd deploy ([deploy/launchd/README.md](../../deploy/launchd/README.md))

## Context

Everything Houge is — his memory, his audit ledger, his learned lessons — lives in one
SQLite file the always-on daemon holds open (journal_mode=delete today; nothing here
assumes it — the mechanism is equally safe under WAL if that ever changes). A corruption
or an accidental `rm` loses all of it. Copying the file while the daemon writes is not
safe: a `cp` can capture the file mid-transaction (and under WAL, the main file and its
`-wal` sibling at different instants).

## Decision

### 1. `VACUUM INTO` is the snapshot mechanism

SQLite's transactional `VACUUM INTO ?` writes a consistent point-in-time copy of the
live database from inside the same connection — WAL-safe by construction, checkpointed
and defragmented, zero dependencies (verified working on this Node's `node:sqlite`).

Rejected alternatives:
- **litestream** (continuous WAL replication): an external binary, a service to babysit,
  ops complexity disproportionate to one ~MB database — deferred, not refused.
- **Time Machine / OS backup**: not guaranteed present, not WAL-aware mid-write, and
  invisible to the ledger — a backup we can't verify happened is not a safety net.

### 2. tmp + rename atomicity, integrity-gated

`VACUUM INTO` refuses an existing path, so the tick writes
`backups/houge-<YYYYMMDDTHHmmss>Z.sqlite.tmp`, opens that snapshot **readonly** and
requires `PRAGMA quick_check` = "ok" (a corrupt snapshot is deleted and the tick fails),
then `fs.rename`s to the final name. A final-named file is therefore never half-written
and never unverified. Snapshot names sort lexicographically = chronologically, so
retention (keep newest `HOUGE_BACKUP_KEEP`, default 7) is a filename sort.

### 3. Interval latch, advanced only on success

A single-row `backup_state` latch (the `lesson_decay_state` pattern, migration
`2026-07-17-backup-state`) gates the tick to once per `HOUGE_BACKUP_INTERVAL_HOURS`
(default 24). The latch advances **only after** a verified snapshot lands — any failure
leaves it put, so the next daemon cycle retries instead of silently waiting a day.

### 4. Fail-open, flag-gated, audited

The tick rides the daemon's signal path beside the decay ticks, gated on
`HOUGE_BACKUP_ENABLED` (default OFF). It never throws: success emits one
`db_backup_completed` ledger event (`path`, `bytes`, `kept_count`, `duration_ms`);
failure emits `db_backup_failed` (`reason`) + a stderr line. A broken backup must never
break the daemon — the backup protects the data, it is not allowed to endanger the agent.

### 5. LOCAL-ONLY — stated honestly

`backups/` lives on the same disk as `houge.sqlite` (gitignored). This protects against
**corruption and accidental deletion**, NOT disk death or machine loss. Offsite/second-disk
replication is a future step; this ADR deliberately ships the smaller, dependency-free net
first.

## Restore runbook

```bash
cd /path/to/adventure
launchctl bootout gui/$UID/com.houge.daemon        # stop the daemon
ls backups/                                        # pick the snapshot to restore
cp backups/houge-<stamp>Z.sqlite houge.sqlite      # copy it over the live db
rm -f houge.sqlite-wal houge.sqlite-shm            # stale WAL siblings must not replay
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.houge.daemon.plist  # restart (bootout removed the service; kickstart would fail 503)
# then /status in Telegram to verify
```

## Consequences

- Worst-case data loss from corruption/accidental delete drops from "everything" to one
  backup interval (default ≤24h), bounded by 7 retained generations.
- A crash mid-`VACUUM` can leave a stale `.tmp` file behind (timestamps make collisions
  impossible; retention ignores `.tmp`) — inert, cleanable by hand.
- `VACUUM INTO` briefly reads the whole database on the daemon thread once per interval —
  negligible at current size; revisit if the file grows to GB scale.
- Disk-death protection is explicitly NOT provided — see §5.
