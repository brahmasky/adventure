# Remainder slice R3 — `intake.bare_ack` + `intake.steer_or_queue` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `intake.bare_ack` (locked) and `intake.steer_or_queue` as rule-only, record-never-steer entries for `PlannerSupervisor.submit`'s nudge / steer / queue decision, recorded at the incoming run's claim, and prove zero behaviour change with a stamped merge-base differential (new supervisor fixture), a live gate and a rollback check.

**Architecture:** Two entry modules under `src/decisions/entries/`. `submit` keeps branching exactly as today; it captures each decision's input from the same values the branch reads, and the row is written where the incoming run is claimed (ADR 0030 §5: a lost turn writes no row): `nudgeAck` and `steer` after their `claimRun`, and `runTurn` after its claim for a queued request (the captured input rides on the request). `SupervisorDeps` gains an optional `recorder`; `CoreWorker` passes its lazy `decisionRecorder`.

**Tech Stack:** Node 25, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest. Zero runtime deps.

**Plan status:** Rev 1.1 — after the plan review: senior (Sonnet 5.5; applied and ran Tasks 1–2 in a worktree: implementation verbatim typechecks, `tests/omp/planner-supervisor.test.ts` 169/169 unchanged, all 15 cases reachable and passing after test-code fixes; probed a dist-only fixture on both builds) and codex (3 B / 2 W); every finding verified first-hand and applied (rulings P9–P13, Tasks 1–6); codex scoped re-review: all closed, one warning (corpus `not_running` item, the `submit`-consult mutation) applied.

**Spec:** `docs/superpowers/specs/2026-11-01-ladder-remainder-r3-ack-steer-design.md` (Rev 1.2, APPROVED by Paco 2026-11-01: 1-A, 2-A). Read it before any task. Pattern slice: R2 (`docs/superpowers/plans/2026-11-01-remainder-r2-sender-contract.md`).

## Rulings (orchestrator)
- **P1 — merge base and old builds.** The branch is cut from `main` after this plan's commit; its merge base is a docs-only commit. The `r3` old build is pinned to `6c75b03` explicitly (codex B1): `git diff --stat 6c75b03 <branch merge base> -- src scripts tests` is empty (verified for `2631e56`; Task 3 re-verifies against the real merge base and stops if it is not), so the stamped build is the branch's code base. The `r3` pair's old build: `.worktrees/base-6c75b03`, stamped, with `--old-base-r3 <full 6c75b03 sha>` passed on the branch too (the merge-base is the plan commit). Older pairs keep their invocations (R2 ledger): s3 `base-548cb87`; 4A `base-1451a66`; 4B `base-c558413` + `--old-base c558413c3e248122256c3355b8852d3879aed3f6`; R1 `base-aec1d4f` + `--old-base-r1 aec1d4f9377f8fcebf883eaed8a81538b2cf8aef`; R2 `base-ef4d0d1` + `--old-base-r2 ef4d0d10fbcbe3077e10a28979891f0abd256b2f`.
- **P2 — `/kill`.** Any test, corpus or gate that could intake `kill` pins `HOUGE_TOMBSTONE_PATH` / `HOUGE_DISARM_PATH` to a temp dir and asserts no `houge.kill` in the cwd afterwards.
- **P3 — `HOUGE_TELEGRAM_CHAT_ID`** cleared (tests, differential) or a stub (gates) wherever a recorder fault is provoked.
- **P4 — exact rows, never filters (R2 P10).** Any existing test, corpus or gate that drives `submit`/`submitTurn` and asserts whole `decisions` tables or unfiltered row counts is updated to expect the new rows exactly. The senior review found none in `tests/` or `scripts/stage4-corpora/`; Task 2 Step 0 greps the live gates and rollbacks that call `submitTurn`/`submit` (`live-gate-decisions-2a`, `live-gate-ladder-2b-hooks` — its `:511` steers a media turn, which now writes `wait/needs_ingest` — `live-gate-jev-tree`, `live-gate-omp`, `live-gate-media`, `live-gate-memory-write`, `check-ladder-stage4b-rollback`, `check-standing-rollback`) and lists each with "filters by entry" or "updated".
- **P5 — exact PASS values; one planted mutation per new assertion** (R2 lesson).
- **P6 — module names.** `scrubIds` from `scripts/stage4-bind-fixture.mjs`; `withPinnedEnv`, `withCountingClock` from `scripts/stage4-intake-fixture.mjs`; `countingRecorder` from `scripts/stage4-sender-fixture.mjs`; `mkStore`, `mkTemp`, `dumpDb`, `relabelClocks`, `requireNew`, `canon`, `DISTS`, `NEW_ROW_IDS` from `scripts/stage4-diff-lib.mjs`.
- **P7 — commit trailer** names the implementing model (`Co-Authored-By: Claude <Model> 5.5 <noreply@anthropic.com>`).
- **P9 — a passing draft exists** (senior review): `/private/tmp/claude-501/-Users-xiaochuan-Projects-adventure/63a581ab-8d09-4840-a85b-58b78129f365/scratchpad/r3-draft/` holds the reviewer's Task 1–2 code and tests (`tracked.diff` for modified files; new files under `src/` and `tests/`), all green at `2631e56`. Implementers may start from it; it is unreviewed and must still pass the task review, and every Rev 1.1 fix below applies.
- **P10 — `queued_behind` is a setup-failure window** (senior): `this.turn` is cleared in `runTurn`'s finally and the drain resumes a microtask later, so the only synchronous window is `newTurnOrFail` failing (e.g. `buildTools` throws) → `outcome.fail` runs while `busy` is true and no turn is set. Tests and the corpus reach it by submitting from a wrapped `outcome.fail`; the ADR amendment states it.
- **P11 — `approvals > 0` while `RUNNING`** (codex B2, senior): `setAwaitingApprovalForTest(true, { pause: "bounded", ttlMs: 30 })` then `untilState(sup, "RUNNING")` — the bounded pause expires while the card stays open (pattern `tests/omp/planner-supervisor.test.ts:~1356`). Never `(true)` then `(false)` (that returns the count to 0).
- **P12 — counting recorders see the idle consult** (senior): `runTurn` consults `intake.steer_or_queue` for every queued request, including `queue/idle` (no row). Count assertions include it.
- **P13 — test-store access:** `store.db` is private; use `(store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db` as `tests/triggers/sender-decisions.test.ts` does. A recorder over the harness's own store is a lazy delegate (`record: (e, r, c) => storeRecorder(h.store).record(e, r, c)` built after `harness()` returns) — passing `o.store` skips the planner-session seeding.
- **P8 — the live gates read live data.** The `command`/`path` corpora pin exact counts over live omp transcripts (re-pin in a `fix(gate):` commit if they drift); the 4B gate needs a scratch copy without `approval.bind`/`secret.redact` rows (R2 ruling) until its follow-up lands.

