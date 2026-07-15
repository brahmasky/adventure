# ADR 0018: Durable kill switch — park-alive tombstone + disarm posture

- **Status:** accepted
- **Date:** 2026-07-15
- **Deciders:** Paco
- **Relates to:** the safety floor for [ADR 0004](0004-long-poll-daemon.md)'s always-on daemon
  and [ADR 0017](0017-scheduler.md)'s unattended fires; complements the volume breaker
  [ADR 0003](0003-global-budget-breaker.md) and the $ ceiling [ADR 0019](0019-metered-ceiling.md);
  charter: full autonomy + **mechanical** safety nets (freedom over control — the brake is what
  makes boldness affordable)

## Context

Houge runs unattended: launchd starts him at login and `KeepAlive` restarts him on ANY exit.
That always-on guarantee is exactly wrong when the operator wants him STOPPED — `launchctl
unload` works, but it is transient (next login re-loads), machine-local, and easy to get wrong
under stress. There was no durable stop: nothing a single Telegram command could set that a
supervisor restart, a crash loop, or a reboot would respect. With the scheduler firing runs
overnight, "I can always ctrl-C it" stopped being true.

Forces:

- **launchd `KeepAlive` is unconditional `<true/>`** (plist template, `ThrottleInterval` 10s).
  A kill that simply exits the process is resurrected ten seconds later, forever — a
  tombstone-exit design turns the kill switch into a crash loop.
- The stop must be **unforgeable**: model output, forwarded messages, and prompt-injected
  content must not be able to trigger (or *un*-trigger) it.
- Between "running" and "killed" there is a useful middle posture: **keep talking, stop
  evolving/acting unattended** — worth one command, not four env edits and a restart.
- Self-writes land through an automated merge path; the stop must be outside that blast
  radius (a self-write must never be able to remove the operator's brake).

## Decision

### 1. `/kill` → tombstone file → PARK-ALIVE boot gate

`/kill` writes a **tombstone file** (`houge.kill` at the repo root, override
`HOUGE_TOMBSTONE_PATH`, gitignored) recording `{killed_at, by, reason?}`, enqueues an ack
(with the revival steps), and THEN signals the daemon's graceful shutdown — the ack rides the
existing shutdown flush. launchd relaunches the process; the boot gate in `src/cli.ts` sees
the tombstone and **parks alive**: one log line, no store/gateway/poll construction, an idle
promise that still honors SIGTERM/SIGINT (so `launchctl unload` stays clean). launchd sees a
healthy long-lived process; the agent is stopped. `run` and `telegram-poll --once` print the
same message and exit 1 (interactive invocations don't park); read-only commands
(`status`, `send-outbox`) stay usable — inspection must survive a kill.

**Alternative considered — `KeepAlive: {SuccessfulExit: false}` + exit 0:** launchd can be
told to not restart clean exits, letting a killed daemon simply exit. Rejected: it requires
migrating the installed plist on every deployment (a manual infra step the code can't verify
happened), changes crash-recovery semantics for every OTHER exit path, and still leaves
`RunAtLoad` re-starting the daemon at next login — the tombstone would be needed anyway.
Park-alive needs zero infra migration and is self-evidently durable.

**Fail-closed reads:** a tombstone that exists but is unreadable or unparseable still kills
(`readTombstone` returns present-with-unknown-fields). Corrupting the file must never revive
the agent.

**Revival is manual by design:** delete the file, then
`launchctl kickstart -k gui/$UID/com.houge.daemon`. There is deliberately no `/revive` —
a stop that the stopped system could be talked into undoing is not a stop.

### 2. Unforgeability chain

`/kill` (and `/disarm`/`/rearm`) are **explicit branches in the command parser** — this is
load-bearing: an *unknown* slash command falls through to a natural-language `turn` that the
model interprets, and a stop command re-interpreted by an LLM is forgeable. Upstream,
`authorizeTelegramUpdate` already rejects non-allowlisted senders, forwarded messages,
channel posts, and anonymous senders — a forward of someone else's `/kill` text never
becomes an event. `/kill` is additionally **exempt from the per-chat command rate limit**
(the emergency stop must not queue behind chatter); the allowlist auth is untouched.

### 3. `/disarm` + `/rearm` — the restart-surviving posture

`/disarm` writes a **posture file** (`houge.disarm`, override `HOUGE_DISARM_PATH`,
gitignored) and immediately sets `DISARM_FLAGS = [HOUGE_SELFWRITE_ENABLED,
HOUGE_CODEX_ENABLED, HOUGE_SKILLS_ENABLED, HOUGE_SCHEDULER_ENABLED]` to `"false"` in
`process.env` — the flags are read live at every call site, so the effect is instant.
Episodic memory is deliberately NOT in the set: remembering a conversation is neither
evolution nor unattended action, and losing memory would punish the operator for braking.

**The precedence trick:** `loadHougeEnv` is first-writer-wins (a set variable is never
overwritten by `.env`). `applyDisarmPosture` runs at the top of `loadHougeEnv`, BEFORE the
`.env` parse, forcing the flags to `"false"` — so `.env`'s `HOUGE_*_ENABLED=true` loses on
every restart while the posture file exists. It is written over a real-env value too: the
posture is the operator's STOP, and a stale shell export must not outrank it. (Corollary:
`HOUGE_DISARM_PATH` itself must be a real env var, not a `.env` entry — it is read before
`.env` exists.)

`/rearm` deletes the file and acks that flags re-apply **on the next restart** — live
re-enable would require remembering pre-disarm values; the ack says so instead of lying.

### 4. Self-write protection

`houge.kill`, `houge.disarm`, `src/run/tombstone.ts`, `src/config/disarm-posture.ts`, and
`src/config/load-env.ts` join `PROTECTED_FILES` in the self-write guard: a self-write that
deletes the tombstone revives a killed agent; one that edits `readTombstone` (or removes the
posture application from env loading) does the same one hop removed. All are Paco's-hand-only.

## Consequences

- One Telegram command from the allowlisted operator now durably stops the agent across
  crashes, restarts, and reboots; a second command steps down to talk-only mode without
  stopping conversation.
- A parked daemon holds no daemon lock and no Telegram connection — `status` and manual
  `--once` diagnostics work while parked.
- The parked process consumes one idle Node process; acceptable (it IS the always-on seat).
- Revival requires shell access to the host — deliberate. The tombstone file body is
  human-readable JSON so the operator sees who killed it, when, and why before reviving.
- `/rearm` is not instant (restart required) — documented in its ack text.
