# Remainder slice R4 — `planner.crash_guard` + `turn.retry` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `planner.crash_guard` and `turn.retry` as rule-only, record-never-steer entries for the planner supervisor's spawn-or-halt and retry-or-fail decisions, recorded with the consulting turn's run, and prove zero behaviour change with the stamped merge-base differential (R3's supervisor fixture, extended), a live gate and a rollback check.

**Architecture:** Two entry modules under `src/decisions/entries/`. `ensureSession` gains the consulting `turn` (threaded from every caller) and reads the clock once for both the captured input and the raw `crashLooping(now)`; a new private `crashGuard(turn)` captures, calls the raw guard, records (only while `!turn.finished`) and returns the raw answer. `mayRetry` becomes a call to a pure exported `mayRetryOf` in `omp-frames.ts` (one predicate for code and rule) and records `turn.retry` on every consult (`alwaysRecord`). R3's `SupervisorDeps.recorder` and private `record()` helper are reused; `CoreWorker` already passes the recorder.

**Tech Stack:** Node 25, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest. Zero runtime deps.

**Plan status:** Rev 1.0 — for the plan review.

**Spec:** `docs/superpowers/specs/2026-11-01-ladder-remainder-r4-crash-retry-design.md` (Rev 1.2, APPROVED by Paco 2026-11-01: 1-A, 2-A). Read it before any task. Pattern slice: R3 (`docs/superpowers/plans/2026-11-01-remainder-r3-ack-steer.md`, shipped `c02a96c`).

## Rulings (orchestrator)
- **P1 — merge base and old builds.** The branch `remainder-r4` is cut from `main` after this plan's commit. Every commit on `main` after `c02a96c` is docs-only (verify: `git diff --stat c02a96c <merge base> -- src scripts tests` empty; Task 3 stops if not), so the `r4` old build is the **real merge base**, built and stamped in `.worktrees/base-<12-char sha>` (`npm ci && npm run build && node scripts/stamp-dist.mjs`, as for earlier pairs); no `--old-base-r4` is needed on the branch (merge-base discovery finds it); after the merge it is passed explicitly (`--old-base-r4 <full sha>`). Older pairs keep their invocations: s3 `base-548cb87`; 4A `base-1451a66`; 4B `base-c558413` + `--old-base c558413c3e248122256c3355b8852d3879aed3f6`; R1 `base-aec1d4f` + `--old-base-r1 aec1d4f9377f8fcebf883eaed8a81538b2cf8aef`; R2 `base-ef4d0d1` + `--old-base-r2 ef4d0d10fbcbe3077e10a28979891f0abd256b2f`; R3 `base-6c75b03` + `--old-base-r3 6c75b03bbbbb602a9cc4cc42f0bba54d6bfea255`.
- **P2 — `/kill`.** Any test, corpus or gate that could intake `kill` pins `HOUGE_TOMBSTONE_PATH` / `HOUGE_DISARM_PATH` to a temp dir and asserts no `houge.kill` in the cwd afterwards.
- **P3 — `HOUGE_TELEGRAM_CHAT_ID`** cleared (tests, differential) or a stub (gates) wherever a recorder fault is provoked.
- **P4 — exact tallies and rows, never filters (R2 P10; spec §6).** Every first spawn consults the crash guard, so every exact recorder-call tally on a spawn path gains `planner.crash_guard` calls. Tally rule: `planner.crash_guard` +1 per `ensureSession` call that reaches the guard — one per turn that spawns or is refused, +1 for a stale re-check, +1 per candidate omp refused at spawn. Known sites: `tests/omp/supervisor-decisions.test.ts` (`counts` arrays), `scripts/stage4-corpora/supervisor.mjs` (17 items' `calls`), and any `counts`/`calls` in `tests/core/supervisor-decision-wiring.test.ts`. Task 2 Step 0 greps the rest (`live-gate-omp`, `live-gate-jev-tree`, `live-gate-decisions-2a`, `live-gate-ladder-2b-hooks`, `live-gate-ladder-remainder-r3`, `check-ladder-remainder-r3-rollback`, `check-standing-rollback`) and lists each as "filters by entry" or "updated".
- **P5 — exact PASS values; one planted mutation per new assertion** (R2 lesson).
- **P6 — module names.** `scrubIds` from `scripts/stage4-bind-fixture.mjs`; `withPinnedEnv`, `withCountingClock` from `scripts/stage4-intake-fixture.mjs`; `countingRecorder` from `scripts/stage4-sender-fixture.mjs`; `mkStore`, `mkTemp`, `dumpDb`, `relabelClocks`, `requireNew`, `canon`, `DISTS`, `NEW_ROW_IDS` from `scripts/stage4-diff-lib.mjs`; `fakeSession`, `heldSession`, `sink`, `mkSupervisor`, `intakeRun`, `req`, `until`, `untilState`, `cleanup` from `scripts/stage4-supervisor-fixture.mjs`.
- **P7 — commit trailer** names the implementing model (`Co-Authored-By: Claude <Model> 5.5 <noreply@anthropic.com>`).
- **P8 — the live gates read live data.** The `command`/`path` corpora pin exact counts over live omp transcripts (re-pin in a `fix(gate):` commit if they drift); the 4B gate needs a scratch copy without `approval.bind`/`secret.redact` rows until its follow-up lands.
- **P9 — the late consult** (spec §4.0, Rev 1.2). The natural path (a lane turn whose warm start joins a start in flight that outlives two bounded 5 s waits) takes over 10 s of real time and cannot latch by itself (a superseded start pushes no exit). Tests and the corpus drive it at the seam: seed `exits` with three recent times (the field is a plain JS property on the dist object; in TS cast through `unknown`), then call the private `ensureSession(true, turn)` with a turn whose `finished` is true. Required: returns `"crash_loop"`, the latch is set, one `planner_crash_loop` incident, **zero** rows; the next real turn records `halt/latched`.
- **P10 — start failures** use `fakeSession({ noManifest: true })` with `manifestWaitMs: 20` in the TS harness (pattern `tests/omp/planner-supervisor.test.ts:470–488`) and the fixture's new `script.failStart` in `.mjs` (start rejects at once).
- **P11 — test-store access:** `store.db` is private; use `(store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db` (R3 P13). A recorder over the harness's own store is a lazy delegate (R3's `withRecorder` in `tests/omp/supervisor-decisions.test.ts`).