## Global Constraints

- `dependencies: {}` stays empty.
- **Behaviour identical** to `6c75b03`: which messages are nudged, steered or queued; claims; chat turns; `ack_nudged` events; `ACK_NUDGE_TEXT`; outbox rows; merged completions; failures; and their order. The only new rows are `decisions` rows with `entry_id` `intake.bare_ack` or `intake.steer_or_queue` — plus, only on an insert fault, `decision_record_failed` and its one operator alert.
- **Raw answer drives:** `isBareAck(req.text)` and the existing `live && (RUNNING || AWAITING_APPROVAL)` test drive the branches; `decideSync` results are never used.
- **Recording rule (spec §4.0):** a row is written only after the incoming run's claim succeeds (`nudgeAck` `:377`, `steer` `:455`, `runTurn` `:470`); a failed claim writes nothing.
- `intake.bare_ack`: `stage "intake"`, `input "paco"`, `locked: true`, verdicts `nudge | pass`, default `pass`, `fail: "nudge"`, reason `ack_while_card_waits`; consulted only when a card waits on a live Telegram turn.
- `intake.steer_or_queue`: `stage "intake"`, `input "tool"`, unlocked, verdicts `steer | wait | queue`, default `queue`, `fail: "wait"`, reasons (first match) `idle` (queue), `queued_behind`, `turn_not_live`, `turn_schedule_born`, `message_scheduled`, `needs_ingest`, `not_running` (wait), `live_turn` (steer).
- Rows: `run_id` = the incoming run; `tool_call_id` null; no text.
- `src/omp/planner-supervisor.ts` is protected (`src/omp`): edits only as specified.
- No message text in any row, test print or script print; synthetic text only.
- Never write `houge.sqlite`; gates use a VACUUM copy deleted on every exit path.
- New functions under 50 lines; tests in `tests/<area>/`.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/decisions/entries/intake-bare-ack.ts`, `intake-steer-or-queue.ts` (new) | 1 | entries |
| `src/decisions/entry-ids.ts`, `registry.ts`, `tests/decisions/registry.test.ts`, count literals in `scripts/` | 1 | 28 → 30 |
| `tests/decisions/intake-bare-ack.test.ts`, `intake-steer-or-queue.test.ts` (new) | 1 | pins |
| `src/omp/planner-supervisor.ts` (`SupervisorDeps`, `TurnRequest`, `submit`, `nudgeAck`, `steer`, `runTurn`, new `steerOrQueueInput`) | 2 | capture + record at claim |
| `src/core/core-worker.ts` (`supervisorDeps`) | 2 | pass recorder |
| `tests/omp/supervisor-decisions.test.ts` (new), `tests/core/supervisor-decision-wiring.test.ts` (new) | 2 | rows, mirror, wiring |
| `scripts/stage4-diff-lib.mjs`, `scripts/check-ladder-stage4-differential.mjs`, `scripts/stage4-supervisor-fixture.mjs` (new) | 3 | `r3` pair, exports, fixture |
| `scripts/stage4-corpora/supervisor.mjs` (new) | 4 | corpus |
| `scripts/live-gate-ladder-remainder-r3.mjs` (new) | 5 | live gate |
| `scripts/check-ladder-remainder-r3-rollback.mjs` (new) | 6 | rollback |

---

### Task 1: The two entries on the registry

**Files:** Create `src/decisions/entries/intake-bare-ack.ts`, `src/decisions/entries/intake-steer-or-queue.ts`; Modify `src/decisions/entry-ids.ts:5`, `src/decisions/registry.ts` (imports, `REGISTRY` tail after `TURN_CONTRACT`), `tests/decisions/registry.test.ts` (every `toHaveLength(28)`), every registry-count literal in `scripts/` (grep `=== 28` / `28 ids`); Test `tests/decisions/intake-bare-ack.test.ts`, `tests/decisions/intake-steer-or-queue.test.ts`.

**Interfaces — Produces:** `INTAKE_BARE_ACK: Entry<BareAckInput, BareAckVerdict>`, `interface BareAckInput { acked: boolean }`, `type BareAckVerdict = "nudge" | "pass"`; `STEER_REASONS` (const tuple), `type SteerReason`, `type SteerVerdict = "steer" | "wait" | "queue"`, `interface SteerOrQueueInput { outcome: SteerVerdict; reason: SteerReason }`, `INTAKE_STEER_OR_QUEUE: Entry<SteerOrQueueInput, SteerVerdict>`.

- [ ] **Step 1: failing tests**

`tests/decisions/intake-bare-ack.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_BARE_ACK } from "../../src/decisions/entries/intake-bare-ack.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_BARE_ACK as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: "r", tool_call_id: null, recorder };

