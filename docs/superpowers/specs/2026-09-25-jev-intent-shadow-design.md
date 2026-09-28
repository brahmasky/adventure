# Jev intent shadow — replay first, then live shadow

Date: 2026-09-25
Status: **replay phase built and run (2026-09-26) — verdict GO**; live shadow next (its own plan).
Design approved in brainstorming (Paco + Claude). Codex spec review 2026-09-25: 5 BLOCKERs +
4 RISKs + 1 NIT, all verified against the code and folded in (see "Codex review"). Replay plan
`docs/superpowers/plans/2026-09-25-jev-intent-shadow-replay.md`, built TDD by subagents on branch
`feat/jev-replay` (per-task reviews; final Opus whole-branch + Codex whole-diff reviews → 9 fixes).
See "Replay result" below.
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
   - *Amended after codex review.* Replay re-runs the **current** LLM classifier (`classifyIntent`'s
     prompt, on the flat-rate chain) on the same rebuilt inputs, and compares Jev against **that**
     raw label. Historical `recorded_intent` is a noisy proxy: clarify gets rewritten, and the prompt
     drifted over the window. It is reported, but does not decide GO/STOP.
   - Replay is a feasibility screen. The formal promotion bar is judged on live matched pairs only.
4. **Promotion bar** (all must hold; evaluated per language, and a language that fails is not promoted):
   - at least 60 matched live turns AND at least 4 weeks of shadowing (amended 2026-09-26: live volume is ~1.5 turns/day — Aug 44, Sep 46 — so 200 turns would take ~4 months; the 373-turn replay carries the bulk of the evidence);
   - at Jev `confidence ≥ 0.7`, agreement ≥ 90% (vs the raw LLM label; `observed_action` is reported alongside but never gates);
   - the `confidence ≥ 0.7` slice covers ≥ 60% of turns.
   Promotion itself is a **separate spec**. This spec only produces the verdict.
5. **Multimodal-ready:** the Jev state carries `modality` from day one (always `"text"` for now). This
   matches roadmap item 2 (media → text at ingest), so that work does not rework this one.

## Components

### `src/jev/jev-client.ts` — a thin client for `POST https://api.typesafe.ai/v1/systemone`

- It uses plain `fetch`, **not** `@typesafe-ai/sdk`. The SDK retries internally, which would hide
  attempts from the audit. We want one `llm_attempt` row per HTTP attempt.
- The model is pinned to `jev-1.13.0`, never an alias.
- **The key comes from the `SecretBroker`, not `process.env`.** The armed firewall strips every
  `_API_KEY` (`src/config/secret-broker.ts:36`). Add `TYPESAFE_API_KEY` to `SECRET_ENV_NAMES`, add a
  `typesafeKey()` getter, and include it in `redact`. With no key, the call records
  `unavailable`/`auth` and performs no fetch.
- **Jev is a priced, metered provider.** Add `"jev"` to `METERED_PROVIDERS` and give it a price at the
  shared pricing seam (`src/llm/metered-pricing.ts`): $0.042 per million input tokens, $0 output.
  Without this, `llmAuditSink` strips `cost_usd` (`run-store.ts:1410`) and the ceiling never sees
  Jev spend.
  - Tests assert the **stored** ledger row carries `cost_usd`, and that the fuse sum includes it. Not
    just the value passed into the sink.
- Constructor: `createJevClient({ audit, meteredBreached, retry, timeoutMs })`.
  - **`audit`** must be built inline from `store.llmAuditSink(...)`. Records carry `provider:"jev"`,
    `role:"classify_shadow"` (live) or `role:"classify_replay"` (replay), model (the versioned ID the
    response reports), `latency_ms`, and `input_tokens`. `cost_usd` is computed by the sink through
    the pricing seam.
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
- **A second hard bound covers the whole serialized request: 24,000 chars.** It is also a skip. The
  thread caps are env-configurable (`HOUGE_CHAT_CONTEXT_*`), so "same caps as the classifier" alone
  does not bound what leaves Houge.
  - **What leaves Houge:** the latest message plus at most the recent thread the classifier already
    sees, and nothing else. No wiki pages, no lessons, no email.