## Global Constraints

- `dependencies: {}` stays empty.
- **Behaviour identical** to the merge base: when the planner spawns, latches, re-arms, retries, steps up or fails; the `planner_crash_loop`, `planner_no_leg`, `planner_start_failed` incidents; `llm_attempt` rows; `routed_escalation` events; run failures; `RETRY_NOTE`; `PLANNER_CRASH_LOOP_TEXT`; and their order. The only new rows are `decisions` rows with `entry_id` `planner.crash_guard` or `turn.retry` — plus, only on an insert fault, `decision_record_failed` and its one operator alert.
- **Raw answer drives:** `crashLooping(now)`'s result and `mayRetryOf(...)` drive the branches; `decideSync` results are never used.
- **One clock read** in the crash guard: `now = Date.now()` once, passed to the capture and to `crashLooping(now)`; window test `t > now - CRASH_WINDOW_MS` (strict).
- **One predicate:** `mayRetryOf` in `src/omp/omp-frames.ts` beside `RETRYABLE_ERROR_KINDS`; `mayRetry` and the entry's rule both call it.
- **Recording rule (spec §4.0):** rows carry the consulting turn's `run_id` (passed in, never read from `this.turn`), `tool_call_id` null, no text. A crash-guard consult after its turn finished (`turn.finished`) writes no row; `laneEnded` alone does not suppress it.
- `planner.crash_guard`: `stage "supervision"`, `input "tool"`, unlocked, verdicts `spawn | halt`, default `spawn`, `fail: "halt"`, reasons `limit_reached`, `latched`; rows only for `halt`.
- `turn.retry`: `stage "supervision"`, `input "tool"`, unlocked, verdicts `retry | final`, default `final`, `fail: "final"`, `alwaysRecord: true`; reasons (12) `quota`, `auth`, `transport`, `timeout`, `model_missing`, `other_once`, `other_unrouted`, `other_retried`, `other_after_tool`, `model_refusal`, `aborted`, `spawn`; first match for `other`: `!routed` → `other_unrouted`, `retriedOther` → `other_retried`, `usedTool` → `other_after_tool`, else `other_once`.
- `src/omp/planner-supervisor.ts` and `src/omp/omp-frames.ts` are protected (`src/omp`): edits only as specified.
- Never write `houge.sqlite`; gates use a VACUUM copy deleted on every exit path. Synthetic text only; no message or error text in any row or print.
- New functions under 50 lines; tests in `tests/<area>/`.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/decisions/entries/planner-crash-guard.ts`, `turn-retry.ts` (new) | 1 | entries; `CRASH_LIMIT`, `CRASH_WINDOW_MS` move here |
| `src/omp/omp-frames.ts` (`mayRetryOf`) | 1 | one predicate |
| `src/decisions/entry-ids.ts`, `registry.ts`, `tests/decisions/registry.test.ts`, count literals in `scripts/` | 1 | 30 → 32 |
| `tests/decisions/planner-crash-guard.test.ts`, `turn-retry.test.ts` (new) | 1 | pins, ⇔ test |
| `src/omp/planner-supervisor.ts` (`ensureSession`, `afterWarm`, `startSession`, `startTurn`, `crashLooping`, new `crashGuard`, `mayRetry`) | 2 | thread turn, capture, record |
| `tests/omp/supervision-decisions.test.ts` (new), `tests/omp/supervisor-decisions.test.ts`, `tests/core/supervisor-decision-wiring.test.ts` | 2 | rows, tallies, wiring |
| `scripts/stage4-diff-lib.mjs`, `scripts/check-ladder-stage4-differential.mjs`, `scripts/stage4-supervisor-fixture.mjs`, `scripts/stage4-corpora/supervisor.mjs` | 3 | `r4` pair, fixture additions, R3 corpus tallies |
| `scripts/stage4-corpora/supervision.mjs` (new) | 4 | corpus |
| `scripts/live-gate-ladder-remainder-r4.mjs` (new) | 5 | live gate |
| `scripts/check-ladder-remainder-r4-rollback.mjs` (new) | 6 | rollback |

---

### Task 1: The two entries and the shared predicate

**Files:** Create `src/decisions/entries/planner-crash-guard.ts`, `src/decisions/entries/turn-retry.ts`; Modify `src/omp/omp-frames.ts` (after `RETRYABLE_ERROR_KINDS`, `:65`), `src/decisions/entry-ids.ts:5`, `src/decisions/registry.ts` (imports; `REGISTRY` tail after `INTAKE_STEER_OR_QUEUE`), `tests/decisions/registry.test.ts` (every `toHaveLength(30)`), every registry-count literal in `scripts/` (grep `=== 30`, `30 ids`, `(30)`); Test `tests/decisions/planner-crash-guard.test.ts`, `tests/decisions/turn-retry.test.ts`.

**Interfaces — Produces:** `export const CRASH_LIMIT = 3`, `export const CRASH_WINDOW_MS = 10 * 60_000`, `interface CrashGuardInput { latched: boolean; recent: number }`, `type CrashGuardVerdict = "spawn" | "halt"`, `PLANNER_CRASH_GUARD: Entry<CrashGuardInput, CrashGuardVerdict>`; `interface RetryInput { kind: LlmErrorKind; routed: boolean; usedTool: boolean; retriedOther: boolean }`, `type RetryVerdict = "retry" | "final"`, `RETRY_REASONS` (const tuple), `type RetryReason`, `TURN_RETRY: Entry<RetryInput, RetryVerdict>`; in `omp-frames.ts`: `export function mayRetryOf(i: { kind: LlmErrorKind; routed: boolean; usedTool: boolean; retriedOther: boolean }): boolean`.

- [ ] **Step 1: failing tests**

`tests/decisions/planner-crash-guard.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { CRASH_LIMIT, CRASH_WINDOW_MS, PLANNER_CRASH_GUARD } from "../../src/decisions/entries/planner-crash-guard.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(PLANNER_CRASH_GUARD as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: "r", tool_call_id: null, recorder };

