# Decision ladder stage 2b-ii: `improve.route` — design

**Status:** Rev 4, 2026-10-21 (Rev 1 + the senior review's probes + codex rounds 1–2, §12). Parent spec: [2026-10-12-decision-ladder-design.md](2026-10-12-decision-ladder-design.md) §7.4 (the
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
| 2b-ii-R9 | **Fact target handler:** an accepted fact proposal is saved through the memory lane's save writes (a fact row, a `memory_changes` `add` row, Undo), not through `memory_correct` as the parent table says: `memory_correct` corrects or retires an *existing* fact, and a proposal from a correction of a researched fact (parent: "refine") is the wiki's business (R5, deferred). Correcting an existing fact from `improve.route` is deferred with it. | Claude, cost if wrong: a correction of a stored fact gets a new fact beside the old one instead of a correction; Undo and the memory lane's `memory_correct` tool still fix it by hand |
| 2b-ii-R10 | **Model-route proposals** (parent §8.1 "model routes") are deferred: routes are `turn.gear`'s territory (stage 3 migration of the supervision families); the `ladder` target covers bars, judges and sources. | Claude, cost if wrong: one proposal class missing from the digest until stage 3 |
| 2b-ii-R11 | **Schedule-born runs are never a signal, with one exemption:** `approval_expired` on a schedule-born run is the schedule target's only evidence (§5.5), so it is recorded; `correction`, recurrence and abandonment never count schedule-born runs (the parent's rule). | Claude, cost if wrong: none beyond §5.5's own proposals, which are taps |

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

Two kinds of signal rows feed the tick:

- **Existing `decision_outcomes` rows** (`settle_*`, `review_ok|bad`, `think_harder`, `dig_deeper`, `lesson_undone`):
  written as today on the decision they label.
- **New producers write an inbox row**, never a `decision_outcomes` row (senior review B2: an outcome needs an existing
  decision, and a failed run or a pre-ladder turn may have none; writing to the inbox never depends on another entry's
  recording rule):

```
improve_signals(signal_id INTEGER PRIMARY KEY AUTOINCREMENT, signal TEXT NOT NULL, value TEXT NOT NULL, run_id TEXT, chat_id TEXT,
  about_run_id TEXT, created_at TEXT NOT NULL, consumed_at TEXT)
```

`value` is checked by `checkOutcomeValue` at insert (the same closed sets; new sets below are a protected edit of
`outcomes.ts` with pin tests). The tick turns each consumed inbox row into a `decision_outcomes` row on the `improve.route`
decision of its group (`source: "code"`), so every signal ends as an outcome row and `/status decisions` sees it.

