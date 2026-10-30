# Decision ladder, stage 4 slice C — `memory.lesson_admit`, `schedule.admit` and `memory.correct_preflight` on the ladder (Rev 2.1)

**Status:** Rev 2 — after the senior review (Sonnet; Fable rate-limited; probed live code + DB: 1 blocker, 6 warnings, 3 suggestions) and the codex review (4 blockers, 3 warnings, 1 suggestion); every finding applied (§Rev 2 changes); codex scoped re-review of Rev 2: 7 closed, 3 open → applied in Rev 2.1. Awaiting Paco's tap (Decisions 1, 2).
**Date:** 2026-10-30
**Amends:** `docs/ROADMAP.md` (the Stage 4 line); ADR 0030 gets an amendment row (drafted under the approved spec, awaiting Paco's signature).
**Depends on:** ADR 0030 §4.1 (entry), §6.1 (inventory rows B9, B23), §6.2 (move, don't improve); ladder design `docs/superpowers/specs/2026-10-12-decision-ladder-design.md` §6.1 (`:377`); Stage 3 spec `2026-10-24-ladder-stage-3-pretool-safety-design.md` §2 (`:45`: "`memory.lesson_admit`, `schedule.admit` (stage 4, with trust/standing approvals)"); Stage 4B (`2026-10-29-ladder-stage4b-bind-redact-design.md`, shipped `17e72c2`) for the pattern and the differential harness.

## 1. Goal

Put the last three unregistered **pre_tool** inventory rows on the registry as rule-only entries that **record and never steer**, so that after this slice every pre_tool row of §6.1 has an entry:

- `memory.lesson_admit` (B23, first half): the code checks a memory save passes before and after the distill;
- `schedule.admit` (B23, second half): the code checks a `schedule_task` create, update or cancel passes;
- `memory.correct_preflight` (B9): the trust limits a `memory_correct` retire or correct passes before any card.

Each wraps today's code unchanged; the raw answer keeps driving the branch (Stage 4B ruling R1). The proof is the Stage 4 differential gate, extended with three corpora: zero behaviour differences against the current `main` build.

## 2. Why this is "the next Stage 4 item"

The ladder design's §13 row 4 lists eight ids plus standing approval; all are shipped (Stage 3 wired six early, 4A standing, 4B the last two, the clean room as its prerequisite). Its gate column is closed except one line that waits on Paco: "the real Alishan command produces the same report in the clean room" needs the Alishan schedule `sch_2af53119-…` re-enabled. The Stage 3 spec moved B23 to "stage 4" by name (`:45`), and B9 is in neither stage's list (an orphan of the same pre_tool row). These are the only Stage 4–tagged rows left. After this slice, the ladder's remaining migration is Stage 3's original "unprotected families" (intake ×6, pre-model ×10, supervision ×2, settle `attach.path` and `notify.page`), which is the following ROADMAP item.

## 3. Live facts (2026-10-30, `main@de53195`, read-only; `houge.sqlite` read through a `VACUUM INTO` copy)

**Registry.** `ENTRY_IDS` has 20 ids (`src/decisions/entry-ids.ts:5`); none of the three is present. None is in `LOCKED_ENTRY_IDS` (`:14–15`), matching §6.1 (B9, B23 carry no L).

**Live traffic is tiny** [`select … from ledger_events where event_type='tool_finished'` grouped by `$.tool`; `memory_not_saved`; `decisions`]:
- `lesson_write` 8 calls (all `succeeded`; a refusal returns `ok: true` with `saved: false`, so refusals are invisible in `tool_finished`); `lesson_saved` events 3; `memory_not_saved` events **0**; `memory.kind` decisions rows **0**.
- `schedule_task` 18 calls: 14 succeeded, 2 failed (an `ok: false` refusal or validation error), 2 denied by the task contract (`Capability not allowed by task contract`, the provenance strip, `src/contracts/task-contract.ts:168`).
- `memory_correct` 23 calls, all succeeded; `memory_corrected` events 6.
The slice's value is completing §6.1 (ruling R2, "migration full") and a row per decision for the outcome loop, not traffic.

### 3.1 `memory.lesson_admit` — the memory-save admits (`src/capabilities/lesson-write.ts`)

One pipeline serves both callers, the `lesson_write` loop tool and a lane's save-first (`CoreWorker.runMemoryWrite`, `core-worker.ts:2699`). The adapter `createMemoryWriteAdapter` (`lesson-write.ts:178`) runs, in order:

1. `memoryPreChecks` (`:206`): `scheduledRun` → reason `scheduled-run`; `alreadySaved` → `already_saved_this_turn` (the `ALREADY_SAVED_REASON` constant); an empty instruction → `ok: false` error (validation, mechanics).
2. `clampScope` (`:216`): mechanics (whitelist + clamp, never refuses).
3. `codeOwnedRefusal` (`:224`): a quoted phrase found verbatim in `src/` → `code-owned`.
4. `decideMemoryKind` (`:235`): **already an entry** (`memory.kind`, Jev + model); its refusals (`fix`, `memory_other`, `distill_failed`, `nothing_to_save`) stay `memory.kind`'s.
5. `planOf` (`:294`) → `checkLessonSide` / `checkFactSide` (`src/capabilities/memory-backstops.ts:14`, `:73`): lesson side `rejected_by_backstop`; fact side `no_evidence` or `rejected_by_backstop`. A refused side is reported and the other side still saves.
6. The store's save (`saveMemoryForTurn`): `already_covered`, `too-large` (capped), `turn_ended`, `save_failed` — store outcomes, not admits.

The admit decisions are steps 1 (two reasons), 3 and 5. Steps 2, 4, 6 are out (§4.1).

**Scope:** the `lesson_write` loop tool and the lane save-first, both through `runMemoryWrite` (`core-worker.ts:3699`, `:3245`). Two other memory writes do not pass these admits and are not this entry: Gate A lesson saves (`reconcileAndSaveLesson`, `core-worker.ts:2095`) and accepted improvement proposals (`saveMemoryPlan`, `src/capabilities/memory-save.ts:15`) — both are Paco's tap on a proposal, not a model-initiated save.

**Recorder trap.** `runMemoryWrite` passes the adapter a `heldRecorder` (`core-worker.ts:4577`) that keeps **one** row (the last `record` wins) so `memory.kind`'s row lands inside the save transaction. A `memory.lesson_admit` row through that recorder would overwrite `memory.kind`'s. The admit rows therefore go to a **second held recorder that keeps a list**, passed as a new config field and flushed by `runMemoryWrite` (§4.1, "When the rows land").

### 3.2 `schedule.admit` — `CoreWorker.executeScheduleTask` (`core-worker.ts:3747`)

Verb precedence is a spec'd invariant (list → cancel → update → create). The admit decisions:
- any verb: the run's notify target is not Telegram → `SCHEDULE_TASK_NO_CHAT_ERROR` (`:3749`);
- cancel: id shape fails, or the row is missing, in another chat, or the store refuses → `SCHEDULE_TASK_CANCEL_NOT_FOUND_ERROR` (one refusal for all, so a hostile id is never echoed);
- update: id shape, missing/other chat/`disabled` → `…UPDATE_NOT_FOUND_ERROR`; the store's late refusal (`:3834`) → the same;
- create: an enabled duplicate (same spec, tz, goal, chat) → idempotent success naming the existing id (`buildScheduleExistsDigest`); the per-chat cap (`resolveSchedulerMaxPerChat`, `countActiveSchedules`) → `buildScheduleCapError(cap)`.
Mechanics (stay code, not recorded): `list`; the spec, tz, goal parses and the goal sanitizer/char cap; the empty update; an uncomputable next fire. The provenance strip (a schedule-born turn has no `schedule_task`) is `tool.manifest`/the contract and is not touched.

### 3.3 `memory.correct_preflight` — `writeRefusal` (`src/capabilities/memory-correct.ts:250`)

One pure predicate, two callers: the bridge preflight `memoryWritePreflight` (`:194`, wired at `core-worker.ts:2498`; a refusal never shows a card) and `executeMemoryCorrect` (`:207`, the gated write after an approval). Reasons in order: `not_operator_turn` (run source not `telegram`), `tainted_turn` (an earlier capability outside `MEMORY_CLEAN_PRIOR_STEPS`), `too_many` (ids per call over `MEMORY_IDS_PER_CALL_MAX`), `not_offered` (an id this turn's search did not offer), `too_many` again (changes this turn over `MEMORY_CHANGES_PER_TURN_MAX`). The order is kept; both `too_many` checks map to the one code. Parse refusals (`parseMemoryRequest`) and `not_active` (the store found nothing to change) are mechanics.

## 4. The entries (pattern: `entries/approval-bind.ts`, `entries/secret-redact.ts`)

All three: `version: 1`, `stage: "pre_tool"`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`, **not locked** (§6.1 carries no L for B9/B23; ruling R3), no Jev or model rung (adding one is a later ladder move with Paco's tap, §4.3).

### 4.1 `memory.lesson_admit`
- `input: "mixed"` (Paco's instruction and thread, plus the distill's model output at the backstop seam; ruling R6); verdicts `admit | refuse`; `defaultVerdict: "admit"`; `fail: "refuse"`; **no `alwaysRecord`** — a successful save is already a `lesson_saved` event, so only refusals leave a row.
- Input `{ seam: "pre" | "backstop"; refused?: MemoryAdmitReason }`.
- `reasonCodes`: `scheduled_run`, `already_saved`, `code_owned` (seam `pre`); `lesson_backstop`, `fact_backstop`, `fact_no_evidence` (seam `backstop`). The rule maps today's strings to these codes; the tool result keeps today's strings byte-for-byte.
- Effects: `admit` none; `refuse` `tighten`, reversible, announced none.
- Call sites: **(pre)** one `decideSync` at each existing early return — the `scheduledRun` return and the `alreadySaved` return in `memoryPreChecks`, and the `codeOwnedRefusal` return — with today's order kept exactly (a scheduled or already-saved call returns before `clampScope` and before `codeOwnedRefusal`'s `spawnSync grep`, up to 2 s per phrase; evaluating both first would add that work, invisible to a byte differential); **(backstop)** one `decideSync` per refused side after `planOf`. A call with nothing refused writes zero rows; a lesson refused beside a saved fact writes one row; both sides refused write two.
- **When the rows land (lost-turn rule, ADR 0030 ruling 14).** The adapter records into a second held recorder that keeps a **list** (`memory.kind`'s held recorder keeps one row and would be clobbered, §3.1). `runMemoryWrite` writes the list in its `finally` under the condition it already uses for `memory.kind` (`!o.signal?.aborted && this.ompTurns.get(run_id) === state`), outside the save transaction. A lost or aborted turn writes no admit row. An admit refusal is the code's decision at the time it was made, so a later `racedBy` or `turn_ended` result from the save does not remove a backstop row that was made before it on a live turn; the row and the result can then differ (stated, tested).

### 4.2 `schedule.admit`
- `input: "tool"`; verdicts `admit | exists | refuse`; `defaultVerdict: "admit"`; `fail: "refuse"`; **`alwaysRecord: true`** (Decision 2: every create, update and cancel leaves a row; ~18 calls in the DB's whole history).
- Input `{ verb: "create" | "update" | "cancel" | "none"; outcome: "admit" | "exists" | "refuse"; code?: ScheduleAdmitReason }`. `none` exists only for `no_chat`: the notify-target check runs before the verb dispatch (`core-worker.ts:3748` before `:3759`), so a non-Telegram call of any verb, `list` included, records `refuse/no_chat` with verb `none`.
- `reasonCodes`: `create`, `update`, `cancel` (on `admit`/`exists`, naming the verb), `no_chat`, `not_found`, `cap`.
- Effects: `admit` none; `exists` none; `refuse` `tighten`, reversible, announced none.
- Call site: one helper `admitSchedule(...)` called at each admit branch of `executeScheduleTask` before it returns (one row per call that reached an admit decision); a validation error returns before any admit and writes no row; a Telegram `list` writes none.
- **Scope:** the model's `schedule_task` tool only. The operator and loop paths that mutate schedules directly — `/schedule` cancel (`gateway.ts:637`, `:642`), improvement update/undo (`improvement-commands.ts:114`, `:135`), the tick's auto-cancel (`schedule-tick.ts:189`) — are not this entry (Paco's own taps and code mechanics, not a pre_tool decision); "every change leaves a row" in Decision 2-A means every `schedule_task` change.

### 4.3 `memory.correct_preflight`
- `input: "tool"`; verdicts `allow | refuse`; `defaultVerdict: "allow"`; `fail: "refuse"`; no `alwaysRecord` (an allowed write is already a `memory_corrected` event and an approval row).
- Input `{ caller: "preflight" | "write"; refused: MemoryCorrectRefusal | null }`, where `MemoryCorrectRefusal` is the typed union of the four codes and `writeRefusal`'s return type becomes that union (a new refusal string then fails typecheck; the strings are unchanged); `reasonCodes`: `not_operator_turn`, `tainted_turn`, `too_many`, `not_offered`. `MemoryToolDeps` gains an optional `recorder`; when absent (the existing unit tests build deps without one) no row is written.
- Call site: `writeRefusal` stays the pure predicate; a wrapper records its answer at both callers. The preflight refusal and the write-side refusal are separate rows (the write side should never refuse after a passed preflight unless the turn changed; a row there is the signal).

### 4.4 Failure behaviour (Stage 4B R2 carried over)
Two distinct faults, tested separately: (a) the store insert fails inside `storeRecorder` (`src/decisions/record.ts:51`) → it opens `decision_record_failed`; (b) a recorder that throws past itself → `decideSync` catches it and logs (`src/decisions/decide.ts:168`), no incident. Neither changes the branch, the tool result or the save. A rule that throws cannot happen (each rule is a total map over a closed input); the entry's `fail` verdict is never acted on because the raw answer drives.

## 5. What does not change
- Every tool result, error string, digest, ledger event (`memory_not_saved`, `lesson_saved`, `memory_corrected`, `tool_finished`), store row and their order — byte-identical.
- `memory.kind`'s row, its held-recorder timing and ruling 14 (a lost turn writes no `memory.kind` row).
- `tool.policy`, `turn.trust` and the trust ask for `lesson_write` / `schedule_task` (`src/decisions/trust-ask.ts:13`): untouched.
- The digest.
- `/status` gains a count line per new id once rows exist (lines come from `decisions` rows in the 24 h window; no new copy).

## 6. The differential (extends `scripts/check-ladder-stage4-differential.mjs`)

Old side: the current `main` build (the merge base of the branch, a clean worktree under `.worktrees/`, `dist/` built from that HEAD). **Harness work this needs (a plan task):** the lib's builds today are `new/s3/s4a` (`scripts/stage4-diff-lib.mjs:7`) and the CLI validates two hard-coded bases (`check-ladder-stage4-differential.mjs:37`); add a third pair `--old-dist-4b` (the merge base) used by the three new corpora, and prove its provenance by **building it**: the harness's setup step (or a documented command it checks for) runs `npm run build` in the merge-base worktree and writes `dist/.provenance.json` = `{ head: <git rev-parse HEAD>, clean: true, dist_sha256: <hash over the sorted dist file list and contents> }`; the check refuses unless the worktree is clean, HEAD equals the stamp's `head`, and the recomputed dist hash equals the stamp's (a clean worktree alone cannot prove an ignored `dist/` came from HEAD; the stamp written right after a build at that HEAD can, and any later edit to `dist/` breaks the hash). The existing `old-dist-provenance.mjs` check (HEAD + differs-from-new) stays for the s3/s4a pairs. The loader's explicit export map (`stage4-diff-lib.mjs:17`) gains `createMemoryWriteAdapter`, `memoryWritePreflight`, `executeMemoryCorrect` and `CoreWorker`, for all builds that have them (all three exist on the merge base). The existing corpora keep their bases and rerun unchanged. New side: the branch build. Each item runs on both sides on its own fresh copy; compared projection: the tool result, every ledger event and store row the call wrote (minus ids, timestamps, hashes in `STRIP_KEYS`), and the order. The row filter (`stage4-diff-lib.mjs:138`) excludes **only** `decisions` rows of the three new entry ids, so any change to `memory.kind`'s row stays a difference; the new rows are asserted separately (count, verdict, reason per item). Determinism: a fixed clock, an explicit `tz` on every schedule item, and the scheduler cap env set by the harness. The compiled `CoreWorker` exposes `executeScheduleTask` and `runMemoryWrite` as JS methods (TypeScript `private` is not enforced), so both are called on a constructed worker in each build.

New corpora under `scripts/stage4-corpora/`:
- **`memadmit`**, at two levels. **Worker level** (the wiring AGENTS.md warns about): `runMemoryWrite` on a constructed `CoreWorker` over a DB copy, LLM legs stubbed, the real save transaction — scheduled run, already saved, code-owned, a backstop refusal beside a saved fact (asserts `memory.kind`'s row is still written in the save transaction), an abort mid-save (no admit row), a race (`racedBy`). **Adapter level**: the adapter with stubbed `llm`/`askJev`/`save`, over: scheduled run; already saved (lesson, fact, both); code-owned phrase (thread and instruction); empty instruction; each backstop outcome per side × both sides; a clean save; abort before and after the kind decision. Both callers (loop, lane) where they differ.
- **`schedule`**: `executeScheduleTask` over a seeded DB copy: non-Telegram run for each verb including `list`; cancel/update with bad shape, missing, other-chat, disabled, store-refused; create duplicate, at cap, under cap; validation errors (no row expected); `list`. The verb-precedence combinations (each pair of verbs present).
- **`memcorrect`**: `memoryWritePreflight` and `executeMemoryCorrect` over each refusal, a passing retire, a passing correct, and a preflight-pass/write-refuse turn change.

PASS: 0 differences, every new-side item has its expected decision rows, the self-test (a mutated copy) fails. The harness's existing corpora rerun unchanged.

## 7. Live gate — `scripts/live-gate-ladder-stage4c.mjs` (on `dist/`, a VACUUM copy, never the live DB for writing; refuses to run outside `.worktrees/`)
1. A scheduled-run memory save → refused, one `memory.lesson_admit` row `refuse/scheduled_run`, tool result identical to `main`'s.
2. A code-owned phrase save → `refuse/code_owned`.
3. A backstop-rejected lesson with a saved fact → one row `refuse/lesson_backstop`, the fact saved (`fact_saved`), `memory.kind` row still present and in the save transaction.
4. A clean lesson save → zero `memory.lesson_admit` rows, `lesson_saved` present.
5. `schedule_task` create → `admit/create`; the same again → `exists/create`; at cap → `refuse/cap`; cancel of another chat's id → `refuse/not_found`.
6. `memory_correct` retire with an un-offered id → no card, `memory.correct_preflight` row `refuse/not_offered`.
7. The store's decision insert faulted (seam on `insertDecision`) → `decision_record_failed` opened, every result unchanged (silent-degradation line); separately, a recorder that throws past itself → logged, no incident, results unchanged.
8. `/status` shows a count line for each of the three ids (the lines come from `decisions` rows in the 24 h window, so the gate's own rows make them appear).

The slice also updates the two hard-coded entry counts of 20: `tests/decisions/registry.test.ts:132` and `scripts/live-gate-ladder-stage4b.mjs:172` (→ 23), and reruns the 4B live gate.

## 8. Rollback check — `scripts/check-ladder-stage4c-rollback.mjs`
The previous build opens a copy carrying the new rows, runs its own reads (`/status`, digest, `decisions` readers), no errors, no lost rows; and, as 4B's rollback did (`check-ladder-stage4b-rollback.mjs:248`), calls its `ENTRY_IDS`-validated writers (`review_ok` in `outcomes.ts`, `insertLadderMove`) naming a new id and asserts they refuse cleanly. No migration: the slice adds rows to an existing table only.

## 9. Protected files touched (Tier A under the approved spec)
`src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `src/decisions/entries/memory-lesson-admit.ts`, `schedule-admit.ts`, `memory-correct-preflight.ts` (all under `src/decisions/`). Not protected: `lesson-write.ts`, `memory-correct.ts`, `core-worker.ts`.

## 10. Risks
- **Held-recorder clobber** (§3.1): mitigated by the second held list; a test asserts `memory.kind`'s row survives a backstop refusal in the same call.
- **Reason-string drift:** today's strings stay in tool results; the entry maps them. A test pins the map over every string the adapter can emit, so a new string fails the test rather than recording as reason-less.
- **Verb precedence:** the schedule call sites sit inside existing branches; the differential's verb-pair items catch a reorder.
- **Unlocked entries** could later gain a Jev rung by a ladder move; that needs Paco's tap (§4.3) and the monotone rule holds. Ruling R3.

## Decision needed (Paco, at the spec tap)

**Decision 1 — include B9 `memory.correct_preflight`?**
- **1-A (recommended):** yes. It is a pre_tool row no stage claimed; with it, every pre_tool row of §6.1 is on the registry. Cost: one task, one corpus.
- **1-B:** no; B9 waits for the Stage 3 remainder.

**Decision 2 — how much `schedule.admit` records.**
- **2-A (recommended):** every `schedule_task` create, update and cancel that reached an admit decision (`alwaysRecord`) — one audit row per model-made schedule change (18 `schedule_task` calls in the DB's history). Operator and loop paths are out (§4.2).
- **2-B:** refusals and duplicates only, like the other two entries.

## Rulings in this Rev (overturnable by review)
- **R1** The raw answer drives; `decideSync`'s result is discarded (Stage 4B R1, Stage 3 as built). Cost if wrong: none while each rule is total.
- **R2** `memory.kind`'s refusals stay `memory.kind`'s; store outcomes (`already_covered`, `too-large`, `turn_ended`, `save_failed`) are not admits. Cost if wrong: a later entry version adds them.
- **R3** Not locked, per §6.1. Cost if wrong: one-line flip to `locked: true` + `LOCKED_ENTRY_IDS`.
- **R4** Keep the id `memory.lesson_admit` although the save now covers facts too (the tool is still `lesson_write`; §6.1's name). Cost if wrong: a rename before any row exists.
- **R5** Reason codes are new snake_case codes mapped from today's strings; tool output keeps today's strings. Cost if wrong: a code rename before any row exists.
- **R6** `memory.lesson_admit` is `input: "mixed"`, not `"paco"`: the backstop seam judges model output, and `"paco"` would let a later Jev rung cause effects (R12). Cost if wrong: none for a rule-only entry.

## Rev 2 changes (senior Sonnet + codex, all applied)
- **Pre-seam order (senior BLOCKER, codex BLOCKER):** one `decideSync` at each existing early return; no extra `grep` work (§4.1).
- **Lost-turn rows (codex BLOCKER, senior WARNING):** admit rows held in a list and written in `runMemoryWrite`'s `finally` under the `memory.kind` condition; a lost turn writes none; backstop row vs a later `racedBy`/`turn_ended` result stated (§4.1).
- **Recorder fault (codex BLOCKER):** insert fault → incident; throwing recorder → log only; both tested (§4.4, §7 line 7).
- **Differential (codex BLOCKER, senior WARNING):** a `--old-dist-4b` pair at the merge base with a clean-tree + built-from-HEAD provenance check; filter excludes only the three new ids; worker-level cases; fixed clock, tz, cap env (§6).
- **`no_chat` verb (both WARNING):** verb `none`, `list` included (§4.2).
- **Hard-coded counts (both WARNING):** the two count-20 sites updated, 4B gate rerun (§7).
- **`/status` wording (senior WARNING):** lines come from rows in the 24 h window (§5, §7).
- **`writeRefusal` order (senior WARNING):** corrected (§3.3).
- **Rev 2.1 (codex scoped re-review):** §3.1 and §10 now say "second held list" (no direct recorder anywhere); the 4B pair's provenance is a build stamp with a dist hash; loader export map named; memory-save scope excludes Gate A and improvement-proposal saves.
- **Suggestions:** schedule scope vs operator paths (both); `fact_saved` vs `lesson_saved` (codex); typed refusal union + optional recorder (senior); rollback calls the old build's id-validated writers (senior).