describe("planner.crash_guard — 3 crash exits in 10 min halt spawning until re-armed (D2)", () => {
  it("is rule-only, unlocked, supervision, tool input, fails to halt, sound; the limits are today's", () => {
    expect(PLANNER_CRASH_GUARD.locked).toBeUndefined();
    expect(LOCKED_ENTRY_IDS).not.toContain("planner.crash_guard");
    expect(PLANNER_CRASH_GUARD.stage).toBe("supervision");
    expect(PLANNER_CRASH_GUARD.input).toBe("tool");
    expect(PLANNER_CRASH_GUARD.fail).toBe("halt");
    expect(PLANNER_CRASH_GUARD.defaultVerdict).toBe("spawn");
    expect(PLANNER_CRASH_GUARD.alwaysRecord).toBeUndefined();
    expect(PLANNER_CRASH_GUARD.reasonCodes).toEqual(["limit_reached", "latched"]);
    expect(PLANNER_CRASH_GUARD.effects.halt).toMatchObject({ kind: "tighten", reversible: true });
    expect(CRASH_LIMIT).toBe(3); expect(CRASH_WINDOW_MS).toBe(600_000);
    expect(entryProblems(PLANNER_CRASH_GUARD as unknown as AnyEntry)).toEqual([]);
  });
  it("latched → halt/latched, recorded (latched wins over a full window)", () => {
    expect(decideSync(PLANNER_CRASH_GUARD, { latched: true, recent: 5 }, ctx)).toMatchObject({ verdict: "halt", reason: "latched" });
    expect(rows).toEqual([{ verdict: "halt", reason: "latched" }]);
  });
  it("three recent exits → halt/limit_reached, recorded", () => {
    expect(decideSync(PLANNER_CRASH_GUARD, { latched: false, recent: 3 }, ctx)).toMatchObject({ verdict: "halt", reason: "limit_reached" });
    expect(rows).toEqual([{ verdict: "halt", reason: "limit_reached" }]);
  });
  it("two recent exits → spawn, not recorded", () => {
    expect(decideSync(PLANNER_CRASH_GUARD, { latched: false, recent: 2 }, ctx).verdict).toBe("spawn");
    expect(rows).toEqual([]);
  });
});
```

`tests/decisions/turn-retry.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { RETRY_REASONS, TURN_RETRY, type RetryInput } from "../../src/decisions/entries/turn-retry.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";
import type { LlmErrorKind } from "../../src/llm/audit.js";
import { classifyOmpError, mayRetryOf, RETRYABLE_ERROR_KINDS } from "../../src/omp/omp-frames.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(TURN_RETRY as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: "r", tool_call_id: null, recorder };
/** The nine kinds classifyOmpError can return (omp-frames.ts:68–78), each reached from a sample error text. */
const SAMPLES: Record<string, string> = { quota: "429 usage limit", auth: "401 unauthenticated", model_missing: "unknown model x", model_refusal: "refusal", aborted: "request aborted", timeout: "timed out", transport: "fetch failed", spawn: "spawn ENOENT", other: "something odd" };
const KINDS = Object.keys(SAMPLES) as LlmErrorKind[];
const all = (): RetryInput[] => KINDS.flatMap((kind) => [false, true].flatMap((routed) => [false, true].flatMap((usedTool) => [false, true].map((retriedOther) => ({ kind, routed, usedTool, retriedOther })))));