describe("intake.bare_ack — a bare ack while an approval card waits is nudged, never consent (ADR 0029 §5.1, locked)", () => {
  it("is locked, rule-only, reads Paco's words, fails to nudge, sound", () => {
    expect(INTAKE_BARE_ACK.locked).toBe(true);
    expect(LOCKED_ENTRY_IDS).toContain("intake.bare_ack");
    expect(INTAKE_BARE_ACK.input).toBe("paco");
    expect(INTAKE_BARE_ACK.stage).toBe("intake");
    expect(INTAKE_BARE_ACK.fail).toBe("nudge");
    expect(INTAKE_BARE_ACK.defaultVerdict).toBe("pass");
    expect(INTAKE_BARE_ACK.alwaysRecord).toBeUndefined();
    expect(INTAKE_BARE_ACK.reasonCodes).toEqual(["ack_while_card_waits"]);
    expect(entryProblems(INTAKE_BARE_ACK as unknown as AnyEntry)).toEqual([]);
  });
  it("an ack → nudge/ack_while_card_waits, recorded", () => {
    expect(decideSync(INTAKE_BARE_ACK, { acked: true }, ctx)).toMatchObject({ verdict: "nudge", reason: "ack_while_card_waits" });
    expect(rows).toEqual([{ verdict: "nudge", reason: "ack_while_card_waits" }]);
  });
  it("not an ack → pass, not recorded", () => {
    expect(decideSync(INTAKE_BARE_ACK, { acked: false }, ctx).verdict).toBe("pass");
    expect(rows).toEqual([]);
  });
});
```

`tests/decisions/intake-steer-or-queue.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_STEER_OR_QUEUE, STEER_REASONS, type SteerOrQueueInput } from "../../src/decisions/entries/intake-steer-or-queue.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_STEER_OR_QUEUE as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: "r", tool_call_id: null, recorder };

