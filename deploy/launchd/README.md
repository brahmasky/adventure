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

## Install

```bash
cd /path/to/adventure                      # the project root
npm install && npm run build               # the daemon runs built JS (dist/cli.js)
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

Send `/ask` to the bot — it should be answered within seconds, with no manual
poll. `npm run houge -- status` shows the daemon heartbeat (last poll, last error).

## Kill switch + revival (ADR 0018)

`/kill` (Telegram, allowlisted operator only) writes a tombstone file — `houge.kill` at the
project root — and stops the daemon. **KeepAlive will relaunch the process, but it PARKS
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
- **Graceful shutdown:** `unload` sends SIGTERM; the daemon finishes the in-flight
  run, flushes the notification outbox, and exits 0 (`ExitTimeOut=40s` headroom).
- **Single instance:** the daemon also takes a lockfile (`houge.daemon.lock`), so a
  stray second copy exits immediately instead of fighting launchd's instance over
  the Telegram long-poll (which would cause HTTP 409).
- **Restarts are safe:** the durable Telegram offset means a restart resumes exactly
  where it left off — no message lost or double-processed.
