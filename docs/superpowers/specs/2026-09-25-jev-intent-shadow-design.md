# Jev intent shadow — replay first, then live shadow

Date: 2026-09-25
Status: design approved in brainstorming (Paco + Claude); pending codex spec review → writing-plans
Author: Paco + Claude

## Problem

Paco has a TypeSafe API key for **Jev** (`jev-1.13.0`), a "System One" decision model: it takes a
`state` plus typed questions (`choice` / `score` / `noul`) and returns calibrated probabilities and a
`confidence`. It does **not** generate text. Docs: https://docs.typesafe.ai/llms.txt.

The goal is to find out, cheaply and with evidence, whether Jev can take over Houge's intent
classification (`classifyIntent`, `src/core/core-worker.ts:3027`). Today that is a full CLI LLM call
on every turn (role `classify`, chain `pi,agy-cli`) that returns strict JSON parsed by `parseIntent`
(`src/capabilities/intent.ts`).

### Facts that shape the design

- **The classification is advisory.** Since ADR 0013 the inner loop decides the actual actions; the
  intent is only a hint (`core-worker.ts:2041`). A wrong label degrades quality, never safety.
- **Six intents**: `answer | research | feedback | clarify | selfcode | skill`.
- **The classifier also generates** `query` (for research) and `clarifying_question`. Jev cannot.
  Even after promotion, Jev can only own the label; generation stays with the LLM.
- **History is replayable.** `chat_turns` keeps the full text: 373 user turns, 2026-06-19 → 2026-09-25.
  **But the raw classifier label is not stored anywhere.** The assistant row's `intent` is the
  *recorded* intent (`core-worker.ts:2336`), where a clarify outcome overrides it and a clarify hint
  becomes `answer`. The classifier prompt has also changed over the window.
- **The behaviour label is a proxy.** `loop_step.capability` (since 2026-07-02) records what the loop
  actually did (`web_search` 927 steps, `self_write_propose`, `skill_author`, …). It stands in for
  ground truth, but it cannot distinguish `feedback` from `clarify`.
