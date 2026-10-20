# Decision ladder stage 2b-ii: `improve.route` — design

**Status:** Rev 1, 2026-10-21. Parent spec: [2026-10-12-decision-ladder-design.md](2026-10-12-decision-ladder-design.md) §7.4 (the
entry), §8 (the surface), §13 (stage 2b). Sibling: [2026-10-19-ladder-2b-hooks-settle-design.md](2026-10-19-ladder-2b-hooks-settle-design.md)
(2b-i, merged 2026-10-21 at `139b501`). ADR 0030 decision 8 ("Improvement as a decision"). Facts below were read at
`61b8a5e`.

## 0. Scope and rulings

2b-ii builds `improve.route`: one entry that takes every improvement signal (corrections, review taps, failures, recurrence)
and routes each to what it points at. Code rungs cause the only automatic effects; Jev and a Tiny model only propose; a
daily digest is the surface. It also builds the signal producers that do not exist yet, because an entry over no signals
decides nothing.

| # | Ruling | By |
|---|---|---|
| 2b-R1 | Split 2b: hooks + settle first (2b-i), `improve.route` second (this spec) | Paco, 2026-10-19 |
| 2b-ii-R1 | **Surface B:** the daily decision digest comes back for improvements only: *Improvements today* (with Undo/Revoke), *Proposals waiting* (Accept/Dismiss), *Watch*. No unsure-verdict list, no counts, no Health lines (incidents page on their own). Paco flips `HOUGE_DECISION_DIGEST_AT` from `off` to a time at kickstart. | Paco, 2026-10-21 |
| 2b-ii-R2 | **Daily batch:** `improve.route` runs in one tick before the digest, over the day's signals, grouped; not per signal after each turn (parent §7.4 wording "after the turn, in the background" is amended: the tick never delays a reply either, and recurrence needs a window anyway). Cost: a proposal lands next evening, never within minutes. | Paco, 2026-10-21 |
| 2b-ii-R3 | Stated rule → lesson (parent §7.4 code rung) is **owned by `memory.kind`** (merged 2026-10-19). `improve.route` never saves a lesson from a stated rule; it records that signal as `nothing`. One owner per effect. | Claude, cost if wrong: a stated rule reaching `improve.route` without `memory.kind` having saved it is lost; the digest's Watch line counts corrections, which would show it |
| 2b-ii-R4 | Signals with no producer and no cheap source (`dig_deeper` has one; `lesson_unfollowed` needs a "followed" signal that does not exist, `applied_count` counts renders) are **recorded if they arrive, named as silent in the digest**, not built here. `rating` has a producer path (`processRatingSignal`) and is wired. | Claude, cost if wrong: a signal family stays dark; visible in the Watch line |
| 2b-ii-R5 | **Knowledge target stays recorded-only** while `HOUGE_WIKI_ENABLED` is unset (it is unset in `.env` today). Nothing is built on the wiki beyond the row and a digest line. Arming the wiki is Paco's `.env` edit and its own later slice. | Claude, cost if wrong: none now; a later slice adds the handler |
| 2b-ii-R6 | **Ladder target:** Accept writes a `ladder_moves` row (`granted_by: paco`, the callback id); no bar, judge or source changes automatically. A registry edit stays Paco's hand (protected surface). | Claude, cost if wrong: a proposal Paco accepts has no effect until a human edit; the digest lists active moves so it is not forgotten |
| 2b-ii-R7 | **Tool-gap target:** Accept replies with the exact `self_write_propose` focus text for Paco to send as his own message. The self-write runs on Paco's words (R12), never from a tap. | Claude, cost if wrong: one extra message from Paco |
| 2b-ii-R8 | **Jev bar:** provisional `p = 0.6` on `improve_target` until the sanity run (§9.3) sets it from 30 days of real signals before merge; the calibrated value amends this spec and the entry's `source` string, as 2b-i did (§3.3 there). | Claude, cost if wrong: too many or too few proposals for a few days; proposals are taps, never effects |

Out of scope: standing approvals (stage 4), the unsure-verdict review list (off by R1; `/status decisions` stays), the
wiki handler (R5), a per-signal background path (R2), `lesson_unfollowed` (R4).

## 1. What exists today (read at `61b8a5e`)

- **Entry machinery.** `Entry<S,V,D>` (`src/decisions/types.ts:62-88`): `ladder` of `rule` / `system_one` / `model`
  (`role: "tiny"|"fast"`) / `paco` rungs; `decide()` (`src/decisions/decide.ts:37`) returns `DecideResult` with
  `decisionId`; `storeRecorder` (`src/decisions/record.ts:38`) writes `decisions` rows (ids, enums, numbers only) and
  pages `decision_fallback` after three failures in an hour. `ENTRY_IDS` (`src/decisions/entry-ids.ts:5`) has seven
  entries; `improve.route` is not in it, and `review_*` outcome values are checked against it.
- **Signals.** `DECISION_SIGNALS` (`types.ts:20`) already lists all seventeen. `VALUE_CHECKS` (`src/decisions/outcomes.ts:29-40`)
  has `null` for `approval_denied`, `approval_expired`, `planner_failed`, `abandoned`, `lesson_unfollowed` (inserts refused).
  Writers today: `settle_*` (`src/omp/supervisor-settle.ts:69-107`), `review_ok|bad` (`src/gateway/decision-commands.ts:37`),
  `think_harder` (`core-worker.ts:2969`), `dig_deeper` (`src/gateway/memlane-commands.ts:67,69`), `lesson_undone`
  (`src/decisions/tap-outcomes.ts:36`). No writer for `correction`, `rating`, `recurrence`, `abandoned`, `review_unsure`.
