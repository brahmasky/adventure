# Goal 1 — Autonomy Guardrails

**Active /goal (Stop-hook gate):** durable SQLite GlobalBudgetLedger enforcing rolling-24h
caps; refuses over-cap runs with a `global_budget_fuse` event + exactly one deduped Telegram
alert; `/status` shows today's run counts by state, last error, per-cap headroom; tests for
(N+1)th-run refusal, 24h aging-out, /status view; `npm test` green + typecheck clean + zero new deps.

## Design (minimal-impact)

- **Run admissions** need a dedicated durable counter (no existing source) → new table
  `global_budget_events(kind='run')`.
- **tool_calls** and **gated_attempts** are *derived* from existing ledger events
  (`tool_finished`, `approval_requested`) in the 24h window → NO core-worker edits.
- Gate lives in `Gateway.handleTaskIntake` (the run-admission choke point; status/approve/deny
  already bypass it). Caps resolved from env, injectable for tests.
- Exactly-one alert via a single-row latch `global_budget_fuse_state(fused, since)`: first breach
  arms + alerts; later breaches don't; a successful admission disarms (re-arms next episode).

## Checklist

- [ ] `src/budget/global-budget-ledger.ts` — caps type, defaults, `resolveGlobalBudgetCaps(env)`,
      `GLOBAL_BUDGET_WINDOW_HOURS`, breach/usage types, `formatFuseAlert`.
- [ ] `src/run/run-ledger.ts` — add `global_budget_fuse` event type + required payload fields.
- [ ] `src/run/run-store.ts` — migration (events table + index + fuse latch); methods:
      `checkGlobalBudget`, `globalBudgetUsage`, `recordGlobalBudgetRun`, `recordGlobalBudgetFuse`,
      `armGlobalFuseIfNeeded`, `disarmGlobalFuse`, `runCountsByStateSince`, `lastRunError`.
- [ ] `src/status/status-query.ts` — enrich no-run_id result with `overview`
      (runs_by_state, last_error, budget headroom); resolve caps from env by default.
- [ ] `src/gateway/gateway.ts` — caps in ctor; global-budget gate in `handleTaskIntake`.
- [ ] `.env.example` + `README.md` — document caps, defaults, fuse + alert-dedup behavior.
- [ ] Tests: gateway (N+1 refusal + exactly-one alert + status/approve bypass), store (24h aging-out),
      status overview; update the 2 strict `toEqual` status tests.
- [ ] `npm run typecheck` clean, `npm test` green, `npm run build` ok, zero new deps.

## Review

Done. All checklist items complete.

- **GlobalBudgetLedger** (`src/budget/global-budget-ledger.ts`): caps, env resolver,
  breach/headroom math, fuse-alert formatter. Pure + unit-tested.
- **Durable store** (`src/run/run-store.ts`): `global_budget_events` table + index +
  single-row `global_budget_fuse_state` latch via a new idempotent migration
  (`2026-06-18-autonomy-guardrails`). Methods for check / usage / record-run /
  record-fuse / arm / disarm / run-counts-by-state / last-error. tool_calls and
  gated_attempts are derived from existing ledger events (no core-worker edits).
- **Gateway** (`src/gateway/gateway.ts`): breaker gate in `handleTaskIntake`; refuses
  over-cap admissions with a `global_budget_fuse` event + one deduped alert; records
  admissions and re-arms on success. Control commands bypass.
- **/status** (`src/status/status-query.ts` + Telegram text): rolling-window overview —
  run counts by state, last error, per-cap headroom.
- **Tests:** +9 (gateway N+1 refusal, exactly-one-alert dedup, re-arm, 24h aging-out,
  control-command bypass, /status overview, caps resolver). Updated 3 existing tests
  (2 strict status `toEqual`, 1 migration-count). **225 pass** (was 216), typecheck +
  build clean, zero new runtime deps.

**Scope note:** the distilled `/goal` gate did not require recording per-run budget
usage into the global ledger as a separate path; deriving tool_calls/gated_attempts
from the ledger is simpler, authoritative, and keeps the change off the core-worker.

**Live-test bug (caught by end-to-end verification, missed by 225 unit tests):** the
Telegram poll runner only treated a fixed set of intake-error codes as handled; a
`GLOBAL_BUDGET_FUSE` refusal would `throw` and stall the whole poll batch (offset never
advances → reprocess loop; fuse alert never dispatched). Fixed in
`telegram-poll-runner.ts` (treat the breaker refusal as a deterministic denial) +
regression test. This seam between Gateway and poll runner is only exercised live —
hence live verification is now part of the stop gate (see memory `live-test-stop-gate`).
