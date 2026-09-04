# CLI-only LLM legs + structural audit chokepoint

Date: 2026-09-04
Status: design approved, pending spec review
Author: Paco + Claude

## Problem

A Google bill of ~15–16 AUD/month traced to Gemini API usage does not tally with
Houge's own ledger, which records $1.06 of `gemini-api` spend across the whole
2026-06-26 → 2026-09-03 window. Investigation found four separate defects.

### D1 — the flat-rate Gemini leg is dead

`AGY_DEFAULT_MODEL` in `src/llm/providers/agy-cli.ts` pins `"Gemini 3.5 Flash (Low)"`.
That model no longer exists in the installed `agy` binary. A live probe returns:

```
"status":"ERROR","error":"invalid model selection (--model \"Gemini 3.5 Flash (Low)\")...
Available models: Gemini 3.8/3.7/3.6 Flash (High|Medium|Low), Gemini 3.1 Pro (High|Low),
Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking), GPT-OSS 120B (Medium)"
```

The provider maps a non-zero exit to `unavailable`, so the chain silently falls
through to the metered legs. The subscription-funded leg has been contributing
nothing, and no signal was emitted because failed legs are not recorded anywhere.

### D2 — the reader chain leads with a metered leg

`HOUGE_LLM_READER_PROVIDERS=gemini-api,agy-cli`. The Dual-LLM quarantined reader
(ADR 0014) fires on every external-read tool output and is the highest-volume LLM
consumer in the system (742 `web_search_performed` events). It has always gone to
the paid Gemini API first, with the dead CLI leg as its only fallback.

The *intent* was right: the reader must sit on a different model family from the
planner for injection resistance. The mistake was reaching for the metered Gemini
API rather than the Gemini CLI.

### D3 — thinking tokens are invisible

`extractUsage` (`src/llm/providers/openai-compat.ts:71`) reads only `prompt_tokens`
and `completion_tokens`. Google's OpenAI-compat endpoint bills the gap between those
and `total_tokens` as output. Measured live:

| probe | prompt | completion | total | hidden |
|---|---|---|---|---|
| trivial | 12 | 54 | 611 | 545 |
| reader-shaped, small | 94 | 132 | 849 | 623 |
| reader-shaped, 1.4k input | 1438 | 147 | 2418 | 833 |

Output is undercounted 5–11x; total cost ~3.6x. The metered-$ ceiling (ADR 0019)
sums these same figures, so `metered_fuse_state.fused = 0` is not evidence of
restraint — the fuse cannot trip on spend it cannot see.

### D4 — whole call paths emit no telemetry

Telemetry is an opt-in `onUsage` hook passed at adapter construction. These sites
never pass it, so they record nothing at all:

- `src/telegram/telegram-daemon.ts:149` — the daemon tick adapter, used by episodic
  distill (1 extract + 1 reconcile per fact), episodic consolidate, lesson
  consolidate, and idea radar.
- `buildPanelSeatBindings` (~`telegram-daemon.ts:459`) — both pinned panel judges.
- `src/core/core-worker.ts:1001`, `:2562`, `:2579` — direct `this.llmAdapter` calls
  that bypass the instrumented `llmAdapterFor`.

A structural cause sits underneath D4: `recordLlmCall` writes via
`appendRunLedgerEvent`, which requires a `run_id`. Daemon tick work has no run, so
even a wired hook would have had nowhere to write.

## Goals

1. No LLM call in Houge's runtime reaches a metered pay-per-token API by default.
2. Every LLM call attempt — success, failure, or fallthrough — is recorded in the
   ledger, including calls made outside any run.
3. Token counts, where the engine reports them, include thinking/reasoning tokens.
4. A leg dying the way agy died becomes visible within one tick.

## Non-goals

- Removing the metered provider code. It stays, unreachable by default (decision
  below).
- Optimising reader latency. Accepted as-is (decision below).
- Backfilling corrected token counts onto historical events.

## Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Metered legs | Keep the code, remove from every default chain | If a CLI leg dies again, re-enabling a paid leg is an env change, not a redeploy. The pricing table and fuse stay meaningful for that case. |
| Audit enforcement | Structural chokepoint in `answerWithChain` | Opt-in hooks are what produced D4. A required parameter cannot be forgotten. |
| Reader latency | Accept CLI spawn cost | Houge is asynchronous over Telegram. Measure before optimising. |