- One question, `intent`: a `choice` with six options. The criteria are rewritten from
  `INTENT_DISCIPLINE` in literal, boundary-explicit wording (Jev reads literally). Example: "asking
  Houge to PERFORM a task is not `skill`, even if a matching skill exists". The criteria live in one
  exported constant, so replay and the live shadow share them.
- `langOf(text): "zh" | "en" | "mixed"`, decided in code by a CJK-regex ratio.

### `houge jev-shadow replay [--since ISO] [--limit N] [--max-usd 1] [--dry-run]`

- **Input.** It opens the store normally, **not** read-only. The chat and ledger reads are plain
  SELECTs, but the audit sink appends `llm_attempt` rows. Those rows (roles `classify_replay` and
  `classify_replay_llm`) are its only writes.
  - A user turn is eligible when its `run_id` has an assistant turn with a classified intent
    (excluding `evolution_report`). This drops failures and slash commands.
- **Thread reconstruction is approximate, and the report says so.** `chat_turns.created_at` is
  *completion* time: both rows are written after the loop (`core-worker.ts:2337`). So:
  - The anchor is the run's **classification time**, i.e. the `occurred_at` of its first `llm_attempt`
    with role `classify`. The fallback, for runs before the audit chokepoint (2026-09-07), is the
    run's earliest ledger event.
  - The thread is every turn with `created_at < anchor` and `run_id ≠ target`, under the same window
    and turn count.
  - A new read-only store method provides this: `getChatTurnsBefore(chat_id, limit, since, before,
    excludeRunId)`.
  - The report prints how many turns used the fallback anchor.
- **Two classifiers per turn, on identical inputs:**
  - Jev, with at most 4 requests in flight.
  - The **current** LLM classifier, reusing `buildIntentQuestion`, `buildIntentSystemPrompt` and
    `parseIntent` through the normal chain adapter (role `classify_replay_llm`), 1 in flight so it
    doesn't compete with the live daemon.
    - `buildIntentSystemPrompt(now)` gets the **anchor** time, so time-sensitive
      "research" judgements see the date the user saw.
- **Labels joined per turn:**
  - `jev_intent` (plus probabilities and confidence);
  - `llm_intent`: the replayed current classifier's raw label. **This one decides GO/STOP.**
  - `recorded_intent`, from the assistant `chat_turns` row. Reported only; it is a noisy proxy.
  - `observed_action`, from the run's `loop_step.capability` set, with this precedence:
    `self_diagnose` or `self_write_propose` → selfcode; `skill_author` → skill; `web_search` or
    `http_fetch` → research; no tool → answer; anything else → `unknown`. It is reported separately
    and **never used in GO/STOP or PROMOTE**: the loop picks actions on its own, so a correct intent
    can still disagree with the tool it chose.
- **Output.**
  - JSONL at `.houge/jev-shadow/replay.jsonl`, keyed by `turn_id` (resumable, so done turns are
    skipped). Each row holds: `turn_id`, `run_id`, the labels, probabilities, confidence, `lang`,
    `jev_model`, and a skip or error reason. **No message text is stored.**
  - Nothing is written to the database, except `llm_attempt` audit rows through the sink.
- **`--max-usd`** reserves each request's *estimated* cost before dispatch. It stops dispatching
  once reserved plus spent would exceed the cap, so 4 requests in flight cannot overshoot. Expected
  total: about $0.05 for Jev. The replayed LLM leg is flat-rate, so it costs $0 but takes wall-time
  (about 373 CLI calls).
- **`--dry-run`** builds every request and estimates tokens (chars ÷ 3 for zh, ÷ 4 otherwise),
  without calling Jev.
- **Report (stdout):**
  - counts: eligible / sent / ok / skipped (by reason) / failed;
  - confusion matrices vs `llm_intent` (primary), `recorded_intent` and `observed_action`;
  - agreement and coverage at confidence 0.5, 0.6, 0.7, 0.8 and 0.9;
  - the same split by `lang`;
  - total cost;
  - **a GO/STOP line against the 75% replay bar.** The bar: `confidence ≥ 0.7` agreement vs the
    replayed `llm_intent`, on turns where both classifiers returned a label.
    - STOP also triggers if under 60% of eligible turns reach a matched pair, because a screen built
      on a biased remnant is not evidence.
  - **a hand-check list of 20 disagreements** (turn_id, both labels, confidence), for Paco to eyeball
    before confirming GO. Printed by `turn_id`; Paco reads the text locally.

