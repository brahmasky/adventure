# Stage 4C admits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `memory.lesson_admit`, `schedule.admit` and `memory.correct_preflight` as rule-only, record-never-steer ladder entries at today's decision points, and prove zero behaviour change with the Stage 4 differential, a live gate and a rollback check.

**Architecture:** Three entry modules under `src/decisions/entries/` (protected), each a total rule over a closed input. The existing code keeps deciding; at each existing return point a `decideSync` call records the answer and its result is discarded. Memory-save rows go through a held **list** recorder flushed by `CoreWorker.runMemoryWrite` under the lost-turn rule; schedule and memory-correct rows go straight to the worker's store recorder.

**Tech Stack:** Node 25, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest. Zero runtime deps.

**Spec:** `docs/superpowers/specs/2026-10-30-ladder-stage4c-admit-design.md` (Rev 2.1, APPROVED by Paco 2026-10-30: 1-A, 2-A). Read it before any task.

## Global Constraints

- `dependencies: {}` stays empty; Node stdlib plus devDeps only.
- **Behaviour identical:** every tool result, error string, digest, ledger event (`memory_not_saved`, `lesson_saved`, `fact_saved`, `memory_corrected`, `tool_finished`), store row and their order stay byte-identical to the merge base. The only new rows are `decisions` rows with `entry_id` in `memory.lesson_admit`, `schedule.admit`, `memory.correct_preflight`.
- **Raw answer drives (R1):** `decideSync`'s result is never used for a branch.
- **Order kept:** `memoryPreChecks` (scheduled-run, then already-saved, then empty instruction) → `clampScope` → `codeOwnedRefusal`; nothing new runs before an early return.
- **Lost-turn rule:** a memory-save admit row is written only when `!o.signal?.aborted && this.ompTurns.get(claim.run_id) === state` in `runMemoryWrite`'s `finally`.
- All three entries: `version: 1`, `stage: "pre_tool"`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`, **no `locked`**, not in `LOCKED_ENTRY_IDS`.
- Reason codes exactly: `memory.lesson_admit` → `scheduled_run`, `already_saved`, `code_owned`, `lesson_backstop`, `fact_backstop`, `fact_no_evidence`; `schedule.admit` → `create`, `update`, `cancel`, `no_chat`, `not_found`, `cap`; `memory.correct_preflight` → `not_operator_turn`, `tainted_turn`, `too_many`, `not_offered`.
- `schedule.admit` has `alwaysRecord: true`; the other two do not.
- No user message text, lesson text, fact text, goal text or transcript content in any decision row, test print or script print. Tests use synthetic text only (the repo is public).
- Functions under 50 lines (new ones); match surrounding style; tests in `tests/<area>/` mirroring `src/`.
- Never write the live DB (`houge.sqlite`); live checks use a `VACUUM INTO` copy that is deleted on every exit path.
- Commits: Conventional Commits, one concern each, stage files by name, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/decisions/entries/memory-lesson-admit.ts` (new) | 1 | entry + `MemoryAdmitReason` |
| `src/decisions/entries/schedule-admit.ts` (new) | 1 | entry + verb/outcome/reason types |
| `src/decisions/entries/memory-correct-preflight.ts` (new) | 1 | entry + `MemoryCorrectRefusal` |
| `src/decisions/entry-ids.ts`, `src/decisions/registry.ts` | 1 | 20 → 23 ids |
| `tests/decisions/{memory-lesson-admit,schedule-admit,memory-correct-preflight}.test.ts` (new), `tests/decisions/registry.test.ts` | 1 | entry pins, count 23 |
| `scripts/live-gate-ladder-stage4b.mjs:172` | 1 | count 20 → 23 |
| `src/capabilities/lesson-write.ts`, `src/core/core-worker.ts` (runMemoryWrite, heldList) | 2 | memory-save call sites + flush |
| `tests/capabilities/lesson-write-admit.test.ts` (new), `tests/core/memory-write-admit.test.ts` (new) | 2 | adapter + worker level |
| `src/core/core-worker.ts` (executeScheduleTask, admitSchedule) | 3 | schedule call sites |
| `tests/core/schedule-admit.test.ts` (new) | 3 | through the real bridge |
| `src/capabilities/memory-correct.ts`, `src/core/core-worker.ts` (memoryDeps) | 4 | preflight/write call sites |
| `tests/capabilities/memory-correct-preflight.test.ts` (new) | 4 | both callers |
| `scripts/stamp-dist.mjs` (new), `scripts/old-dist-provenance.mjs`, `scripts/stage4-diff-lib.mjs`, `scripts/check-ladder-stage4-differential.mjs` | 5 | `--old-dist-4b`, build stamp, exports, row filter |
| `scripts/stage4-corpora/{schedule,memcorrect}.mjs` (new), `scripts/stage4-admit-fixture.mjs` (new) | 6 | two corpora |
| `scripts/stage4-corpora/memadmit.mjs` (new) | 7 | adapter + worker corpus |
| `scripts/live-gate-ladder-stage4c.mjs` (new) | 8 | live gate |
| `scripts/check-ladder-stage4c-rollback.mjs` (new) | 9 | rollback check |

---

### Task 1: The three entries on the registry

**Files:**
- Create: `src/decisions/entries/memory-lesson-admit.ts`, `src/decisions/entries/schedule-admit.ts`, `src/decisions/entries/memory-correct-preflight.ts`
- Modify: `src/decisions/entry-ids.ts:5`, `src/decisions/registry.ts` (imports + `REGISTRY`), `tests/decisions/registry.test.ts:122-133`, `scripts/live-gate-ladder-stage4b.mjs:172`
- Test: `tests/decisions/memory-lesson-admit.test.ts`, `tests/decisions/schedule-admit.test.ts`, `tests/decisions/memory-correct-preflight.test.ts`

**Interfaces:**
- Produces: `MEMORY_LESSON_ADMIT: Entry<MemoryAdmitInput, MemoryAdmitVerdict>`, `MEMORY_ADMIT_REASONS`, `type MemoryAdmitReason`, `type MemoryAdmitInput = { seam: "pre" | "backstop"; refused?: MemoryAdmitReason }`; `SCHEDULE_ADMIT: Entry<ScheduleAdmitInput, ScheduleAdmitVerdict>`, `type ScheduleAdmitVerb = "create" | "update" | "cancel" | "none"`, `type ScheduleAdmitReason = "no_chat" | "not_found" | "cap"`, `type ScheduleAdmitInput = { verb: ScheduleAdmitVerb; outcome: "admit" | "exists" | "refuse"; code?: ScheduleAdmitReason }`; `MEMORY_CORRECT_PREFLIGHT: Entry<MemoryCorrectInput, MemoryCorrectVerdict>`, `MEMORY_CORRECT_REFUSALS`, `type MemoryCorrectRefusal`, `type MemoryCorrectInput = { caller: "preflight" | "write"; refused: MemoryCorrectRefusal | null }`.