## Design

### Chain layout

| Surface | Before | After |
|---|---|---|
| Planner | `pi,agy-cli,kimi-api,gemini-api` | `pi,agy-cli` |
| Reader | `gemini-api,agy-cli` | `agy-cli,pi` |
| Panel judges | pinned `kimi-api` + `gemini-api` | pinned `agy-cli` + `pi` |
| Self-write | codex writer, kimi-cli reviewer | unchanged |

The reader is deliberately the planner reversed. The planner leads with Kimi, so the
reader leads with Gemini, preserving the ADR 0014 cross-family separation that the
current config was reaching for.

Panel diversity after the change spans four families with no paid API: Gemini via
`agy-cli`, Kimi via `pi`, OpenAI via the existing codex judge, Claude via the
existing chair.

### Slice 1 — CLI-only (stops the spend)

**`src/llm/providers/agy-cli.ts`**

- `AGY_DEFAULT_MODEL` → `"Gemini 3.8 Flash (Low)"`.
- Add `--output-format json` to argv. Parse the single-object envelope
  `{conversation_id, status, response, error, duration_seconds, num_turns, usage}`.
- `status !== "SUCCESS"` ⇒ failure. An `error` containing `invalid model selection`
  ⇒ `unavailable` (fall through), because a hard error would take the whole chain
  down on a model retirement. The audit event is what makes it loud.
- Normalise usage:

  ```
  input_tokens        := usage.input_tokens
  output_tokens       := usage.output_tokens + usage.thinking_tokens
  cached_input_tokens := usage.cache_read_tokens
  ```

  Thinking tokens are real output. This mirrors `normalizeCodexUsage`, which already
  folds `reasoning_output_tokens` into output.
- Interim reporting: until slice 2 lands, agy's parsed usage rides the existing
  `onUsage` hook, exactly as `pi` and `gemini-api` already do, so the intermediate
  state is strictly better than today and never worse. Slice 2 deletes every hook.

**`src/llm/providers/openai-compat.ts`**

Fix `extractUsage` even though the metered legs leave the default chain: derive
output as `completion_tokens_details.reasoning_tokens + completion_tokens` when
present, else `total_tokens - prompt_tokens` when that exceeds `completion_tokens`.
Without this, re-enabling a paid leg silently reintroduces D3.

**`src/llm/registry.ts`**

`DEFAULT_LLM_PROVIDERS` → `"pi,agy-cli"`. `METERED_PROVIDERS` and the fuse filter
stay as they are.

**`src/telegram/telegram-daemon.ts`**

`buildPanelSeatBindings` pins judges to `agy-cli` and `pi`.

**`.env`**

```
HOUGE_LLM_PROVIDERS=pi,agy-cli
HOUGE_LLM_READER_PROVIDERS=agy-cli,pi
HOUGE_AGY_MODEL=Gemini 3.8 Flash (Low)
```

The model is pinned in config, not left to the code default, so the next model
retirement is an env edit.

### Slice 2 — audit chokepoint

**New ledger event `llm_attempt`.**

Registered in `src/run/run-ledger.ts` alongside `llm_call`. Required payload fields:
`provider`, `role`, `outcome`. Optional: `model`, `latency_ms`, `input_tokens`,
`output_tokens`, `thinking_tokens`, `cached_input_tokens`, `cost_usd`, `error_kind`.

`outcome ∈ ok | error | unavailable`.

`error_kind` is a bounded classifier (`auth`, `model_missing`, `timeout`, `spawn`,
`transport`, `parse`, `other`) — never raw provider text, which could carry
untrusted bytes. The existing bodies-out-of-the-ledger invariant holds: counts and
metadata only, never prompt or response content.

**`answerWithChain` becomes the chokepoint.**

```
answerWithChain(chain, req, audit)
  for each leg:
    t0 = now
    result = await leg.answer(req)
    audit.record({ provider, model, role, outcome, latency_ms, usage? , error_kind? })
    if result.ok: return result
  return { ok:false, provider:"chain", ... }
```

`audit` is a required third parameter. Every existing call site must supply one, so
the compiler enforces coverage. This replaces the `onUsage` hook, which is deleted
from `LlmAnswerAdapterConfig`, `PiProviderConfig`, `OpenAiCompatConfig` and
`AgyCliProviderConfig`.

