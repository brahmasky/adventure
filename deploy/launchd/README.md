# Running the Houge daemon under launchd (macOS)

The always-on daemon (`houge telegram-poll`, no `--once`) is a long-running
process that holds a long-poll connection to Telegram. **launchd** (macOS's
service manager) starts it at login and restarts it on crash — the "always-on"
guarantee. This is the production setup for the always-on Mac mini; the same
steps work on any macOS machine (e.g. this laptop, for verification).

> Linux host instead? Use a systemd user service running the same
> `npm run houge -- telegram-poll` command with `Restart=always`. The daemon
> code is identical; only the supervisor differs.

## Prerequisites

- `.env` filled in at the project root (Telegram token + user/chat ids — see
  [docs/reference/configuration.md](../../docs/reference/configuration.md)).
- Node + npm installed. Find the bin dir: `dirname "$(which node)"`
  (e.g. `/opt/homebrew/bin` on Apple Silicon, `/usr/local/bin` on Intel).
- **omp 18.4.4** (`@oh-my-pi/pi-coding-agent`) installed, and logged in four times under
  the `houge` profile, never the default one:
  `omp --profile houge login anthropic`, `… google-antigravity`, `… kimi-code`,
  `… openai-codex`. launchd runs the daemon on the restricted PATH below, which usually
  does not include omp's bin dir (`~/.bun/bin`, for a bun install), so give the daemon
  omp's absolute path in `.env` ([LLM runtime — omp](../../docs/reference/configuration.md#llm-runtime--omp-adr-0028)).
  An absolute path is not enough on its own: omp's launcher is a `#!/usr/bin/env bun` script, so the
  plist's `PATH` must also contain the directory holding `bun` (`~/.bun/bin`). Without it every spawn
  fails `omp not runnable` (seen on the 2026-10-01 cutover). `setup-new-host.sh` puts the dirs of node,
  bun, omp, codex and agy on the plist's `PATH` (add more with `EXTRA_PATH=/a:/b`), and checks omp against
  the pin; `bash deploy/launchd/setup-new-host.sh --check-only` runs only the checks and renders the plist
  to a temp file.
  Every spawn checks the version pin; a different omp is refused with an incident.
- `agy` (voice notes) and `codex` (self-diagnose, self-write), also by absolute path in `.env`.

## Install

```bash
cd /path/to/adventure                      # the project root
npm install && npm run build               # the daemon runs built JS (dist/cli.js + dist/omp/, below)
PROJECT_DIR="$PWD"
NODE_BIN_DIR="$(dirname "$(which node)")"
mkdir -p logs                              # launchd writes daemon logs here

# Render the template into a real plist.
sed -e "s#__PROJECT_DIR__#${PROJECT_DIR}#g" \
    -e "s#__NODE_BIN_DIR__#${NODE_BIN_DIR}#g" \
    deploy/launchd/com.houge.daemon.plist.template \
    > ~/Library/LaunchAgents/com.houge.daemon.plist

# Load it (starts immediately because RunAtLoad is true).
launchctl load ~/Library/LaunchAgents/com.houge.daemon.plist
```

Verify it's running and watch the log:

```bash
launchctl list | grep com.houge.daemon     # shows PID + last exit code
tail -f logs/houge-daemon.err.log          # daemon logs to stderr
```

Send the bot a message — the first turn starts the chat's omp planner and is answered
with no manual poll. `npm run houge -- status` shows the daemon heartbeat (last poll,
last error). If the first turn replies that the planner is unavailable, check
`incidents` for `omp_version_mismatch`, `planner_start_failed` or `sandbox_unavailable`.

Before kickstarting onto a new build that touches the runtime, run the real-omp smoke from
the project root; it never touches the running daemon:

```bash
HOUGE_ENV_FILE="$PWD/.env" node scripts/live-gate-omp.mjs --smoke
```

### What the build and the daemon put on disk