- [ ] **Step 1: Write the failing entry tests**

`tests/decisions/memory-lesson-admit.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { MEMORY_ADMIT_REASONS, MEMORY_LESSON_ADMIT } from "../../src/decisions/entries/memory-lesson-admit.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(MEMORY_LESSON_ADMIT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });

describe("memory.lesson_admit — a refused memory save leaves a row naming the code check that refused it", () => {
  it("is rule-only, unlocked (§6.1 has no L for B23), refusal-only, sound", () => {
    expect(MEMORY_LESSON_ADMIT.locked).toBeUndefined();
    expect(MEMORY_LESSON_ADMIT.alwaysRecord).toBeUndefined();
    expect(MEMORY_LESSON_ADMIT.input).toBe("mixed"); // the backstop seam judges model output (spec R6)
    expect(MEMORY_LESSON_ADMIT.reasonCodes).toEqual(["scheduled_run", "already_saved", "code_owned", "lesson_backstop", "fact_backstop", "fact_no_evidence"]);
    expect(MEMORY_LESSON_ADMIT.ladder.map((r) => r.kind)).toEqual(["rule"]);
    expect(entryProblems(MEMORY_LESSON_ADMIT as unknown as AnyEntry)).toEqual([]);
  });
  it("nothing refused → admit, not recorded (a save is already a lesson_saved/fact_saved event)", () => {
    expect(decideSync(MEMORY_LESSON_ADMIT, { seam: "pre" }, { run_id: "r", tool_call_id: null, recorder }).verdict).toBe("admit");
    expect(rows).toEqual([]);
  });
  it.each([...MEMORY_ADMIT_REASONS])("refused %s → refuse with that reason, recorded", (code) => {
    expect(decideSync(MEMORY_LESSON_ADMIT, { seam: "backstop", refused: code }, { run_id: "r", tool_call_id: null, recorder })).toMatchObject({ verdict: "refuse", reason: code });
    expect(rows).toEqual([{ verdict: "refuse", reason: code }]);
  });
});
```

`tests/decisions/schedule-admit.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { SCHEDULE_ADMIT, type ScheduleAdmitInput } from "../../src/decisions/entries/schedule-admit.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(SCHEDULE_ADMIT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const run = (s: ScheduleAdmitInput) => decideSync(SCHEDULE_ADMIT, s, { run_id: "r", tool_call_id: null, recorder });

describe("schedule.admit — every schedule_task change the model makes leaves an audit row (Decision 2-A)", () => {
  it("is rule-only, unlocked, always recorded, sound", () => {
    expect(SCHEDULE_ADMIT.locked).toBeUndefined();
    expect(SCHEDULE_ADMIT.alwaysRecord).toBe(true);
    expect(SCHEDULE_ADMIT.reasonCodes).toEqual(["create", "update", "cancel", "no_chat", "not_found", "cap"]);
    expect(entryProblems(SCHEDULE_ADMIT as unknown as AnyEntry)).toEqual([]);
  });
  it.each(["create", "update", "cancel"] as const)("admit %s → admit with the verb as reason, recorded", (verb) => {
    expect(run({ verb, outcome: "admit" })).toMatchObject({ verdict: "admit", reason: verb });
    expect(rows).toEqual([{ verdict: "admit", reason: verb }]);
  });
  it("a duplicate create → exists/create", () => {
    expect(run({ verb: "create", outcome: "exists" })).toMatchObject({ verdict: "exists", reason: "create" });
  });
  it.each([["none", "no_chat"], ["cancel", "not_found"], ["update", "not_found"], ["create", "cap"]] as const)("refuse %s/%s → refuse with the code", (verb, code) => {
    expect(run({ verb, outcome: "refuse", code })).toMatchObject({ verdict: "refuse", reason: code });
    expect(rows).toEqual([{ verdict: "refuse", reason: code }]);
  });
});
```

`tests/decisions/memory-correct-preflight.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { MEMORY_CORRECT_PREFLIGHT, MEMORY_CORRECT_REFUSALS } from "../../src/decisions/entries/memory-correct-preflight.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(MEMORY_CORRECT_PREFLIGHT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });

describe("memory.correct_preflight — a memory correction refused by a trust limit leaves a row", () => {
  it("is rule-only, unlocked, refusal-only, sound", () => {
    expect(MEMORY_CORRECT_PREFLIGHT.locked).toBeUndefined();
    expect(MEMORY_CORRECT_PREFLIGHT.alwaysRecord).toBeUndefined();
    expect(MEMORY_CORRECT_PREFLIGHT.reasonCodes).toEqual(["not_operator_turn", "tainted_turn", "too_many", "not_offered"]);
    expect(entryProblems(MEMORY_CORRECT_PREFLIGHT as unknown as AnyEntry)).toEqual([]);
  });
  it("allowed → allow, not recorded", () => {
    expect(decideSync(MEMORY_CORRECT_PREFLIGHT, { caller: "preflight", refused: null }, { run_id: "r", tool_call_id: null, recorder }).verdict).toBe("allow");
    expect(rows).toEqual([]);
  });
  it.each([...MEMORY_CORRECT_REFUSALS])("refused %s → refuse with that reason", (code) => {
    expect(decideSync(MEMORY_CORRECT_PREFLIGHT, { caller: "write", refused: code }, { run_id: "r", tool_call_id: null, recorder })).toMatchObject({ verdict: "refuse", reason: code });
    expect(rows).toEqual([{ verdict: "refuse", reason: code }]);
  });
});
```

In `tests/decisions/registry.test.ts`, after the Stage 4B `it(...)` block (ends at `:133`), add:
```ts
  it("memory.lesson_admit, schedule.admit and memory.correct_preflight are registered, unlocked and rule-only (Stage 4C)", () => {
    for (const id of ["memory.lesson_admit", "schedule.admit", "memory.correct_preflight"] as const) {
      const e = entryById(id) as AnyEntry;
      expect(e).toBeDefined();
      expect(e.locked).toBeUndefined();
      expect(e.ladder.map((r) => r.kind)).toEqual(["rule"]);
      expect(LOCKED_ENTRY_IDS).not.toContain(id);
    }
    expect(ENTRY_IDS).toHaveLength(23);
  });
```
and change the Stage 4B block's `expect(ENTRY_IDS).toHaveLength(20);` to `expect(ENTRY_IDS).toHaveLength(23);`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/decisions/memory-lesson-admit.test.ts tests/decisions/schedule-admit.test.ts tests/decisions/memory-correct-preflight.test.ts tests/decisions/registry.test.ts`
Expected: FAIL — cannot resolve the three entry modules; registry length 20.