describe("turn.retry — a model error moves to the next model or fails the turn (D9)", () => {
  it("is rule-only, unlocked, supervision, tool input, records every consult, fails to final, sound", () => {
    expect(TURN_RETRY.locked).toBeUndefined();
    expect(TURN_RETRY.stage).toBe("supervision");
    expect(TURN_RETRY.input).toBe("tool");
    expect(TURN_RETRY.fail).toBe("final");
    expect(TURN_RETRY.defaultVerdict).toBe("final");
    expect(TURN_RETRY.alwaysRecord).toBe(true);
    expect(TURN_RETRY.reasonCodes).toEqual([...RETRY_REASONS]);
    expect(RETRY_REASONS).toEqual(["quota", "auth", "transport", "timeout", "model_missing", "other_once", "other_unrouted", "other_retried", "other_after_tool", "model_refusal", "aborted", "spawn"]);
    expect(TURN_RETRY.effects.retry).toMatchObject({ kind: "effect", reversible: false });
    expect(TURN_RETRY.effects.final).toMatchObject({ kind: "tighten", reversible: true });
    expect(entryProblems(TURN_RETRY as unknown as AnyEntry)).toEqual([]);
  });
  it("the samples classify to the nine kinds", () => {
    for (const k of KINDS) expect(classifyOmpError(SAMPLES[k] as string)).toBe(k);
  });
  it("mayRetryOf is today's mayRetry expression", () => {
    for (const i of all()) expect(mayRetryOf(i)).toBe(RETRYABLE_ERROR_KINDS.has(i.kind) || (i.kind === "other" && i.routed && !i.usedTool && !i.retriedOther));
  });
  it("verdict ⇔ mayRetryOf over all 72 inputs; every reason is a listed code and agrees with its verdict", () => {
    const retryReasons = new Set(["quota", "auth", "transport", "timeout", "model_missing", "other_once"]);
    for (const i of all()) {
      const r = decideSync(TURN_RETRY, i, ctx);
      expect(r.verdict).toBe(mayRetryOf(i) ? "retry" : "final");
      expect(RETRY_REASONS).toContain(r.reason);
      expect(retryReasons.has(r.reason as string)).toBe(r.verdict === "retry");
    }
    expect(rows).toHaveLength(72); // alwaysRecord: final rows too (Decision 1-A)
  });
  it("other: first match unrouted → retried → after_tool → once", () => {
    const o = (routed: boolean, usedTool: boolean, retriedOther: boolean) => decideSync(TURN_RETRY, { kind: "other", routed, usedTool, retriedOther }, ctx).reason;
    expect(o(false, true, true)).toBe("other_unrouted");
    expect(o(true, true, true)).toBe("other_retried");
    expect(o(true, true, false)).toBe("other_after_tool");
    expect(o(true, false, false)).toBe("other_once");
  });
  it("a non-other kind's reason is the kind", () => {
    expect(decideSync(TURN_RETRY, { kind: "quota", routed: false, usedTool: true, retriedOther: true }, ctx)).toMatchObject({ verdict: "retry", reason: "quota" });
    expect(decideSync(TURN_RETRY, { kind: "model_refusal", routed: true, usedTool: false, retriedOther: false }, ctx)).toMatchObject({ verdict: "final", reason: "model_refusal" });
  });
});
```

- [ ] **Step 2: run, see fail** — `npx vitest run tests/decisions/planner-crash-guard.test.ts tests/decisions/turn-retry.test.ts` → module not found.

- [ ] **Step 3: implement**

`src/omp/omp-frames.ts`, directly after `RETRYABLE_ERROR_KINDS`:
```ts
/**
 * turn.retry's predicate (spec R4 §4.2), shared by PlannerSupervisor.mayRetry and the entry's rule: a retryable kind, or
 * `other` once, on a routed turn, while no tool has run (a failure after a side effect is never re-spent on another model).
 */
export function mayRetryOf(i: { kind: LlmErrorKind; routed: boolean; usedTool: boolean; retriedOther: boolean }): boolean {
  if (RETRYABLE_ERROR_KINDS.has(i.kind)) return true;
  return i.kind === "other" && i.routed && !i.usedTool && !i.retriedOther;
}
```

`src/decisions/entries/planner-crash-guard.ts`:
```ts
import type { Entry, RungAnswer } from "../types.js";

/** The planner supervisor's crash latch (spec 2026-11-01 R4 §4.1): CRASH_LIMIT crash exits inside CRASH_WINDOW_MS latch it. */
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 10 * 60_000;
export type CrashGuardVerdict = "spawn" | "halt";
/** Captured in ensureSession with the same `now` the raw crashLooping(now) uses. */
export interface CrashGuardInput { latched: boolean; recent: number }

function rule(s: CrashGuardInput): RungAnswer<CrashGuardVerdict> | CrashGuardVerdict {
  if (s.latched) return { verdict: "halt", reason: "latched" };
  if (s.recent >= CRASH_LIMIT) return { verdict: "halt", reason: "limit_reached" };
  return "spawn";
}