describe("intake.steer_or_queue — a message steered into a live turn, or held back from one, leaves a row (spec R3 §4.2, Decision 1-A)", () => {
  it("is unlocked, rule-only, tool input, sound (rule-only: R12 does not bind the irreversible steer, Decision 2-A)", () => {
    expect(INTAKE_STEER_OR_QUEUE.locked).toBeUndefined();
    expect(LOCKED_ENTRY_IDS).not.toContain("intake.steer_or_queue");
    expect(INTAKE_STEER_OR_QUEUE.input).toBe("tool");
    expect(INTAKE_STEER_OR_QUEUE.defaultVerdict).toBe("queue");
    expect(INTAKE_STEER_OR_QUEUE.fail).toBe("wait");
    expect(INTAKE_STEER_OR_QUEUE.reasonCodes).toEqual(["live_turn", "turn_schedule_born", "message_scheduled", "needs_ingest", "not_running", "turn_not_live", "queued_behind", "idle"]);
    expect(entryProblems(INTAKE_STEER_OR_QUEUE as unknown as AnyEntry)).toEqual([]);
  });
  it("a judge rung on this entry would be refused (the registry check Decision 2-A relies on)", () => {
    const jev = { kind: "system_one", name: "x", questions: [], bars: { kind: "provisional", question: "q", criteriaHash: "h", model: "m", p: 0.5, source: "mu" }, timeoutMs: 1 };
    const judged = { ...INTAKE_STEER_OR_QUEUE, ladder: [...INTAKE_STEER_OR_QUEUE.ladder, jev] } as unknown as AnyEntry;
    expect(entryProblems(judged).some((p) => p.includes("steer"))).toBe(true);
  });
  const cases: Array<[SteerOrQueueInput, boolean]> = [
    [{ outcome: "steer", reason: "live_turn" }, true],
    ...(["turn_schedule_born", "message_scheduled", "needs_ingest", "not_running", "turn_not_live", "queued_behind"] as const).map((reason) => [{ outcome: "wait" as const, reason }, true] as [SteerOrQueueInput, boolean]),
    [{ outcome: "queue", reason: "idle" }, false]
  ];
  it.each(cases)("%o → that verdict and reason; recorded: %s", (input, recorded) => {
    expect(decideSync(INTAKE_STEER_OR_QUEUE, input, ctx)).toMatchObject({ verdict: input.outcome, reason: input.reason });
    expect(rows).toEqual(recorded ? [{ verdict: input.outcome, reason: input.reason }] : []);
  });
  it("every reason is covered", () => { expect(new Set(cases.map(([i]) => i.reason))).toEqual(new Set(STEER_REASONS)); });
});
```
In `tests/decisions/registry.test.ts` change every `toHaveLength(28)` to `toHaveLength(30)` and add:
```ts
  it("intake.bare_ack (locked) and intake.steer_or_queue (unlocked) are registered rule-only intake entries (remainder R3)", () => {
    for (const [id, locked] of [["intake.bare_ack", true], ["intake.steer_or_queue", false]] as const) {
      const e = entryById(id) as AnyEntry;
      expect(e).toBeDefined();
      expect(e.stage).toBe("intake");
      expect(e.locked === true).toBe(locked);
      expect(e.ladder.map((r) => r.kind)).toEqual(["rule"]);
      expect((LOCKED_ENTRY_IDS as readonly string[]).includes(id)).toBe(locked);
    }
    expect(ENTRY_IDS).toHaveLength(30);
  });
```
The only other count literal is `scripts/live-gate-ladder-stage4b.mjs:172` (`=== 28` → `=== 30`).

- [ ] **Step 2: run, see fail** — `npx vitest run tests/decisions/intake-bare-ack.test.ts tests/decisions/intake-steer-or-queue.test.ts tests/decisions/registry.test.ts`.

- [ ] **Step 3: entries**

`src/decisions/entries/intake-bare-ack.ts`:
```ts
import type { Entry, RungAnswer } from "../types.js";

/** Consulted only while an approval card waits on a live Telegram turn (spec 2026-11-01 R3 §4.1); `acked` is isBareAck's raw answer. */
export interface BareAckInput { acked: boolean }
export type BareAckVerdict = "nudge" | "pass";

function rule(s: BareAckInput): RungAnswer<BareAckVerdict> {
  return s.acked ? { verdict: "nudge", reason: "ack_while_card_waits" } : { verdict: "pass" };
}