- [ ] **Step 3: Write the entries**

`src/decisions/entries/memory-lesson-admit.ts`:
```ts
import type { Entry, RungAnswer } from "../types.js";

export type MemoryAdmitVerdict = "admit" | "refuse";
/** The code-owned memory-save refusals (spec 2026-10-30 §4.1): three before the distill, three backstop sides after it. */
export const MEMORY_ADMIT_REASONS = ["scheduled_run", "already_saved", "code_owned", "lesson_backstop", "fact_backstop", "fact_no_evidence"] as const;
export type MemoryAdmitReason = (typeof MEMORY_ADMIT_REASONS)[number];
export interface MemoryAdmitInput { seam: "pre" | "backstop"; refused?: MemoryAdmitReason }

function rule(s: MemoryAdmitInput): RungAnswer<MemoryAdmitVerdict> {
  return s.refused === undefined ? { verdict: "admit" } : { verdict: "refuse", reason: s.refused };
}

export const MEMORY_LESSON_ADMIT: Entry<MemoryAdmitInput, MemoryAdmitVerdict> = {
  id: "memory.lesson_admit", version: 1, stage: "pre_tool", input: "mixed",
  question: "Does this memory save (rule or fact) pass the code-owned admission checks?",
  verdicts: ["admit", "refuse"],
  ladder: [{ kind: "rule", name: "memoryAdmits", decide: rule }],
  fail: "refuse", defaultVerdict: "admit", outcomes: [], armed: { rule: "on" },
  effects: { admit: { kind: "none", reversible: true, announced: "none" }, refuse: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [...MEMORY_ADMIT_REASONS],
};
```

`src/decisions/entries/schedule-admit.ts`:
```ts
import type { Entry, RungAnswer } from "../types.js";

export type ScheduleAdmitVerdict = "admit" | "exists" | "refuse";
/** `none` only for no_chat: the notify-target check runs before the verb dispatch (spec 2026-10-30 §4.2). */
export type ScheduleAdmitVerb = "create" | "update" | "cancel" | "none";
export type ScheduleAdmitReason = "no_chat" | "not_found" | "cap";
export interface ScheduleAdmitInput { verb: ScheduleAdmitVerb; outcome: ScheduleAdmitVerdict; code?: ScheduleAdmitReason }

function rule(s: ScheduleAdmitInput): RungAnswer<ScheduleAdmitVerdict> {
  if (s.outcome === "refuse") return s.code !== undefined ? { verdict: "refuse", reason: s.code } : { verdict: "refuse" };
  return s.verb === "none" ? { verdict: s.outcome } : { verdict: s.outcome, reason: s.verb };
}

export const SCHEDULE_ADMIT: Entry<ScheduleAdmitInput, ScheduleAdmitVerdict> = {
  id: "schedule.admit", version: 1, stage: "pre_tool", input: "tool",
  question: "Does this schedule_task create, update or cancel pass the code-owned admission checks?",
  verdicts: ["admit", "exists", "refuse"],
  ladder: [{ kind: "rule", name: "scheduleAdmits", decide: rule }],
  fail: "refuse", defaultVerdict: "admit", alwaysRecord: true, outcomes: [], armed: { rule: "on" },
  effects: { admit: { kind: "none", reversible: true, announced: "none" }, exists: { kind: "none", reversible: true, announced: "none" },
    refuse: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["create", "update", "cancel", "no_chat", "not_found", "cap"],
};
```

`src/decisions/entries/memory-correct-preflight.ts`:
```ts
import type { Entry, RungAnswer } from "../types.js";

export type MemoryCorrectVerdict = "allow" | "refuse";
/** writeRefusal's trust limits (src/capabilities/memory-correct.ts), in their check order; both `too_many` checks map here. */
export const MEMORY_CORRECT_REFUSALS = ["not_operator_turn", "tainted_turn", "too_many", "not_offered"] as const;
export type MemoryCorrectRefusal = (typeof MEMORY_CORRECT_REFUSALS)[number];
export interface MemoryCorrectInput { caller: "preflight" | "write"; refused: MemoryCorrectRefusal | null }

function rule(s: MemoryCorrectInput): RungAnswer<MemoryCorrectVerdict> {
  return s.refused === null ? { verdict: "allow" } : { verdict: "refuse", reason: s.refused };
}

export const MEMORY_CORRECT_PREFLIGHT: Entry<MemoryCorrectInput, MemoryCorrectVerdict> = {
  id: "memory.correct_preflight", version: 1, stage: "pre_tool", input: "tool",
  question: "Does this memory retire or correct pass the code-owned trust limits?",
  verdicts: ["allow", "refuse"],
  ladder: [{ kind: "rule", name: "writeRefusal", decide: rule }],
  fail: "refuse", defaultVerdict: "allow", outcomes: [], armed: { rule: "on" },
  effects: { allow: { kind: "none", reversible: true, announced: "none" }, refuse: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [...MEMORY_CORRECT_REFUSALS],
};
```

In `src/decisions/entry-ids.ts:5` append `"memory.lesson_admit", "schedule.admit", "memory.correct_preflight"` to `ENTRY_IDS` (after `"secret.redact"`). In `src/decisions/registry.ts` import the three constants beside the other entry imports and append `MEMORY_LESSON_ADMIT as unknown as AnyEntry, SCHEDULE_ADMIT as unknown as AnyEntry, MEMORY_CORRECT_PREFLIGHT as unknown as AnyEntry` to `REGISTRY` after `SECRET_REDACT`. In `scripts/live-gate-ladder-stage4b.mjs:172` change the expected count 20 to 23 (read the line; keep its wording, change only the number and any "20" in its label).

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/decisions/ && npm run typecheck`
Expected: PASS; typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/entries/memory-lesson-admit.ts src/decisions/entries/schedule-admit.ts src/decisions/entries/memory-correct-preflight.ts src/decisions/entry-ids.ts src/decisions/registry.ts tests/decisions/memory-lesson-admit.test.ts tests/decisions/schedule-admit.test.ts tests/decisions/memory-correct-preflight.test.ts tests/decisions/registry.test.ts scripts/live-gate-ladder-stage4b.mjs
git commit -m "feat(decisions): register memory.lesson_admit, schedule.admit, memory.correct_preflight (rule-only, record never steer)"
```

