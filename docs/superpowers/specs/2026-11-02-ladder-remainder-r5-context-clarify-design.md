# Decision ladder, remainder slice R5 — `context.recall`, `context.catch_up`, `context.lessons` and `turn.clarify_cap` on the ladder (Rev 1.0)

**Status:** DRAFT — awaiting the senior review and the codex design pass, then Paco's tap on Decisions 1 and 2.
**Date:** 2026-11-02
**Amends:** `docs/ROADMAP.md` (the remainder line); ADR 0030 gets an amendment row (drafted under the approved spec, awaiting Paco's signature); the ladder design spec §6.1 gets a dated note.
**Depends on:** ADR 0030 §4.1, §5 (a turn's row is written with the turn's own records), §6.1 (rows A23, A25, A26, A27, stage `pre_model`), §6.2; remainder R1 spec §2 (the R5 rows of the re-walk table, seam "a recorder on `TurnContextDeps`"); R3/R4 (`2026-11-01-ladder-remainder-r3-ack-steer-design.md`, `…-r4-crash-retry-design.md`) for the pattern: a recorder on the deps, a private record helper, the stamped merge-base differential on `scripts/stage4-supervisor-fixture.mjs`, production-wiring tests, exact-row assertions, one exported predicate shared by code and rule.

## 1. Goal

Put the four pre-model context decisions on the registry as rule-only entries that **record and never steer**:

- `context.recall` (A25): which retrieved episodic facts and wiki pages enter the turn's `[context]` block (cosine ≥ gate with an embedding, an FTS hit without one).
- `context.catch_up` (A26): does the planner prompt carry the quick replies Paco got from the lanes since the planner last answered, and how many fit.
- `context.lessons` (A23, the lesson part): which active lessons the spawned child's system prompt holds under the char cap.
- `turn.clarify_cap` (A27, the cap only): Houge has asked its limit of clarifying questions in a row; does this prompt carry the "do not ask another" line.

Each wraps today's code unchanged; the raw answer drives. Proof: the stamped merge-base differential on the R3/R4 supervisor fixture, zero behaviour differences.

## 2. Scope

In: the four entries; a `recorder` on `TurnContextDeps` (passed by `CoreWorker.ompTurnContext`); recording calls in `omp/turn-context.ts` and, for `context.lessons`, the spawn path of `omp/planner-supervisor.ts` (the turn threaded to `preparePaths`); one pure predicate per entry exported beside the code it mirrors; fixture additions; a new `context` corpus; a live gate; a rollback check.

Out (stated so the review cannot creep):
- R6 (`lookup.rewrite`, `lookup.thin`, `turn.model`), R7 (`attach.path`).
- A23 restart-on-fingerprint, A24 lesson-change session reset, A27's session seed, restart note and quote resolution: §6.1 lists them as mechanics; they stay code.
- **Lane-turn recall and lessons.** The answer lane reads the same retrieval (`answerLaneDeps.retrieve`, `core-worker.ts:3502–3503`) and the planner's system prompt (`:3502`), but through `AnswerLaneDeps`, not `TurnContextDeps`, and a lane turn writes no `loop_started` attribution row today (`recordLoopStarted`'s only caller is `turn-context.ts:264`). R5 records what the planner prompt holds; a lane's recall row would be a new record with no attribution row to anchor it. A follow-up if the lane's recall turns out to be judged.
- `admit`, the cosine gates, `HOUGE_LESSON_CHAR_CAP`, `HOUGE_LESSON_CAP_PER_SCOPE`, `HOUGE_MAX_CONSECUTIVE_CLARIFY`, `CATCH_UP_MAX_ENTRIES`, `CATCH_UP_MAX_CHARS`, `CLARIFY_CAP_NOTICE`, the `loop_started` payload (field names and values), `lesson_dropped` / `lesson_render_failed` events and incidents, the embedding call; any change to what a prompt holds.

## 3. Live facts (`main@28c4990`, read first-hand)