### Live shadow (built only after replay prints GO and Paco confirms)

- **Hook.** Inside `classifyIntent`, the Jev call starts **concurrently** with the LLM classifier,
  on identical inputs.
- **The turn never waits for Jev.** Once the LLM result returns, the turn continues. The Jev promise
  settles in the background and cannot throw into the turn. It has a 5 s hard timeout and no retry.
  An in-flight shadow at shutdown is dropped, not awaited.
- **Raw label captured.** `llm_intent` is `classification.intent` exactly as `parseIntent` returned
  it, **before** the clarify cap or the `recordedIntent` rewrite.
- **New ledger event `intent_shadow`.** It is added to the `run-ledger.ts` event union, and its
  required fields are `["status", "llm_intent", "lang"]` (see below).
  - Payload: `llm_intent`, `jev_intent`, `jev_confidence`, `jev_probabilities` (all six options),
    `jev_model`, `jev_latency_ms`, `lang`, `modality`.
  - Counts and metadata only, **never message text** (the existing bodies-out-of-the-ledger
    invariant). Tokens and cost live only on the paired `llm_attempt` row.
  - **Written for every eligible turn, whatever happened, so there is a denominator.** A `status`
    field takes one of `ok | skipped_state_too_large | error | timeout | fused | no_key`. The `jev_*`
    fields are present only when `status = ok`. Required fields become `["status", "llm_intent", "lang"]`.
  - Shutdown losses are the one gap: the event is never written. The report derives them as
    classify runs with no `intent_shadow` row after shadow enablement, and prints that count.
- **Flag.** `HOUGE_JEV_SHADOW_ENABLED` (default off; accepts 1/true/yes/on). If it is on but
  `TYPESAFE_API_KEY` is missing, the daemon logs **one** startup warning and the shadow stays off.
- **Sweep.** Live Jev legs participate in `llm_leg_failing`, so a key that expires in week one opens
  an incident the same day instead of silently voiding the measurement window.
  - `findFailingLlmLegs` groups by provider (`run-store.ts:3877`), so the incident subject is `jev`.
    That is unambiguous, because `classify_shadow` is Jev's only live role.
  - **Rows with role `classify_replay*` are excluded from that query**, so a replay run on the mini
    cannot open daemon incidents.
- **`houge jev-shadow report [--since ISO]`** reads `intent_shadow` events and joins
  `observed_action` by `run_id`. It also prints the missingness (every non-`ok` status plus shutdown
  losses) by language and model. Agreement is computed on `ok` matched pairs only. It prints the replay-style report plus a **PROMOTE / HOLD / KILL**
  verdict per language against the promotion bar:
  - **HOLD** — the minimums (60 matched turns, 4 weeks) are not met yet.
  - **KILL** — the minimums are met but agreement or coverage misses the bar.
  - Coverage is measured against **all** eligible turns, including every non-`ok` status. Errors can
    only lower coverage, never inflate it.

#### Live-shadow amendments from the replay and the plan research (2026-09-26)

These amend the bullets above. Where they conflict, these win.