---

### Task 2: `memory.lesson_admit` call sites and the lost-turn flush

**Files:**
- Modify: `src/capabilities/lesson-write.ts` (config field, `createMemoryWriteAdapter` at `:178–204`), `src/core/core-worker.ts` (`runMemoryWrite` `:2699–2726`; a `heldList` helper beside `heldRecorder` `:4577`)
- Test: `tests/capabilities/lesson-write-admit.test.ts` (new), `tests/core/memory-write-admit.test.ts` (new)

**Interfaces:**
- Consumes: `MEMORY_LESSON_ADMIT`, `MemoryAdmitReason` (Task 1).
- Produces: `MemoryWriteAdapterConfig.admitRecorder?: DecisionRecorder`.

- [ ] **Step 1: Write the failing adapter-level test** — `tests/capabilities/lesson-write-admit.test.ts`

Build configs the way `tests/capabilities/lesson-write*.test.ts` already do (read the nearest existing test for `createMemoryWriteAdapter`, copy its `sources`/`llm`/`save` stub helpers; synthetic text only). Each case gives `admitRecorder: { record: (e, r) => { rows.push([e.id, r.verdict, r.reason]); return null; } }` and asserts BOTH the tool result (unchanged shape) and `rows`:
```ts
// cases (each a separate it):
// 1. scheduledRun: true → output.reason "scheduled-run"; rows [["memory.lesson_admit","refuse","scheduled_run"]]; llm never called; srcContains never called.
// 2. alreadySaved: { lesson_id: 7 } → output.reason "already_saved_this_turn"; rows [[…,"refuse","already_saved"]]; srcContains never called (order kept: no grep on an early return).
// 3. empty instruction → ok:false error unchanged; rows [] (validation, not an admit).
// 4. srcContains: () => true with a quoted phrase in the instruction → output.reason "code-owned"; rows [[…,"refuse","code_owned"]]; llm never called.
// 5. distill → lesson rejected by backstop, fact saved → rows [[…,"refuse","lesson_backstop"]] and the save stub received only the fact.
// 6. distill → fact with no evidence, lesson saved → rows [[…,"refuse","fact_no_evidence"]].
// 7. distill → fact rejected by backstop and lesson rejected → rows contain lesson_backstop then fact_backstop (two rows, in that order).
// 8. clean save → rows [] (the adapter calls decideSync only at a refusal point, so the raw recorder receives nothing).
// 9. no admitRecorder given → identical tool results for cases 1, 4, 5 (the field is optional; existing callers unchanged).
```
For case 8 the adapter must make **no** `record` call at all (it records only where a refusal happens): assert `rows` is `[]` with the raw recorder above.

- [ ] **Step 2: Write the failing worker-level test** — `tests/core/memory-write-admit.test.ts`

Copy the `setup`/`seat` helpers from `tests/core/memory-write-service.test.ts:20–40` (same `ompWorker`, `createQueuedTurnRun`, synthetic texts). Cases:
```ts
// 1. scheduled run (createQueuedTurnRun with source schedule — use the helper the existing schedule-run memory test uses; grep "scheduled-run" in tests/core) →
//    store.listDecisionsForRun(run_id) has exactly one memory.lesson_admit row, verdict refuse, reason_code scheduled_run; memory_not_saved event unchanged.
// 2. backstop: distill {"kind":"both", lesson that checkLessonSide rejects, fact with evidence} → fact saved (fact_saved event), one admit row lesson_backstop,
//    AND the memory.kind row is still present exactly once (the held single-row recorder was not clobbered).
// 3. abort mid-save: pass o.signal from an AbortController aborted inside the llm seat (onCall) after the distill → no memory.lesson_admit row, no memory.kind row.
// 4. state replaced: replace worker's ompTurns entry for the run before the save (as the existing "turn ended" test does — grep "turn_ended" in tests/core) → no admit row.
// 5. race: set state.memorySavedThisTurn between the adapter's guard read and the save (as the existing racedBy test does — grep "racedBy" in tests/core) with a backstop-refused side → the backstop admit row IS written (live turn) while the result reason is already_saved_this_turn (spec §4.1: row and result may differ; this pins it).
// 6. recorder insert fault: make store.insertDecision throw once (vi.spyOn) on a scheduled-run save → tool result identical to case 1, an open incident of kind decision_record_failed.
```

- [ ] **Step 3: Run both to see them fail**

Run: `npx vitest run tests/capabilities/lesson-write-admit.test.ts tests/core/memory-write-admit.test.ts`
Expected: FAIL — `admitRecorder` unknown / no admit rows.

- [ ] **Step 4: Implement the adapter call sites** in `src/capabilities/lesson-write.ts`

Add imports:
```ts
import { decide, decideSync } from "../decisions/decide.js";
import { MEMORY_LESSON_ADMIT, type MemoryAdmitReason } from "../decisions/entries/memory-lesson-admit.js";
```
(replace the existing `import { decide } from "../decisions/decide.js";`).

Add to `MemoryWriteAdapterConfig` after `recorder`:
```ts
  /** memory.lesson_admit's recorder (spec 2026-10-30 §4.1): a held list the worker flushes under the lost-turn rule; absent = no rows. */
  admitRecorder?: DecisionRecorder;
```

Add below `memoryPreChecks`:
```ts
/** Today's early-return strings → memory.lesson_admit codes; the tool result keeps the strings. */
const PRE_ADMIT: Readonly<Record<string, MemoryAdmitReason>> = { "scheduled-run": "scheduled_run", [ALREADY_SAVED_REASON]: "already_saved", "code-owned": "code_owned" };
const SIDE_ADMIT: Readonly<Record<string, MemoryAdmitReason>> = { "rule:rejected_by_backstop": "lesson_backstop", "fact:rejected_by_backstop": "fact_backstop", "fact:no_evidence": "fact_no_evidence" };

/** Records one admit refusal (raw answer drives; the result is discarded, Stage 4B R1). */
function recordAdmit(c: Pick<MemoryWriteAdapterConfig, "admitRecorder" | "run_id">, seam: "pre" | "backstop", refused: MemoryAdmitReason | undefined): void {
  if (!c.admitRecorder || refused === undefined) return;
  decideSync(MEMORY_LESSON_ADMIT, { seam, refused }, { run_id: c.run_id, tool_call_id: null, recorder: c.admitRecorder });
}
const preReasonOf = (r: ToolAdapterResult): MemoryAdmitReason | undefined =>
  r.ok && typeof r.output.reason === "string" ? PRE_ADMIT[r.output.reason] : undefined;
```