export const INTAKE_BARE_ACK: Entry<BareAckInput, BareAckVerdict> = {
  id: "intake.bare_ack", version: 1, stage: "intake", input: "paco", locked: true,
  question: "While an approval card waits, is this message a bare acknowledgement — nudged, never taken as consent (ADR 0029 §5.1)?",
  verdicts: ["nudge", "pass"],
  ladder: [{ kind: "rule", name: "isBareAck", decide: rule }],
  fail: "nudge", defaultVerdict: "pass", outcomes: [], armed: { rule: "on" },
  effects: {
    nudge: { kind: "reply", reversible: true, announced: "none", what: "the code-owned nudge points at the card; nothing is approved" },
    pass: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: ["ack_while_card_waits"],
};
```

`src/decisions/entries/intake-steer-or-queue.ts`:
```ts
import type { Entry, RungAnswer } from "../types.js";

/** PlannerSupervisor.submit's steer/queue branch, first match in this order (spec 2026-11-01 R3 §4.2); listed steer first. */
export const STEER_REASONS = ["live_turn", "turn_schedule_born", "message_scheduled", "needs_ingest", "not_running", "turn_not_live", "queued_behind", "idle"] as const;
export type SteerReason = (typeof STEER_REASONS)[number];
export type SteerVerdict = "steer" | "wait" | "queue";
/** Captured in submit from the values the branch reads; recorded at the incoming run's claim (spec §4.0). */
export interface SteerOrQueueInput { outcome: SteerVerdict; reason: SteerReason }

function rule(s: SteerOrQueueInput): RungAnswer<SteerVerdict> {
  return { verdict: s.outcome, reason: s.reason };
}

export const INTAKE_STEER_OR_QUEUE: Entry<SteerOrQueueInput, SteerVerdict> = {
  id: "intake.steer_or_queue", version: 1, stage: "intake", input: "tool",
  question: "Does this message steer into the live Telegram turn, wait behind a turn it may not join, or queue on an idle planner?",
  verdicts: ["steer", "wait", "queue"],
  ladder: [{ kind: "rule", name: "submit", decide: rule }],
  fail: "wait", defaultVerdict: "queue", outcomes: [], armed: { rule: "on" },
  effects: {
    steer: { kind: "effect", reversible: false, announced: "none", what: "the message joins the running turn; one reply" },
    wait: { kind: "none", reversible: true, announced: "none" },
    queue: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: [...STEER_REASONS],
};
```
Append `"intake.bare_ack"` is already in `LOCKED_ENTRY_IDS`; add both ids to `ENTRY_IDS` after `"turn.contract"`, import both in `registry.ts` and append them to `REGISTRY` after `TURN_CONTRACT`.

- [ ] **Step 4: run, see pass** — `npx vitest run tests/decisions/ && npm run typecheck`.
- [ ] **Step 5: commit** — stage the files above by name; `feat(decisions): register intake.bare_ack (locked) and intake.steer_or_queue (rule-only, record never steer)`.

---

### Task 2: Capture in `submit`, record at the claim; `CoreWorker` passes the recorder

**Files:** Modify `src/omp/planner-supervisor.ts` (`TurnRequest` `:50–56`, `SupervisorDeps` `:84–106`, `submit` `:358–372`, `nudgeAck` `:374–382`, `steer` `:453–466`, `runTurn` `:468–471`), `src/core/core-worker.ts` (`supervisorDeps` `:2376–2390`); Test `tests/omp/supervisor-decisions.test.ts` (new), `tests/core/supervisor-decision-wiring.test.ts` (new); any gate Step 0 finds.

**Interfaces — Consumes:** Task 1's entries. **Produces:** `SupervisorDeps.recorder?: DecisionRecorder`; `TurnRequest.steerDecision?: SteerOrQueueInput`; `export function steerOrQueueInput(t: { live: boolean; req: { source: "telegram" | "schedule" } } | undefined, st: SupervisorState, busy: boolean, req: TurnRequest): SteerOrQueueInput`.

- [ ] **Step 0: P4 audit.** `grep -ln "submitTurn\|\.submit(" scripts/live-gate-*.mjs scripts/check-*.mjs` (the senior also found `live-gate-ladder-remainder-r2.mjs`, `check-ladder-remainder-r2-rollback.mjs`, `check-ladder-2b-hooks-rollback.mjs`; and two whole-table reads to check first: `check-ladder-stage4b-rollback.mjs:146` — every `decisions` row since `t0`, no entry filter — and `check-ladder-remainder-r2-rollback.mjs:91` — `contentOf` over `SELECT * FROM decisions`); for each, read how it counts `decisions` rows and whether its path reaches `submit`; write a table (file, line, "filters by entry_id" / "updated to expect …") into the report. Update any that assert unfiltered counts, expecting the new rows exactly.

- [ ] **Step 1: failing tests** — `tests/omp/supervisor-decisions.test.ts`, on `tests/helpers/supervisor-harness.ts` (`harness(session, env, extra)`; the recorder is a lazy delegate over `h.store` per P13 — never `o.store`), with `afterEach(async () => { for (const c of cleanups.splice(0)) await c(); })`. Rows: `SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE entry_id IN ('intake.bare_ack','intake.steer_or_queue') ORDER BY rowid`. Cases, each asserting the exact rows **and** today's behaviour (the existing tests' assertions, `tests/omp/planner-supervisor.test.ts:83–117`, `:1339–1370`):
  1. idle message → completes; zero rows.
  2. second message during the held live turn (RUNNING) → `session.steers` = `["second"]`; exactly `[["intake.steer_or_queue","steer","live_turn", b, null]]`.
  3. `setAwaitingApprovalForTest(true)`, then `好` → nudged (reply contains "waiting for your tap", `ack_nudged` event, no steer); exactly `[["intake.bare_ack","nudge","ack_while_card_waits", r2, null]]`; zero `intake.steer_or_queue` rows for r2.
  4. a card waits, a non-ack text → steered; exactly one `steer/live_turn` row; zero `intake.bare_ack` rows.
  5. schedule-born live turn + Telegram message → no steer; **no row while it waits** (assert zero rows for it before the first turn ends — codex W2: never compare rowids across tables); after the first turn ends the message is claimed, runs and completes; then exactly one `wait/turn_schedule_born` row for it.
  6. Telegram live turn + a scheduled message → `wait/message_scheduled`.
  7. live turn + `{ ...req(c, "photo"), needsIngest: true }` → `wait/needs_ingest`; and the same with text `好` while a card waits → `wait/needs_ingest`, no nudge, zero `intake.bare_ack` rows.
  8. a message submitted while the first turn's start is held (not yet live) → `wait/turn_not_live` (the existing `Script.start` hook: `heldSession({ start: () => gate })`, `untilState(sup, "STARTING")`, submit — senior).
   8b. a bare ack in `RUNNING` with an open card (`approvals > 0`, P11) → nudged; one `nudge` row.
  9. `queued_behind` (P10): `buildTools` throws for the first queued run; a wrapped `outcome.fail` submits a third run while `busy` is true and no turn is set → that run's `wait/queued_behind` row once it is claimed.
  10. the same run submitted twice during a live turn → exactly one `steer` row (the second claim fails).
  11. a nudge whose run was pre-claimed (`store.claimRun(r2, "other", 120)` first) → zero rows, no reply; a steer whose run was pre-claimed → zero rows.
  12. a queued request failed by `abortAll("killed")` before it runs → zero rows (pin the tombstone paths, P2).
  13. no recorder in deps → identical behaviour, zero rows (the harness default).
  14. insert fault (`store.insertDecision` throws) on case 2 → steer still happens, `decision_record_failed` opened; a recorder that throws → steer still happens, no incident.
  Count assertions follow P12. 15. `steerOrQueueInput` mirror: for every combination of `t ∈ {undefined, {live:false, telegram}, {live:true, telegram}, {live:true, schedule}}`, `st ∈ {STARTING, IDLE, RUNNING, AWAITING_APPROVAL, ABORTING, STOPPED}`, `busy ∈ {false, true}`, `req.source ∈ {telegram, schedule}`, `needsIngest ∈ {false, true}`: `outcome === "steer"` iff `t?.live && t.req.source === "telegram" && req.source === "telegram" && !req.needsIngest && (st === "RUNNING" || st === "AWAITING_APPROVAL")` (the branch's own expression, copied), and the reason is the first match in the spec's order.

`tests/core/supervisor-decision-wiring.test.ts` — the production deps: a `CoreWorker` with a fake omp (copy `tests/core/core-worker-omp-turn.test.ts:~229` — `rpcFinishOnSteer`, `ompWorker`, `fakeLog` — senior), two turn runs on one chat where the first is held live (or two `submitTurn` calls back to back if the fake holds the first), and **require** one `intake.steer_or_queue` row in the store (R2 lesson). Pin `HOUGE_TELEGRAM_CHAT_ID` and the P11 env list from R2 (`HOUGE_SCHEDULER_ENABLED`, `HOUGE_RADAR_ENABLED`, `HOUGE_RADAR_PANEL_ENABLED`, `HOUGE_MEDIA_INGEST_ENABLED`, `HOUGE_LLM_MEDIA_PROVIDERS`).

- [ ] **Step 2: run, see fail.**

- [ ] **Step 3: implement** in `src/omp/planner-supervisor.ts`:
```ts
// TurnRequest gains:
  /** intake.steer_or_queue's input, captured in submit for a queued request; recorded at runTurn's claim (spec R3 §4.0). */
  steerDecision?: SteerOrQueueInput;
// SupervisorDeps gains:
  /** Records intake.bare_ack / intake.steer_or_queue at the incoming run's claim (spec R3 §4.3); absent → no rows. */
  recorder?: DecisionRecorder;

/** The steer/queue branch's own inputs, named; first match wins (spec R3 §4.2). Mirrors submit's `live && (RUNNING || AWAITING)`. */
export function steerOrQueueInput(t: { live: boolean; req: { source: "telegram" | "schedule" } } | undefined, st: SupervisorState, busy: boolean, req: TurnRequest): SteerOrQueueInput {
  const wait = (reason: SteerReason): SteerOrQueueInput => ({ outcome: "wait", reason });
  if (t === undefined) return busy ? wait("queued_behind") : { outcome: "queue", reason: "idle" };
  if (!t.live) return wait("turn_not_live");
  if (t.req.source !== "telegram") return wait("turn_schedule_born");
  if (req.source !== "telegram") return wait("message_scheduled");
  if (req.needsIngest) return wait("needs_ingest");
  if (st !== "RUNNING" && st !== "AWAITING_APPROVAL") return wait("not_running");
  return { outcome: "steer", reason: "live_turn" };
}
```
`submit` becomes (same branches, same order):
```ts
  submit(req: TurnRequest): void {
    const t = this.turn;
    const live = t?.live && t.req.source === "telegram" && req.source === "telegram" && !req.needsIngest;
    if (live && (this.st === "AWAITING_APPROVAL" || t.approvals > 0)) {
      const acked = isBareAck(req.text);
      if (acked) { this.nudgeAck(t, req); return; }
      this.record(INTAKE_BARE_ACK, { acked }, req.run_id); // pass: the default, never a row
    }
    const decision = steerOrQueueInput(t, this.st, this.busy, req);
    if (live && (this.st === "RUNNING" || this.st === "AWAITING_APPROVAL")) {
      void this.steer(t, req, decision).catch((e) => this.incident("planner_steer_failed", { run_id: req.run_id, reason: rpcCode(e) }));
      return;
    }
    this.queue.push({ ...req, steerDecision: decision });
    if (!this.busy) this.draining = this.drain();
  }

  /** decideSync for a rule-only entry: never throws, writes per shouldRecord; no recorder → nothing (spec R3 §4.3). */
  private record<S, V extends string>(entry: Entry<S, V>, s: S, run_id: string): void {
    const recorder = this.d.recorder;
    if (recorder) decideSync(entry, s, { run_id, tool_call_id: null, recorder });
  }
```
(Comment lines from the original `submit` — provenance B2, slot A — stay above their branches. If `t` loses narrowing inside the `if`, keep `live &&` inline as written; do not hoist the card test into a variable.) In `nudgeAck`, right after `if (!store.claimRun(...)) return;`: `this.record(INTAKE_BARE_ACK, { acked: true }, req.run_id);`. `steer(turn, req, decision: SteerOrQueueInput)`: right after its `claimRun` check: `this.record(INTAKE_STEER_OR_QUEUE, decision, req.run_id);`. `runTurn`: right after `if (!claim) return;`: `if (req.steerDecision) this.record(INTAKE_STEER_OR_QUEUE, req.steerDecision, req.run_id);`. Imports: `decideSync`, both entries and their types, `Entry`, `DecisionRecorder`. In `core-worker.ts` `supervisorDeps`, add `recorder: this.decisionRecorder,`.

- [ ] **Step 4: run, see pass** — `npx vitest run tests/omp/ tests/core/ tests/decisions/ && npm run typecheck`. Then plant two mutations, one at a time, and show each failing: record `steer` before the claim in `steer()` (case 11 fails); derive `steerOrQueueInput` with `!t?.live → idle` (cases 8/15 fail). Revert.
- [ ] **Step 5: commit** — `feat(omp): record intake.bare_ack and intake.steer_or_queue at the incoming run's claim; CoreWorker passes the recorder` (+ any gate updated in Step 0).

---

### Task 3: Harness — `r3` pair, exports, supervisor fixture

**Files:** Modify `scripts/stage4-diff-lib.mjs` (`DISTS`, `R3_IDS`, `NEW_ROW_IDS`, `EXPORTS`), `scripts/check-ladder-stage4-differential.mjs` (flags, provenance, ctx, usage); Create `scripts/stage4-supervisor-fixture.mjs`.

- [ ] **Step 1: lib/CLI.** `DISTS.r3`; `export const R3_IDS = ["intake.bare_ack", "intake.steer_or_queue"]`; every `NEW_ROW_IDS` set gains `...R3_IDS`; `r3: new Set(R3_IDS)`; `--old-dist-r3 <dir>` (required; provenance file `omp/planner-supervisor.js`) and `--old-base-r3 <sha>` (needed on the branch, P1); `EXPORTS` gains `PlannerSupervisor: "omp/planner-supervisor.js"`, `lessonSetFingerprint: "run/lesson-render.js"`, `parseModelString` and `selectorKey` (read their module in `src/omp/`) — `ToolRegistry`, `RunStore`, `resolveOmpConfig`, `storeRecorder`, `Gateway`, `buildTypedTaskEvent` are already there (senior). Re-verify P1: `git diff --stat 6c75b03 $(git merge-base HEAD main) -- src scripts tests` must be empty.
- [ ] **Step 2: fixture** `scripts/stage4-supervisor-fixture.mjs` — the narrow path of `tests/helpers/supervisor-harness.ts` over a dist module object `d`, no vitest: `mkSupervisor(d, store, { recorder, session })` building `SupervisorDeps` as `harness()` does (chat `42`, seeded planner session, `resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0" })`, temp data dir with a short path for the bridge socket, `skipPreflightForTest: true`, `versionCheck` ok, fake roles, `settleClient` returning the 0.1 Jev answers); `fakeSession()` and `heldSession()` ported (prompts/steers logs, hold-live, hold-start); `until(fn, ms)` and `untilState(sup, st)` on real timers; `sink(store)`; `cleanup()`. Read `startFake` and `bridgeRequester` in the TS harness — the fake must play the extension against the real bridge socket exactly as the TS one does (inline the 6-line `openManifestClient`; `memoryRoot` = the absolute repo `memory/` path). Size (senior, who probed it: a 55-line throwaway steered on both builds): ~120–150 lines with hold-start, hold-live, `untilState`, `sink`, `cleanup` and worker-id scrubbing; the probe is at `/private/tmp/claude-501/-Users-xiaochuan-Projects-adventure/63a581ab-8d09-4840-a85b-58b78129f365/scratchpad/smoke.mjs` if it still exists. Precedent: `scripts/stage4-bridge-seam.mjs`. Prove the fixture: one smoke run on the new dist that reproduces case 2 of Task 2 (one steer, one row).
- [ ] **Step 3: verify** — `npm run build`, full differential with every pair's flags plus `--old-dist-r3 /Users/xiaochuan/Projects/adventure/.worktrees/base-6c75b03/dist --old-base-r3 <full sha>` → all existing corpora PASS (P8 re-pins only if the transcripts drifted); `same_build` mutation on `omp/planner-supervisor.js` → exit 2.
- [ ] **Step 4: commit** — `test(gate): differential gains the r3 pair and a dist supervisor fixture`.

---

### Task 4: Corpus `supervisor`

**Files:** Create `scripts/stage4-corpora/supervisor.mjs` (pattern: `scripts/stage4-corpora/sender.mjs`).

- [ ] **Step 1: items** — spec §6's list on the Task 3 fixture, each on a fresh store, same scenario on old and new dist (new side injects `countingRecorder` over `d.storeRecorder(store)`; old side has no `recorder` dep): idle; `turn_not_live`; `queued_behind`; duplicate submit; bare ack on a media message during a card; `steer` in RUNNING and in AWAITING_APPROVAL; bare ack in AWAITING (nudge); bare ack in RUNNING with a card (`approvals > 0`, P11: bounded pause expired) (nudge); `queued_behind` (P10: `buildTools` throws, submit from the wrapped `outcome.fail`); bare ack in RUNNING with no card (steer); non-ack with a card (pass + steer); `turn_schedule_born`; `message_scheduled`; `needs_ingest`; `not_running` on a live turn mid-respawn (`STARTING` after `:1056`; drive it the way an existing respawn test does — grep `tests/omp/planner-supervisor.test.ts` for a mid-turn child exit — or, if no deterministic path exists, say so and rely on Task 2's mirror test, recording why); a pre-claimed nudge and a pre-claimed steer (no rows).
- [ ] **Step 2: project / required** — compared: the session's `prompts`/`steers` logs, the sink's `done`/`failed` (run ids and fields, worker ids scrubbed), and `dumpDb(store, { dropDecisionIds: [...all new-row ids] })` → `relabelClocks` → `scrubIds`; old side throws if any `R3_IDS` row exists. Required: exact new rows per item `[entry, verdict, reason, run_id = the submitted run, null]` and exact per-entry recorder call counts (bare_ack `pass` consults count 1 with no row). Coverage + determinism self-tests; two planted mutations each fail `required` once: no `record` in `steer`; and the `submit`-side consult removed (no `decideSync` for the bare-ack `pass` and no captured `steerDecision`, so queued runs record nothing) — spec §6.
- [ ] **Step 3: run** `--only supervisor`, then the full differential → every corpus PASS.
- [ ] **Step 4: commit** — `test(gate): supervisor corpus — nudge, steer, wait and queue over the dist supervisor`.

---

### Task 5: Live gate `scripts/live-gate-ladder-remainder-r3.mjs`

Pattern: `scripts/live-gate-ladder-remainder-r2.mjs` (read whole). The Task 3 fixture's supervisor on a VACUUM copy (chat id `-1003` — a numeric id that is not a real chat: `CoreWorker` refuses a non-numeric chat id before `submit`, `core-worker.ts:2283`, codex W1), a fake session (no real omp child), stub Telegram, P2/P3 pins. Spec §7's eight lines, exact values (P5), with lines 4 and 5 asserting each queued run completes exactly once; line 6 through `CoreWorker.submitTurn` with the production deps on the copy (fake omp as in Task 2's wiring test); line 7, two separate faults (codex B3, spec §7): the insert faulted → `decision_record_failed` opened and exactly one alert to the stub chat; a throwing recorder → **zero** incidents and zero alerts; effects unchanged in both; line 8 `/status` count lines built from SQL over the 24 h window (R2 lesson) and `insertLadderMove` on `intake.bare_ack` → `locked_entry`. Show lines 1, 2 and 7 failing once each under a planted mutation. Rerun the R2, R1, 4C (`--old-dist .../base-c558413/dist --old-base c558413…`) and 4B (P8) gates: exit 0. Commit `test(gate): remainder R3 live gate — nudge, steer, wait on a copy of the live DB, faults, the lock`.

---

### Task 6: Rollback check `scripts/check-ladder-remainder-r3-rollback.mjs`

Pattern: `scripts/check-ladder-remainder-r2-rollback.mjs` (read whole). Seed one row of each new id through the real supervisor path on copy F (`nudge`, `steer`, `wait`); the old build (`base-6c75b03`, `--old-base-r3`) opens A and F with no migration, renders `/status` (the two count lines exact from SQL; every other line byte-identical A vs F) and the digest (raw arrays identical A vs F), reads every row unchanged with exact fields, and refuses `review_ok` naming each new id; the new build reopens F. Run: every line PASS, exit 0; one planted mutation failing. Commit `test(gate): remainder R3 rollback — the merge-base build reads the new intake rows`.

---

## After the tasks (orchestrator)
Full suite + typecheck + build on a quiet machine; the full differential (every pair); R3, R2, R1, 4C, 4B gates; R3 rollback; final whole-branch reviews (most capable non-orchestrator model, a mutation pass, codex whole-diff); one fix wave; docs sync — ADR 0030 amendment "awaiting Paco's signature" (two entries; recording at the claim per §5; Decision 1-A; Decision 2-A with its consequence), index row, ladder §6.1 note, ROADMAP delta, state block, lessons, sessions; merge, push, rebuild, kickstart (Tier A).