| Signal | Producer (new unless noted) | `about_run_id` | Value set |
|---|---|---|---|
| `correction` | (a) the memory lane's `fix` hand-off in `saveThenRoute` (`core-worker.ts:3256`): the **previous** turn of the chat (`latestJevVerdictForChat`, as `markThinkHarder` does; first correction wins) is the corrected one; (b) `paco_correction` writers `ask_anyway`, `escalation`, `low_rating` (each writes one inbox row) | the corrected run | `CORRECTION_VALUES` (exists): the corrected turn's `jev_verdicts.category`; `other` when null (P1: 6 of 32 verdicts in 30 days have no category) |
| `rating` | **at rating capture** in the gateway (`gateway.ts:372-379`, before `processRatingSignal`, which returns early for ratings above 1 and receives no run id): `about_run_id` = `latestJevVerdictForChat(chat_id, now).run_id`; none → an `improve_signal_skipped` event, no row | the chat's latest planner run | 0–3 (exists) |
| `approval_denied` | `gateway.handleApproval` after `processApprovalTrigger` resolved `denied` | the run | `CAPABILITY_NAME` = `/^[a-z][a-z0-9_]{0,39}$/` (the tool registry name) |
| `approval_expired` | `bridge-handler.ts:361` **only when `outcome === "expired"`** (an abort is not Paco's silence) | the run | same |
| `planner_failed` | **inside `RunStore.finishRun`** when `next === "failed"` and the run's `source` is `telegram`: the store inserts the inbox row in the same statement batch as the `run_failed` ledger event, so every failure path (`ompFail`, `recoverPlannerLeases`, `failStrandedTurns`, `refuseOmpTurn` at `core-worker.ts:2343`, any later one) is covered without a seam list (codex F4, round 2) | the run | `PLANNER_FAILED_VALUES` = the `error_type` strings `finishRun` is called with: the `PlannerFailure` union plus `model_error`, `killed` (P1: 30 days show `planner_exit`, `merged_parent_failed`, `model_error`, `killed`); unknown → `other`; pinned by a test that greps every `finishRun({next: "failed"` call's literal |
| `recurrence` | the tick (§3.3) | the cluster's newest run | 1–10 000 (exists) |
| `abandoned` | the tick (§3.4) | A's run | `DIG_DEEPER_VALUES` (lanes; exists as a list) |
| `review_unsure` | none (the digest no longer offers ✅/❌; R1) | — | entry id (exists) |
| `lesson_unfollowed` | none (R4) | — | lane list, defined so an insert is not refused |

Producers never throw into their caller (`recordTapOutcome`'s contract: catch, log `[improve] signal skipped: <code>`).
A producer that cannot insert (no run to attach, a refused value, a store error) writes a ledger event
`improve_signal_skipped{signal, code}` (`run_id` when known, else null) instead; the Watch line counts those events as
*unattached* per signal family, so a silent producer is visible for every family, not only failures (codex D14).

**Never a signal** (parent §7.4, lessons.md "a monitor must not observe its own output"): schedule-born runs
(`runs.source = 'schedule'`) except `approval_expired` (R11), the improvement jobs' own LLM calls (they have no run),
the digest and its taps' delivery, and `improve.route`'s own outcome rows (§3.2).

## 3. The daily tick

### 3.1 Placement and shape

`runImproveTick(options, store, now)` runs inside `runSignalPathTick` after `runModelTicks` and before `runDigestTick`,
once per local date when the digest is due (same `resolveDigestAt` clock; when the digest is `off`, the tick still runs
at `21:00` local so rows and jobs exist for `/status`; R1 note: Paco turns the digest on to see them). It takes the
daemon's stop signal and returns early between model calls (lessons.md 2026-10-02). A new table

```
improve_ticks(local_date TEXT PRIMARY KEY, started_at, finished_at, result TEXT CHECK(running|done|stopped|failed), detail_json)
improve_cursor(id INTEGER PRIMARY KEY CHECK(id = 1), outcome_created_at TEXT NOT NULL, outcome_rowid INTEGER NOT NULL)
```

**The inbox is the tick's only input** (codex round 2 N1). Step 1, the *mirror*: one transaction copies every
`decision_outcomes` row after the outcome cursor `(created_at, rowid)` (P7: `outcome_id` is `do_<uuid v4>`, random,
not a cursor) into `improve_signals` (`source_outcome_id` set; rows on `improve.route`'s own decisions and on
schedule-born runs other than `approval_expired` are skipped) and advances the cursor past the last row read. The
mirror reads rows in order and groups nothing, so the cursor never passes an unread row. Step 2 works on inbox rows
with `consumed_at IS NULL` (the oldest 500 per tick), grouped (§3.2); **a deferred group's rows stay unconsumed** and
are read again tomorrow (durable retry); a row unconsumed for 30 days is consumed as `nothing` / `stale`. **Commit
boundary** (codex D3): model calls (Jev, Tiny, distill) run outside any transaction; then **one transaction per group**
writes the decision row, its outcome rows (one per inbox row, `source: "code"`), the proposal or queued job, and
`consumed_at` on the group's rows. A crash mid-tick loses nothing: the next loop cycle finds the date latch `running`
and runs step 2 again over what is still unconsumed; committed groups are not redone. The date latch becomes `done` in
the last transaction. A missed day (daemon down at 21:00) runs at the next loop cycle after the due time. Ledger events
`improve_tick{phase: start|end, counts}` (`run_id` null) bracket every run, so a tick that died mid-way is visible.

### 3.2 Input and grouping

Readers: `listDecisionOutcomesAfter(cursor, limit)` for the mirror (joins `decision_outcomes` with `decisions` for
`entry_id`, `run_id` and with `runs` for `source`; **rows whose decision is `improve.route`'s own are excluded**, codex
D2) and `listUnconsumedSignals(limit)` for step 2. The chat of a row is the inbox row's `chat_id`, else the run's
`chat_turns.chat_id` (`runs` has no chat column, codex F3), else the operator chat (`allowlist.chats[0]`). Schedule-born
runs are dropped at the mirror except `approval_expired` (R11). Rows are grouped by **(signal, scope)** where scope is:
the category for `correction`, `think_harder`, `dig_deeper`; `category + value` for `rating` (a 0 and a 3 are not one
group, codex D13); the capability for `approval_*`; the failure kind for `planner_failed`; the reason for `settle_*`;
the entry id for `review_*`. One `improve.route` decision per group (`run_id` = the group's newest run, so `/status
decisions` shows it; the run id is not a parent lease, nothing dispatches).

### 3.3 Recurrence

Recurrence (parent §7.4, R4): **3 or more Telegram turns from Paco in 14 days, same `turn.handler` category, request
cosine ≥ the relevance gate**, schedule-born runs excluded. Steps:

1. Candidate turns: `chat_turns` rows with `role = 'user'`, `runs.source = 'telegram'`, **text ≥ 20 characters**, and a
   `jev_verdicts` category **not in `other`, `status`, `memory`** (P2: at the episodic gate 0.42 the short `other` turns
   of the last 14 days formed one 15-turn cluster: greetings and status asks are not a skill), in the last 14 days (the
   window is read each tick; nothing is stored across days except embeddings).
2. Embeddings: a new table `turn_embeddings(turn_id TEXT PRIMARY KEY, model TEXT, embedding BLOB, created_at)` filled
   lazily by the tick for candidate turns that lack one (text capped at `EMBED_TEXT_CHAR_CAP = 1_500` chars per turn,
   a constant of its own; `THREAD_TEXT_CHAR_CAP` is the memory lane's total thread budget, codex F7). `embedText` null (Ollama down) → the tick records `detail_json.embed_unavailable = n` and
   skips recurrence and abandonment for the day; the Watch line says so.
3. Per category, single-linkage clusters at cosine ≥ `HOUGE_RECURRENCE_COSINE_GATE` (`resolveCosineGate`, **default
   `0.6`**, not the episodic gate: P2 on the last 14 days gave 15-turn and 4-turn clusters at 0.42, four at 0.5, one
   at 0.6 and none at 0.7 over unfiltered turns, and none at any gate over the 14 filtered candidates; documented in
   `configuration.md`). A cluster of ≥ 3 turns is a recurrence; its **cluster id** is `rec_<sha256(category + sorted
   turn ids)[0:16]>`, and its **idempotency key** is `category + the earliest turn id` (stable as the cluster grows).
   **Volume today:** 44 Telegram user turns in 14 days, 14 candidates after the filters, no recurrence; the job path
   will fire rarely at this volume, which is correct (R4 stands; the live gate plants the pattern).
4. **Once per cluster** (codex D4): `improvement_jobs.idempotency_key` is unique for ever; the key is `category + the
   earliest turn id in the 14-day window`, so a cluster is authored once, and only after its root turn has left the
   window can a new cluster on the same topic (a new root) author again, at least 14 days later. A cluster that
   **shares any turn id** with a job younger than 30 days (`origin_json.turn_ids`, checked before insert; this covers
   single-linkage merges that change the root) is recorded (`recurrence` outcome, verdict `nothing`, reason
   `already_authored`) and starts nothing. So is one whose request matches an active skill by Gate A anchors
   (`skillStore.list()` word-boundary match, as `authorAndWriteSkill` step 0 does): `skill_exists`.

### 3.4 Abandonment

`abandoned`: Paco's user turn B arrives within 10 minutes after Houge's reply to his turn A in the same chat, B's cosine to
A ≥ the same gate, B is ≥ 20 characters (a bare ack or "ok" never counts; `chat_turns.intent` is not set on user turns,
P1), and B's run did not route to the memory lane (a "记下来" after a reply is a save, not a re-ask). Value: A's lane
(`jev_verdicts.lane`). One row per (A, B) pair; the pair key
(`A.turn_id`) is kept in the tick's `detail_json` for the day only, so a B seen yesterday is not recounted.

### 3.5 Rate and cost

Per tick: at most 40 groups get model calls, at most one Jev call per group (`improve_target`), at most one Tiny call
per group below the bar, at most **3 automatic effects a day** (skill jobs started). A group beyond the 40 or a cluster
beyond the 3 is **not consumed and gets no decision row** (its rows stay in the inbox, §3.1; `detail_json.deferred`
counts it; a `recurrence` cluster is recomputed tomorrow from the window anyway), so "try tomorrow" has durable input
(codex round 2 N1). Expected volume from the 2b-i sanity window: 5–15 signals a day → 3–8 groups, under TypeSafe's
limits at 10× (parent P5).

## 4. The entry

### 4.1 Registration

`improve.route` joins `ENTRY_IDS`, `REGISTRY`, `decision-map.md`; `src/decisions/entries/improve-route.ts` (protected).
`stage: "after_turn"` (already in `DecisionStage`, `types.ts:7`; the `decisions` table has no stage CHECK, so no
migration, codex F2), `input: "mixed"`
(signals come from Paco's taps and from tool-born events), `alwaysRecord: true`, `fail: "nothing"`, `defaultVerdict:
"nothing"`, `monotone: undefined` (targets are not ordered; R12 holds because no Jev/Tiny verdict causes an effect).

### 4.2 State

```ts
interface ImproveState {
  signal: DecisionSignal; value: string; scope: string; count: number; count14d: number;   // the checked signal value (a rating, a role, a reason); this group today; same (signal, scope) in 14 days
  category: Category | null; lane: Lane | null; capability: string | null;
  pacoText: string;            // the newest signal turn's Paco text, redacted (§7), ≤ 500 chars (R11: Paco's own words)
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
   wording). The question is **one fixed question** (one criteria hash, one bar; codex D15): every option is always
   offered, and the state carries `applicable: ImproveTarget[]` (`knowledge` only when the wiki is armed, `skill` only
   with a recurrence and no existing skill, `schedule` only with a hint) so the instructions say which targets Houge can
   act on today. **Masking after the answer** (codex round 2 N3): the verdict is the overall top option when it is
   applicable and its probability ≥ bar → that target / `jev_choice`; an inapplicable overall top option → abstain
   with reason `inapplicable_top` (probabilities sum to 1, so no runner-up can clear a 0.6 bar; the Watch line counts
   these, and a rising count means the instructions' "applicable today" list is not being read); an applicable top
   below the bar → abstain with `detail.top2` (the two best applicable options) for the Tiny rung. The row's `p` is the
   overall top option's probability (`recordedP: "improve_target"` names the question, as `turn.settle`'s names
   `settle`). State sent: the `ImproveState` minus `pacoText` plus `redacted.pacoText` (§7's durable redaction). Bar:
   `IMPROVE_BAR` provisional `p = 0.6` (R8), timeout 1 500 ms client + 500 ms outer.
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
  scope TEXT, draft_json TEXT NOT NULL, evidence TEXT NOT NULL, state TEXT CHECK(open|accepted|reverted|dismissed|expired) DEFAULT 'open',
  created_at, offered_at, resolved_at, paco_callback_id TEXT UNIQUE)
```

`draft_json` holds what the handler needs, code-built: lesson `{scope, text, avoid?}`; fact `{text, evidence: {line,
quote}, source_turn_ids}`; skill `{origin: {turn_ids, category}}`; schedule `{schedule_id, before: {spec_json, tz,
next_run_at}, after: {spec_json, tz, next_run_at}, hour_from, hour_to}`; tool_gap `{focus}`; ladder `{entry_id, move}`.
`evidence` is a code-built one-liner shown beside the draft (parent §8.1 "with its evidence", codex P3): "correction
on <date>, scope <category>", "3 requests over 9 days", "2 expiries at 11:00 (<dates>)". Drafting for lesson and fact
runs **at proposal time** through the distill (`buildMemoryDistillQuestion({thread: [Paco's correction text], prior,
instruction: Paco's text, scope, kind})` on `tickSeat(…, "distill")`), where **`prior`** is the corrected reply's text
through §7's redactor **only when that turn's `turn_trust_final` level was `clean`**, else empty (codex D11: a reply
can carry tool output; a clean turn's output was judged, the draft is reviewed by Paco before Accept, and the one-shot
distill has no tools; the injection test covers the draft). A **fact** draft needs the distill's `evidence.quote` to
occur in Paco's text (the memory lane's `factRefused: no_evidence` rule, codex D12), else no fact proposal. A `failed:
"parse"` or empty draft records the proposal as `nothing` / `no_text` instead of showing an empty card. One open
proposal per (target, scope): a second one on the same scope is recorded `nothing` with reason `already_proposed` (new
reason code). Open proposals older than 14 days become `expired` at the next tick, silently.

`offered_at` is set when the digest (or a card) carrying the proposal is enqueued, in the same transaction as the
outbox row (§6.1); a tap on a proposal with `offered_at` null answers "Already handled." (codex D9: no `offered_json`
list). **Tap history** (codex round 2 N4): `paco_callback_id` leaves the proposals and jobs tables; every handled tap is
a row of

```
improvement_taps(tap_id TEXT PK, subject_kind TEXT CHECK(proposal|job|move), subject_id TEXT NOT NULL, action TEXT NOT NULL,
  telegram_callback_id TEXT NOT NULL UNIQUE, result TEXT NOT NULL, created_at)
```

so Accept and a later Revert are two rows on one proposal. Callbacks `dec:pr:<proposal_id>:acc|dis|rev` (≤ 64 bytes;
`pr_` + uuid), parsed by `parseImprovementCallback` after the sender allowlist, as `dec:rv:` is; handled in
`src/gateway/improvement-commands.ts` under `oncePerTrigger`, whose replay is **per Telegram callback id** (a retried
delivery of the same tap gets the same stored result; that is correct: the same tap, the same answer): a *new* callback
id is never a replay and is checked against the current state. `acc` and `dis` act only on `open`; **`rev`** (schedule
only) acts only on `accepted` within 14 days of `resolved_at` and restores `before` (`updateScheduledTask`), state
`reverted` (codex D8). Any other state, an unknown id, or an id older than 14 days answers "Already handled." and
writes only the tap row. Accept runs the handler **inside the same transaction as the state
change** where the handler is a store write (lesson, fact, schedule, ladder); for `skill` and `tool_gap` the state
changes first and the effect follows (a crash leaves `accepted` with no job: the next tick's `reconcileAccepted` starts
it, idempotent on `proposal_id`).

### 5.2 Skill: the authoring job

```
improvement_jobs(job_id TEXT PK, kind TEXT CHECK(skill_author), decision_id TEXT NOT NULL, proposal_id TEXT, origin_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, attempt INTEGER NOT NULL DEFAULT 0,
  state TEXT CHECK(queued|running|pending_review|suggested|promoting|promoted|dismissed|failed), result_code TEXT, gate_a TEXT,
  pending_scope TEXT, pending_name TEXT, created_at, started_at, finished_at, offered_at, resolved_at, paco_callback_id TEXT UNIQUE)
```

`origin_json` = `{turn_ids, run_ids, category, text_hashes}`; the texts are re-read from `chat_turns` when the job runs
(never stored twice). **No runs row** (parent §7.4: an expired lease would dispatch it as a turn). `startSkillJob(origin)`
inserts `queued`; `runQueuedJob(job)` sets `running` with `attempt + 1` and calls `tryStartEvolutionPipeline({current:
{run_id: job_id, tool: "skill_author", started_at}, capMs: compileSkillAuthorContract(objective).budget.time_minutes ×
60 000, run: () => authorPendingSkill(job, attempt), onTimeout, onError, deliver})`; `false` (lane busy) → back to
`queued` / `lane_busy`, retried next tick (a `queued` job older than 3 days → `failed` / `lane_busy`).

**Restart, fencing and delivery** (codex D5, round 2 N2). The lane calls `deliver` exactly once, with whichever of
`run()`'s result, `onTimeout()`'s or `onError()`'s comes first (`evolution-lane.ts:84`). Each of the three ends with
**one fenced transition** `UPDATE improvement_jobs SET state = ?, … WHERE job_id = ? AND state = 'running' AND attempt = ?`:
`run()` → `pending_review` or `suggested` (after `writePending`, which itself runs only after a read that the fence
still holds); `onTimeout()` → `failed` / `timeout`; `onError()` → `failed` / `<error code>`. The transition that
updates one row is the one whose card is delivered; a transition that updates zero rows (the other side won) returns a
no-op outcome and the lane's deliver-once guard drops it. A late `run()` after a timeout therefore writes no state, no
file (its pre-write check fails), and no card; a `_pending` file written just before the timeout fence moved is
orphaned and swept by `reconcileJobs` (a pending file with no `pending_review` job → `_retired`). At boot,
`reconcileJobs` marks every `running` job `failed` / `daemon_restart` (the lane is an in-memory singleton; nothing
survives a restart) and enqueues the failed card; the cluster may author again only through a new job (same 30-day
turn-overlap rule, §3.3). `deliver` enqueues the card through `enqueueNotification` with `idempotency_key:
improve_job:<job_id>:<attempt>:<state>` (not `enqueueEvolutionReportNotification`, which needs a run with a chat; the
chat is the operator chat) and sets `offered_at` in the same transaction when the card carries buttons (§5.1's offer
rule; codex D9). Every transition writes a ledger event `improvement_job{job_id, from, to, attempt, result_code?}`
(`run_id` null).

`authorPendingSkill(job, attempt)` (new, `src/core/skill-job.ts`, claim-less):
- objective = Paco's request texts of the cluster joined (≤ 6 turns, `THREAD_USER_TURN_CAP`; `JOB_OBJECTIVE_CHAR_CAP =
  3_000` characters in total, newest turns kept; codex F7), **never tool output or Houge's replies**;
- Gate A over the objective (`buildGateAQuestion`, `parseGateAVerdict`) on `tickSeat(…, "classify")`; `retire|restore|
  lesson|code|unsure` → terminal state **`suggested`** (`gate_a` = the verdict), **no file**, and a card without
  promotion buttons that lists the verdict as a suggestion (parent: "never saves a lesson, never retires or restores";
  codex D6);
- the writer: `buildSkillAuthorQuestion(objective, fedFile)` with `SKILL_AUTHOR_DISCIPLINE` on `tickSeat(…, "compose")`
  (one-shot, no tools; `fedFile` = the one active skill the objective names, as step 0 does: active skills are
  Houge-authored and Paco-accepted files, so their text is in-house, codex D11), up to 2 attempts, `parseAuthoredSkill`;
- Gate B `verifySkill` through the daemon's `anchorLlm`; the score is stamped into the draft's frontmatter;
- **writes only `skillStore.writePending(scope, name, body)`**, whatever the gates said; `pending_scope/name` recorded;
  state `pending_review`; the urgent card: "Skill drafted from N requests about <category>: <name> (Gate B <score>)
  [Accept] [Dismiss]" with `dec:sk:<job_id>:accept|dismiss` buttons.
- The plan extracts the writer + Gate B steps of `authorAndWriteSkill` into a function both callers use (`draftSkill`),
  so the commanded path's behaviour is unchanged (its tests stay green).

**Promotion protocol** (one protocol, the parent's copy → rebuild → unlink; codex D7). `SkillStore.promotePending(scope,
name, o: {onCollision: "refuse" | "replace" | "keep_both", now})`: (1) read the pending file; (2) collision check on the
active tree: `refuse` → `{ok: false, error: "collision"}` and the card re-offers [Replace] [Keep both] (`dec:sk:<job>:
replace|keep`), `replace` → `retireSkill(scope, name, {date: now, by: "paco", supersededBy: name})` first (codex F6),
`keep_both` → the new name gets a `-2` suffix; (3) write the active copy (`writeSkill`, which regenerates the
registry); (4) unlink the pending copy; (5) the caller marks `promoted`. State `promoting` is set before (3); a crash
leaves `promoting`, which the next tick retries from (1): an identical active copy counts as (3) done, a missing
pending copy counts as (4) done. `dismissPending(scope, name)` moves the draft to `_retired`. Both taps are one-shot
("Already handled.").

### 5.3 Lesson and fact

Accept saves through the **memory lane's own store writes**: the plan extracts `saveMemoryForTurn`'s store section into
`saveMemoryPlan(store, plan, {run_id: origin run, chat_id, source: "improve"})` returning the change ids, so the lesson row
+ `lesson_changes` Undo and the fact row + `memory_changes` `add` are written exactly as a lane save, under the origin
turn's run id (Undo and `recordSaveUndone` work unchanged; `lessons.source` gains `improve`). Caps apply
(`resolveSkillMaxPerScope`'s sibling for lessons, `LESSON_CAPPED_HINT`); a capped save answers the tap with the hint. The
digest's *Improvements today* line for it carries the Undo button (`memlaneUndoButton`, `memoryUndoButton`).

### 5.4 Knowledge (R5)

`wikiArmed = resolveWikiEnabled(env)`. 2b-ii builds the **recorded-only** path: the decision records `knowledge` /
`wiki_disarmed` (or `knowledge` / `recurrence_lookup` when armed), no proposal, and the Watch line says "wiki
disarmed: N recurring lookup topics" (or "N lookup topics recurring; wiki handler not built"). The proposal and its
handler (a wanted-topics table and a planner prompt line) are a later slice, named in the ADR as deferred (senior
review S1: no table for a flag that is off).

### 5.5 Schedule

The hint: two `approval_expired` rows for one capability on schedule-born runs of one `schedule_id` at the same local
hour within 14 days. Proposal: "<goal> asks for <capability> at HH:00 and you were not there twice; move it to <H2>:00?"
where H2 = the median local hour of Paco's own Telegram turns over 14 days (code-built; ties → the later hour). The
proposal stores `before` (the row's `spec_json`, `tz`, `next_run_at` at proposal time) and `after` (the shifted spec,
`computeNextRunAt`). Accept → `updateScheduledTask({schedule_id, ...after})` **only if the row's `spec_json` still
equals `before.spec_json`** (Paco edited it meanwhile → "Already handled.", state `expired`); Revert (`rev`, §5.1) →
`updateScheduledTask({schedule_id, ...before})` under the same equality check against `after`. A spec the shifter
cannot parse (not a daily/weekly time spec) records the proposal as `nothing` / `no_text` instead of offering it.

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

1. **Improvements today** — automatic effects and accepted proposals since the last digest, each with its code-built
   evidence (§5.1 `evidence`; parent §8.1 "with its evidence", codex P3): "skill <name> drafted · 3 requests over 9
   days [Accept] [Dismiss]" (a `pending_review` job), "suggested: <gate A verdict> · 3 requests" (a `suggested` job, no
   buttons), "lesson saved: <text ≤ 80> · correction on <date> [Undo]", "fact saved · <quote ≤ 40> [Undo]", "schedule
   <goal> moved to H2:00 · 2 expiries at 11:00 [Revert]" (`dec:pr:<id>:rev`, §5.1), "ladder move <…> · 3 ❌ on
   <entry> [Revoke]".
2. **Proposals waiting** — up to 8 open proposals, oldest first, each one line with its draft (≤ 120 chars, redacted)
   and evidence, [Accept] [Dismiss]; a ninth and later are counted ("+N more"). **Offer transaction** (codex round 2
   N6): `buildDecisionDigest` returns the ids it rendered (`offered: {proposal_ids, job_ids}`); `runDecisionDigestTick`'s
   existing transaction (`digest.ts:251`: enqueue, then latch) sets `offered_at = now` on exactly those ids **after
   `enqueueNotification` reported the row inserted**; a deduped enqueue (the day's idempotency key already used) sets
   nothing, and an id whose `offered_at` is already set keeps its first value. The transaction is atomic, so a crash
   leaves either the message, the latch and the offers, or none of them.
3. **Watch** — one line each, 7-day numbers: corrections · abandoned · clarify rate (assistant turns `intent = clarify`
   over all assistant turns, the A27 cap stays) · unattached signals · deferred (rate limit) · silent signals
   (`review_unsure`, `lesson_unfollowed`, and `dig_deeper` if zero in 7 days) · "wiki disarmed: N topics" · "embeddings
   unavailable: N days".

The unsure list, counts, trust/noise, bar-stale and Health sections are removed from the digest (Health conditions
still page as incidents; stale bars still page `decision_bar_stale`; `/status` keeps the counts). The existing
`decision_digests.offered_json` is no longer written (no unsure rows are offered); `offered_at` on proposals and jobs
is the offer record (§5.1, §5.2).

### 6.2 Urgent cards

Sent at once through the outbox: skill authoring started ("drafting a skill from N requests about <category>"),
finished (the Accept/Dismiss card), failed (`result_code`, no text from the model). As parent §8.2.

### 6.3 One-shot and allowlist

All new callbacks (`dec:pr:<id>:acc|dis|rev`, `dec:sk:<job>:accept|dismiss|replace|keep`, `dec:lm:<move>:revoke`)
pass `authorizeTelegramUpdate` first (adapter chain after `dec:rv:`), run under `oncePerTrigger`, and answer "Already
handled." on a second tap, a state the action does not apply to, an unknown or stale (> 14 days) id, or an id whose
`offered_at` is null, writing nothing. `TaskEventType` gains `improvement_tap`; `RATE_LIMIT_EXEMPT` includes it as
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
- **Egress, from durable data** (codex D10: a turn's `extracted` codes and links live in a `WeakMap` on the live turn
  and are gone by the next day): one function `redactForImprove(store, text)` = `redactForJudge(text, { brokerRedact: (s)
  => store.redactSecretValues(s), linkTokens: true, codeShapes: true })` (`RedactOptions` has `brokerRedact`, `known`,
  `extracted`, `linkTokens` today, `egress.ts:30-39`), where **`codeShapes`** is a new boolean option of the judge
  redactor implemented as one more masking rule in its named-pattern pass (beside the credential-shape rules): a
  standalone run of 6–8 digits (`(?<![\w.-])\d{6,8}(?![\w.-])`; dates such as `20261021` are over-masked, accepted),
  and 4–8 alphanumerics after a code word (`(?:code|OTP|verification|验证码|校验码|码)\s*[:：]?\s*([A-Za-z0-9]{4,8})`,
  case-insensitive); masked as `SECRET_MASK`, mirrored to the planner copy like every mask; off by default so no
  existing caller changes. Tests: the two shapes mask, a 5-digit and a 9-digit run do not, the option off leaves them. Jev reads `redacted.pacoText` only (Paco's own words); Tiny reads the same; the distill's
  `prior` and every draft and evidence line the digest or a card shows go through the same function; tool text never
  leaves except inside a clean turn's reply as `prior` to the in-house distill (§5.1). Tests plant an OTP, a link and a
  known secret value in Paco's text and assert all three are masked in the Jev request, the Tiny prompt, the distill
  prompt and the digest text.

## 8. Probes before code (the spec review runs these against the live system)

| # | Probe | Expect |
|---|---|---|
| P1 | On a `VACUUM INTO` copy: `jev_verdicts.category` values over 30 days against `CORRECTION_VALUES`; `paco_correction` counts by value; `run_failed` `error_type` values | **Run 2026-10-21.** Categories (30 d, 32 rows): answer 11, null 6, lookup 4, machine_task 3, other 2, memory 2, status/self_change/schedule/research 1 each: all in the list, null → `other`. `paco_correction`: none in 90 days. `run_failed` (30 d): `planner_exit` 2, `merged_parent_failed` 2, `model_error` 1, `killed` 1: two kinds outside the `PlannerFailure` union → §2's value set. `decision_outcomes`: 1 row in total. `chat_turns.intent` is empty on user turns. |
| P2 | Ollama `embeddinggemma` reachable from the daemon's env; embed 14 days of Paco's Telegram request texts; cluster at the episodic gate | **Run 2026-10-21.** Ollama up with `embeddinggemma:latest`; 44 turns embedded in 5.7 s (avg 62 chars). Unfiltered: 0.42 → `other` 15+3, `answer` 4; 0.5 → `other` 4,3,4,3; 0.6 → `other` 3; 0.7 → none. Filtered (≥ 20 chars, not other/status/memory): 14 turns, no cluster at any gate → §3.3's filters and the 0.6 default. |
| P3 | `tool_approvals` expiries over 30 days by capability and local hour, schedule-born only | **Run 2026-10-21.** 30 d: `shell_external` consumed 26, expired 6, denied 2; schedule-born expiries: 3 × `shell_external` at local hour 11 → §5.5 would fire today. |
| P4 | `tryStartEvolutionPipeline` called with a `job:` run id and a `deliver` that enqueues to the outbox: the lane claims and releases; `evolutionLaneSnapshot` shows it | plan task 0 (cheap; a unit test in the plan covers it since the lane is a pure singleton) |
| P5 | `skillStore.writePending` under omp: a `_pending` draft is absent from the planner prompt and `REGISTRY.md`; `promotePending` prototype: rename + regenerate shows it | plan task 0 |
| P6 | Jev `improve_target` over 20 real signal groups from the copy (dry run of §9.3) | plan task: the sanity script's first run (history is thin; §9.3) |
| P7 | `decision_outcomes.outcome_id` ordering: ids issued by the store are time-ordered | **Run 2026-10-21.** `do_<uuid v4>`: random → the tick uses `(created_at, rowid)` and the inbox's autoincrement id (§3.1). |
| P8 | Decisions coverage: every Telegram run since the ladder shipped has a `turn.handler` row | **Run 2026-10-21.** Decisions since 2026-10-12; 21 Telegram runs since then, 22 `turn.handler` rows: coverage holds, but turns before that date have none → the inbox design (§2) rather than hanging producers on other entries' rows. |

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
| 9 silent degradation | every inbox row in the window is consumed and has an outcome row on an `improve.route` decision; every job state transition has an `improvement_job` ledger event (`run_id` null, `payload_json` = `{job_id, from, to, result_code?}`); `improve_tick` start and end events exist; Jev fallback count = 0 on the day; the unattached count = 0 | |
| 10 memory lane unchanged | `scripts/live-gate-memory-write.mjs` (the memory-write gate) reruns green after §5.3's extraction of the save writes | |

A planner-side outage or Ollama down makes a case INCONCLUSIVE, never PASS (lessons.md: preconditions, counts).

### 9.3 Sanity `scripts/improve-sanity.mjs`

Mirrors `settle-sanity.mjs` (worktree-only, `VACUUM INTO`, `--db`, `--days 30`, planted-token check on its own output,
redacted samples). **History is thin** (P1: `decision_outcomes` holds 1 row, `paco_correction` is null for 90 days,
6 `run_failed` and 8 non-consumed approvals in 30 days), so the script rebuilds signal groups from what exists in the
copy: `run_failed` ledger events, denied and expired approvals, `settle_*` rows (live since 2026-10-21), computed
recurrence and abandonment over the window, plus 10 planted groups (a correction with text, a recurrence cluster, an
expiry pattern, a tool gap). It asks Jev `improve_target` for each, prints the target distribution, the top-probability
histogram, the proposals it would have made (20 samples, redacted), and `PASS` when the planted groups get their
intended target at the bar and real groups would yield ≤ 5 proposals a day. Its result sets `IMPROVE_BAR` (R8) before
merge; with N this small the bar is provisional in the plain sense and the 14-day revisit (§11) is the real calibration.

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

### Round 1, senior review against the live system (2026-10-21, probes P1–P3, P7, P8; Rev 1 → Rev 2)

| # | Finding | Fix in Rev 2 |
|---|---|---|
| B1 | [BLOCKER] Failure modes — the watermark used `outcome_id` order; ids are random uuids (P7) | §3.1: cursors `(created_at, rowid)` and the inbox autoincrement id; `improve_tick` ledger events |
| B2 | [BLOCKER] Requirements — producers hung outcome rows on other entries' decisions, which may not exist (a run failed before triage, a turn before 2026-10-12; `insertDecisionOutcome` throws `decision_not_found`) | §2: `improve_signals` inbox; the tick writes the outcome rows on its own decision |
| B3 | [BLOCKER] Requirements — recurrence at the episodic gate (0.42) clusters short `other` turns (15 of 20 in 14 days, P2): a skill would be drafted from greetings | §3.3: ≥ 20 chars, categories other/status/memory excluded, gate default 0.6 |
| B4 | [BLOCKER] Requirements — `PLANNER_FAILED_VALUES` as the `PlannerFailure` union misses `model_error` and `killed` (P1) | §2: the `finishRun` literals, `other` fallback, a grep-pinned test |
| W1 | [WARNING] Testability — the sanity run (R8) has almost no history to calibrate on (1 outcome row, no corrections in 90 days) | §9.3: rebuilt from ledger, approvals, settle rows, computed clusters, plus 10 planted groups; the bar stays provisional, the 14-day revisit is the calibration |
| W2 | [WARNING] Requirements — abandonment excluded "bare acks" via `intake.bare_ack`, but user turns carry no intent (P1) | §3.4: B ≥ 20 chars |
| W3 | [WARNING] Failure modes — §5.3 extracts the memory lane's save writes; a behaviour change there would be invisible to this slice's gate | §9.2 case 10: the memory-write gate reruns |
| W4 | [WARNING] Operability — job and tick transitions had no ledger trace | §3.1, §9.2 case 9: `improve_tick` and `improvement_job` ledger events |
| S1 | [SUGGESTION] Simplicity — a `wiki_topics_wanted` table and prompt line for a flag that is off | §5.4: recorded-only; the handler is a later slice |
| S2 | [SUGGESTION] Scale — at today's volume (44 user turns / 14 days) recurrence will rarely fire; the job machinery is the largest part of the build | kept (R4, R5 are Paco's rulings); stated in §3.3 so the plan orders it last and the gate plants it |

### Round 1, codex design pass (2026-10-21, `codex exec -s read-only` over Rev 1 at `3970bf9`; Rev 2 → Rev 3)

Factual: F1 outcome ids random (= senior B1, fixed); F2 `after_turn` exists, no CHECK (§4.1); F3 `runs.chat_id` absent
(§3.2 chat lookup); F4 lease recovery bypasses `ompFail` (§2 `noteRunFailed` at every seam, grep-pinned); F5 rating
producer at capture with the chat's latest run (§2); F6 `retireSkill(scope, name, {date, by, supersededBy})` (§5.2);
F7 `THREAD_TEXT_CHAR_CAP` is a total → `JOB_OBJECTIVE_CHAR_CAP`, `EMBED_TEXT_CHAR_CAP` (§3.3, §5.2).

Design: D1 schedule-born exclusion ate the schedule signal → R11; D2 tick read its own outcomes → excluded (§3.2);
D3 no commit boundary → per-group transactions, cursors, `running` latch (§3.1); D4 unique key vs 30-day retry → once
per root turn, overlap rule (§3.3); D5 job restart → attempt token, fencing, boot reconcile (§5.2); D6 `pending_review`
without a file → `suggested` (§5.2); D7 two promotion protocols → one (§5.2); D8 Revert outside the callback contract →
`rev` action, `before`/`after`, `reverted` (§5.1, §5.5); D9 urgent cards never "offered" → `offered_at` on proposals and
jobs (§5.1, §5.2, §6.3); D10 redaction from a live-only source → `redactForImprove` over durable data (§7); D11 the
reply as `prior` carries tool output → clean turns only, redacted, in-house distill (§5.1); D12 fact without evidence →
quote required (§5.1); D13 grouping lost the value → `value` in state, `rating` scope (§3.2, §4.2); D14 Watch could not
count unattached corrections → `improve_signal_skipped` events (§2); D15 dynamic options vs one criteria hash → one
fixed question, masking after the answer (§4.3).

Parent gaps: P1 fact handler → R9; P2 model-route proposals → R10; P3 evidence on the daily line → `evidence` (§5.1,
§6.1).

### Round 2, codex scoped verification (2026-10-21, over Rev 3 at `5f85850`; Rev 3 → Rev 4)

Closed 18 of 25. Open and new, fixed in Rev 4: F4 `refuseOmpTurn`'s direct `finishRun` → the producer lives inside
`finishRun` (§2); D3/N1 cursor could pass an interleaved row and a deferred group had no durable input → the inbox is
the only input, outcomes are mirrored in order, deferred groups stay unconsumed (§3.1, §3.5); D5/N2 timeout vs the
lane's deliver-once → one fenced transition per ending, the winner's card is delivered (§5.2); D8/N4 one callback id
and `oncePerTrigger` replay → `improvement_taps` rows per callback id, replay only for the same id (§5.1); D9/N6 offer
outside the digest transaction → `offered_at` set in it after the enqueue reported inserted (§6.1); D10/N5 wrong
redactor option and an undefined `codeShapes` → `brokerRedact`, and the rule defined with its tests (§7); D15/N3 masked
runner-up could not clear the bar → an inapplicable top abstains with `inapplicable_top`, `p` is the top option's
probability (§4.3).