```
dist/cli.js                     CLI and daemon entry
dist/omp/extension/houge.js     the one extension the planner loads (policy hook + tool stubs; tsc output)
dist/omp/shell-wrapper.sh       the bash wrapper, copied by scripts/copy-omp-assets.mjs (hash-checked before use)
dist/omp/tools/*.json           the tool declarations, copied by scripts/copy-omp-assets.mjs (validated at boot)

<project>/omp/                  per-chat sessions/ and workspace/, bridge/ sockets, rendered planner.sb and
                                shell.sb, the omp profile config, per-chat system prompts
<project>/selfwrite/            self-write worktrees
~/Library/Caches/houge-daemon/  the daemon's temp root (media, codex out-files, agy workdirs), 0700
```

`<project>` here is the directory holding `houge.sqlite` (the working directory under
launchd). All of it is gitignored runtime state. The temp root must sit outside any git
repo: if an ancestor holds `.git`, boot raises `daemon_tmp_in_git_repo` and voice ingest
stays off. Override it only with an absolute path (see the configuration reference).

## Kill switch + revival (ADR 0018)

`/kill` (Telegram, allowlisted operator only) aborts every chat's omp planner, writes a
tombstone file — `houge.kill` at the project root — and stops the daemon. **KeepAlive will relaunch the process, but it PARKS
idle** (no polling, no runs) while the tombstone exists: launchd sees a healthy process,
the agent stays stopped across crashes, restarts, and reboots. `houge status` and other
read-only commands keep working while parked.

Revival is **manual by design** (nothing automatic can undo a kill):

```bash
cd /path/to/adventure                                # the project root
cat houge.kill                                       # who killed it, when, why
rm houge.kill
launchctl kickstart -k gui/$(id -u)/com.houge.daemon # restart the parked process (bash, zsh, fish)
```

`$(id -u)` rather than `$UID`: fish does not define `$UID`, and a bare `gui//com.houge.daemon`
just prints launchctl's usage. The parked process also leaves `houge.parked` beside the
tombstone; the invariant sweep reads it once after revival so the heartbeat gap is logged as a
deliberate park rather than opened as an incident, then the daemon removes it on its first good
cycle. Leave it alone — it is not a stop switch.

Related: `/disarm` writes `houge.disarm` (evolution + scheduler flags forced off, survives
restarts); `/rearm` deletes it — flags re-apply on the next restart (same `kickstart` as
above). See [ADR 0018](../../docs/decisions/0018-kill-switch.md).

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.houge.daemon.plist   # SIGTERM → graceful stop
rm ~/Library/LaunchAgents/com.houge.daemon.plist
```

## Notes

- **Run built JS, not `tsx`:** the wrapper `exec`s `node dist/cli.js` so the daemon
  *is* the supervised process and launchd's SIGTERM reaches it. Running via
  `npm run`/`tsx` inserts wrapper processes that swallow the signal, so the daemon is
  hard-killed (exit 143) instead of shutting down gracefully. Rebuild (`npm run build`)
  after pulling changes.
- **Auto-restart on crash:** `KeepAlive=true`. **Start at login:** `RunAtLoad=true`.
- **Graceful shutdown:** `unload` (or `kickstart -k`) sends SIGTERM. Chat turns run
  detached on the omp planners, so they do **not** finish: an in-flight turn and any
  queued turns fail `planner_exit` and the chat gets a reply saying so; each planner's
  process group is stopped. A non-turn run and a running self-write pipeline are finished,
  the notification outbox is flushed, and the daemon exits 0 (`ExitTimeOut=40s` headroom).
  The chat's transcript resumes on the next message. Check for an in-flight turn before
  restarting.
- **Single instance:** the daemon also takes a lockfile (`houge.daemon.lock`), so a
  stray second copy exits immediately instead of fighting launchd's instance over
  the Telegram long-poll (which would cause HTTP 409).
- **Restarts are safe for intake:** the durable Telegram offset means a restart resumes
  exactly where it left off — no message lost or double-processed. A turn the restart
  ended is not retried; resend it.