export const PLANNER_CRASH_GUARD: Entry<CrashGuardInput, CrashGuardVerdict> = {
  id: "planner.crash_guard", version: 1, stage: "supervision", input: "tool",
  question: "Before spawning an omp child: is the planner crash-looping, so the spawn is refused until /rearm or a sweep re-arms it?",
  verdicts: ["spawn", "halt"],
  ladder: [{ kind: "rule", name: "crash_looping", decide: rule }],
  fail: "halt", defaultVerdict: "spawn", outcomes: [], armed: { rule: "on" },
  effects: {
    spawn: { kind: "none", reversible: true, announced: "none" },
    halt: { kind: "tighten", reversible: true, announced: "none", what: "no child is spawned; the turn fails crash_loop (a lane turn still completes); /rearm or the next sweep that runs clears it" }
  },
  reasonCodes: ["limit_reached", "latched"],
};
```
(Check `RuleRung.decide`'s return type, `types.ts:54`: `V | RungAnswer<V, D> | RungAbstain<V, D>`; returning a bare verdict for `spawn` is allowed — match how an existing entry returns a no-reason verdict, e.g. `intake-sender.ts`, and follow it.)

`src/decisions/entries/turn-retry.ts`:
```ts
import type { LlmErrorKind } from "../../llm/audit.js";
import { mayRetryOf } from "../../omp/omp-frames.js";
import type { Entry, RungAnswer } from "../types.js";

/** Retry reasons first (the five retryable kinds, then `other_once`), then the final ones (spec 2026-11-01 R4 §4.2). */
export const RETRY_REASONS = ["quota", "auth", "transport", "timeout", "model_missing", "other_once", "other_unrouted", "other_retried", "other_after_tool", "model_refusal", "aborted", "spawn"] as const;
export type RetryReason = (typeof RETRY_REASONS)[number];
export type RetryVerdict = "retry" | "final";
/** Captured in mayRetry from the values it reads (retriedOther is set after the decision, so this is the pre-decision value). */
export interface RetryInput { kind: LlmErrorKind; routed: boolean; usedTool: boolean; retriedOther: boolean }

function reasonOf(s: RetryInput): string {
  if (s.kind !== "other") return s.kind; // a kind outside RETRY_REASONS (unreachable from classifyOmpError) is nulled by rowOf
  if (!s.routed) return "other_unrouted";
  if (s.retriedOther) return "other_retried";
  if (s.usedTool) return "other_after_tool";
  return "other_once";
}

function rule(s: RetryInput): RungAnswer<RetryVerdict> {
  return { verdict: mayRetryOf(s) ? "retry" : "final", reason: reasonOf(s) };
}