**Where the planner prompt is built.** `buildTurnPrompt(d, i)` (`omp/turn-context.ts:343–359`), called once per planner turn from `PlannerSupervisor.startTurn` (`planner-supervisor.ts:627`, awaited inside `this.step(turn, …)`, so a turn that ends meanwhile discards the result). In order: `await d.retrieve(chat_id, message)` (`:344`); `sessionSeed` (`:345`); `catchUp` (`:346`); `recordAttribution` writes `loop_started` with `applied_artifacts` and `retrieval` telemetry (`:347`, `:263–282`); `renderContextBlock` (`:348`); `clarifyCapReached` (`:350`); the restart note (`:352`). Every input carries `i.run_id`, the turn's claimed run: these decisions are made for the turn's own run and are written beside its `loop_started` row, so the R4 late-consult rule (§4.0) applies only to `context.lessons`.

**Recall (A25).** `d.retrieve` is `CoreWorker.retrieveForOmpTurn` (`core-worker.ts:2418–2431`): one query embedding when either memory flag is on (`embedQueryForTurn`, `null` on failure); `episodicFactsForTurn` (`:1102`) and `wikiPagesForTurn` (`:1122`), each `noRetrieval(…)` when its flag is off, else the store's gated retrieval through `admit` (`run/relevance-gate.ts:32–36`); facts already in the rendered core band are removed (`:2423`). It returns one block per admitted row and `telemetry` (`admitted`, `best_admitted`, `best_rejected`, `embedding`, `fts_only` per side) — **no telemetry when both memory flags are off** (`:2429`), and `embedding: false` with telemetry present means the embed failed. `renderContextBlock` (`:338–341`) is empty exactly when `facts.length + pages.length === 0`.
- `fts_only` is never `true` in today's code (both `noRetrieval` calls pass `false`, `core-worker.ts:1107`, `:1123`; the retrieval functions set it from the embedding). The live rows show `fts_only: 1` exactly when `embedding: 0`. The entry reads `embedding`, not `fts_only`.

**Catch-up (A26).** `catchUp(d, i, seeded)` (`:326–335`): a schedule turn returns before any read; otherwise `laneTurnsSince(chat_id, plannerLastAnsweredAt(chat_id))`, then `renderCatchUp` (`:318–323`, pure): the newest `CATCH_UP_MAX_ENTRIES` (6) rows, oldest dropped until the block fits `CATCH_UP_MAX_CHARS` (2 000); zero left → no block. A read failure is logged and injects nothing (`:331–333`). The shown run ids go into `loop_started.applied_artifacts.catch_up_run_ids` (only when non-empty).

