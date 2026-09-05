# ADR 0019: Metered-API $ ceiling — ledger-derived spend, latch-driven enforcement

- **Status:** accepted
- **Date:** 2026-07-15
- **Deciders:** Paco
- **Relates to:** extends the breaker pattern of [ADR 0003](0003-global-budget-breaker.md)
  (which bounds VOLUME, not dollars); consumes the `llm_call` telemetry that Phase 3.1 put
  in the ledger; sibling of the kill switch [ADR 0018](0018-kill-switch.md); charter:
  **flat-rate first** (pi/kimi/agy subscriptions), metered APIs as capped fallback

## Context

Houge's LLM chain mixes flat-rate legs (pi, agy-cli — subscription CLIs, marginal cost 0)
with metered legs (kimi-api, gemini-api — pay-per-token HTTP). The global budget breaker
caps runs/tool-calls/gated-attempts, which bounds *volume* — but 1,000 tool calls can cost
cents or tens of dollars depending on which legs served them and how big the prompts were.
With the scheduler firing unattended overnight, an unbounded metered bill is the one
runaway the count caps can't see. The `llm_call` ledger event has carried an optional
`cost_usd` field since Phase 3.1 — never populated, because no pricing existed anywhere.

**Amendment 2026-09-06 (CLI-only migration).** Two findings from tracing an unexplained Google
bill bear directly on this ADR. First, the ceiling was **blind**, not merely unbreached:
`extractUsage` read `completion_tokens` only, while Google's OpenAI-compat endpoint bills the gap
up to `total_tokens` as output — measured undercounts of 5–11× on output and ~3.6× on cost. A
`metered_fuse_state.fused = 0` was therefore not evidence of restraint; the fuse cannot trip on
spend it cannot see. Fixed: output now derives from `completion_tokens_details.reasoning_tokens`
when present, else from `total_tokens - prompt_tokens` when that exceeds `completion_tokens`.
Historical pre-cutover `llm_call` rows for `gemini-api` remain undercounted and are NOT backfilled.
Second, the metered legs left every default chain, so the ceiling now guards an escape hatch rather
than the normal path — which is exactly why both the price table and the fuse stay.

## Decision

### 1. Price at the recording seam; spend is DERIVED from the ledger

A price table (`src/llm/metered-pricing.ts`) keyed by **model-id prefix** (longest match
wins) maps `{input, output, cached_input}` USD-per-Mtok rates for the metered providers
only (`METERED_PROVIDERS = {kimi-api, gemini-api}`). `computeCostUsd` runs inside the
CoreWorker's `recordLlmCallSafe` — the one seam where provider + model + usage meet for
every role (writer/reviewer/cheap-chain) — and fills the existing optional `cost_usd`
payload field. Spend is then `SUM(cost_usd)` over `llm_call` events in-window
(`RunStore.meteredSpendUsd`): **no second bookkeeping**, no drift between telemetry and
enforcement, and the counts-and-metadata-only invariant is untouched.

Seed prices cover the current defaults (`moonshot-v1-auto`, `gemini-3.5-flash`, plus
`kimi-`/`gemini-` family prefixes) at public list prices as of 2026-07 — **sensible, not
sacred**: the mechanism matters more than the numbers, and `HOUGE_METERED_PRICES_JSON`
merges operator overrides over the defaults (tolerant parse — a broken override never
takes pricing down).

### 2. Two ceilings, two windows

- `HOUGE_METERED_DAILY_USD` (default **$5**) over a **rolling 24h** window — the same
  precedent as the count caps; catches a fast runaway.
- `HOUGE_METERED_MONTHLY_USD` (default **$50**) over the **calendar month (UTC)**
  (`strftime('%Y-%m')`) — how the provider's invoice actually resets; catches a slow leak.

The windows deliberately disagree at a month flip: spend at July 31 23:59Z still counts
daily at Aug 1 00:01Z but monthly resets to $0 (encoded as a test).

### 3. Enforcement: drop the metered legs, never silence the chain

`buildLlmChain` (the single chokepoint through which every role's chain is built) takes an
optional `meteredBreached?: () => boolean` dep. When it returns true, metered names are
filtered out of the provider list BEFORE construction — flat-rate legs keep working. If the
filter would empty the chain (an all-metered `HOUGE_LLM_PROVIDERS`), it falls back to
`METERED_FALLBACK_PROVIDERS = ["pi"]`: a zero-leg chain silences Houge entirely, a worse
failure than one more flat-rate call. This is a degradation, not a refusal — the charter's
"flat-rate first" means the ceiling only removes what costs money.

### 4. Latch-driven checking: sum once per tick, read cheap per call

Summing the ledger on every LLM call would be chatty. Instead `checkMeteredCeiling` runs
once per daemon poll cycle (the signal-path tick): it computes spend, drives a single-row
latch `metered_fuse_state` (the exact twin of `global_budget_fuse_state`), and on the
**0→1 transition** enqueues exactly ONE Telegram alert (window + spend + ceiling + "metered
legs dropped, flat-rate continue"). The `meteredBreached` dep the chain builder consults is
just a latch-row read — and it is defensive (any error reads as "not breached"): the
ceiling is a cost net, not a security gate, and a broken latch must never take the answer
path down. When spend falls back under both ceilings (the window rolls), the latch disarms,
so a future breach is a new episode and alerts again. `/status` gains one line:
`Metered: $d.dd/$D.DD 24h, $m.mm/$M.MM month`.

## Consequences

- A runaway metered bill is now bounded at ~$5/day and ~$50/month by default, with the
  agent degrading to flat-rate legs instead of going silent, and the operator told once.
- **Residual — unknown-model spend is invisible:** a metered call whose model matches no
  price prefix logs once and records no `cost_usd`; its spend does not count toward the
  ceiling until the operator prices it via `HOUGE_METERED_PRICES_JSON`. The prefix entries
  (`kimi-`, `gemini-`) make this unlikely for the current providers.
- **Residual — run-less LLM reads are unmetered:** the daemon's episodic distill/consolidate
  reads ride an adapter without a usage hook (pre-existing: they record no `llm_call` at
  all), so their spend is invisible too. They run on the same chain, so enforcement still
  drops their metered legs when the fuse is latched; only the *measurement* misses them.
- Enforcement lags a breach by at most one poll cycle (the latch is tick-driven) — and by
  design a one-shot `run`/`--once` invocation consults whatever latch state the last daemon
  tick left. Both windows are small against a $5 ceiling.
- Prices drift; the defaults are operator-tunable and the ADR's numbers are not a contract.
