# Goal 2 — Always-On Telegram Daemon (M3)

**Active /goal (Stop-hook gate):** `houge telegram-poll` (no --once) runs a continuous
long-poll loop answering /ask in near-real-time; graceful SIGTERM/SIGINT shutdown
(finish in-flight run, flush outbox, exit 0); single-instance guard (no 409);
exponential backoff on Telegram errors; heartbeat (last poll, last error) in /status;
macOS launchd plist + install/uninstall docs; new env vars in
docs/reference/configuration.md + .env.example; ADR for the design. `npm test` green +
typecheck clean + zero new deps + a LIVE run (answers /ask unattended, single-instance
guard, graceful shutdown).

## Design (extend, don't rebuild)

- Transport ALREADY supports long-poll: `getUpdates({offset, timeout_seconds})` → real
  client appends `&timeout=N`. `createTelegramLongPollingAdapter` + durable offset =
  resume (no drop_pending, unlike WuKong).
- Host: the always-on Mac mini via macOS launchd; identical plist verifiable on this
  Mac (same OS).

## Build steps (each independently green)

- [ ] 1. Abortable long-poll: add optional `signal?` to getUpdates (client + adapter +
      pollOnce) so shutdown can cancel an idle long-poll instantly.
- [ ] 2. Single-instance lock helper (`src/telegram/single-instance-lock.ts`): PID
      lockfile via O_EXCL, stale-lock reclaim, `release()`. Tests.
- [ ] 3. Heartbeat: run-store migration (`daemon_heartbeat` single row) +
      `recordPollHeartbeat` / `getPollHeartbeat`; surface as `poller` in /status
      overview (+ update the 2 strict status tests). Tests.
- [ ] 4. Daemon (`src/telegram/telegram-daemon.ts`): `runTelegramDaemon({..., stopSignal})`
      — construct gateway/worker/adapter/dispatcher once, loop pollOnce(long-poll)+dispatch,
      heartbeat each cycle, exponential backoff on error (interruptible sleep), break on
      stopSignal. Tests: multi-batch, graceful stop mid-run, backoff escalation, heartbeat.
- [ ] 5. CLI: `telegram-poll` (no --once) → acquire lock, wire SIGTERM/SIGINT → abort
      stopSignal, run daemon, release lock in finally. (--once unchanged.)
- [ ] 6. launchd plist (`deploy/launchd/`) + install/uninstall runbook (KeepAlive +
      RunAtLoad = auto-start + auto-restart).
- [ ] 7. Docs: env vars (HOUGE_TELEGRAM_LONGPOLL_TIMEOUT_S, HOUGE_DAEMON_BACKOFF_*,
      HOUGE_DAEMON_LOCK_PATH) → configuration.md + .env.example; ADR 0004 (long-poll
      daemon + single-instance + heartbeat).
- [ ] 8. `npm run typecheck` clean, `npm test` green, `npm run build` ok, zero new deps.
- [ ] 9. LIVE: start daemon in background; user sends /ask → answered unattended; second
      instance exits via guard; SIGTERM → graceful shutdown (logs show finish + flush);
      /status shows heartbeat.

## Review

(filled at completion)

---

# Goal 1 — Autonomy Guardrails (DONE, merged a539ffb)

Global budget circuit-breaker (runs/tool_calls/gated_attempts per 24h), refuse over-cap
admissions with `global_budget_fuse` + one deduped alert, /status headroom. Live-verified;
caught a poll-runner seam bug 225 unit tests missed. See ADR 0003.