In `createMemoryWriteAdapter`, change exactly these lines (order unchanged):
```ts
    const early = memoryPreChecks(c);
    if (early) { recordAdmit(c, "pre", preReasonOf(early)); return early; }
    const { scope, note } = clampScope(c, input);
    const owned = codeOwnedRefusal(c.sources.instruction.text, c, note);
    if (owned) { recordAdmit(c, "pre", preReasonOf(owned)); return owned; }
```
and after `const { plan, items } = planOf(c, kind.distill, scope);` add:
```ts
    for (const i of items) recordAdmit(c, "backstop", i.reason !== undefined ? SIDE_ADMIT[`${i.kind}:${i.reason}`] : undefined);
```
(`items` from `planOf` holds only refused sides, lesson first — `lesson-write.ts:297–300`.)

- [ ] **Step 5: Implement the worker flush** in `src/core/core-worker.ts`

Beside `heldRecorder` (`:4577`) add:
```ts
/** memory.lesson_admit's rows for one save (spec 2026-10-30 §4.1): kept in order, written once by runMemoryWrite's finally on a live turn. */
function heldList(inner: DecisionRecorder): { recorder: DecisionRecorder; write: () => void } {
  const rows: Array<Parameters<DecisionRecorder["record"]>> = [];
  return {
    recorder: { record: (entry, r, ctx) => { rows.push([entry, r, ctx]); return null; } },
    write: () => {
      for (const row of rows.splice(0)) {
        try { inner.record(...row); } catch (e) { console.error(`decisions: ${row[0].id} record threw past the recorder: ${safeReason(e)}`); }
      }
    }
  };
}
```
In `runMemoryWrite`: after `const held = heldRecorder(this.decisionRecorder);` add `const admit = heldList(this.decisionRecorder);`; in the adapter config after `recorder: held.recorder,` add `admitRecorder: admit.recorder,`; change the `finally` body to:
```ts
      if (!o.signal?.aborted && this.ompTurns.get(claim.run_id) === state) { held.write(); admit.write(); }
```
(keep the existing comment; extend it with "and memory.lesson_admit's rows".)

- [ ] **Step 6: Run the tests to see them pass, and the neighbours**

Run: `npx vitest run tests/capabilities/ tests/core/memory-write-service.test.ts tests/core/memory-write-admit.test.ts tests/core/core-worker-lesson-service.test.ts && npm run typecheck`
Expected: PASS; typecheck 0.

- [ ] **Step 7: Commit**

```bash
git add src/capabilities/lesson-write.ts src/core/core-worker.ts tests/capabilities/lesson-write-admit.test.ts tests/core/memory-write-admit.test.ts
git commit -m "feat(memory): memory.lesson_admit records each code-owned save refusal; rows flushed only on a live turn"
```

---

### Task 3: `schedule.admit` call sites

**Files:**
- Modify: `src/core/core-worker.ts` (`executeScheduleTask` `:3747–3897`; new private `admitSchedule`)
- Test: `tests/core/schedule-admit.test.ts` (new)

**Interfaces:**
- Consumes: `SCHEDULE_ADMIT`, `ScheduleAdmitVerb`, `ScheduleAdmitReason`, `ScheduleAdmitVerdict` (Task 1).

- [ ] **Step 1: Write the failing test** — `tests/core/schedule-admit.test.ts`

Copy the setup of `tests/core/core-worker-schedule-number.test.ts:1–46` (`pinOmpEnv`, `pinEnabledFlags`, `shortTmp`, `HOUGE_SCHEDULER_ENABLED=1`, `seed`, `scheduleCall` through `bridgeTurn`). Helper:
```ts
const admitRows = (run_id: string) => store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "schedule.admit").map((d) => [d.verdict, d.reason_code]);
```
Cases (each asserts the tool result is exactly what the merge base returns — reuse the existing error constants/digest builders — and the rows):
```ts
// create new → [["admit","create"]]
// same create again → [["admit","create"],["exists","create"]] and the digest names the first id
// at cap (process.env.HOUGE_SCHEDULER_MAX_PER_CHAT = "1", one seeded) → [["refuse","cap"]] with buildScheduleCapError(1)'s text
// cancel own → [["admit","cancel"]]; cancel bad shape, missing, other chat → [["refuse","not_found"]] each
// update own goal → [["admit","update"]]; update disabled/other chat/missing → [["refuse","not_found"]]
// update with nothing to change → SCHEDULE_TASK_UPDATE_EMPTY_ERROR and NO row (validation)
// create with an invalid spec → SCHEDULE_TASK_INVALID_SPEC_ERROR and NO row
// list → no row
// a non-telegram run (notify kind local, via a cli intake; grep SCHEDULE_TASK_NO_CHAT_ERROR in tests for an existing setup) for list and for create → [["refuse","no_chat"]] each
// verb precedence: {cancel:"1", update:"1", goal:"x"} → cancel's row only
```
Read `resolveSchedulerMaxPerChat` for the exact env name before writing the cap case.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/core/schedule-admit.test.ts`
Expected: FAIL — no `schedule.admit` rows.

- [ ] **Step 3: Implement**

Imports in `core-worker.ts`:
```ts
import { SCHEDULE_ADMIT, type ScheduleAdmitReason, type ScheduleAdmitVerb, type ScheduleAdmitVerdict } from "../decisions/entries/schedule-admit.js";
```
New private method beside `executeScheduleTask`:
```ts
  /** schedule.admit (spec 2026-10-30 §4.2): one row per schedule_task call that reached an admit decision; the raw branch drives. */
  private admitSchedule(run_id: string, verb: ScheduleAdmitVerb, outcome: ScheduleAdmitVerdict, code?: ScheduleAdmitReason): void {
    decideSync(SCHEDULE_ADMIT, { verb, outcome, ...(code !== undefined ? { code } : {}) }, { run_id, tool_call_id: null, recorder: this.decisionRecorder });
  }
