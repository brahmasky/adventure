# ADR 0004: Always-on long-poll daemon

- **Status:** accepted
- **Date:** 2026-06-18
- **Deciders:** Paco

## Context

Through Milestone 2, Houge answered Telegram only when `telegram-poll --once` was
run by hand — a one-shot that exits after draining pending updates. To be a useful
assistant it must be **always-on**: listening continuously so `/ask` is answered in
near-real-time with no manual step. Milestone 3 is that always-on service.

Two questions had to be settled: (1) how to receive messages continuously, and
(2) what keeps the process alive. A reference point was the operator's existing
assistant (WuKong), which long-polls Telegram via a long-running Node process — but
it has **no supervisor in its repo** (started manually in a terminal, no
auto-restart) and **drops pending updates on restart**.

## Decision

**A long-running daemon that holds a Telegram long-poll connection, supervised by
the OS.**

- **Receive:** `houge telegram-poll` (no `--once`) runs a continuous loop calling
  `getUpdates` with a long-poll timeout (default 30s). The connection is held open;
  Telegram pushes a message the instant it arrives (near-real-time), and the idle
  timeout only bounds how long an empty connection waits. Latency is *not* the
  timeout. Webhooks are explicitly **out of scope** — long-polling is outbound-only,
  so it needs no public IP, open ports, or tunnel, and runs behind home NAT.
- **Supervise:** macOS **launchd** LaunchAgent (`RunAtLoad` + `KeepAlive`) — start at
  login, restart on crash. Production target is the always-on Mac mini; the identical
  plist runs on any macOS host. Linux hosts use a systemd unit running the same
  command. The daemon code is host-agnostic.
- **Graceful shutdown:** SIGTERM/SIGINT abort a shared stop signal that (a) cancels an
  idle long-poll immediately and (b) lets a run already executing finish, after which
  the outbox is flushed and the process exits 0.
- **Single instance:** a PID lockfile (O_EXCL, stale-lock reclaim) so a stray second
  daemon exits instead of fighting over the long-poll — two pollers on one token make
  Telegram return HTTP 409.
- **Resilience:** exponential backoff on Telegram errors; a persisted heartbeat
  (last-successful-poll, last error) surfaced in `/status` so an unattended operator
  can confirm liveness.

## Consequences

- **Easier:** real-time bot with no manual poll; the in-process scheduler (Goal 3)
  becomes a tick inside this same loop.
- **More robust than the reference design:** Houge **resumes** on restart via the
  durable Telegram offset (no message lost or double-processed), where WuKong drops
  pending; and launchd gives real crash/reboot recovery WuKong lacks.
- **Accepted cost:** a long-lived process needs supervision, graceful-shutdown, and a
  single-instance guard — more machinery than a one-shot. Mitigated by Goal 1's global
  breaker, which bounds what an unattended loop can do.
- **Availability bound by the host:** on a laptop, closing the lid pauses the bot
  (messages queue ~24h and resume on wake). True 24/7 wants an always-on host (the
  Mac mini).

## Alternatives considered

- **Periodic one-shot** (launchd/cron runs `--once` every N seconds): simpler, no
  lifecycle, but not "always on" (no held connection) and latency = the interval.
  Rejected — it isn't a listener.
- **Webhooks:** lower overhead at scale, but needs a public HTTPS endpoint / tunnel
  and inbound exposure. Rejected for a single-operator local/home deployment.
- **pm2 / forever** (Node process managers) instead of launchd: extra dependency that
  itself needs launchd to start at boot. Rejected — launchd is native and zero-dep.