**Lessons (A23).** `renderLessonSection` (`run/lesson-render.ts:68–…`): every active lesson of both scopes, row-capped per scope, theme then id, skip-and-continue under `HOUGE_LESSON_CHAR_CAP` (4 000); `skipped` lists each lesson the cap hid. `buildSystemPrompt` (`turn-context.ts:185–203`) wraps it (`safeLessonSection`: a throw renders no lessons, `lessonRenderFailed`). `buildSystemPrompt` is called four ways: `writeSystemPromptFile` (`:244–254`, **the spawn**: the file the child reads, plus `raiseLessonDrops`); `systemPromptFingerprint` (every `ensureSession`, `planner-supervisor.ts:994`, a comparison only); the `appliedOf(buildSystemPrompt(…))` fallback in `buildTurnPrompt` when `i.applied` is absent (one-shot callers, tests); `answerLaneDeps.systemPrompt` (lane turns, out of scope). Only the spawn is "the prompt the child holds". `writeSystemPromptFile` is called once, from `preparePaths` (`:1116–1129`), from `spawn(model)` (`:1132`), whose only caller is `preflightThenSpawn(fresh)` (`:1004–1013`), launched by `ensureSession(fresh, turn)` (`:988–1002`, which R4 threaded the turn into). `preflightThenSpawn` takes no turn today, and a spawn runs after awaits (`preflight`), so by the time `preparePaths` runs the launching turn may have finished (a lane turn completes after a bounded wait on its warm start; `/kill`). One turn can spawn twice (a stale re-check, `startTurn`'s second `ensureReady`; a candidate omp refused at spawn walks to the next model), so two `context.lessons` consults per turn are possible.

**Clarify cap (A27).** `clarifyCapReached(d, chat_id)` (`:123–126`): reads the chat's recent turns (`getRecentChatTurns` with `resolveChatContextTurns` and `chatContextSince`), counts trailing `clarify` assistant turns (`countTrailingClarifyTurns`, `capabilities/intent.ts:67–79`, user turns skipped), compares `>= resolveMaxConsecutiveClarify(env)` (`intent.ts:56–59`, default **1**; `0` is allowed and caps every turn). Consulted for every planner turn, Telegram and schedule alike. Its only production caller is `buildTurnPrompt` (`:350`).

**No recorder today.** `TurnContextDeps` (`:22–33`) has none. `CoreWorker.ompTurnContext` (`core-worker.ts:2395–2405`) builds it; the supervisor already gets `recorder: this.decisionRecorder` (`:2390`). `src/omp/` and `src/decisions` are protected (`self-write-guard.ts`); `src/core/core-worker.ts`, `src/capabilities/intent.ts` and `src/run/lesson-render.ts` are not.

**Live traffic** (live DB, read-only, last 30 days): 112 planner `loop_started` rows, all with retrieval telemetry; 74 admitted at least one fact or page; 4 had a failed embed (`embedding: 0`: 3 admitted nothing, 1 admitted by FTS); 8 carried a catch-up block; 1 `clarify` assistant turn (37 all-time); `lesson_dropped` and `lesson_render_failed` incidents: **0** in the DB's history. Recall is the only traffic path; catch-up, the cap and the lesson cap are rare.

**Test seam.** `scripts/stage4-supervisor-fixture.mjs`: `mkSupervisor(d, store, opts)` builds `turnContext` with `retrieve: async () => ({ facts: [], pages: [] })` and `env: {}` (`:99`), and `opts.extra` overrides any `SupervisorDeps` field (`:103`), so `opts.extra.turnContext` can supply a recorder, a scripted `retrieve` with telemetry, and an env; lessons, `chat_turns` and lane turn rows are seeded in the store. Existing unit tests: `tests/omp/turn-context.test.ts` (cap `:304`, catch-up, retrieval), `tests/run/lesson-render.test.ts`.

## 4. The entries

### 4.0 The recording rule (ADR 0030 §5)
All four decisions are made inside a turn whose run is already claimed, so each row is written at the decision with that run's id and `tool_call_id` null. **Recall, catch-up and the cap** are decided inside `buildTurnPrompt` for `i.run_id`, beside `recordAttribution`: the same run and moment as the turn's `loop_started` row, written even if the turn ends while the prompt is built (as `loop_started` is today). **Lessons** are decided at the spawn: the launching turn is passed down, never read from `this.turn` — `ensureSession(fresh, turn)` → `preflightThenSpawn(fresh, turn)` → `spawn(model, turn)` → `preparePaths(turn)` → `writeSystemPromptFile(d, chatId, run_id?)`; the row is written only when `!turn.finished` at the consult; **a consult reached after the launching turn ended writes no row** (R4 §4.0, verbatim): the prompt is still written and the drops still raised (raw behaviour). No message, fact, page, lesson or lane text is stored (`rowOf` has no input column).

All four: `version: 1`, `stage: "pre_model"`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`, **unlocked** (§6.1 carries no L for A23, A25, A26, A27). `input`: `context.recall` `mixed` (Paco's message scored against stored rows); `context.catch_up` `mixed` (it folds Paco's lane messages); `context.lessons` `tool`; `turn.clarify_cap` `tool` (assistant intents only). R12: an `effect` verdict over `mixed` input is allowed for a rule-only entry — `effectProblems` (`registry.ts:100–…`) still requires an effect declared for every verdict but skips the R12 check when the entry has no Jev or model rung; as for `turn.retry`, the amendment states the consequence: adding a Jev or model rung later needs a compliant effect contract, and `entryProblems` fails the suite until it has one.

**One read, one predicate.** Each capture uses the values the raw code already computed, never a second read: the cap's capture comes from the same `getRecentChatTurns` read (§4.4); recall's from the returned `TurnRetrieval`; catch-up's from the one `laneTurnsSince` read; lessons' from the one `renderLessonSection` result.

### 4.1 `context.recall`
- Verdicts `include | none`; `defaultVerdict: "none"`; `fail: "none"` (recorded, never acted on).
- **Consulted** once per `buildTurnPrompt` call **when retrieval was attempted** (`telemetry` present), after `d.retrieve` resolves. Both memory flags off → not consulted (no embed, no read, nothing to judge).
- Input `{ embedding: boolean; facts: number; pages: number; best_admitted: number | null; best_rejected: number | null }`: `facts`/`pages` = the returned arrays' lengths (what `renderContextBlock` renders); `best_*` = the larger of the two sides' telemetry values (null when both null); `embedding` = the facts side's telemetry flag (both sides share one embedding). Rule: `facts + pages > 0` → `include` / `embedded` (embedding) or `fts_only` (no embedding); else `none` / `embed_failed` (no embedding), `below_gate` (`best_rejected` not null), or `no_candidates`. A test pins `include` ⇔ `renderContextBlock(...) !== ""` on every corpus item. `reasonCodes`: `embedded`, `fts_only`, `embed_failed`, `below_gate`, `no_candidates`.
- Effects: `include` `effect`, reversible true (the next turn retrieves afresh), announced none; `none` `none`.
- Rows: **Decision 1.**

### 4.2 `context.catch_up`
- Verdicts `inject | none`; `defaultVerdict: "none"`; `fail: "none"`.
- **Consulted** on a Telegram planner turn **when there is something to decide**: the read returned at least one lane row, or the read failed. A schedule turn (returns before the read) and a Telegram turn with no lane reply since the planner's last answer are not consults.
- Input `{ read_failed: boolean; available: number; shown: number }` (`available` = rows read, `shown` = `run_ids.length` of `renderCatchUp`'s result). Rule (first match): `read_failed` → `none` / `read_failed`; `shown > 0` → `inject` / `all` when `shown === min(available, CATCH_UP_MAX_ENTRIES)`, else `trimmed`; else `none` / `all_trimmed`. `reasonCodes`: `all`, `trimmed`, `all_trimmed`, `read_failed`.
- `catchUp` becomes `{ text, run_ids, available, read_failed }` internally; `renderCatchUp` is unchanged (pure, exported, tested).
- Effects: `inject` `effect`, reversible true, announced none; `none` `none`.
- Rows: **Decision 2.**

### 4.3 `context.lessons`
- Verdicts `full | capped | none`; `defaultVerdict: "full"`; `fail: "full"`.
- **Consulted** once per `writeSystemPromptFile` call on the spawn path (§4.0); never by `systemPromptFingerprint`, the `appliedOf` fallback, or the lane. `writeSystemPromptFile` gains an optional `record?: { run_id: string }` (absent → no consult; its one production caller passes it when the launching turn has not finished).
- Input `{ rendered: number; skipped: number; failed: boolean }` from the snapshot (`lessonIds.length`, `skipped.length`, `lessonRenderFailed`). Rule: `failed` → `none` / `render_failed`; `skipped > 0` → `capped` / `char_cap`; else `full`. `reasonCodes`: `char_cap`, `render_failed`.
- Effects: `capped` `tighten`, reversible true (a shorter lesson, a raised cap or a pruned lesson re-renders it at the next spawn), announced none (each drop already raises today's `lesson_dropped` incident, unchanged); `none` `tighten`, reversible true, announced none (`lesson_render_failed` is today's announcement); `full` `none`.
- Rows: `capped` and `none` only (the default writes none). Zero in the DB's history: an outage record.

### 4.4 `turn.clarify_cap`
- Verdicts `allow | cap`; `defaultVerdict: "allow"`; `fail: "allow"`.
- **One predicate, one read.** `turn-context.ts` exports a pure `clarifyCapOf({ trailing, max }): boolean` (`trailing >= max`); `clarifyCapReached` is replaced by `clarifyCapState(d, chatId): { trailing: number; max: number }` (the same read and count), and `buildTurnPrompt` uses `clarifyCapOf(state)` for the notice and the same `state` as the input. The rule's verdict is `clarifyCapOf`'s, so there is no second copy.
- **Consulted** once per `buildTurnPrompt` call.
- Input `{ trailing: number; max: number }`. Rule: `clarifyCapOf` → `cap` / `cap_reached`, else `allow`. `max === 0` caps every turn (a test pins it, raw and rule). `reasonCodes`: `cap_reached`.
- Effects: `cap` `tighten`, reversible true (the next non-clarify reply resets the streak), announced none (the notice is in the planner prompt, never shown to Paco); `allow` `none`.
- Rows: `cap` only.

### 4.5 Recorder seam
`TurnContextDeps` gains `recorder?: DecisionRecorder`; `CoreWorker.ompTurnContext` passes `this.decisionRecorder`. A private `record(d, entry, input, run_id)` helper in `turn-context.ts` mirrors the supervisor's (`planner-supervisor.ts:417–421`): absent recorder → no `decideSync` call; never throws into the turn. The supervisor's `context.lessons` consult goes through `writeSystemPromptFile` with its `turnContext` (the same recorder). A production-wiring test drives `CoreWorker.submitTurn` with a fake session and a seeded clarify streak and requires the `turn.clarify_cap` row, and with a fake embedding/retrieval requires the `context.recall` row (R2 lesson: a fixture that injects its own recorder cannot see a constructor that forgets one).

### 4.6 Failure behaviour (R1–R4 carried over)
(a) The insert fails → `decision_record_failed` and one operator alert; (b) a recorder that throws past itself → logged. `decideSync` never throws for a rule-only entry. A rule that throws records its `fail` verdict at the `fail` rung while the raw code did what it did: a reader of a `none` / `full` / `allow` row checks `rung` first. For `context.lessons` and `turn.clarify_cap` the `fail` verdict is the default, so a throwing rule writes no row (`shouldRecord`, `decisions/record.ts:27–28`); both rules are integer comparisons over captured numbers, and a test pins that each rule is total over its input type. Neither fault changes the prompt, the attribution row, the touches, the drops or their order. A recorder fault inside `buildTurnPrompt` or `preparePaths` must not throw into the turn or the spawn (the helper catches).

## 5. What does not change
- What any prompt or system prompt holds; the `loop_started` payload; `touchApplied` / `touchEpisodicApplied` / `touchWikiApplied` / `touchLessonsSeen`; `lesson_dropped` / `lesson_render_failed` events and incidents; when a child spawns or restarts; the session seed and restart note; the embedding call count.
- `/status` gains a count line per new id once rows exist. The digest is unchanged (it lists only System One rows with a `p`).

## 6. The differential
**Harness (a plan task):** a stamped pair `--old-dist-r5` at this branch's merge base, provenance file `omp/turn-context.js`; `R5_IDS = ["context.recall", "context.catch_up", "context.lessons", "turn.clarify_cap"]` added to every pair's `NEW_ROW_IDS` and a new `r5` set. The first task greps for **every exact recorder-call tally or unfiltered `decisions` count on a path that builds a planner prompt or spawns a planner child** — every planner turn consults the cap, and every spawn consults lessons, so not only the rare paths are hit. Known: R3's `supervisor` and R4's `supervision` corpora (exact `calls`), `tests/omp/supervisor-decisions.test.ts` `counts`; also check `live-gate-omp`, `live-gate-jev-tree`, `live-gate-decisions-2a`, `live-gate-ladder-2b-hooks`, `live-gate-ladder-remainder-r3`, `live-gate-ladder-remainder-r4`. New tallies follow one rule: `turn.clarify_cap` +1 per `buildTurnPrompt`; `context.lessons` +1 per spawn whose launching turn had not finished; `context.recall` +1 per `buildTurnPrompt` with telemetry; `context.catch_up` +1 per Telegram `buildTurnPrompt` with a lane row or a failed read. Updated to expect the new calls and rows exactly (R2 P10).

**Fixture additions** (`scripts/stage4-supervisor-fixture.mjs`): `opts.turnContext` (merged over the default) for `retrieve`, `env` and a recorder pass-through; seed helpers for active lessons (with a small `HOUGE_LESSON_CHAR_CAP`), `chat_turns` with a clarify streak, and lane turn rows after a planner answer. Narrow, ported from `tests/omp/turn-context.test.ts` where it has them.

**Corpus `context`**, each item on a fresh store and supervisor:
- recall: retrieval with telemetry, 2 facts admitted [`include/embedded`]; FTS-only admission (`embedding: false`, 1 page) [`include/fts_only`]; failed embed, nothing admitted [`none/embed_failed`]; embedded, nothing admitted, `best_rejected` 0.3 [`none/below_gate`]; embedded, no candidates [`none/no_candidates`]; no telemetry (both flags off) [no row].
- catch-up: two lane rows since the planner's answer [`inject/all`]; eight short rows [`inject/all`, shown 6 — `min(8, 6)`]; rows whose newest six overflow 2 000 chars so some are dropped [`inject/trimmed`]; one row longer than 2 000 chars alone [`none/all_trimmed`]; `laneTurnsSince` throwing [`none/read_failed`]; a schedule turn with lane rows present [no row]; no lane rows [no row].
- lessons: a first spawn with lessons under the cap [no row]; lessons over the cap [`capped/char_cap` on the launching run]; `getActiveLessons` throwing [`none/render_failed`, the `lesson_render_failed` incident as today]; a lane turn whose warm start spawns after the lane turn finished, lessons over the cap [no row; the `lesson_dropped` incident as today]; a stale re-check spawning twice in one turn, over the cap [two `capped` rows on the run].
- cap: one trailing clarify, default max 1 [`cap/cap_reached`, the notice in the prompt]; a clarify followed by a non-clarify assistant turn [no row, no notice]; `HOUGE_MAX_CONSECUTIVE_CLARIFY=0` on a fresh chat [`cap/cap_reached`]; a schedule turn after a clarify [`cap/cap_reached`].
- none: a run claimed by another worker before `submit` [zero R5 calls and rows].
Compared: the session's call log (prompts — the full text — and steers and `setModel` calls, in order), the outcome sink's calls (incl. incidents), the system prompt file's bytes per spawn, and the whole-DB dump (new rows dropped before `relabelClocks`; ids scrubbed). Required: per item, the exact new rows (`[entry, verdict, reason, run_id label]`) and exact per-entry recorder call counts; a planted fault (recall's `embedded` and `fts_only` swapped; catch-up's `all` and `trimmed` swapped) shown failing once.

## 7. Live gate — `scripts/live-gate-ladder-remainder-r5.mjs` (dist, VACUUM copy, refuses outside `.worktrees/`, copy deleted on every exit path, `HOUGE_TELEGRAM_CHAT_ID` stub, tombstone pinned, fake session — no real omp child, no real Telegram)
1. A turn with a real retrieval over the copy's facts and pages (the real embedder, or its failure) → exactly one `context.recall` row on the run whose verdict matches the prompt's `[context]` block (present ⇔ `include`), and the run's `loop_started` payload byte-identical in shape to the merge base's for the same turn.
2. Ollama unreachable (embed URL pointed at a closed port) → `context.recall` reason `embed_failed` or `fts_only`, never `embedded`.
3. Two lane rows after a planner answer, then a Telegram planner turn → one `inject/all` row, the block in the prompt.
4. A clarify assistant turn, then a turn → one `cap/cap_reached` row, `CLARIFY_CAP_NOTICE` in the prompt.
5. Lessons over a lowered `HOUGE_LESSON_CHAR_CAP` at a spawn → one `capped/char_cap` row on the spawning run; the `lesson_dropped` incident as today.
6. Through `CoreWorker.submitTurn` (production deps) → line 4's row is written (wiring).
7. Faults: the insert faulted → `decision_record_failed`, exactly one alert to the stub chat, the prompt unchanged; a throwing recorder → no incident, prompt unchanged.
8. `/status` count lines for the four ids exact.
The slice updates the registry-count literals (32 → 36) and reruns the R4, R3, R2, R1, 4C and 4B gates (4B on a baselined copy until its follow-up lands). `live-gate-jev-tree` cases 3 and 7 fail on `main` today (logged follow-up): a rerun compares against `main`, not against green.

## 8. Rollback check — `scripts/check-ladder-remainder-r5-rollback.mjs`
The previous build opens a copy carrying the new rows (all four ids, with run ids), renders `/status` and the digest (digest identical to an untouched copy's; `/status` differs only in the four count lines, asserted exactly), reads every row unchanged (`rung`, `entry_version`, `verdict`, `reason_code`), and refuses `review_ok` naming the new ids. No migration.

## 9. Protected files touched (Tier A under the approved spec)
`src/omp/turn-context.ts`, `src/omp/planner-supervisor.ts` (the turn threaded to `preparePaths`), `src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `src/decisions/entries/context-recall.ts`, `context-catch-up.ts`, `context-lessons.ts`, `turn-clarify-cap.ts`. `docs/decisions/0030-decision-ladder.md` (amendment drafted, awaiting Paco's signature). Not protected: `src/core/core-worker.ts` (passes the recorder).

## 10. Risks
- **Traffic.** `context.recall` is the first R-slice entry on the common path: under 1-A, one row per planner turn with memory on (~112 per 30 days today). Bounded by turns; a row is a handful of columns.
- **A second read sneaking in.** The cap's capture must reuse its one `getRecentChatTurns`; recall's must use the returned arrays, not a re-query; the equivalence tests pin each.
- **The spawn-time run.** The threading must not change spawn order or the joined-start behaviour: a joiner never launches `preflightThenSpawn`, so only the launching turn is passed; the late-launcher item pins no row.
- **The prompt bytes.** No recording call may run between the pieces of `buildTurnPrompt`'s string in a way that reorders them; the differential compares the full prompt text.

## Decisions needed (Paco, at the spec tap)

**Decision 1 — which `context.recall` consults write a row.**
- **1-A (recommended):** every consult (`alwaysRecord`): `include` and `none`, ~112 rows per 30 days. Both errors are judgeable — noisy context (an `include` that misled) and a missed fact (a `none` with `below_gate` while the answer needed it) — and the failed-embed degradation (`embed_failed`) is visible per turn.
- **1-B:** `include` only (~74 per 30 days). A `none` stays invisible, including a failed embed that admitted nothing (3 of the last 30 days' 4); the `loop_started` telemetry still holds the numbers.

**Decision 2 — which `context.catch_up` consults write a row.**
- **2-A (recommended):** every consult (`alwaysRecord`), and a consult is only a turn with lane rows or a failed read (§4.2): `inject`, `all_trimmed`, `read_failed` (~8 per 30 days). The two `none` reasons are the ones where Paco's quick replies did not reach the planner.
- **2-B:** `inject` only. A read failure and an all-trimmed block (Paco's lane exchange invisible to the planner) leave no row.