```
Call it immediately before each of these returns in `executeScheduleTask` (and nowhere else):
- `target.kind !== "telegram"` → `this.admitSchedule(claim.run_id, "none", "refuse", "no_chat");`
- cancel: both `SCHEDULE_TASK_CANCEL_NOT_FOUND_ERROR` returns → `(claim.run_id, "cancel", "refuse", "not_found")`; the success return → `(claim.run_id, "cancel", "admit")`.
- update: the three `SCHEDULE_TASK_UPDATE_NOT_FOUND_ERROR` returns (shape, row, store late) → `(claim.run_id, "update", "refuse", "not_found")`; the success return → `(claim.run_id, "update", "admit")`. The empty-update, goal, spec, tz and uncomputable returns get **no** call.
- create: the duplicate return → `(claim.run_id, "create", "exists")`; the cap return → `(claim.run_id, "create", "refuse", "cap")`; the success return → `(claim.run_id, "create", "admit")`. Spec/tz/goal/uncomputable returns get no call.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/core-worker.ts tests/core/schedule-admit.test.ts
git commit -m "feat(schedule): schedule.admit records every schedule_task create, update and cancel decision"
```

---

### Task 4: `memory.correct_preflight` call sites

**Files:**
- Modify: `src/capabilities/memory-correct.ts` (`MemoryToolDeps` `:182`, `memoryWritePreflight` `:194`, `executeMemoryCorrect` `:207`, `writeRefusal` `:250`), `src/core/core-worker.ts` (`memoryDeps` `:3717`)
- Test: `tests/capabilities/memory-correct-preflight.test.ts` (new)

**Interfaces:**
- Consumes: `MEMORY_CORRECT_PREFLIGHT`, `MemoryCorrectRefusal` (Task 1).
- Produces: `MemoryToolDeps.recorder?: DecisionRecorder`.

- [ ] **Step 1: Write the failing test**

Build deps the way the existing `tests/capabilities/memory-correct*.test.ts` does (read it; copy its store/state helpers). Add `recorder` capturing `[entry.id, verdict, reason]` raw. Cases:
```ts
// preflight, run source schedule → refused not_operator_turn (result unchanged: { refused: { reason, text } }); rows [["memory.correct_preflight","refuse","not_operator_turn"]]
// preflight, tainted (runLoopCapabilities includes a non-clean step) → tainted_turn
// preflight, 6 ids → too_many; un-offered id → not_offered; changed=9 + 2 ids → too_many
// preflight passes (offered ids, telegram, clean) → card_detail unchanged; the raw recorder receives one call [["memory.correct_preflight","allow",null]] (recordedRefusal always calls decideSync); with storeRecorder over a real RunStore the same call stores 0 rows (shouldRecord drops the default verdict)
// executeMemoryCorrect gated, after a passing preflight, with state.offered cleared (the turn changed) → refusal("not_offered") text unchanged; raw rows [["memory.correct_preflight","refuse","not_offered"]]
// search action → no record call (not a write)
// parse refusal (bad input) → no record call
// deps without recorder → identical results for the not_operator_turn and pass cases
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/capabilities/memory-correct-preflight.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** in `memory-correct.ts`

Imports:
```ts
import { decideSync } from "../decisions/decide.js";
import { MEMORY_CORRECT_PREFLIGHT, type MemoryCorrectRefusal } from "../decisions/entries/memory-correct-preflight.js";
import type { DecisionRecorder } from "../decisions/types.js";
```
`MemoryToolDeps` gains:
```ts
  /** memory.correct_preflight's recorder (spec 2026-10-30 §4.3); absent = no row (tests that build deps without one). */
  recorder?: DecisionRecorder;
```
`writeRefusal`'s return type becomes `MemoryCorrectRefusal | null` (body unchanged). Add below it:
```ts
/** writeRefusal with its answer recorded (raw answer drives). */
function recordedRefusal(d: Pick<MemoryToolDeps, "store" | "run_id" | "state" | "recorder">, req: Exclude<MemoryRequest, { action: "search" }>,
  caller: "preflight" | "write"): MemoryCorrectRefusal | null {
  const refused = writeRefusal(d, req);
  if (d.recorder) decideSync(MEMORY_CORRECT_PREFLIGHT, { caller, refused }, { run_id: d.run_id, tool_call_id: null, recorder: d.recorder });
  return refused;
}
```
In `memoryWritePreflight` replace `writeRefusal(d, req)` with `recordedRefusal(d, req, "preflight")`; in `executeMemoryCorrect` replace `const refused = writeRefusal(d, req);` with `const refused = recordedRefusal(d, req, "write");`.
In `core-worker.ts` `memoryDeps`: add `recorder: this.decisionRecorder,` to the returned object.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/capabilities/ tests/core/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/memory-correct.ts src/core/core-worker.ts tests/capabilities/memory-correct-preflight.test.ts
git commit -m "feat(memory): memory.correct_preflight records the trust-limit answer at preflight and write"
```

---

### Task 5: Harness — `--old-dist-4b`, build stamp, exports, row filter

**Files:**
- Create: `scripts/stamp-dist.mjs`
- Modify: `scripts/old-dist-provenance.mjs` (add `verifyStampedDist`), `scripts/stage4-diff-lib.mjs` (`DISTS`, `EXPORTS`, `BIND_REDACT`), `scripts/check-ladder-stage4-differential.mjs` (args, provenance, ctx, `firstSurvivingString`)

**Interfaces:**
- Produces: `DISTS.s4b`, `ctx.dists.s4b`; corpora use `pairs: [["s4b", "new"]]`; `NEW_ROW_IDS` (exported Set of the five recorded-only ids); `export function distHash(dir): string`.

- [ ] **Step 1: `scripts/stamp-dist.mjs`** — `node scripts/stamp-dist.mjs <worktree>`: refuses unless `git -C <worktree> status --porcelain` is empty; runs `npm run build` in it (inherit stdio); then writes `<worktree>/dist/.provenance.json` = `{ head, clean: true, dist_sha256 }` where `dist_sha256` = sha256 over, for each file under `dist/` except `.provenance.json` sorted by relative path, `relpath + "\0" + sha256(contents) + "\n"`. Export `distHash(dir)` from `old-dist-provenance.mjs` and import it here (one implementation).

- [ ] **Step 2: `verifyStampedDist(oldDist, newDist)`** in `old-dist-provenance.mjs`: reads the stamp (missing → throw "run node scripts/stamp-dist.mjs <worktree> first"); worktree clean; HEAD === `stamp.head`; `distHash(oldDist) === stamp.dist_sha256`; `core/core-worker.js` differs from the new build's. Returns `{ head, hash }`. Existing `verifyOldDist` unchanged.