export const TURN_RETRY: Entry<RetryInput, RetryVerdict> = {
  id: "turn.retry", version: 1, stage: "supervision", input: "tool",
  question: "A model error ended the turn's current leg: move to the next model, or fail the turn?",
  verdicts: ["retry", "final"],
  ladder: [{ kind: "rule", name: "may_retry", decide: rule }],
  fail: "final", defaultVerdict: "final", outcomes: [], armed: { rule: "on" }, alwaysRecord: true,
  effects: {
    retry: { kind: "effect", reversible: false, announced: "none", what: "another model continues the turn with RETRY_NOTE; a step-up is ledgered" },
    final: { kind: "tighten", reversible: true, announced: "none", what: "the turn fails with today's error text" }
  },
  reasonCodes: [...RETRY_REASONS],
};
```
(`RungAnswer.reason`'s type: if it is the entry's reason union rather than `string`, type `reasonOf` accordingly — read `types.ts` and `intake-steer-or-queue.ts`.) Register both: `entry-ids.ts` `ENTRY_IDS` gains `"planner.crash_guard"`, `"turn.retry"` (not `LOCKED_ENTRY_IDS`); `registry.ts` imports and appends `PLANNER_CRASH_GUARD`, `TURN_RETRY` after `INTAKE_STEER_OR_QUEUE`. Update every 30 → 32 literal found by the grep. Do **not** touch `planner-supervisor.ts` in this task (its local `CRASH_LIMIT`/`CRASH_WINDOW_MS` move in Task 2).

- [ ] **Step 4: run, see pass** — `npx vitest run tests/decisions/ && npm run typecheck`. Plant two mutations, one at a time, and show each failing: swap the `latched` and `limit_reached` branches (the "latched wins" test fails); swap `other_retried` and `other_after_tool` (first-match test fails). Revert.
- [ ] **Step 5: commit** — `feat(decisions): planner.crash_guard and turn.retry entries; mayRetryOf shared predicate`.

---

### Task 2: Thread the turn, capture, record

**Files:** Modify `src/omp/planner-supervisor.ts` (imports; delete local `CRASH_WINDOW_MS`/`CRASH_LIMIT` `:150–151` in favour of the entry's exports; `startTurn` warm call `:600`; `startSession` `:986–997`; `afterWarm` `:1004–1008`; `ensureSession` `:954–968`; `mayRetry` `:923–926`; `crashLooping` `:1041–1049`; new private `crashGuard`); Test `tests/omp/supervision-decisions.test.ts` (new), `tests/omp/supervisor-decisions.test.ts` (tallies), `tests/core/supervisor-decision-wiring.test.ts` (wiring cases), any gate Step 0 finds.

**Interfaces — Consumes:** Task 1's entries, `CRASH_LIMIT`, `CRASH_WINDOW_MS`, `mayRetryOf`. **Produces:** nothing exported (private signatures: `ensureSession(fresh: boolean, turn: Turn)`, `afterWarm(warm, turn: Turn)`, `crashLooping(now: number)`, `crashGuard(turn: Turn): boolean`).

- [ ] **Step 0: grep (P4)** — list every exact tally/count on a spawn path (`rg -n "counts\)|calls:|toEqual\(\[\"intake|decisions" tests/omp tests/core scripts/live-gate-*.mjs scripts/check-*rollback.mjs scripts/stage4-corpora`); record each site in the report as "filters by entry" or "updated". (The R3 corpus `supervisor.mjs` tallies are Task 3's.)

- [ ] **Step 1: failing tests** — `tests/omp/supervision-decisions.test.ts`, built like `tests/omp/supervisor-decisions.test.ts` (copy its `withRecorder`, `rows` with `entry_id IN ('planner.crash_guard','turn.retry')`, `q`, P11). Use `failing`/`routed` helpers as in `tests/omp/planner-supervisor.test.ts:1560–1625` (copy them; read their definitions there). Cases, each asserting the exact rows `[entry, verdict, reason, run_id, null]`, the exact `counts` (P4 rule), and the unchanged behaviour the existing test of the same path asserts:

| # | scenario | rows | behaviour pinned |
|---|---|---|---|
| 1 | clean turn | `[]`; counts `["intake.steer_or_queue","planner.crash_guard"]` | completed |
| 2 | 3 failed starts (P10), then turn 4 | turn 4: `[crash_guard, halt, limit_reached, r4]` | r4 failed `planner_exit`/`crash_loop`; one `planner_crash_loop` incident; starts 3 |
| 3 | then turn 5 | `[…, halt, latched, r5]` | still 3 starts; one incident |
| 4 | `sup.resetCrashGuard()`, turn 6 | no new row | starts 4 |
| 5 | latched, lane turn (triage `lane_reply`) | `[crash_guard, halt, latched, lane run]` | lane run completed with the lane text |
| 6 | 2 failed starts, then a good turn | `[]` | completed |
| 7 | late consult (P9) | `[]`, then next turn `halt/latched` | `"crash_loop"`, latch set, one incident |
| 8 | boundary: exits seeded at `now − CRASH_WINDOW_MS` exactly ×3 (fake `Date` via `vi.useFakeTimers({ toFake: ["Date"] })`), turn | `[]` | spawned (strict `>`) |
| 9 | quota then success (`fakeSession` as `planner-supervisor.test.ts:121–129`) | `[turn.retry, retry, quota, r]` | prompts `["hi", RETRY_NOTE]`, completed |
| 10 | `model_refusal` | `[turn.retry, final, model_refusal, r]` | failed `model_error`/`model_refusal`, prompts `["hi"]` |
| 11 | `other` unrouted | `[final, other_unrouted]` | failed `model_error`/`other` |
| 12 | routed default, `other` ×2 (`failing(["something odd","something odd"])`) | `[retry, other_once]`, `[final, other_retried]` | failed `model_error`/`other` |
| 13 | routed fast, `tool_execution_start` then `other` | `[final, other_after_tool]` | prompts `["hi"]` |
| 14 | routed fast, `todo` tool then `other` ×2 | `[retry, other_once]`, `[final, other_retried]` | prompts `["hi", RETRY_NOTE]` |
| 15 | routed fast, quota ×2 → step-up (`:1578`) | `[retry, quota]` ×2 | escalation `{from:"fast",to:"default",kind:"quota"}`, completed |
| 16 | async-work-only end with an error (`:1895`) | `[]` (crash_guard counted, no retry consult) | failed `model_error`, prompts `["hi"]` |
| 17 | throwing recorder on case 9 and case 2 | no rows, no incident | effects identical to 9 and 2 |
| 18 | insert fault (recorder over a store whose `insertDecision` throws, as R3's case for faults) on case 2 | one `decision_record_failed`, outbox +1 at the fault (delta, R3 ruling 2) | effects identical |

Also a mirror test: the private `crashLooping(now)` result equals `rule(capture).verdict === "halt"` for `latched ∈ {t,f}` × `recent ∈ {0,2,3,4}`, driving it by seeding `exits`/`crashLatched` through `unknown` casts.

Wiring (`tests/core/supervisor-decision-wiring.test.ts`, extend R3's): through `CoreWorker.submitTurn` with the fake omp, (a) a first leg erroring `quota` then success → the `turn.retry` `retry/quota` row exists on the run; (b) three failed starts (fake omp `rpcStderrAtStart`, `tests/fixtures/fake-omp.mjs:47`) then a turn → the `planner.crash_guard` `halt/limit_reached` row exists.

- [ ] **Step 2: run, see fail** — `npx vitest run tests/omp/supervision-decisions.test.ts tests/core/supervisor-decision-wiring.test.ts` → rows missing.

- [ ] **Step 3: implement** in `planner-supervisor.ts`:
```ts
// imports
import { CRASH_LIMIT, CRASH_WINDOW_MS, PLANNER_CRASH_GUARD, type CrashGuardInput } from "../decisions/entries/planner-crash-guard.js";
import { TURN_RETRY, type RetryInput } from "../decisions/entries/turn-retry.js";
// add mayRetryOf to the existing omp-frames import; delete the local CRASH_WINDOW_MS / CRASH_LIMIT consts

// startTurn (:600)
const warm: Promise<StartResult> = this.ensureSession(true, turn).catch((e): StartResult => `spawn_failed: ${message(e)}`);
// startSession (:988)
const r = await this.step(turn, warm ? this.afterWarm(warm, turn) : this.ensureSession(fresh, turn));
// afterWarm
private async afterWarm(warm: Promise<StartResult>, turn: Turn): Promise<StartResult> {
  const r = await warm;
  if (r !== null) return r;
  return this.session && !this.stale ? null : this.ensureSession(true, turn);
}
// ensureSession(fresh: boolean, turn: Turn): the line `if (this.crashLooping()) return "crash_loop";` becomes
if (this.crashGuard(turn)) return "crash_loop";