- **Jev 1.13 weaknesses** (vendor's own list): literal reading, math/dates, indirection, large noisy
  state, adversarial content, and weaker non-English (CJK) accuracy. Limits: 1,200 RPM, 32k tokens
  for state plus the longest question. Price: $0.042 per million input tokens; output is free.

## Decisions (from brainstorming)

1. **Scope: shadow `classifyIntent` only.** Excluded: per-turn LLM leg routing, the idea-panel judge,
   and anything security-bearing. **Jev never gates self-write, the Dual-LLM reader, the invariant
   sweep, or any action.**
2. **Data egress approved (option A):** Jev receives the latest message plus the recent thread,
   under the same window and caps the LLM classifier gets.
3. **Approach 1:** replay history first. **If agreement is below ~75%, stop without touching the
   daemon.** If it passes, build the live shadow, which captures the clean raw LLM label.
4. **Promotion bar** (all must hold; evaluated per language, and a language that fails is not promoted):
   - at least 200 shadowed turns AND at least 2 weeks of shadowing;
   - at Jev `confidence ≥ 0.7`, agreement ≥ 90% (vs the raw LLM label; the behaviour label is reported alongside);
   - the `confidence ≥ 0.7` slice covers ≥ 60% of turns.
   Promotion itself is a **separate spec**. This spec only produces the verdict.
5. **Multimodal-ready:** the Jev state carries `modality` from day one (always `"text"` for now). This
   matches roadmap item 2 (media → text at ingest), so that work does not rework this one.

## Components

### `src/jev/jev-client.ts` — a thin client for `POST https://api.typesafe.ai/v1/systemone`

- It uses plain `fetch`, **not** `@typesafe-ai/sdk`. The SDK retries internally, which would hide
  attempts from the audit. We want one `llm_attempt` row per HTTP attempt.
- The model is pinned to `jev-1.13.0`, never an alias. The key comes from `TYPESAFE_API_KEY`. With
  no key, the call records `unavailable`/`auth` and performs no fetch.
- Constructor: `createJevClient({ audit, meteredBreached, retry, timeoutMs })`.
  - **`audit`** must be built inline from `store.llmAuditSink(...)`. Records carry `provider:"jev"`,
    `role:"classify_shadow"`, model (the versioned ID the response reports), `latency_ms`,
    `input_tokens`, and `cost_usd = input_tokens × 0.042e-6`.
  - **`meteredBreached`:** when it returns true, no fetch happens. Jev counts toward the metered
    ceiling (ADR 0019).
  - **`retry`:** `none` for the live shadow. For replay: up to 3 retries, honouring `retry-after`,
    otherwise exponential backoff. Only 429, 5xx and network errors are retried.
- The response is validated with Zod: the answer is `type:"choice"`, the option keys equal the six
  intents, the probabilities sum to 1 ± 0.01, and `confidence` is in [0, 1]. A failure is recorded as
  `error`/`parse`, and no answer is returned.
- The key is never logged (debug output shows at most `key[:8]`).

### `src/jev/intent-question.ts` — pure, with no I/O

- `buildJevIntentRequest(message, recentTurns, turnChars, recentClarifyCount)` takes **the same
  inputs** as `buildIntentQuestion`, so a disagreement measures the model, not input drift.
- It returns either `{ state, questions }` or `{ skip: "state_too_large" }`.
- State: `{ modality: "text", latest_message, recent_turns: [{ role, text }], already_asked_clarification: boolean }`.
  Thread text uses `feedTurnText` with the same `turnChars` cap.
- `latest_message` is capped at 8,000 chars. **Anything over the cap is skipped, never truncated:** a
  truncated message would silently yield a worse label.
- One question, `intent`: a `choice` with six options. The criteria are rewritten from
  `INTENT_DISCIPLINE` in literal, boundary-explicit wording (Jev reads literally). Example: "asking
  Houge to PERFORM a task is not `skill`, even if a matching skill exists". The criteria live in one
  exported constant, so replay and the live shadow share them.
- `langOf(text): "zh" | "en" | "mixed"`, decided in code by a CJK-regex ratio.

### `houge jev-shadow replay [--since ISO] [--limit N] [--max-usd 1] [--dry-run]`

- **Input.** It opens `houge.sqlite` **read-only**. A user turn is eligible when its `run_id` has an
  assistant turn with a classified intent (excluding `evolution_report`), which drops failures and
  slash commands. For each eligible turn it rebuilds the thread exactly as it stood at that turn's
  `created_at`: same window, same turn count, same clarify count.
  - `RunStore.getRecentChatTurns` has no upper time bound today. Replay therefore needs a read-only
    variant, `getChatTurnsBefore(chat_id, limit, since, before)`. `before` is exclusive, so the turn
    being classified is not in its own thread.
- **Calls.** Jev is called with at most 4 requests in flight.
- **Labels joined per turn:**
  - `jev_intent` (plus probabilities and confidence);
  - `recorded_intent`, from the assistant `chat_turns` row;
  - `behaviour_label`, from the run's `loop_step.capability` set, with this precedence:
    `self_diagnose` or `self_write_propose` → selfcode; `skill_author` → skill; `web_search` or
    `http_fetch` → research; no tool → answer; anything else → `unknown`. It cannot tell feedback
    from clarify, and the report says so.
- **Output.**
  - JSONL at `.houge/jev-shadow/replay.jsonl`, keyed by `turn_id` (resumable, so done turns are
    skipped). Each row holds: `turn_id`, `run_id`, the labels, probabilities, confidence, `lang`,
    `jev_model`, and a skip or error reason. **No message text is stored.**
  - Nothing is written to the database, except `llm_attempt` audit rows through the sink.
- **`--max-usd`** stops the run once the running `input_tokens` cost exceeds the cap. Expected
  total: about $0.05.
- **`--dry-run`** builds every request and estimates tokens (chars ÷ 3 for zh, ÷ 4 otherwise),
  without calling Jev.
- **Report (stdout):**
  - counts: eligible / sent / ok / skipped (by reason) / failed;
  - confusion matrices vs `recorded_intent` and vs `behaviour_label`;
  - agreement and coverage at confidence 0.5, 0.6, 0.7, 0.8 and 0.9;
  - the same split by `lang`;
  - total cost;
  - **a GO/STOP line against the 75% replay bar.** The bar: `confidence ≥ 0.7` agreement vs
    `recorded_intent`, restricted to turns where `recorded_intent ≠ clarify`, because clarify is
    rewritten in history.

### Live shadow (built only after replay prints GO and Paco confirms)

- **Hook.** Inside `classifyIntent`, the Jev call starts **concurrently** with the LLM classifier,
  on identical inputs.
- **The turn never waits for Jev.** Once the LLM result returns, the turn continues. The Jev promise
  settles in the background and cannot throw into the turn. It has a 5 s hard timeout and no retry.
  An in-flight shadow at shutdown is dropped, not awaited.
- **Raw label captured.** `llm_intent` is `classification.intent` exactly as `parseIntent` returned
  it, **before** the clarify cap or the `recordedIntent` rewrite.
- **New ledger event `intent_shadow`.** It is added to the `run-ledger.ts` event union, and its
  required fields are `["llm_intent", "jev_intent", "jev_confidence", "jev_model"]`.
  - Payload: `llm_intent`, `jev_intent`, `jev_confidence`, `jev_probabilities` (all six options),
    `jev_model`, `jev_latency_ms`, `lang`, `modality`.
  - Counts and metadata only, **never message text** (the existing bodies-out-of-the-ledger
    invariant). Tokens and cost live only on the paired `llm_attempt` row.
  - Written only when Jev returned a valid answer. A failed attempt shows up only as its
    `llm_attempt` row.
- **Flag.** `HOUGE_JEV_SHADOW_ENABLED` (default off; accepts 1/true/yes/on). If it is on but
  `TYPESAFE_API_KEY` is missing, the daemon logs **one** startup warning and the shadow stays off.
- **Sweep.** Jev legs participate in `llm_leg_failing` (`findFailingLlmLegs`), so a key that expires
  in week one opens an incident the same day instead of silently voiding the measurement window.
  Incident text names the role `classify_shadow`.
- **`houge jev-shadow report [--since ISO]`** reads `intent_shadow` events and joins the
  `behaviour_label` by `run_id`. It prints the replay-style report plus a **PROMOTE / HOLD / KILL**
  verdict per language against the promotion bar:
  - **HOLD** — the minimums (200 turns, 2 weeks) are not met yet.
  - **KILL** — the minimums are met but agreement or coverage misses the bar.

## Error handling

| Case | Live shadow | Replay |
|---|---|---|
| 429 rate limit | No retry. `error`/`transport`; the shadow is dropped | Retry ≤3, honour `retry-after`; each attempt is audited |
| 5xx / network error | `error`/`transport`; dropped | Same retry rule |
| 401 / 403 | `unavailable`/`auth` → sweep incident | **Abort the run** with a clear message |
| Timeout | 5 s → `error`/`timeout` | 15 s per call |
| Malformed response | Zod fail → `error`/`parse`; no event | Same; the row carries the error reason |
| Message > 8k chars | Skip `state_too_large`; no Jev call | Same; counted in the report |
| Response `model` ≠ `jev-1.13.0` | Record as returned; one warning | Same; the report splits by `jev_model` |
| Metered fuse tripped | No call | No call; the run stops and says so |

**Security.**
- Message content can steer Jev's label (prompt injection). That is acceptable **only because the
  label is advisory.** Any promotion spec must preserve "Jev output never gates an action".
- Jev output is never inserted into any prompt. It goes only to the ledger and the report.

## Testing

Under `tests/jev/`, with no network:

- **`intent-question.test.ts`**
  - The thread passed to Jev equals the one `buildIntentQuestion` renders (same cap, window and
    clarify flag). *Why:* otherwise a disagreement measures input drift.
  - The option set is exactly the six intents.
  - An over-cap message returns a skip, not a truncation.
  - `langOf` handles zh, en and mixed text.
- **`jev-client.test.ts`** (mocked `fetch`)
  - 200 / 401 / 429 with `retry-after` / 5xx / timeout / malformed body each yield the right outcome
    and error kind.
  - Replay retries write one audit row per attempt.
  - `meteredBreached` means zero fetches.
  - The key never appears in logger output.
- **`replay.test.ts`** (in-memory store seeded with turns and loop steps)
  - The eligibility filter.
  - `behaviour_label` precedence.
  - Thread reconstruction as of each turn's timestamp.
  - Resume skips done turns.
  - `--max-usd` stops the run.
  - The report identity: eligible = ok + skipped + failed.
- **`report.test.ts`** checks the verdict edges: 199 turns → HOLD; 13 days → HOLD; exactly 90% → PROMOTE;
  89.9% → KILL; 59% coverage → KILL; zh fails while en passes → per-language verdicts.

In the existing suites:

- **Core-worker tests**
  - A hanging Jev leaves turn latency unchanged.
  - A throwing Jev lets the turn succeed and records an `llm_attempt` error.
  - A clarify verdict later capped to answer records `llm_intent: "clarify"`.
  - With the flag off or the key missing: zero Jev calls and zero `intent_shadow` events.
- **`tests/llm/audit-coverage.test.ts`** is extended so every `createJevClient(` call site in `src/`
  passes an inline `llmAuditSink(` and `meteredBreached:`.
- The no-bodies assertion is extended to `intent_shadow` payloads.

**Live gate** `scripts/live-gate-jev.mjs` (opt-in, needs the real key):
- Three fixed messages go to the real API: an obvious research query, an obvious selfcode request,
  and a Chinese message.
- It asserts the response shape, the pinned model ID, and an `llm_attempt` row with `cost_usd > 0`.
- **PASS additionally requires** the research and selfcode messages to be labelled correctly at
  `confidence ≥ 0.7`. Otherwise a shape-only pass would hide a broken question.
- Finally, a `replay --limit 5 --dry-run` runs against a copy of `houge.sqlite`.

## Rollout

1. Build `jev-client`, `intent-question` and `replay` with tests, and pass the live gate.
2. Run the replay on real data, and show Paco the report.
3. **Go/no-go:** STOP (below 75%) ends the project; record why in `tasks/lessons.md`. GO needs Paco's
   confirmation.
4. Build the live shadow with tests. Paco enables `HOUGE_JEV_SHADOW_ENABLED` on the mini (the daemon
   restart is Paco's action).
5. At ≥ 2 weeks, run `jev-shadow report`. A PROMOTE verdict opens a separate promotion spec. Its
   likely shape: Jev owns the label at high confidence, and the LLM is called only when `query` or
   `clarifying_question` is needed.

## Out of scope

- LLM leg routing by Jev, the idea-panel judge, email triage (roadmap item 3), and multimodal ingest
  (roadmap item 2).
- Any change to `parseIntent`, `INTENT_DISCIPLINE`, or the loop.
- Storing message text anywhere new.

## Docs to update on ship

- `docs/reference/configuration.md` (`TYPESAFE_API_KEY`, `HOUGE_JEV_SHADOW_ENABLED`).
- README (a short Jev shadow section).
- `docs/ROADMAP.md`.
- An ADR only if the project reaches promotion.