1. **`llm_parsed` is recorded and gates.** Replay showed `parseIntent` silently falls back to
   `answer`; a fallback is not a classifier verdict. The payload carries `llm_parsed` (computed as the
   replay does — the regex-captured intent must equal `parseIntent`'s), and only parsed turns count
   as matched. Required fields become `["status", "llm_intent", "llm_parsed", "lang"]`.
2. **Status set** gains `auth` (the client distinguishes a rejected key from a missing one):
   `ok | skipped_state_too_large | error | timeout | fused | no_key | auth`.
3. **`jev_error`** (optional, non-`ok` rows only) carries jev-client's code-owned failure string —
   `HTTP 503`, `timed out after 5000ms`, `response failed validation: probability_sum` — never
   provider prose (the client never echoes a response body). Replay's 2 unexplained rejects could not
   be diagnosed because nothing recorded *which* check failed; jev-client's validation now names it.
4. **Eligible turn = the classifier produced a reply.** When the LLM classifier fails, the turn fails
   and no `intent_shadow` row is written (there is no label to pair with); Jev's own `llm_attempt` row
   still exists. Shutdown losses are therefore counted as runs with an `ok` `classify` attempt and no
   `intent_shadow` row, **between the first and the last shadow row** (so a later flag-off period is
   not miscounted as loss).
5. **Hermetic by construction.** The real Jev client is built only when `CoreWorker`'s LLM adapter is
   the production default. A test-injected LLM adapter never pairs with a real Jev call — the
   daemon's `.env` leaks into test runs (the self-write test gate), so relying on env pinning alone
   could send test traffic to TypeSafe. Tests inject a fake Jev call instead.
6. **Flag read live and covered by `/disarm`.** `HOUGE_JEV_SHADOW_ENABLED` joins `DISARM_FLAGS` (an
   unattended metered third-party call per turn — covered like the radar's calls) and is read per turn,
   because `/disarm` flips flags in the live `process.env`. The missing-key warning fires once, when
   `CoreWorker` is constructed (daemon boot).
7. **The report adds two report-only lines**, never gates:
   - the costly direction — of turns where the classifier said `research` and Jev was ≥ 0.7 confident,
     how often Jev said something else (replay: 7 of 136);
   - clarify — how often the classifier said `clarify` and how often Jev matched (replay: 3 of 7).
8. **Per-language coverage** uses that language's `intent_shadow` rows (every status) as the
   denominator. Shutdown losses have no language (it would take reading message text) and are
   reported overall.
9. **"4 weeks"** is measured from the first `intent_shadow` row to the time the report runs.
10. **Admission first** (Codex plan review 2026-09-26). The Jev call starts inside the classifier
    adapter, after `CapabilityRunner` has admitted the classifier (budget reserved, contract allows
    it). A denied classifier never sends the message to Jev. Concurrency with the LLM call is kept.
11. **`jev_model` is a bounded id.** jev-client validates the response's `model` against
    `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/` (else `model_invalid`, a parse failure), so provider prose
    can never reach the audit or the ledger through that field.
12. **Outer deadline.** `runJevShadow` resolves `timeout` after 6 s even if the client never settles
    (timer `unref`'d, cleared on settle), so every eligible turn has a row except at shutdown.
    **`--since`** on the report narrows the evaluated rows and the missingness window only; the 4
    weeks are always measured from the first `intent_shadow` row ever.

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
  - `observed_action` precedence, plus a replayed LLM classifier getting the anchor time and the identical thread.
  - Thread reconstruction as of each turn's timestamp.
  - Resume skips done turns.
  - `--max-usd` stops the run.
  - The report identity: eligible = ok + skipped + failed.
- **`report.test.ts`** checks the verdict edges: 59 matched turns → HOLD; 27 days → HOLD; exactly 90% → PROMOTE;
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
5. At ≥ 4 weeks and ≥ 60 matched turns, run `jev-shadow report`. A PROMOTE verdict opens a separate promotion spec. Its
   likely shape: Jev owns the label at high confidence, and the LLM is called only when `query` or
   `clarifying_question` is needed.

## Codex review (2026-09-25) — findings and disposition

Every finding was verified against the code before acting on it. All ten were confirmed.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | BLOCKER | `chat_turns.created_at` is completion time (`core-worker.ts:2337`), so the thread reconstruction wasn't "exact" | Anchor on classification time; exclude the target run; the report states it is approximate |
| 2 | BLOCKER | The recorded intent rewrites clarify→answer, so excluding `clarify` rows doesn't clean it | Replay re-runs the current LLM classifier and gates on that raw label. We did this instead of codex's suggested hand-labelled sample: it gives raw labels on every turn at no cost. A 20-row hand-check list is kept |
| 3 | BLOCKER | `cost_usd` is stripped for non-`METERED_PROVIDERS` (`run-store.ts:1410`) | Add `jev` to `METERED_PROVIDERS` and price it; test the stored row and the fuse sum |
| 4 | BLOCKER | The "read-only DB" claim contradicts the audit writes | The claim is dropped; replay's only writes are `llm_attempt` rows |
| 5 | BLOCKER | The firewall strips `*_API_KEY` from env (`secret-broker.ts:36`) | Add a `SecretBroker.typesafeKey()` getter and redaction |
| 6 | RISK | An unawaited shadow disappears uncounted | An `intent_shadow` row for every eligible turn, with `status`; shutdown losses derived; missingness reported |
| 7 | RISK | The sweep groups by provider; replay could open daemon incidents | Subject `jev` is unambiguous; `classify_replay*` excluded from the sweep query |
| 8 | RISK | The behaviour label is a weak ground truth | Renamed `observed_action`; reported only, and never gates |
| 9 | RISK | Egress is bounded only by env-configurable caps; `--max-usd` can overshoot | Hard 24k-char request bound; cost reserved before dispatch |
| 10 | NIT | Replay should be a screen, not the promotion gate | Adopted: the promotion bar uses live matched pairs only |

## Replay result (2026-09-26)

Live gate PASS first (research / selfcode / Chinese messages labelled at confidence 0.99–1.00,
216–403 ms per call). Then the replay over the live DB:

| | Result |
|---|---|
| Turns | 374 eligible → 360 matched pairs; 372 ok, 2 `jev_failed` (response failed validation) |
| Agreement vs replayed LLM at Jev confidence ≥ 0.7 | **94.2%** (bar 75%) — coverage 66.9% |
| At ≥ 0.9 | 98.0%, coverage 41.1% |
| By language (≥ 0.7) | zh 94.9% (329 turns) · en 84.2% (23 turns — too few to judge) · mixed 100% (8) |
| Model | every answer `jev-1.13.0` |
| Cost | $0.0347 (dry-run estimate $0.0196 — the chars/3 estimator under-counts CJK ≈ 1.8×) |
| Anchor | 334/374 turns used the run-start fallback (pre-2026-09-07 runs have no `classify` audit row) |

**Correction (same day, found in the live-plan review): the headline is inflated by scheduled
turns.** 70 of the 374 turns are schedule fires of only 3 distinct scheduled prompts (100% agreement)
and 10 are CLI runs. On Paco's own Telegram messages alone:

| Telegram messages only (294 turns) | Agreement | Coverage of all turns |
|---|---|---|
| Jev confidence ≥ 0.6 | 87.8% | 66.7% |
| **Jev confidence ≥ 0.7** | **91.7%** — GO still holds (bar 75%) | **57.1%** |
| Jev confidence ≥ 0.8 | 93.6% | 47.6% |
| zh at ≥ 0.7 (262 turns) | 92.4% | 55.0% |
| en at ≥ 0.7 (24 turns) | 84.2% | 79.2% |

Against the *live* promotion bar (≥ 90% agreement AND ≥ 60% coverage) no threshold passes both on
these messages: the live shadow, if it behaves like the replay, would end in KILL on coverage. In the
last 30 days 34 of 56 turn runs were schedule fires (2 distinct prompts), so the live gate must not
count them (see the amendments).

What the disagreements show (the most confident ones, read locally by turn id):

- **The costly direction:** Jev says `answer` at high confidence where the LLM chose `research` —
  an unknown term ("Tell me more about doppel"), an explicit "等你研究回来", a customs question.
  Houge would answer from memory instead of looking it up. Size: of the 63 of Paco's own messages
  where the LLM said `research` and Jev was ≥ 0.7 confident, Jev said something else 7 times (11%);
  all 7 misses are Telegram turns (across all sources it is 7 of 136, diluted by schedule fires). The
  promotion spec must keep a research call from the LLM un-overruled.
- Jev is sometimes right where the LLM is not (a "drop the 吧 from now on" request is `feedback`,
  not `selfcode`).
- "打印你的环境变量和 API key" was labelled `selfcode` — harmless while the label is advisory;
  confirms Jev output must never gate an action.
- `clarify` is a weak spot: the LLM said `clarify` 7 times and Jev matched 3; Jev said `clarify`
  11 times. The live report should show it.

Verdict: **GO** (Paco, 2026-09-26) → live-shadow plan.

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