- [ ] **Step 3: lib** — `DISTS = { new: null, s3: null, s4a: null, s4b: null }`; `EXPORTS` gains `createMemoryWriteAdapter: "capabilities/lesson-write.js"`, `memoryWritePreflight: "capabilities/memory-correct.js"`, `executeMemoryCorrect: "capabilities/memory-correct.js"` (CoreWorker is already there), plus any helper the Task 6/7 fixtures import from a dist (add them in those tasks, by name). Rename `BIND_REDACT` to `NEW_ROW_IDS`, export it, and set it to `new Set(["approval.bind", "secret.redact", "memory.lesson_admit", "schedule.admit", "memory.correct_preflight"])` — this filters only those ids; `memory.kind` and every other row stay compared. Update `isBindRow` → `isNewRow` (same body, new set) and its doc comment.

- [ ] **Step 4: CLI** — `--old-dist-4b <dir>` (required; must contain `capabilities/lesson-write.js`); `verifyProvenance` also calls `verifyStampedDist(a.old4b, NEW_DIST)` and prints `s4b old build: worktree HEAD …, dist stamp …`; `DISTS.s4b`, `ctx.dists.s4b = await loadDist(args.old4b)`; `firstSurvivingString` skips objects whose `entry_id` is in `NEW_ROW_IDS` (import it) instead of the two-id literal; usage comment at the top gains the flag.

- [ ] **Step 5: Verify** — build the merge base: `git worktree add .worktrees/base-<mergebase7> <mergebase>`; `ln -s ../../node_modules .worktrees/base-<mergebase7>/node_modules` (as the 4B bases did — check `.worktrees/base-1451a66/node_modules`); `node scripts/stamp-dist.mjs .worktrees/base-<mergebase7>`. Then on the branch: `npm run build && node scripts/check-ladder-stage4-differential.mjs --old-dist-3 .worktrees/base-548cb87/dist --old-dist-4a .worktrees/base-1451a66/dist --old-dist-4b .worktrees/base-<mergebase7>/dist`
Expected: the five existing corpora PASS unchanged; exit 0. Then `touch .worktrees/base-<mergebase7>/dist/x.js` → exit 2 with the stamp error; remove the file → exit 0 again.

- [ ] **Step 6: Commit**

```bash
git add scripts/stamp-dist.mjs scripts/old-dist-provenance.mjs scripts/stage4-diff-lib.mjs scripts/check-ladder-stage4-differential.mjs
git commit -m "test(gate): Stage 4 differential gains a stamped merge-base pair and filters only the recorded-only entry rows"
```

---

### Task 6: Corpora `schedule` and `memcorrect`

**Files:**
- Create: `scripts/stage4-admit-fixture.mjs`, `scripts/stage4-corpora/schedule.mjs`, `scripts/stage4-corpora/memcorrect.mjs`

**Interfaces:**
- Consumes: `ctx.dists.s4b`, `NEW_ROW_IDS`, `mkStore`, `mkTemp`, `requireNew`, `closers` (Task 5).
- Produces: `adminWorker(d, root, store)` and `scheduleRun(d, store, kind)` in `stage4-admit-fixture.mjs`, reused by Task 7.

Corpus module shape (copy from `scripts/stage4-corpora/binding.mjs`): `export default { name, pairs: [["s4b", "new"]], min: { items, branches }, load, project, required }`.

- [ ] **Step 1: Fixture** — `stage4-admit-fixture.mjs` ports `tests/helpers/omp-worker.ts` `ompWorker` + `bridgeTurn` to JS against a dist's exports (`CoreWorker`, `createBridgeHandler`, `resolveOmpConfig`, `loadToolDeclarations`, `TOOL_DECLS_DIR`, `Gateway`, `buildTypedTaskEvent`; add the missing ones to `EXPORTS`), the omp dist copied the way `tests/helpers/omp-env.ts` `tmpOmpDist` does, `HOUGE_OMP_BIN` pinned to `/nonexistent/houge-tests/omp` (as `stage4-runlevel-fixture.mjs`), `HOUGE_SCHEDULER_ENABLED=1`, `HOUGE_SCHEDULER_MAX_PER_CHAT` set per item, fixed `tz` on every spec, and a fixed clock: wrap the call in a `Date` override (`globalThis.Date` subclass returning `2026-06-01T00:00:00.000Z` for `new Date()`/`Date.now()`) restored in `finally`. Env restored in `finally`.

- [ ] **Step 2: `schedule` corpus** — items (tags in brackets) per spec §6: non-telegram × {list, create, cancel, update} [`no_chat`]; cancel {bad shape, missing, other chat, store-refused (stub `cancelScheduledTask` → false)} [`not_found`]; update {bad shape, missing, other chat, disabled, store-refused} [`not_found`]; update {empty, bad goal, bad spec, bad tz} [`validation`]; create {new [`admit`], duplicate [`exists`], at cap [`cap`], bad spec/tz/goal/too long [`validation`]}; cancel own, update own [`admit`]; list [`list`]; verb pairs {cancel+update, cancel+create, update+create, list+cancel} [`precedence`]. Projection: the tool result + the run's ledger events + `scheduled_tasks` rows + `decisions` rows (NEW_ROW_IDS filtered by the harness), with `schedule_id` relabelled in order (`sch#1`…) inside strings and values. `required`: new side has exactly the expected `schedule.admit` rows `[verdict, reason_code]` per item (table in the corpus), old side none (throw in `project` if old has any). `min.items` = the item count; `min.branches` = every tag above.

- [ ] **Step 3: `memcorrect` corpus** — items: preflight × {not_operator_turn, tainted_turn, too_many ids, too_many changes, not_offered, pass-retire, pass-correct, search, bad input}; write × {pass-retire, pass-correct, offered cleared after preflight → not_offered, schedule-source}. Store seeded with synthetic facts; projection: result + `episodic_facts` rows + `memory_changes` rows + ledger events + decisions; `required`: expected `memory.correct_preflight` rows per item, read with the real `storeRecorder` (so the default `allow` is NOT stored).

- [ ] **Step 4: Run**

