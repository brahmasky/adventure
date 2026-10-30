# Decision ladder, stage 4 slice C — `memory.lesson_admit`, `schedule.admit` and `memory.correct_preflight` on the ladder (Rev 1)

**Status:** Rev 1, draft for review (senior, then codex), then Paco's tap.
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

**Recorder trap.** `runMemoryWrite` passes the adapter a `heldRecorder` (`core-worker.ts:4577`) that keeps **one** row (the last `record` wins) so `memory.kind`'s row lands inside the save transaction. A `memory.lesson_admit` row through that recorder would overwrite `memory.kind`'s. The admit rows therefore use a second, direct recorder (`this.decisionRecorder`, `:559`), passed as a new config field.

### 3.2 `schedule.admit` — `CoreWorker.executeScheduleTask` (`core-worker.ts:3747`)

Verb precedence is a spec'd invariant (list → cancel → update → create). The admit decisions:
- any verb: the run's notify target is not Telegram → `SCHEDULE_TASK_NO_CHAT_ERROR` (`:3749`);
- cancel: id shape fails, or the row is missing, in another chat, or the store refuses → `SCHEDULE_TASK_CANCEL_NOT_FOUND_ERROR` (one refusal for all, so a hostile id is never echoed);
- update: id shape, missing/other chat/`disabled` → `…UPDATE_NOT_FOUND_ERROR`; the store's late refusal (`:3834`) → the same;
- create: an enabled duplicate (same spec, tz, goal, chat) → idempotent success naming the existing id (`buildScheduleExistsDigest`); the per-chat cap (`resolveSchedulerMaxPerChat`, `countActiveSchedules`) → `buildScheduleCapError(cap)`.
Mechanics (stay code, not recorded): `list`; the spec, tz, goal parses and the goal sanitizer/char cap; the empty update; an uncomputable next fire. The provenance strip (a schedule-born turn has no `schedule_task`) is `tool.manifest`/the contract and is not touched.

### 3.3 `memory.correct_preflight` — `writeRefusal` (`src/capabilities/memory-correct.ts:250`)

