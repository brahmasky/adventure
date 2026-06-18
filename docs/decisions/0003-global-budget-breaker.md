# ADR 0003: Global budget circuit-breaker (autonomy floor)

- **Status:** accepted
- **Date:** 2026-06-18
- **Deciders:** Paco

## Context

The per-run budget (`BudgetLedger`) bounds a single run; Telegram rate limits bound
intake spikes per user/chat. Neither bounds **Houge as a whole over time**. The next
milestone (M3) makes Houge an always-on, scheduled daemon — runs get admitted with
no human watching each action. A malfunction (a looping schedule, a re-enqueue bug, a
prompt-injected run, a runaway retry) could then burn unbounded compute/cost or
hammer risky actions for hours before anyone noticed. We need a hard ceiling on the
blast radius of a malfunction per day, as a precondition for autonomy.

## Decision

Add a durable, cross-run **circuit-breaker** over a rolling 24h window — a breaker,
not a throttle. Once any cap is reached, **new run admissions are refused at the
Gateway** with a `global_budget_fuse` ledger event and **exactly one** deduped
Telegram alert per fuse episode; admissions **re-arm automatically** as the window
clears. Status / approve / deny are never blocked.

Three independent caps, each guarding a different axis of "runaway" (env var → code
default; defaults in `src/budget/global-budget-ledger.ts`):

| Cap | Default | Axis | Protects against |
|-----|---------|------|------------------|
| `HOUGE_GLOBAL_MAX_RUNS_24H` | 200 | volume | looping schedules, re-enqueue bugs, command floods |
| `HOUGE_GLOBAL_MAX_TOOL_CALLS_24H` | 1000 | cost | aggregate LLM/tool spend across all runs |
| `HOUGE_GLOBAL_MAX_GATED_ATTEMPTS_24H` | 100 | risk | repeated approval-requiring attempts + prompt spam |

**Counting:** run admissions are recorded in a dedicated `global_budget_events`
table; tool-calls and gated attempts are *derived* from the authoritative ledger
(`tool_finished` / `approval_requested`) — no duplicate bookkeeping and no
core-worker changes. **Exactly-one alert** is enforced by a single-row fuse latch
(arm on the first breach of an episode, disarm when admissions drop back under cap).
`/status` surfaces per-cap headroom, run counts by state, and the last error.

## Consequences

- **Easier / safer:** the M3 daemon can run unattended with a known worst-case daily
  blast radius; the operator gets a visible signal (the alert + `/status`) and an
  automatic recovery (re-arm) with no manual reset.
- **Accepted cost:** a legitimate burst above a cap is paused, not queued — the user
  must wait for the window to clear (intentional: fail safe, not fail open).
- **Defense-in-depth:** sits alongside per-run budget (one task), rate limits
  (intake), and approval gates (consent per risky action). The first three contain
  blast radius; approvals are consent.

## Alternatives considered

- **A single "max runs" cap:** rejected — wouldn't catch one run that quietly burns
  thousands of LLM calls, nor an agent hammering risky actions; the three axes are
  independent.
- **Throttle (delay) instead of breaker (refuse):** rejected for V1 — a breaker that
  fails safe and alerts is the right primitive for an unattended system; smarter
  shaping can come later.
- **Record tool-calls/gated-attempts in a new table:** rejected — deriving from the
  existing ledger is authoritative and keeps the change off the core-worker.

## Verification note

225 unit tests passed but missed a real seam bug (the Telegram poll runner threw on a
`GLOBAL_BUDGET_FUSE` refusal, stalling the batch). A **live end-to-end run** caught
it. This established a project convention: every goal ends with a live test, not just
`npm test`. See `tasks/todo.md` and the [contributing guide](../../CONTRIBUTING.md).