- **Outcome store.** `insertDecisionOutcome({decision_id, signal, value, source})` (`run-store.ts:4801`) needs an existing
  decision; `listDecisionOutcomes(decision_id)` and `listTapOutcomes(since, entries)` are the only readers: **no query by
  signal and time** exists.
- **Correction sources.** `jev_verdicts.paco_correction` ∈ `ask_anyway | think_harder | escalation | low_rating`
  (`memlane-commands.ts:66`, `core-worker.ts:2967`, `core-worker.ts:2573`, `gateway.ts:1154`); the memory lane's `fix`
  verdict reaches `saveThenRoute` (`core-worker.ts:3256-3264`) as `handOff: "fix"` and the planner takes the turn;
  `markThinkHarder` (`core-worker.ts:2964`) is the template for "label the previous turn's decision".
- **Rating.** `processRatingSignal` (core-worker, called from `telegram-daemon.ts:~314`) handles Paco's ratings and
  `applyRatingToLessons`; it writes no outcome row.
- **Approvals.** Denial resolves in `processApprovalTrigger` → `approval_resolved` ledger event (`run-store.ts:6021`) via
  `gateway.handleApproval` (`gateway.ts:1000-1010`). Expiry: `bridge-handler.ts:361` calls `expireToolApproval` for both
  `expired` and `aborted` `WaitOutcome`s (the table cannot tell them apart; the outcome at `:361` can). The capability
  name is `tool_approvals.capability`.
- **Turn failure.** Every planner failure funnels through `CoreWorker.ompFail` (`core-worker.ts:2649`) → `finishRun({next:
  "failed", error_type})` (`run-store.ts:1951`) → ledger `run_failed{error_type}`. `error_type` is the `PlannerFailure`
  union (`planner_exit`, `turn_timeout`, `frame_idle`, `media_failed`, `lease_expired`, `merged_parent_failed`, …).
  Lease recovery (`core-worker.ts:2309`) fails runs without `ompFail`.
- **Tick loop.** The Telegram poll loop (`telegram-daemon.ts:272`) runs `runSignalPathTick` each cycle; `runModelTicks`
  (`:598`, memory, idea radar, schedules) precedes `runDigestTick` (`:562`). `runDecisionDigestTick` (`digest.ts:243`)
  is due once per local date at or after `HOUGE_DECISION_DIGEST_AT` (default `21:00`; `off` = never), latch row and
  message in one transaction. Sections today: Unsure, Counts, trust/noise, Bar stale, Health. Buttons:
  `NotificationButton{text,data}`, callback data ≤ 64 bytes; `enqueueUrgentCard(store,{chat_id,key,text})`
  (`src/decisions/urgent.ts`).
- **Callbacks.** `parseDecisionReviewCallback` (`telegram-command-parser.ts:338`, regex `^dec:rv:(dec_<uuid>):(ok|bad)$`);
  the adapter (`telegram-trigger-adapter.ts:257-274`) authorises the sender first, then parses approval, memory undo,
  memlane, review, selfwrite. `handleDecisionReview` (`decision-commands.ts`) runs under `oncePerTrigger`, requires the
  decision was offered within 7 days, and answers "Already handled." on a second tap or an unknown id.
- **Skills.** `SkillStore` (`src/skills/skill-store.ts:142`): `writeSkill` (regenerates `REGISTRY.md`), `writePending`
  (`_pending`, inert, no registry), `listPending`, `retireSkill`, `restoreSkill`, `listRetired`, `readRawSkill`,
  `stampVerification`. No `promotePending` / `dismissPending`. Authoring: `authorAndWriteSkill(claim, message, budget,
  verdict, origin)` (`core-worker.ts:1893`): writer `runLlm(claim, buildSkillAuthorQuestion(message, fedFile),
  SKILL_AUTHOR_DISCIPLINE, budget, "compose")` (one-shot, one `llm_answer` tool, no other tools), Gate B `verifySkill`
  through `anchorLlm()`, then `writeActiveSkill` or guided refine → `parkBlockedSkill` (writes `_pending` **and saves a
  lesson**). Gate A: `buildGateAQuestion` / `parseGateAVerdict` (`src/capabilities/skill-router.ts`). Evolution lane:
  `tryStartEvolutionPipeline({current:{run_id,tool,started_at}, capMs, run, onTimeout, onError, deliver})`
  (`src/core/evolution-lane.ts`), singleton, returns false when busy; its only caller delivers through
  `enqueueEvolutionReportNotification(run_id, …)`, which needs a run with a chat.
- **Memory.** `runMemoryWrite` (`core-worker.ts:2691`) is bound to a live turn (`ompTurns`); the distill
  (`src/capabilities/distill.ts`: `buildMemoryDistillQuestion({thread, prior, instruction, scope, kind?})`,
  `parseMemoryDistillResult` → `{kind, lesson?, avoid?, fact?, evidence?}`) runs on role `distill`; the save writes
  `lessons` + `lesson_changes` (Undo, `undoLessonChange`) and facts + `memory_changes` (`add`). Undo buttons:
  `memlaneUndoButton(change_id)` / `memoryUndoButtons` (`src/core/memory-lane-card.ts`).
- **Schedules.** `scheduled_tasks` (`run-store.ts:8486`); `updateScheduledTask({schedule_id, goal?, spec_json?, tz?,
  next_run_at?})` (`:5119`); `parseScheduleSpec` / `computeNextRunAt` (`src/run/schedule-spec.ts`); schedule-born runs
  have `runs.source = 'schedule'`.