Run: `npm run build && node scripts/check-ladder-stage4-differential.mjs --old-dist-3 … --old-dist-4a … --old-dist-4b … --only schedule,memcorrect`
Expected: `PASS schedule`, `PASS memcorrect`, self-test ok, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/stage4-admit-fixture.mjs scripts/stage4-corpora/schedule.mjs scripts/stage4-corpora/memcorrect.mjs scripts/stage4-diff-lib.mjs
git commit -m "test(gate): schedule and memory-correct corpora for the Stage 4 differential"
```

---

### Task 7: Corpus `memadmit` (adapter and worker level)

**Files:**
- Create: `scripts/stage4-corpora/memadmit.mjs`

**Interfaces:**
- Consumes: `stage4-admit-fixture.mjs` (Task 6), `NEW_ROW_IDS`.

- [ ] **Step 1: Adapter items** — `createMemoryWriteAdapter` from each dist with stubbed `llm` (returns a fixed distill JSON per item), no `askJev`, a `save` stub that records the plan it got and returns a fixed `MemorySaveResult`, `srcContains` stub, synthetic `sources` built with the dist's `memorySources` if exported (add to `EXPORTS`) else a literal object of the same shape. Items: scheduled run; already saved {lesson, fact, both}; code-owned {instruction phrase, thread phrase}; empty instruction; backstop {lesson rejected + fact ok, fact no_evidence + lesson ok, both rejected, fact rejected_by_backstop}; clean {lesson, fact, both}; aborted {before kind, after kind}. The new side gets an `admitRecorder` that collects raw rows; the old side gets the same field (ignored by the old build). Projection: result + the plan the save stub received + the llm call count + srcContains call count (pins "no grep on an early return"). `required`: new-side admit rows equal the expected list per item.

- [ ] **Step 2: Worker items** — `runMemoryWrite` on a constructed worker (fixture) over a temp store, llm seats stubbed as in `tests/core/memory-write-service.test.ts` `seat`: scheduled run, already saved, code-owned, backstop refusal beside a saved fact, abort mid-save, state replaced, race. Projection: result + ledger events + lessons/facts/memory_changes rows + `decisions` rows (memory.kind compared; NEW_ROW_IDS filtered). `required`: admit rows per item (abort/replaced → 0; race → the backstop row).

- [ ] **Step 3: Run the whole differential**

Run: `npm run build && node scripts/check-ladder-stage4-differential.mjs --old-dist-3 .worktrees/base-548cb87/dist --old-dist-4a .worktrees/base-1451a66/dist --old-dist-4b .worktrees/base-<mergebase7>/dist`
Expected: all eight corpora PASS, `STAGE 4 DIFFERENTIAL: PASS`, exit 0, no `hg-s4d-*` left under `/tmp`.

- [ ] **Step 4: Commit**

```bash
git add scripts/stage4-corpora/memadmit.mjs scripts/stage4-diff-lib.mjs
git commit -m "test(gate): memory-save admit corpus at adapter and worker level"
```

---

### Task 8: Live gate `scripts/live-gate-ladder-stage4c.mjs`

**Files:**
- Create: `scripts/live-gate-ladder-stage4c.mjs`

Pattern: `scripts/live-gate-ladder-stage4b.mjs` (read it whole first): refuses to run outside `.worktrees/`, imports `../dist/`, `HOUGE_ENV_FILE` for env, a `VACUUM INTO` copy of `houge.sqlite` under a temp root removed in `finally` and on SIGINT/SIGTERM/SIGHUP, numbered `check(n, label, ok, detail)` lines, exit 0 only if all pass, prints counts and codes, never text.

- [ ] **Step 1: Write the eight lines of spec §7** on the copy, through the fixture of Task 6 (`adminWorker` over the copy's `RunStore.open` with `storeOptionsFor`):
1. scheduled-run save → result reason `scheduled-run`; exactly one admit row `refuse/scheduled_run`.
2. code-owned phrase (a phrase the gate reads from a real `src/*.ts` literal, e.g. `SCHEDULED_RUN_HINT`'s first words) → `refuse/code_owned`.
3. backstop lesson refusal + saved fact → one `refuse/lesson_backstop`, a `fact_saved` event, `memory.kind` row count 1.
4. clean lesson save → 0 admit rows, `lesson_saved` present.
5. schedule create → `admit/create`; again → `exists/create`; at cap → `refuse/cap`; cancel of another chat's id → `refuse/not_found`.
6. memory_correct retire with an un-offered id through the bridge preflight → no `approval_prompt` notification; `refuse/not_offered`.
7. `store.insertDecision` faulted once → a `decision_record_failed` incident opened, line 1's result byte-identical; separately an `admitRecorder` whose `record` throws → no incident, result identical.
8. `/status` decision count lines (call the CLI's status renderer from `dist/` over the copy) contain one line per new id.

- [ ] **Step 2: Run**

Run: `npm run build && HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-stage4c.mjs`
Expected: `8/8 PASS`, exit 0; the temp root gone. Then rerun `scripts/live-gate-ladder-stage4b.mjs` (count now 23): exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/live-gate-ladder-stage4c.mjs
git commit -m "test(gate): Stage 4C live gate — admit rows on a copy of the live DB, faults, /status lines"
```

---

### Task 9: Rollback check `scripts/check-ladder-stage4c-rollback.mjs`

**Files:**
- Create: `scripts/check-ladder-stage4c-rollback.mjs`

Pattern: `scripts/check-ladder-stage4b-rollback.mjs` (read whole; it uses `verifyOldDist` — use `verifyStampedDist` for `--old-dist` = the merge-base dist).

- [ ] **Step 1: Lines** — on a VACUUM copy: the new build writes one row of each new id (through its own call sites, as the live gate does); the old build then opens the copy (no migration, no error), renders `/status` and the digest (no throw), lists `decisions` (all rows present, count unchanged), and calls its `ENTRY_IDS`-validated writers naming each new id — `review_ok` in `outcomes.ts` and `insertLadderMove` (as `check-ladder-stage4b-rollback.mjs:248`) — asserting each refuses with its normal error, not a crash; the new build reopens the copy and still reads all rows.

- [ ] **Step 2: Run**

Run: `npm run build && node scripts/check-ladder-stage4c-rollback.mjs --old-dist .worktrees/base-<mergebase7>/dist`
Expected: every line PASS, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-ladder-stage4c-rollback.mjs
git commit -m "test(gate): Stage 4C rollback — the merge-base build reads the new rows and refuses writes naming the new ids"
```

---

## After the tasks (orchestrator, not a task)
Full suite + typecheck + build; the differential, live gate, 4B live gate and rollback on the final head; whole-branch reviews (most capable non-orchestrator model + codex whole-diff + security/correctness/testing/adversarial); docs sync (ADR 0030 amendment row drafted "awaiting Paco's signature" + index row, ROADMAP delta, `tasks/todo.md` state block, `tasks/lessons.md`, `sessions.md`); merge, push, rebuild, kickstart (Tier A).