/** planner.crash_guard (spec R4 §4.1): one clock read for the capture and the raw guard, which drives; no row after the turn ended (§4.0). */
private crashGuard(turn: Turn): boolean {
  const now = Date.now();
  const input: CrashGuardInput = { latched: this.crashLatched, recent: this.exits.filter((t) => t > now - CRASH_WINDOW_MS).length };
  const halt = this.crashLooping(now);
  if (!turn.finished) this.record(PLANNER_CRASH_GUARD, input, turn.req.run_id);
  return halt;
}

/** CRASH_LIMIT crash exits within CRASH_WINDOW_MS latch the guard (incident once); it holds until resetCrashGuard(). */
private crashLooping(now: number): boolean {
  if (this.crashLatched) return true;
  const cutoff = now - CRASH_WINDOW_MS;
  this.exits = this.exits.filter((t) => t > cutoff);
  if (this.exits.length < CRASH_LIMIT) return false;
  this.crashLatched = true;
  this.incident("planner_crash_loop", { exits: this.exits.length });
  return true;
}

/** turn.retry (spec R4 §4.2): recorded on every consult (Decision 1-A); mayRetryOf, the same predicate as the rule, drives. */
private mayRetry(turn: Turn, kind: LlmErrorKind): boolean {
  const input: RetryInput = { kind, routed: turn.route !== null, usedTool: turn.usedTool, retriedOther: turn.retriedOther };
  this.record(TURN_RETRY, input, turn.req.run_id);
  return mayRetryOf(input);
}
```
Keep every other line of these functions as it is; keep their existing doc comments (update the `crashLooping` one only as shown). Update the R3 tallies in `tests/omp/supervisor-decisions.test.ts` per P4 (e.g. case 1 becomes `["intake.steer_or_queue", "planner.crash_guard"]`; a turn's crash-guard consult follows its `runTurn` consult).

- [ ] **Step 4: run, see pass** — `npx vitest run tests/omp/ tests/core/ tests/decisions/ && npm run typecheck`; `tests/omp/planner-supervisor.test.ts` unchanged and green. Plant four mutations, one at a time, each failing: capture `recent` with a second `Date.now()` read after `crashLooping` (case 8 fails under the fake clock advanced between reads — if it does not, say so and record why); drop the `!turn.finished` guard (case 7 fails); read the run id from `this.turn` instead of `turn` in `crashGuard` (case 7 or 5 fails — show which); record `turn.retry` only when `mayRetryOf` is true (cases 10–13 fail). Revert.
- [ ] **Step 5: commit** — `feat(omp): record planner.crash_guard and turn.retry with the consulting turn's run` (+ gates updated in Step 0).

---

### Task 3: Harness — `r4` pair, fixture additions, R3 corpus tallies

**Files:** Modify `scripts/stage4-diff-lib.mjs` (`DISTS`, `R4_IDS`, `NEW_ROW_IDS`), `scripts/check-ladder-stage4-differential.mjs` (flags, provenance, ctx, usage, full post-merge command comment), `scripts/stage4-supervisor-fixture.mjs`, `scripts/stage4-corpora/supervisor.mjs` (tallies).

- [ ] **Step 1: old build (P1).** `MB=$(git merge-base HEAD main)`; verify `git diff --stat c02a96c $MB -- src scripts tests` is empty (stop and report if not); `git worktree add .worktrees/base-${MB:0:12} $MB`, then in it `npm ci && npm run build && node scripts/stamp-dist.mjs` (read `stamp-dist.mjs` for its arguments).
- [ ] **Step 2: lib/CLI.** `DISTS.r4`; `export const R4_IDS = ["planner.crash_guard", "turn.retry"]`; every `NEW_ROW_IDS` set gains `...R4_IDS` (incl. `r3`); `r4: new Set(R4_IDS)`; `--old-dist-r4 <dir>` (required; provenance `omp/planner-supervisor.js`) and `--old-base-r4 <sha>` (post-merge only); `EXPORTS` gains nothing unless the corpus needs it.
- [ ] **Step 3: fixture.** In `fakeSession`: `models: []` and `setModel: async (m) => { s.models.push(\`${m.provider}/${m.model}\`); }` (the TS harness records `provider/model` — match it); one ordered `log` array that `prompt`, `steer` and `setModel` each push to (`["prompt", t]`, `["steer", t]`, `["set_model", "p/m"]`); `exit(code)` as the TS harness `:143` (destroy sockets, call exit callbacks with `{ code, signal: null, stopped: false }`); `script.failStart` → `start()` rejects `new Error("fixture start failed")` before opening the socket. In `mkSupervisor`: `opts.roles` (a `{ default, fast, thinking }` lists object) overrides `LISTS`. Keep the file's existing behaviour for every R3 caller.
- [ ] **Step 4: R3 corpus tallies.** Every `supervisor.mjs` item's `calls` gains `planner.crash_guard` per the P4 rule (rows unchanged: every R3 item spawns successfully, so `spawn` writes none).
- [ ] **Step 5: verify** — `npm run build`; full differential with every pair's flags plus `--old-dist-r4 /Users/xiaochuan/Projects/adventure/.worktrees/base-<sha>/dist` → every existing corpus PASS (P8 re-pins only on drift); `same_build` mutation (point `--old-dist-r4` at the new dist) → exit 2.
- [ ] **Step 6: commit** — `test(gate): differential gains the r4 pair; supervisor fixture logs set_model, exits, fails starts`.