- **Jev.** `ChoiceQuestion` (`src/jev/questions/types.ts:10`; `TREE_MEMORY_KIND` at `tree.ts:94` is the template, escape
  option first because jev-1.13 leans to the first option); `JevChoiceAnswer{choice, probabilities, confidence}`;
  daemon clients built as `telegram-daemon.ts:~527` (`createJevClient({apiKey, audit: store.llmAuditSink({correlation_id,
  role}), meteredBreached, retries: 0, timeoutMs})`); `LlmCallRole` (`run-store.ts:59`) is a closed union; `tickSeat`
  (`src/llm/registry.ts:157`) runs a one-shot on the ticks chain for any role not named in `seatChain`.
- **Embeddings.** `embedText(text, resolveEmbedConfig(env))` (`src/llm/embeddings.ts:37`, Ollama `embeddinggemma`, null on
  failure); `cosineSimilarity`, `float32ToBlob`, `blobToFloat32`; gate helpers in `src/run/relevance-gate.ts`
  (`resolveCosineGate(raw, fallback)`, `admit`). `chat_turns` has no embedding column and no turn-keyed table.
- **Docs.** ADR 0030 line 365 names `improve.route` as 2b-ii; `docs/reference/decision-map.md:116` is its row;
  `CONTEXT.md:75` "Ladder move" already says skill authoring after recurrence is a code-made move.

## 2. Signals and producers

Every signal is a `decision_outcomes` row (closed value set, `outcomes.ts`), hung on a decision of the turn it is about.
New value sets (a protected edit of `outcomes.ts`, with its pin tests):