One pure predicate, two callers: the bridge preflight `memoryWritePreflight` (`:194`, wired at `core-worker.ts:2498`; a refusal never shows a card) and `executeMemoryCorrect` (`:207`, the gated write after an approval). Reasons in order: `not_operator_turn` (run source not `telegram`), `tainted_turn` (an earlier capability outside `MEMORY_CLEAN_PRIOR_STEPS`), `too_many` (ids per call or changes per turn), `not_offered` (an id this turn's search did not offer). Parse refusals (`parseMemoryRequest`) and `not_active` (the store found nothing to change) are mechanics.

## 4. The entries (pattern: `entries/approval-bind.ts`, `entries/secret-redact.ts`)

All three: `version: 1`, `stage: "pre_tool"`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`, **not locked** (§6.1 carries no L for B9/B23; ruling R3), no Jev or model rung (adding one is a later ladder move with Paco's tap, §4.3).

### 4.1 `memory.lesson_admit`
- `input: "mixed"` (Paco's instruction and thread, plus the distill's model output at the backstop seam; ruling R6); verdicts `admit | refuse`; `defaultVerdict: "admit"`; `fail: "refuse"`; **no `alwaysRecord`** — a successful save is already a `lesson_saved` event, so only refusals leave a row.
- Input `{ seam: "pre" | "backstop"; refused?: MemoryAdmitReason }`.
- `reasonCodes`: `scheduled_run`, `already_saved`, `code_owned` (seam `pre`); `lesson_backstop`, `fact_backstop`, `fact_no_evidence` (seam `backstop`). The rule maps today's strings to these codes; the tool result keeps today's strings byte-for-byte.
- Effects: `admit` none; `refuse` `tighten`, reversible, announced none.
- Call sites: **(pre)** one `decideSync` inside `createMemoryWriteAdapter` after `memoryPreChecks` and `codeOwnedRefusal` are both evaluated, recording the first refusal; **(backstop)** one `decideSync` per refused side inside `planOf`'s caller. A saved turn writes zero rows; a fully refused backstop writes one row per refused side (≤ 2).

### 4.2 `schedule.admit`
- `input: "tool"`; verdicts `admit | exists | refuse`; `defaultVerdict: "admit"`; `fail: "refuse"`; **`alwaysRecord: true`** (Decision 2: every create, update and cancel leaves a row; ~18 calls in the DB's whole history).
- Input `{ verb: "create" | "update" | "cancel"; outcome: "admit" | "exists" | "refuse"; code?: ScheduleAdmitReason }`.
- `reasonCodes`: `create`, `update`, `cancel` (on `admit`/`exists`, naming the verb), `no_chat`, `not_found`, `cap`.
- Effects: `admit` none; `exists` none; `refuse` `tighten`, reversible, announced none.
- Call site: one helper `admitSchedule(...)` called at each admit branch of `executeScheduleTask` before it returns (one row per call that reached an admit decision); a validation error returns before any admit and writes no row; `list` writes none.

### 4.3 `memory.correct_preflight`
- `input: "tool"`; verdicts `allow | refuse`; `defaultVerdict: "allow"`; `fail: "refuse"`; no `alwaysRecord` (an allowed write is already a `memory_corrected` event and an approval row).
- Input `{ caller: "preflight" | "write"; refused: string | null }`; `reasonCodes`: `not_operator_turn`, `tainted_turn`, `too_many`, `not_offered`.
- Call site: `writeRefusal` stays the pure predicate; a wrapper records its answer at both callers. The preflight refusal and the write-side refusal are separate rows (the write side should never refuse after a passed preflight unless the turn changed; a row there is the signal).

### 4.4 Failure behaviour (Stage 4B R2 carried over)
A recorder that throws opens `decision_record_failed` (the existing `storeRecorder` behaviour) and never changes the branch, the tool result or the save. A rule that throws cannot happen (each rule is a total map over a closed input); the entry's `fail` verdict is never acted on because the raw answer drives.

## 5. What does not change
- Every tool result, error string, digest, ledger event (`memory_not_saved`, `lesson_saved`, `memory_corrected`, `tool_finished`), store row and their order — byte-identical.
- `memory.kind`'s row, its held-recorder timing and ruling 14 (a lost turn writes no `memory.kind` row).
- `tool.policy`, `turn.trust` and the trust ask for `lesson_write` / `schedule_task` (`src/decisions/trust-ask.ts:13`): untouched.
- The digest. `/status` gains three count lines from the registry (no new copy).

## 6. The differential (extends `scripts/check-ladder-stage4-differential.mjs`)

Old side: the current `main` build (`de53195` or later, a clean worktree under `.worktrees/`, `dist/` newer than its HEAD — the provenance check the 4B follow-up names, done by hand and stated). New side: the branch build. Each item runs on both sides on its own fresh copy; compared projection: the tool result, every ledger event and store row the call wrote (minus ids, timestamps, hashes in `STRIP_KEYS`), and the order; the new side's `decisions` rows are stripped from the comparison and asserted separately (count and verdict per item).

New corpora under `scripts/stage4-corpora/`:
- **`memadmit`**: the adapter with stubbed `llm`/`askJev`/`save`, over: scheduled run; already saved (lesson, fact, both); code-owned phrase (thread and instruction); empty instruction; each backstop outcome per side × both sides; a clean save; abort before and after the kind decision. Both callers (loop, lane) where they differ.
- **`schedule`**: `executeScheduleTask` over a seeded DB copy: non-Telegram run; cancel/update with bad shape, missing, other-chat, disabled, store-refused; create duplicate, at cap, under cap; validation errors (no row expected); `list`. The verb-precedence combinations (each pair of verbs present).
- **`memcorrect`**: `memoryWritePreflight` and `executeMemoryCorrect` over each refusal, a passing retire, a passing correct, and a preflight-pass/write-refuse turn change.

PASS: 0 differences, every new-side item has its expected decision rows, the self-test (a mutated copy) fails. The harness's existing corpora rerun unchanged.

## 7. Live gate — `scripts/live-gate-ladder-stage4c.mjs` (on `dist/`, a VACUUM copy, never the live DB for writing; refuses to run outside `.worktrees/`)
1. A scheduled-run memory save → refused, one `memory.lesson_admit` row `refuse/scheduled_run`, tool result identical to `main`'s.
2. A code-owned phrase save → `refuse/code_owned`.
3. A backstop-rejected lesson with a saved fact → one row `refuse/lesson_backstop`, the fact saved, `memory.kind` row still present and in the save transaction.
4. A clean save → zero `memory.lesson_admit` rows, `lesson_saved` present.
5. `schedule_task` create → `admit/create`; the same again → `exists/create`; at cap → `refuse/cap`; cancel of another chat's id → `refuse/not_found`.
6. `memory_correct` retire with an un-offered id → no card, `memory.correct_preflight` row `refuse/not_offered`.
7. A recorder that throws (seam) → `decision_record_failed` opened, every result unchanged (silent-degradation line).
8. `/status` shows the three count lines.

## 8. Rollback check — `scripts/check-ladder-stage4c-rollback.mjs`
The previous build opens a copy carrying the new rows, runs its own reads (`/status`, digest, `decisions` readers), no errors, no lost rows. No migration: the slice adds rows to an existing table only.

## 9. Protected files touched (Tier A under the approved spec)
`src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `src/decisions/entries/memory-lesson-admit.ts`, `schedule-admit.ts`, `memory-correct-preflight.ts` (all under `src/decisions/`). Not protected: `lesson-write.ts`, `memory-correct.ts`, `core-worker.ts`.

## 10. Risks
- **Held-recorder clobber** (§3.1): mitigated by a direct recorder; a test asserts `memory.kind`'s row survives a backstop refusal in the same call.
- **Reason-string drift:** today's strings stay in tool results; the entry maps them. A test pins the map over every string the adapter can emit, so a new string fails the test rather than recording as reason-less.
- **Verb precedence:** the schedule call sites sit inside existing branches; the differential's verb-pair items catch a reorder.
- **Unlocked entries** could later gain a Jev rung by a ladder move; that needs Paco's tap (§4.3) and the monotone rule holds. Ruling R3.

## Decision needed (Paco, at the spec tap)

**Decision 1 — include B9 `memory.correct_preflight`?**
- **1-A (recommended):** yes. It is a pre_tool row no stage claimed; with it, every pre_tool row of §6.1 is on the registry. Cost: one task, one corpus.
- **1-B:** no; B9 waits for the Stage 3 remainder.

**Decision 2 — how much `schedule.admit` records.**
- **2-A (recommended):** every create, update and cancel that reached an admit decision (`alwaysRecord`) — one audit row per schedule change, ~1 a day at most.
- **2-B:** refusals and duplicates only, like the other two entries.

## Rulings in this Rev (overturnable by review)
- **R1** The raw answer drives; `decideSync`'s result is discarded (Stage 4B R1, Stage 3 as built). Cost if wrong: none while each rule is total.
- **R2** `memory.kind`'s refusals stay `memory.kind`'s; store outcomes (`already_covered`, `too-large`, `turn_ended`, `save_failed`) are not admits. Cost if wrong: a later entry version adds them.
- **R3** Not locked, per §6.1. Cost if wrong: one-line flip to `locked: true` + `LOCKED_ENTRY_IDS`.
- **R4** Keep the id `memory.lesson_admit` although the save now covers facts too (the tool is still `lesson_write`; §6.1's name). Cost if wrong: a rename before any row exists.
- **R5** Reason codes are new snake_case codes mapped from today's strings; tool output keeps today's strings. Cost if wrong: a code rename before any row exists.
- **R6** `memory.lesson_admit` is `input: "mixed"`, not `"paco"`: the backstop seam judges model output, and `"paco"` would let a later Jev rung cause effects (R12). Cost if wrong: none for a rule-only entry.