**Providers return usage instead of calling a hook.**

`LlmResult`'s success arm gains `usage?: LlmUsage`. `LlmUsage` gains an optional
`thinking_tokens`. The provider's job becomes parsing, not reporting; the chain owns
reporting. This is what makes the guarantee structural.

`thinking_tokens` is reported for visibility only and is ALREADY included in
`output_tokens`. Cost computation must keep reading `output_tokens` alone. Adding the
two together would double-count and is the one arithmetic error this field invites.

**Run-less audit.**

The audit sink carries `{ run_id?, correlation_id, role }`. With a `run_id` it writes
through `appendRunLedgerEvent` as today. Without one it writes through
`appendLedgerEvent` with a correlation id naming the tick
(`tick:episodic_distill`, `tick:idea_radar`, `tick:idea_panel`, …), following the
`recordEvalCompleted` precedent. This is what finally makes daemon tick LLM work
visible.

**CLI seats outside the chain.**

The codex judge, the claude chair, and the self-write writer/reviewer do not route
through `answerWithChain`. Each emits `llm_attempt` at its own spawn site. The chair
already runs `--output-format json` and codex already runs `--json`, so both have
usage available to parse.

### Data flow

```
call site (role, correlation)
  └ createLlmAnswerAdapter
      └ answerWithChain(chain, req, audit)
          └ per leg: spawn/http → parse usage → audit.record → return on first ok

spawn seats (codex judge / claude chair / self-write)
  └ parse JSON envelope → audit.record
```

### Error handling

- Audit emission is best-effort and wrapped: a telemetry failure must never fail a
  good answer. Existing precedent is `recordLlmCallSafe`.
- Unlike today, a failed emission logs a warning rather than passing silently.
- Provider failures are recorded with their outcome, which is the mechanism that
  makes D1-class regressions visible within one tick.

### Observability

`usageByModel` and `meteredSpendUsd` switch to reading `llm_attempt` rows with
`outcome = 'ok'`, unioned with historical `llm_call` rows so the existing three
months of history stays queryable. Pre-cutover Gemini output figures are known to
undercount by roughly 5x and are annotated as such in the reference doc rather than
rewritten.

A `/usage` surface breaking down calls by provider, role and outcome is the natural
follow-on but is out of scope here.

## Testing

Vitest, per repo standard. New and changed coverage:

- agy JSON envelope: SUCCESS parse, ERROR status, `invalid model selection` mapped to
  unavailable, malformed JSON, missing usage block.
- agy usage normalisation folds `thinking_tokens` into output and maps
  `cache_read_tokens` to cached input.
- `openai-compat` usage: reasoning-token field present, absent-but-total-exceeds-sum,
  and neither.
- `answerWithChain` emits exactly one `llm_attempt` per leg attempted, in order, with
  the right outcome for ok / error / unavailable.
- Run-less audit writes a correlation-scoped event; run-scoped audit writes a
  run-scoped one.
- Chain defaults contain no metered provider; an explicit metered env still builds.
- Panel judges resolve to `agy-cli` and `pi`.
- Spawn seats emit `llm_attempt` on both success and failure.

## Rollout

1. Slice 1 behind no flag — it is a repair, and the current state is already broken.
2. Verify live: one `/ask` turn and one web-search turn, confirm `llm_attempt` rows
   show `agy-cli` and `pi` only.
3. Watch the next Google bill cycle to confirm the metered spend stops.
4. Slice 2 lands after slice 1 is verified, so the audit is proving a known-good
   configuration rather than debugging two changes at once.

## Risks

| Risk | Mitigation |
|---|---|
| agy model retired again | Model pinned in `.env`; audit makes the failure visible in one tick instead of never. |
| CLI spawn latency on the reader path | Accepted by decision. Per-attempt `latency_ms` now measured, so a pool can be justified with data later. |
| Both CLI legs down leaves no chain | `METERED_FALLBACK_PROVIDERS` behaviour is unchanged; operator can set `HOUGE_LLM_PROVIDERS` to a paid leg as a one-line escape hatch. |
| `answerWithChain` signature change is wide | That is the point — it converts a silent-omission bug class into a compile error. Diff is mechanical. |
| agy's ~13.9k-token system overhead per call | Harmless on flat rate; noted so it is never assumed cheap if a metered leg returns. |