| Signal | Producer (new unless noted) | Hung on | Value set |
|---|---|---|---|
| `correction` | (a) the memory lane's `fix` hand-off in `saveThenRoute` (`core-worker.ts:3256`): the **previous** turn of the chat (`latestJevVerdictForChat`, as `markThinkHarder` does; first correction wins) is the corrected one; (b) `paco_correction` writers `ask_anyway`, `escalation`, `low_rating` (each writes the same row once) | `decisionOf(prev.run_id, "turn.handler")` | `CORRECTION_VALUES` (exists): the corrected turn's `jev_verdicts.category`; `other` when null |
| `rating` | `processRatingSignal` after it applies the rating | the rated turn's `turn.handler` decision | 0–3 (exists) |
| `approval_denied` | `gateway.handleApproval` after `processApprovalTrigger` resolved `denied` | `decisionOf(run_id, "turn.trust") ?? decisionOf(run_id, "turn.handler")` | `CAPABILITY_NAME` = `/^[a-z][a-z0-9_]{0,39}$/` (the tool registry name) |
| `approval_expired` | `bridge-handler.ts:361` **only when `outcome === "expired"`** (an abort is not Paco's silence) | same | same |
| `planner_failed` | `CoreWorker.ompFail` after `finishRun` returned true | `decisionOf(run_id, "turn.handler") ?? decisionOf(run_id, "turn.gear")` | `PLANNER_FAILED_VALUES` = the `PlannerFailure` union names, pinned equal by test |
| `recurrence` | the tick (§3.3) | the tick's own `improve.route` decision for the cluster | 1–10 000 (exists) |
| `abandoned` | the tick (§3.4) | the tick's own `improve.route` decision | `DIG_DEEPER_VALUES` (lanes; exists as a list) |
| `review_unsure` | none (the digest no longer offers ✅/❌; R1) | — | entry id (exists) |
| `dig_deeper`, `think_harder`, `lesson_undone`, `settle_*`, `review_ok|bad` | existing writers, unchanged | as today | as today |
| `lesson_unfollowed` | none (R4) | — | lane list, defined so an insert is not refused |

Producers never throw into their caller (`recordTapOutcome`'s contract: catch, log `[improve] outcome skipped: <code>`).
A producer that finds no decision to hang on writes nothing and the tick counts it from the ledger (`run_failed` events
without a `planner_failed` outcome) as *unattached* in the digest's Watch line, so a silent producer is visible.

**Never a signal** (parent §7.4, lessons.md "a monitor must not observe its own output"): schedule-born runs
(`runs.source = 'schedule'`), the improvement jobs' own LLM calls (they have no run), the digest and its taps' delivery.

## 3. The daily tick

### 3.1 Placement and shape

`runImproveTick(options, store, now)` runs inside `runSignalPathTick` after `runModelTicks` and before `runDigestTick`,
once per local date when the digest is due (same `resolveDigestAt` clock; when the digest is `off`, the tick still runs
at `21:00` local so rows and jobs exist for `/status`; R1 note: Paco turns the digest on to see them). It takes the
daemon's stop signal and returns early between model calls (lessons.md 2026-10-02). A new table

```
improve_ticks(local_date TEXT PRIMARY KEY, started_at, finished_at, watermark_outcome_id TEXT, result TEXT CHECK(done|stopped|failed), detail_json)
```

latches a date; the watermark is the last `decision_outcomes.outcome_id` consumed (ids are time-ordered uuids v7 as the
store issues them; verified in the plan). A missed day (daemon down at 21:00) runs at the next loop cycle after the due
time and consumes everything since the watermark: nothing is skipped, nothing is read twice.

### 3.2 Input and grouping

New reader `listDecisionOutcomesSince(after_outcome_id, limit)` joins `decision_outcomes` with `decisions` (entry, run,
created_at) and `runs` (`source`, `chat_id`). Rows from schedule-born runs are dropped. Rows are grouped by
**(signal, scope)** where scope is: the category for `correction`, `rating`, `think_harder`, `dig_deeper`; the capability
for `approval_*`; the failure kind for `planner_failed`; the reason for `settle_*`; the entry id for `review_*`. One
`improve.route` decision per group (`run_id` = the group's newest run, so `/status decisions` shows it; the run id is
not a parent lease, nothing dispatches). Groups are capped at 40 per tick; the rest wait for tomorrow (counted).

### 3.3 Recurrence

Recurrence (parent §7.4, R4): **3 or more Telegram turns from Paco in 14 days, same `turn.handler` category, request
cosine ≥ the relevance gate**, schedule-born runs excluded. Steps:

1. Candidate turns: `chat_turns` rows with `role = 'user'` joined to `runs.source = 'telegram'` and a `jev_verdicts`
   category in the last 14 days (the window is read each tick; nothing is stored across days except embeddings).
2. Embeddings: a new table `turn_embeddings(turn_id TEXT PRIMARY KEY, model TEXT, embedding BLOB, created_at)` filled
   lazily by the tick for candidate turns that lack one (text capped at 1 500 chars before embedding, the
   `THREAD_TEXT_CHAR_CAP`). `embedText` null (Ollama down) → the tick records `detail_json.embed_unavailable = n` and
   skips recurrence and abandonment for the day; the Watch line says so.
3. Per category, single-linkage clusters at cosine ≥ `HOUGE_RECURRENCE_COSINE_GATE` (default the episodic retrieval
   gate's value, `resolveCosineGate` with the same fallback; one number, documented in `configuration.md`). A cluster of
   ≥ 3 turns is a recurrence; its **cluster id** is `rec_<sha256(category + sorted turn ids)[0:16]>`, and its
   **idempotency key** is `category + the earliest turn id` (stable as the cluster grows).
4. A cluster whose idempotency key has an `improvement_jobs` row younger than 30 days, or whose request matches an
   active skill by Gate A anchors (`skillStore.list()` word-boundary match, as `authorAndWriteSkill` step 0 does), is
   recorded (`recurrence` outcome, verdict `nothing`, reason `already_authored` / `skill_exists`) and starts nothing.

### 3.4 Abandonment

`abandoned`: Paco's user turn B arrives within 10 minutes after Houge's reply to his turn A in the same chat, B's cosine to
A ≥ the same gate, and B's run did not route to the memory lane (a "记下来" after a reply is a save, not a re-ask) and
is not a bare ack (`intake.bare_ack`). Value: A's lane (`jev_verdicts.lane`). One row per (A, B) pair; the pair key
(`A.turn_id`) is kept in the tick's `detail_json` for the day only, so a B seen yesterday is not recounted.

### 3.5 Rate and cost

Per tick: at most 40 groups, at most one Jev call per group (`improve_target`), at most one Tiny call per group below the
bar, at most **3 automatic effects a day** (skill jobs started; the rest of the clusters record `deferred_rate` and
try tomorrow). Expected volume from the 2b-i sanity window: 5–15 signals a day → 3–8 groups, under TypeSafe's limits
at 10× (parent P5).

## 4. The entry

### 4.1 Registration

`improve.route` joins `ENTRY_IDS`, `REGISTRY`, `decision-map.md`; `src/decisions/entries/improve-route.ts` (protected).
`stage: "after_turn"` (a new `DecisionStage` value, added to the `decisions.stage` CHECK by migration), `input: "mixed"`
(signals come from Paco's taps and from tool-born events), `alwaysRecord: true`, `fail: "nothing"`, `defaultVerdict:
"nothing"`, `monotone: undefined` (targets are not ordered; R12 holds because no Jev/Tiny verdict causes an effect).

### 4.2 State

```ts
interface ImproveState {
  signal: DecisionSignal; scope: string; count: number; count14d: number;   // this group today; same (signal, scope) in 14 days
  category: Category | null; lane: Lane | null; capability: string | null;
  pacoText: string;            // the newest signal turn's Paco text, redactForJudge, ≤ 500 chars (R11: Paco's own words)
  toolSummary: string;         // code-built: tool names and counts of that turn, never tool text (as settle's toolSummary)
  lastImprovement: { target: ImproveTarget; ageDays: number } | null;   // the newest accepted proposal or job on this scope
  recurrence: { clusterId: string; turnIds: string[]; idempotencyKey: string } | null;
  skillExists: boolean; wikiArmed: boolean; scheduleHint: { schedule_id: string; hour: number } | null;
  redacted: { pacoText: string };  // the only text the Jev rung may read
}
type ImproveTarget = "nothing" | "lesson" | "fact" | "skill" | "schedule" | "knowledge" | "tool_gap" | "ladder";
```

Verdicts = `ImproveTarget`. Reason codes: `stated_rule_owned`, `recurrence`, `recurrence_lookup`, `already_authored`,
`skill_exists`, `expiry_pattern`, `deferred_rate`, `wiki_disarmed`, `jev_choice`, `tiny_pick`, `below_bar`,
`no_text`, `lane_busy`.

### 4.3 Rungs

1. **Rule** (exact maps, in order; the first that fires decides):
   - a `correction` group whose correcting run (Paco's message) has a `memory_save_triggers` row: `memory.kind` saved
     the stated rule already → `nothing` / `stated_rule_owned` (R3).
   - `recurrence` with `category ∈ {lookup, research}` → `knowledge` / `recurrence_lookup` (proposal when `wikiArmed`;
     recorded with `wiki_disarmed` otherwise, R5).
   - `recurrence` otherwise → **`skill_job`** / `recurrence` (a verdict of its own, reached only here) → **effect:**
     `startSkillJob` (§5.2); `already_authored`, `skill_exists` or a spent daily budget (`deferred_rate`) give `nothing`
     with that reason instead.
   - `approval_expired` with `scheduleHint` (two expiries of the same capability in schedule-born runs at the same local
     hour within 14 days; the schedule is the run's `scheduled_tasks` row) → `schedule` / `expiry_pattern` → proposal
     (§5.5).
   - a group with empty `pacoText` and no recurrence (e.g. `planner_failed` on a turn whose text was pruned) → `nothing`
     / `no_text`: Jev has nothing to read.
   - otherwise abstain.
2. **Jev** `system_one`: one `choice` question `improve_target` (`src/jev/questions/improve.ts`), options in this order
   (escape first): `nothing, lesson, fact, skill, schedule, knowledge, tool_gap, ladder`; instructions name Houge, the
   signal, the scope, the counts, `last_improvement`, the tool summary and Paco's redacted text, and ask "what, if
   anything, should Houge change so this signal does not recur?"; criteria one line per option (the parent table's
   wording). Options that cannot apply are **removed from the question before the call** (`knowledge` when the wiki is
   disarmed, `skill` when `skillExists` or `recurrence === null`, `schedule` when `scheduleHint === null`), so Jev never
   picks a target the handler cannot take. State sent: the `ImproveState` minus `pacoText` plus `redacted.pacoText`
   (built through `buildTreeState`-style redaction, the 2b-i settle precedent: `redactForJudge` with the turn's
   `extracted` codes and links, one function for every egress path, lessons.md). Bar: `IMPROVE_BAR` provisional `p =
   0.6` (R8), `recordedP: "improve_target"`, timeout 1 500 ms client + 500 ms outer. Answer: the top option when its
   probability ≥ bar → that target / `jev_choice`; else abstain with `detail.top2`.
3. **Model** `{kind: "model", role: "tiny"}`: below the bar, `tickSeat(store, "improve", "improve_pick", env, chains)`
   (new `LlmCallRole` `improve_pick`, ticks chain) asks for **one word among Jev's top two** with the same redacted state
   rendered as text; 8 s bound; an answer that is not one of the two → abstain. Verdict / `tiny_pick`.
4. **Fail:** `nothing`.

Verdicts = `ImproveTarget | "skill_job"`. Jev and Tiny verdicts other than `nothing` create a **proposal** (§5.1) and no
effect; a Jev/Tiny `skill` verdict is a proposal whose Accept starts the job. Effects (`effects` map): `skill_job` =
`{kind: "effect", reversible: true, announced: "card", what: "authoring on the evolution lane into _pending; a card
asks to promote"}`; every target other than `nothing` = `{kind: "proposal", reversible: true, announced: "card"}`;
`nothing` = none. `registry.ts`'s R12 check passes because `skill_job` is never an option of the Jev question or the
Tiny pick (a test asserts the question's option list and the pick parser both exclude it).

### 4.4 Recording and outcomes

`outcomes: ["recurrence", "abandoned", "review_ok", "review_bad", "review_unsure", "lesson_undone"]`. The tick writes
the `recurrence` / `abandoned` rows on the entry's own decision (§2). `JEV_PAGED_ELSEWHERE` does not include it: a Jev
failure counts toward `decision_fallback:improve.route` as usual (three in an hour page; a tick makes at most 40 calls,
so a dead Jev pages once per tick day and the tick continues on `fail`).

## 5. Targets and handlers

### 5.1 Proposals

```
improvement_proposals(proposal_id TEXT PK, decision_id TEXT NOT NULL REFERENCES decisions, target TEXT CHECK(lesson|fact|skill|schedule|knowledge|tool_gap|ladder),
  scope TEXT, draft_json TEXT NOT NULL, state TEXT CHECK(open|accepted|dismissed|expired) DEFAULT 'open', created_at, resolved_at, paco_callback_id TEXT UNIQUE)
```

`draft_json` holds what the handler needs, code-built: lesson `{scope, text, avoid?}`; fact `{text, source_turn_ids}`;
skill `{origin: {turn_ids, category}}`; schedule `{schedule_id, spec_json, tz, hour_from, hour_to}`; knowledge
`{topic}`; tool_gap `{focus}`; ladder `{entry_id, move}`. Drafting for lesson and fact runs **at proposal time** through
the distill (`buildMemoryDistillQuestion({thread: [Paco's correction text], prior: the corrected reply's text, instruction:
Paco's text, scope, kind})` on `tickSeat(…, "distill")`): Paco's own words plus Houge's own reply, the memory lane's trust
anchor; a `failed: "parse"` or empty draft records the proposal as `nothing` / `no_text` instead of showing an empty
card. One open proposal per (target, scope): a second one on the same scope is recorded `nothing` with reason
`already_proposed` (new reason code). Open proposals older than 14 days become `expired` at the next tick, silently.

Callbacks `dec:pr:<proposal_id>:acc|dis` (≤ 64 bytes; `pr_` + uuid), parsed by `parseImprovementCallback` after the
sender allowlist, as `dec:rv:` is; handled in `src/gateway/improvement-commands.ts` under `oncePerTrigger`: a tap on a
non-`open` proposal, an unknown id, or an id older than 14 days answers "Already handled." and writes nothing. Accept
runs the handler **inside the same transaction as the state change** where the handler is a store write (lesson, fact,
schedule, ladder); for `skill` and `tool_gap` the state changes first and the effect follows (a crash leaves `accepted`
with no job: the next tick's `reconcileAccepted` starts it, idempotent on `proposal_id`).

### 5.2 Skill: the authoring job

```
improvement_jobs(job_id TEXT PK, kind TEXT CHECK(skill_author), decision_id TEXT NOT NULL, proposal_id TEXT, origin_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, state TEXT CHECK(queued|running|pending_review|promoting|promoted|dismissed|failed), result_code TEXT,
  pending_scope TEXT, pending_name TEXT, created_at, started_at, finished_at, resolved_at, paco_callback_id TEXT UNIQUE)
```

`origin_json` = `{turn_ids, run_ids, category, text_hashes}`; the texts are re-read from `chat_turns` when the job runs
(never stored twice). **No runs row** (parent §7.4: an expired lease would dispatch it as a turn). `startSkillJob(origin)`
inserts `queued` and calls `tryStartEvolutionPipeline({current: {run_id: job_id, tool: "skill_author", started_at}, capMs:
compileSkillAuthorContract(objective).budget.time_minutes × 60 000, run: () => authorPendingSkill(job), …, deliver})`;
`false` (lane busy) → `lane_busy`, state stays `queued`, retried next tick (a `queued` job older than 3 days → `failed` /
`lane_busy`). `deliver` enqueues the urgent card through `enqueueNotification` with `idempotency_key: improve_job:<job_id>:<state>`
(not `enqueueEvolutionReportNotification`, which needs a run with a chat; the chat is the operator chat).

`authorPendingSkill(job)` (new, `src/core/skill-job.ts`, claim-less):
- objective = Paco's request texts of the cluster joined (≤ 6 turns, `THREAD_USER_TURN_CAP`; ≤ 1 500 chars each), **never
  tool output or Houge's replies**;
- Gate A over the objective (`buildGateAQuestion`, `parseGateAVerdict`) on `tickSeat(…, "classify")`; `retire|restore|
  lesson|code|unsure` → the job finishes `pending_review` with no file and the card lists the verdict as a suggestion
  (parent: "never saves a lesson, never retires or restores");
- the writer: `buildSkillAuthorQuestion(objective, fedFile)` with `SKILL_AUTHOR_DISCIPLINE` on `tickSeat(…, "compose")`
  (one-shot, no tools; `fedFile` = the one active skill the objective names, as step 0 does), up to 2 attempts,
  `parseAuthoredSkill`;
- Gate B `verifySkill` through the daemon's `anchorLlm`; the score is stamped into the draft's frontmatter;
- **writes only `skillStore.writePending(scope, name, body)`**, whatever the gates said; `pending_scope/name` recorded;
  state `pending_review`; the urgent card: "Skill drafted from N requests about <category>: <name> (Gate B <score>)
  [Accept] [Dismiss]" with `dec:sk:<job_id>:accept|dismiss` buttons.
- The plan extracts the writer + Gate B steps of `authorAndWriteSkill` into a function both callers use (`draftSkill`),
  so the commanded path's behaviour is unchanged (its tests stay green).

`SkillStore.promotePending(scope, name): {ok: true, path} | {ok: false, error: "collision" | "missing"}`: atomic
`rename` of `_pending/<scope>/<name>.md` into the active tree, then `regenerateRegistry()`. On `collision` the card
offers "replace" (`retireSkill(old, {by: "paco", supersededBy: name})` then promote) or "keep both" (`-2` suffix).
`dismissPending(scope, name)` moves it to `_retired`. Order on Accept (parent, codex W33): write the active copy,
regenerate the registry, unlink the pending copy, mark `promoted`; a crash leaves `promoting`, which the next tick
retries idempotently (an identical active copy counts as written). Both taps are one-shot ("already handled").

### 5.3 Lesson and fact

Accept saves through the **memory lane's own store writes**: the plan extracts `saveMemoryForTurn`'s store section into
`saveMemoryPlan(store, plan, {run_id: origin run, chat_id, source: "improve"})` returning the change ids, so the lesson row
+ `lesson_changes` Undo and the fact row + `memory_changes` `add` are written exactly as a lane save, under the origin
turn's run id (Undo and `recordSaveUndone` work unchanged; `lessons.source` gains `improve`). Caps apply
(`resolveSkillMaxPerScope`'s sibling for lessons, `LESSON_CAPPED_HINT`); a capped save answers the tap with the hint. The
digest's *Improvements today* line for it carries the Undo button (`memlaneUndoButton`, `memoryUndoButton`).

### 5.4 Knowledge (R5)

`wikiArmed = resolveWikiEnabled(env)`. Disarmed: the decision records `knowledge` / `wiki_disarmed`, no proposal; the
Watch line: "wiki disarmed: N recurring lookup topics". Armed: a proposal "keep a page on <topic>?" whose Accept
writes `wiki_topics_wanted(topic, created_at)` (new, tiny) and the planner prompt renders wanted topics as one line
("Paco asked to keep a page on: …; call wiki_build when you research it"). Only that line is built here; the plan
includes it only if the wiki is armed at build time, else the table and line wait (recorded in the ADR as deferred).

### 5.5 Schedule

The hint: two `approval_expired` rows for one capability on schedule-born runs of one `schedule_id` at the same local
hour within 14 days. Proposal: "<goal> asks for <capability> at HH:00 and you were not there twice; move it to <H2>:00?"
where H2 = the median local hour of Paco's own Telegram turns over 14 days (code-built; ties → the later hour). Accept
→ `updateScheduledTask({schedule_id, spec_json: the spec with its hour replaced, tz, next_run_at: computeNextRunAt})`;
a spec the shifter cannot parse (not a daily/weekly time spec) records the proposal as `nothing` / `no_text` instead of
offering it.

### 5.6 Tool gap (R7) and ladder (R6)

Tool gap: the proposal line shows the code-built focus ("<category> turns fail on <capability>/<failure kind> N times");
Accept answers with `Send this to start a self-write: self_write_propose focus="…"` and marks `accepted`. Ladder: the
proposal names the move (`trust_source <host>` for a `tool.injection` scope, `retire_judge <entry>` for three
`review_bad` on one entry, `lower_bar <entry>` for repeated `review_bad` on unsure rows); Accept inserts
`ladder_moves({entry_id, scope, from_rung, to_rung, evidence_json, granted_by: "paco", granted_via: "improve.route",
paco_callback_id})` (locked entries refused by the store; the proposal is never built for them). Effect: none automatic;
the digest's *Improvements today* lists the move with a Revoke button (`dec:lm:<move_id>:revoke` → `state = ended`,
new `endLadderMove`).

## 6. Surface

### 6.1 Digest (R1)

`buildDecisionDigest` is rebuilt as three sections, in order, each skipped when empty; the message is skipped when all
three are empty:

1. **Improvements today** — automatic effects and accepted proposals since the last digest: "skill <name> drafted from
   N requests [Accept] [Dismiss]" (a `pending_review` job), "lesson saved: <text ≤ 80> [Undo]", "fact saved [Undo]",
   "schedule <goal> moved to H2:00 [Revert]" (`dec:pr:<id>:rev` restores the stored previous spec), "ladder move <…>
   [Revoke]".
2. **Proposals waiting** — up to 8 open proposals, oldest first, each one line with its draft (≤ 120 chars, redacted)
   and [Accept] [Dismiss]; a ninth and later are counted ("+N more").
3. **Watch** — one line each, 7-day numbers: corrections · abandoned · clarify rate (assistant turns `intent = clarify`
   over all assistant turns, the A27 cap stays) · unattached signals · deferred (rate limit) · silent signals
   (`review_unsure`, `lesson_unfollowed`, and `dig_deeper` if zero in 7 days) · "wiki disarmed: N topics" · "embeddings
   unavailable: N days".

The unsure list, counts, trust/noise, bar-stale and Health sections are removed from the digest (Health conditions
still page as incidents; stale bars still page `decision_bar_stale`; `/status` keeps the counts). `offered_json` keeps
listing the proposal ids offered, so a tap on a never-offered id is refused.

### 6.2 Urgent cards

Sent at once through the outbox: skill authoring started ("drafting a skill from N requests about <category>"),
finished (the Accept/Dismiss card), failed (`result_code`, no text from the model). As parent §8.2.

### 6.3 One-shot and allowlist

All new callbacks (`dec:pr:`, `dec:sk:`, `dec:lm:`) pass `authorizeTelegramUpdate` first (adapter chain after
`dec:rv:`), run under `oncePerTrigger`, and answer "Already handled." on a second tap, an unknown, stale (> 14 days) or
never-offered id, writing nothing. `TaskEventType` gains `improvement_tap`; `RATE_LIMIT_EXEMPT` includes it as
`decision_review` is.

## 7. Measurement, safety, limits

- **Each improvement is a decision row** (the entry's), and its outcome is the signal's recurrence: the tick writes a
  `recurrence`-style check for accepted proposals: a `correction` on a scope that got a lesson within 30 days writes
  `lesson_unfollowed`-like evidence as a Watch line "lesson <id> did not hold (N corrections since)" and a proposal to
  rewrite or retire it (target `lesson`, scope the same, draft from the newest correction). Skills: `skill-reverify.ts`
  as today. Ladder moves: revocations counted. Proposals: accepted / dismissed / expired counts in `/status decisions`.
- **Pattern before change** (parent rule 1): the only automatic effect is the recurrence → `_pending` draft, after ≥ 3
  turns; a single signal is recorded only.
- **Locked entries and protected files are never targets**: `LOCKED_ENTRY_IDS` are refused by the store for ladder moves
  and never named in a proposal; skills are files under `skills/`, never `src/`.
- **Authoring input is Paco's words only**, the writer is one-shot without tools; the injection test (§9.1) plants
  `ignore previous instructions` in a recurring turn's tool output and asserts the draft and every prompt the job sent
  never contain it.
- **Rate:** 3 automatic effects a day; 40 groups a tick; 8 proposals shown; one open proposal per (target, scope); one job
  per cluster per 30 days.
- **Egress:** Jev reads `redacted.pacoText` only (Paco's own words, through `redactForJudge` with the turn's extracted
  codes and links); Tiny reads the same; the digest shows drafts through the same redactor; tool text never leaves.

## 8. Probes before code (the spec review runs these against the live system)

| # | Probe | Expect |
|---|---|---|
| P1 | On a `VACUUM INTO` copy: `jev_verdicts.category` values over 30 days against `CORRECTION_VALUES`; `paco_correction` counts by value; `run_failed` `error_type` values | every category is in the list; the failure kinds are the `PlannerFailure` union |
| P2 | Ollama `embeddinggemma` reachable from the daemon's env; embed 14 days of Paco's Telegram request texts; cluster at the episodic gate | the number of clusters ≥ 3 per category (predicts job volume); the gate value to document |
| P3 | `tool_approvals` expiries over 30 days by capability and local hour, schedule-born only | whether §5.5 would ever fire; if never, the schedule target ships recorded-only |
| P4 | `tryStartEvolutionPipeline` called with a `job:` run id and a `deliver` that enqueues to the outbox: the lane claims and releases; `evolutionLaneSnapshot` shows it | works without a run; the busy refusal is observed by starting it twice |
| P5 | `skillStore.writePending` under omp: a `_pending` draft is absent from the planner prompt and `REGISTRY.md`; `promotePending` prototype: rename + regenerate shows it | inert until promoted |
| P6 | Jev `improve_target` over 20 real signal groups from the copy (dry run of §9.3) | answers parse; the top-option probability distribution supports a 0.6 bar or says what to set |
| P7 | `decision_outcomes.outcome_id` ordering: ids issued by the store are time-ordered | the watermark is sound; else the tick uses `created_at` + id |

## 9. Gate, tests, sanity, rollback, docs

### 9.1 Tests (hermetic)

Per producer (each writes its row on the right decision, never throws, skips schedule-born runs, `approval_expired` not
on abort); `outcomes.ts` pins (`PLANNER_FAILED_VALUES` equals the `PlannerFailure` union; capability regex); tick:
watermark and catch-up, grouping, 40-cap, recurrence clustering with a fake embedder (3 turns → one cluster, 2 → none,
a second tick → `already_authored`, 30-day key), abandonment pairs, embed-down day; entry: rule order, option removal
before the Jev call, bar, Tiny pick parsing, `nothing` on fail, R12 registry check; proposals: one per scope, expiry,
one-shot taps, never-offered id refused; job: `authorPendingSkill` writes only `_pending`, never a lesson, never retires;
`promotePending` atomic (collision → replace / keep both), crash between steps retried; the injection test (§7);
digest: three sections only, empty → skipped, drafts redacted, button data ≤ 64 bytes; schedule shift on a daily spec and
refusal on an unparseable one; rate limit; stop signal between model calls.

### 9.2 Live gate `scripts/live-gate-improve-route.mjs`

From a built worktree, `HOUGE_ENV_FILE` + `--db` (the gate refuses the main checkout), on a `VACUUM INTO` copy, real Jev,
a temp skills root (never `skills/` of the checkout), the ticks chain for Tiny/distill/writer, outbox read back from the
copy. PASS requires every case and the silent-degradation checks:

| Case | Plant | PASS |
|---|---|---|
| 1 recurrence | 3 Telegram-born user turns, one category, near-identical requests, in 14 days | tick → `recurrence` row, `improve.route` verdict `skill` / `recurrence`, job `pending_review`, a `_pending` draft file, the urgent card in the outbox with `dec:sk:` buttons |
| 2 promote | Accept callback on case 1 | the draft is in the active tree, `REGISTRY.md` names it, `_pending` copy gone, job `promoted`; a second tap → "Already handled." |
| 3 correction | a `fix`-routed turn after a reply (planted rows as the memory-write gate plants them) | `correction` row on the previous turn's `turn.handler` decision; `improve.route` row; a Jev or Tiny verdict; if `lesson`, a proposal with a non-empty redacted draft |
| 4 accept lesson | Accept on case 3's proposal | lesson row with `source = improve`, `lesson_changes` Undo row, *Improvements today* line with Undo |
| 5 schedule | two expired approvals, same capability, schedule-born runs of one schedule, same hour | proposal `schedule` with H2; Accept → `scheduled_tasks.spec_json` shifted, `next_run_at` recomputed; Revert restores |
| 6 digest | after cases 1–5 | exactly the three sections, nothing from the old digest, every button's data ≤ 64 bytes, no draft text contains the planted `sk-` token |
| 7 injection | case 1's turns carry a tool result with `ignore previous instructions`; the daemon temp dir holds it | the draft file and every `llm_calls` prompt row of the job lack the phrase |
| 8 idempotency and rate | run the tick twice; plant 4 clusters | no second job; 3 jobs started, the 4th `deferred_rate` |
| 9 silent degradation | every outcome row in the window has an `improve.route` decision or is counted unattached; every job state transition has a ledger event; Jev fallback count = 0 on the day | |

A planner-side outage or Ollama down makes a case INCONCLUSIVE, never PASS (lessons.md: preconditions, counts).

### 9.3 Sanity `scripts/improve-sanity.mjs`

Mirrors `settle-sanity.mjs` (worktree-only, `VACUUM INTO`, `--db`, `--days 30`, planted-token check on its own output,
redacted samples): rebuilds the last 30 days of signal groups from the copy, asks Jev `improve_target` for each, prints
the target distribution, the top-probability histogram, the proposals it would have made (20 samples, redacted), and
`PASS` when proposals/day ≤ 5 at the chosen bar. Its result sets `IMPROVE_BAR` (R8) before merge.

### 9.4 Rollback

Revert the merge, rebuild `dist/`, kickstart (R13). Tables are additive; `_pending` drafts are inert; open proposals
and jobs are rows nobody reads after a revert. `HOUGE_DECISION_DIGEST_AT=off` silences the surface without a revert.

### 9.5 Docs on ship

ADR 0030 amendment "stage 2b-ii" (rulings R1–R8, the surface change, the tables, the deferred targets) for Paco's
sign-off; ADR 0030 decision 8 unchanged; `decision-map.md` row → live; `jev-decision-layer.md` (the `improve_target`
question, bar); `configuration.md` (`HOUGE_RECURRENCE_COSINE_GATE`, the digest's new content, the new tables, the
`improve_pick` role); README (digest paragraph); `CONTEXT.md` terms **Proposal**, **Improvement job**; ROADMAP delta;
`tasks/todo.md` state block; `tasks/lessons.md`; `sessions.md`.

## 10. Risks

- **Few signals.** If corrections and failures are rare (2b-i sanity: 5–9 % send-backs on 135 replies; corrections
  unknown until P1), the tick records little and the digest is mostly empty; that is correct, not a defect. Revisit the
  bar after 14 days of rows.
- **Recurrence noise.** A category like `answer` is broad; the cosine gate does the work. P2 measures it before the
  gate value is fixed; the 30-day idempotency and the 3/day cap bound the damage of a loose gate to inert drafts.
- **Drafting cost.** One distill call per lesson/fact proposal on the ticks chain; bounded by 40 groups.
- **Ollama down** → no recurrence/abandonment that day, said in the Watch line; everything else runs.

## 11. Revisit when

- 14 days of rows: proposals/day, accept rate, `lesson did not hold` count → bar and gate.
- The wiki is armed → build §5.4's handler slice.
- A "followed" signal exists for lessons → `lesson_unfollowed` producer.
- Paco wants same-day proposals → R2's per-signal path.

## 12. Review log

(filled by the senior and codex passes)