---

### Task 4: Corpus `supervision`

**Files:** Create `scripts/stage4-corpora/supervision.mjs` (pattern: `scripts/stage4-corpora/supervisor.mjs`, read whole).

- [ ] **Step 1: items** — spec §6's list, each on a fresh store and supervisor, the same scenario on old (`DISTS.r4`, no `recorder`) and new dist (`countingRecorder` over `d.storeRecorder(store)`): crash — 3 failed starts + turn 4 (`limit_reached`), + turn 5 (`latched`), reset + turn 6 (no row), a ready child's crash exit ×3 across turns + a turn (`limit_reached`), lane turn while latched (`latched` on the lane run), 2 failed starts + good turn (no row), a run claimed by another worker before `submit` with the guard latched (zero R4 calls and rows), the late consult (P9: zero rows; one incident; next turn `latched`); retry — quota then success (Default role with two candidates via `opts.roles`), timeout on every leg until exhausted (one `retry/timeout` per leg, then `no_planner_leg`), `other` unrouted, routed `other` ×2, `other` after a tool, `other` after only `todo`, `model_refusal`, async-work-only end (no `turn.retry` row), routed Fast quota step-up (`retry/quota` ×2 + `routed_escalation`).
- [ ] **Step 2: project / required** — compared: the session's ordered `log`, the sink's `done`/`failed`/`incidents` (worker ids scrubbed), and `dumpDb(store, { dropDecisionIds: [...all new-row ids] })` → `relabelClocks` → `scrubIds`; the old side throws if any `R4_IDS` row exists. Required: exact new rows per item `[entry, verdict, reason, run label, null]` (run labels by submission order, as `supervisor.mjs` labels them) and exact per-entry recorder call counts. Coverage + determinism self-tests; two planted mutations each fail `required` once: the crash-guard rule's `latched`/`limit_reached` swapped; `other_retried`/`other_after_tool` swapped (spec §6).
- [ ] **Step 3: run** `--only supervision`, then the full differential → every corpus PASS (14 corpora).
- [ ] **Step 4: commit** — `test(gate): supervision corpus — crash guard and retry over the dist supervisor`.

---

### Task 5: Live gate `scripts/live-gate-ladder-remainder-r4.mjs`

Pattern: `scripts/live-gate-ladder-remainder-r3.mjs` (read whole). The Task 3 fixture's supervisor on a VACUUM copy (chat id `-1003`), a fake session (no real omp child), stub Telegram, P2/P3 pins. Spec §7's eight lines with exact values (P5): line 1 quota → `retry/quota` once, `RETRY_NOTE` once, completed once; line 2 `final/model_refusal`; line 3 routed `other` ×2; line 4 three failed starts → `halt/limit_reached`, one incident, then `halt/latched`, then reset → spawn and zero new rows; line 5 a clean turn → zero rows for both ids; line 6 through `CoreWorker.submitTurn` with the production deps on the copy (fake omp as in Task 2's wiring test) → line 1's row; line 7 two separate faults: insert faulted → `decision_record_failed` and exactly one alert to the stub chat, line 1's and line 4's effects unchanged; a throwing recorder → zero incidents, zero alerts, effects unchanged; line 8 `/status` count lines for both ids from SQL over the 24 h window. Show lines 1, 4 and 7 failing once each under a planted mutation. Update registry-count literals if the R3 gate pins 30. Rerun the R3, R2, R1, 4C (`--old-dist .../base-c558413/dist --old-base c558413…`) and 4B (P8) gates: exit 0. Commit `test(gate): remainder R4 live gate — crash guard and retry on a copy of the live DB, faults`.

---

### Task 6: Rollback check `scripts/check-ladder-remainder-r4-rollback.mjs`

Pattern: `scripts/check-ladder-remainder-r3-rollback.mjs` (read whole). Seed rows of each new id through the real supervisor path on copy F (`halt/limit_reached`, `halt/latched`, `retry/quota`, `final/model_refusal`); the old build (`base-<sha>` from Task 3) opens A and F with no migration, renders `/status` (the two count lines exact from SQL; every other line byte-identical A vs F) and the digest (raw arrays identical A vs F), reads every row unchanged (`rung`, `entry_version`, `verdict`, `reason_code`, `run_id`), and refuses `review_ok` naming each new id; the new build reopens F. Run: every line PASS, exit 0; one planted mutation failing. Commit `test(gate): remainder R4 rollback — the merge-base build reads the new supervision rows`.

---

## After the tasks (orchestrator)
Full suite + typecheck + build on a quiet machine; the full differential (every pair, 14 corpora); R4, R3, R2, R1, 4C, 4B gates; R4 rollback; final whole-branch reviews (most capable non-orchestrator model, a mutation pass, codex whole-diff); one fix wave; docs sync — ADR 0030 amendment "awaiting Paco's signature" (two entries; the threaded turn and the late-consult rule per §5; one clock read; one predicate; Decisions 1-A, 2-A; the R12 consequence for `turn.retry`), index row, ladder §6.1 note, ROADMAP delta, state block, lessons, sessions; merge, push, rebuild, kickstart (Tier A).
