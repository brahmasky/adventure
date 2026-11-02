# Remainder slice R5 — `context.recall`, `context.catch_up`, `context.lessons`, `turn.clarify_cap` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the four pre-model context decisions as rule-only, record-never-steer entries — recall, catch-up and the clarify cap recorded in `buildTurnPrompt` for the turn's own run while the turn is live, lessons recorded at the spawn for the launching turn — and prove zero behaviour change with the stamped merge-base differential, a live gate and a rollback check.

**Architecture:** Four entry modules under `src/decisions/entries/`, each with a pure rule over numbers. `TurnContextDeps` gains a `recorder`; `TurnPromptInput` gains `live`; `buildTurnPrompt` captures from the values it already computed (the returned `TurnRetrieval`, the one `laneTurnsSince` read, the one `getRecentChatTurns` read) and records after the prompt string is assembled. The supervisor gains `turn.endSignalled` (set in the same tick `ended` resolves, reset when a retried leg re-arms the end signal), threads the launching turn to `preparePaths`, and records `context.lessons` through its existing `record()` helper. `CoreWorker.ompTurnContext` passes the same recorder the supervisor gets.

**Tech Stack:** Node 25, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest. Zero runtime deps.

**Plan status:** Rev 1.0 — awaiting the plan review.

**Spec:** `docs/superpowers/specs/2026-11-02-ladder-remainder-r5-context-clarify-design.md` (Rev 1.2, APPROVED by Paco 2026-11-02: 1-A, 2-A). Read it before any task. Pattern slice: R4 (`docs/superpowers/plans/2026-11-01-remainder-r4-crash-retry.md`, shipped `81fd742`).

## Rulings (orchestrator)
- **P1 — merge base and old builds.** The branch `remainder-r5` is cut from `main` after this plan's commit. Every commit on `main` after `28c4990` is docs-only (verify: `git diff --stat 28c4990 <merge base> -- src scripts tests` empty; Task 4 stops if not), so the `r5` old build is the real merge base, built and stamped in `.worktrees/base-<12-char sha>` (`npm ci && npm run build && node scripts/stamp-dist.mjs <worktree>`). On the branch merge-base discovery finds it; after the merge it is passed as `--old-base-r5 <full sha>`. Older pairs keep their invocations (the differential's header comment, `scripts/check-ladder-stage4-differential.mjs:15`): s3 `base-548cb87`; 4A `base-1451a66`; 4B `base-c558413`; R1 `base-aec1d4f`; R2 `base-ef4d0d1`; R3 `base-6c75b03`; R4 `base-c6eae37c620f` + `--old-base-r4 c6eae37c620f9f95100579959baebeb5e263b767`.
- **P2 — `/kill`.** Any test, corpus or gate that could intake `kill` pins `HOUGE_TOMBSTONE_PATH` / `HOUGE_DISARM_PATH` to a temp dir and asserts no `houge.kill` in the cwd afterwards.
- **P3 — `HOUGE_TELEGRAM_CHAT_ID`** cleared (tests, differential) or a stub (gates) wherever a recorder fault is provoked.
- **P4 — exact tallies and rows, never filters (spec §6).** A recorder's `record()` is called on every consult, whether or not a row results (`decideSync` → `record`; `shouldRecord` is applied inside `storeRecorder`). So every exact recorder-call tally moves: `turn.clarify_cap` +1 per `buildTurnPrompt` on a live turn; `context.lessons` +1 per spawn whose launching turn is live; `context.recall` +1 per live `buildTurnPrompt` whose retrieval carries telemetry (the harness and fixture `retrieve` return none: 0 there unless an item scripts it); `context.catch_up` +1 per live Telegram `buildTurnPrompt` with a lane row or a failed read. Known sites (spec §6): `tests/omp/supervisor-decisions.test.ts` (`:38`, `:54`, `:68`), `tests/omp/supervision-decisions.test.ts` (`:83`, `:93`, `:102`, `:114` and every other `counts`), `scripts/stage4-corpora/supervisor.mjs` (every item's `calls`), `scripts/stage4-corpora/supervision.mjs` (every item's `calls`). Task 3 Step 0 greps the gates (`live-gate-omp`, `live-gate-jev-tree`, `live-gate-decisions-2a`, `live-gate-ladder-2b-hooks`, `live-gate-ladder-remainder-r3`, `live-gate-ladder-remainder-r4`, `check-ladder-remainder-r3-rollback`, `check-ladder-remainder-r4-rollback`, `check-standing-rollback`) and lists each as "filters by entry" or "updated" (the R4 senior review measured every one as filtering by entry; verify, do not re-derive).
- **P5 — exact PASS values; one planted mutation per new assertion** (R2 lesson).
- **P6 — module names.** `scrubIds` from `scripts/stage4-bind-fixture.mjs`; `withPinnedEnv`, `withCountingClock` from `scripts/stage4-intake-fixture.mjs`; `countingRecorder` from `scripts/stage4-sender-fixture.mjs`; `mkStore`, `mkTemp`, `dumpDb`, `relabelClocks`, `requireNew`, `canon`, `DISTS`, `NEW_ROW_IDS` from `scripts/stage4-diff-lib.mjs`; `fakeSession`, `heldSession`, `sink`, `mkSupervisor`, `intakeRun`, `req`, `until`, `untilState`, `cleanup` from `scripts/stage4-supervisor-fixture.mjs`.
- **P7 — commit trailer** names the implementing model (`Co-Authored-By: Claude <Model> 5.5 <noreply@anthropic.com>`).
- **P8 — the live gates read live data.** The `command`/`path` corpora pin exact counts over live omp transcripts (re-pin in a `fix(gate):` commit if they drift); the 4B gate needs a scratch copy without `approval.bind`/`secret.redact` rows until its follow-up lands. `live-gate-jev-tree` cases 3 and 7 fail on `main` today: compare a rerun against `main`, not against green.
- **P9 — `clarifyCapOf` lives in `src/capabilities/intent.ts`** (beside `countTrailingClarifyTurns`) and `turn-context.ts` re-exports it. The spec says `turn-context.ts` exports it; defining it there would make `turn-clarify-cap.ts` import `turn-context.ts`, which imports the entry — a runtime import cycle. Same reason: `CATCH_UP_MAX_ENTRIES` moves to `src/decisions/entries/context-catch-up.ts` and `turn-context.ts` re-exports it (R4 moved `CRASH_LIMIT` the same way). Cost if wrong: none (one definition either way).
- **P10 — the end signal is re-armed per leg.** `retryNextLeg` replaces `done`/`ended` (`Object.assign(turn, newDeferred())`, `planner-supervisor.ts:951`) after a leg ended with `done("end")`. A flag set by the old `done` would stay true through the retried leg. So `armEnd(turn)` sets `endSignalled = false` and installs a `done` that sets it true in the same tick it resolves; it is called at turn creation and replaces `:951`. No R5 consult runs between a leg's end and its re-arm (a retry pins, never spawns; `buildTurnPrompt` runs once, before the first leg), so this changes no row today; it keeps the flag meaning "this turn's current end signal fired". Cost if wrong: none observable.
- **P11 — test-store access:** `store.db` is private; use `(store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db` (R3 P13). A recorder over the harness's own store is a lazy delegate (`withRecorder` in `tests/omp/supervision-decisions.test.ts:23–28`).
- **P12 — known flakes:** "aborts on the turn deadline" and "a start slower than the deadline is cancelled" in `planner-supervisor.test.ts` can fail under parallel load and pass alone; rerun the file alone before chasing them.

## Global Constraints

- `dependencies: {}` stays empty.
- **Behaviour identical** to the merge base: every prompt's bytes and the system prompt file's bytes; the `loop_started` payload; the `touch*` calls; `lesson_dropped` / `lesson_render_failed` events and incidents; when a child spawns, restarts, retries or fails; the embedding call count; and their order. The only new rows are `decisions` rows with `entry_id` in `context.recall`, `context.catch_up`, `context.lessons`, `turn.clarify_cap` — plus, only on an insert fault, `decision_record_failed` and its one operator alert.
- **Raw answer drives:** `renderContextBlock`, `renderCatchUp`, `renderLessonSection` and `clarifyCapOf` decide what the prompt holds; `decideSync` results are never used.
- **One read:** every capture uses a value the raw code already computed; no second store read, no second retrieval.
- **Recording rule (spec §4.0):** rows carry the turn's own `run_id`, `tool_call_id` null, no text; a consult whose turn's end signal fired (`endSignalled`) writes no row and makes no recorder call.
- `context.recall`: `stage "pre_model"`, `input "mixed"`, unlocked, verdicts `include | none`, default `none`, `fail: "none"`, `alwaysRecord: true` (Decision 1-A); reasons `embedded`, `fts_only`, `embed_failed`, `dropped_after_gate`, `below_gate`, `unscored`; consulted only when telemetry is present.
- `context.catch_up`: `stage "pre_model"`, `input "mixed"`, unlocked, verdicts `inject | none`, default `none`, `fail: "none"`, `alwaysRecord: true` (Decision 2-A); reasons `all`, `entry_capped`, `trimmed`, `all_trimmed`, `read_failed`; consulted only on a Telegram turn with `available > 0` or `read_failed`.
- `context.lessons`: `stage "pre_model"`, `input "tool"`, unlocked, verdicts `full | capped | none`, default `full`, `fail: "full"`; reasons `char_cap`, `render_failed`; consulted once per spawn in `preparePaths`.
- `turn.clarify_cap`: `stage "pre_model"`, `input "tool"`, unlocked, verdicts `allow | cap`, default `allow`, `fail: "allow"`; reason `cap_reached`; consulted once per `buildTurnPrompt`.
- `src/omp/` and `src/decisions/` are protected: edits only as specified. `src/core/core-worker.ts` and `src/capabilities/intent.ts` are not protected.
- Never write `houge.sqlite`; gates use a VACUUM copy deleted on every exit path. Synthetic text only; no message, fact, page, lesson or lane text in any row or print.
- New functions under 50 lines; tests in `tests/<area>/`.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/decisions/entries/context-recall.ts`, `context-catch-up.ts`, `context-lessons.ts`, `turn-clarify-cap.ts` (new) | 1 | entries, rules, `CATCH_UP_MAX_ENTRIES` |
| `src/capabilities/intent.ts` (`clarifyCapOf`, `ClarifyCapInput`) | 1 | one predicate |
| `src/decisions/entry-ids.ts`, `registry.ts`, `tests/decisions/registry.test.ts`, `scripts/live-gate-ladder-stage4b.mjs:172` | 1 | 32 → 36 |
| `tests/decisions/context-recall.test.ts`, `context-catch-up.test.ts`, `context-lessons.test.ts`, `turn-clarify-cap.test.ts` (new) | 1 | pins |
| `src/omp/turn-context.ts` | 2 | recorder, `live`, captures, records |
| `src/core/core-worker.ts` (`ompTurnContext`) | 2 | passes the recorder |
| `tests/omp/turn-context.test.ts`, `tests/omp/context-decisions.test.ts` (new) | 2 | rows, one-read, equivalence |
| `src/omp/planner-supervisor.ts` (`Turn.endSignalled`, `armEnd`, `GuardTurn`, `preflightThenSpawn`, `spawn`, `preparePaths`, `startTurn`) | 3 | end signal, threaded turn, lessons record, `live` |
| `tests/helpers/supervisor-harness.ts` (recorder pass-through), `tests/omp/supervisor-decisions.test.ts`, `tests/omp/supervision-decisions.test.ts`, `tests/omp/lessons-decisions.test.ts` (new), `tests/core/supervisor-decision-wiring.test.ts` | 3 | tallies, rows, wiring |
| `scripts/stage4-diff-lib.mjs`, `scripts/check-ladder-stage4-differential.mjs`, `scripts/stage4-supervisor-fixture.mjs`, `scripts/stage4-corpora/supervisor.mjs`, `supervision.mjs` | 4 | `r5` pair, fixture, R3/R4 corpus tallies |
| `scripts/stage4-corpora/context.mjs` (new) | 5 | corpus |
| `scripts/live-gate-ladder-remainder-r5.mjs` (new) | 6 | live gate |
| `scripts/check-ladder-remainder-r5-rollback.mjs` (new) | 7 | rollback |

---

### Task 1: The four entries and the cap predicate

**Files:**
- Create: `src/decisions/entries/context-recall.ts`, `context-catch-up.ts`, `context-lessons.ts`, `turn-clarify-cap.ts`; `tests/decisions/context-recall.test.ts`, `context-catch-up.test.ts`, `context-lessons.test.ts`, `turn-clarify-cap.test.ts`
- Modify: `src/capabilities/intent.ts`, `src/decisions/entry-ids.ts:5`, `src/decisions/registry.ts:1–47`, `tests/decisions/registry.test.ts` (`toHaveLength(32)` ×6), `scripts/live-gate-ladder-stage4b.mjs:172`

**Interfaces:**
- Produces: `CONTEXT_RECALL: Entry<RecallInput, RecallVerdict>`, `RecallInput { embedding: boolean; facts: number; pages: number; best_admitted: number | null; best_rejected: number | null }`, `RECALL_REASONS`; `CONTEXT_CATCH_UP: Entry<CatchUpInput, CatchUpVerdict>`, `CatchUpInput { read_failed: boolean; available: number; shown: number }`, `CATCH_UP_MAX_ENTRIES = 6`, `CATCH_UP_REASONS`; `CONTEXT_LESSONS: Entry<LessonsInput, LessonsVerdict>`, `LessonsInput { rendered: number; skipped: number; failed: boolean }`; `TURN_CLARIFY_CAP: Entry<ClarifyCapInput, ClarifyCapVerdict>`; in `intent.ts`: `ClarifyCapInput { trailing: number; max: number }`, `clarifyCapOf(s: ClarifyCapInput): boolean`.

- [ ] **Step 1: Write the failing tests.** Pattern: `tests/decisions/turn-retry.test.ts` (read whole). One file per entry; each pins the entry's shape and its rule over every branch through `decideSync` with a recording fake. `tests/decisions/context-recall.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { CONTEXT_RECALL, RECALL_REASONS, type RecallInput } from "../../src/decisions/entries/context-recall.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";

const none: RecallInput = { embedding: true, facts: 0, pages: 0, best_admitted: null, best_rejected: null };
const verdictOf = (s: RecallInput) => {
  const rows: Array<{ verdict: string; reason: string | null; rung: string }> = [];
  const recorder: DecisionRecorder = { record: (_e, r) => { rows.push({ verdict: r.verdict, reason: r.reason ?? null, rung: r.rung }); return null; } };
  decideSync(CONTEXT_RECALL, s, { run_id: "r", tool_call_id: null, recorder });
  return rows;
};

describe("context.recall (spec R5 §4.1)", () => {
  it("is a rule-only pre_model entry over mixed input that records every consult (Decision 1-A)", () => {
    expect(CONTEXT_RECALL).toMatchObject({ id: "context.recall", version: 1, stage: "pre_model", input: "mixed", verdicts: ["include", "none"], defaultVerdict: "none", fail: "none", alwaysRecord: true, armed: { rule: "on" } });
    expect(CONTEXT_RECALL.locked).toBeUndefined();
    expect(RECALL_REASONS).toEqual(["embedded", "fts_only", "embed_failed", "dropped_after_gate", "below_gate", "unscored"]);
  });
  it.each([
    [{ ...none, facts: 2 }, "include", "embedded"],
    [{ ...none, embedding: false, pages: 1 }, "include", "fts_only"],
    [{ ...none, embedding: false, best_rejected: 0.3 }, "none", "embed_failed"],
    [{ ...none, best_admitted: 0.8, best_rejected: 0.2 }, "none", "dropped_after_gate"],
    [{ ...none, best_rejected: 0.3 }, "none", "below_gate"],
    [none, "none", "unscored"]
  ] as const)("%o → %s / %s, one row at the rule rung", (s, verdict, reason) => {
    expect(verdictOf(s)).toEqual([{ verdict, reason, rung: "rule" }]);
  });
  it("include ⇔ something rendered, over every combination", () => {
    for (const embedding of [true, false]) for (const facts of [0, 1]) for (const pages of [0, 1]) for (const b of [null, 0.4]) {
      const [row] = verdictOf({ embedding, facts, pages, best_admitted: b, best_rejected: b });
      expect(row!.verdict === "include").toBe(facts + pages > 0);
    }
  });
});
```

`tests/decisions/context-catch-up.test.ts` pins `{ id: "context.catch_up", stage: "pre_model", input: "mixed", verdicts: ["inject", "none"], defaultVerdict: "none", fail: "none", alwaysRecord: true }`, `CATCH_UP_MAX_ENTRIES === 6`, `CATCH_UP_REASONS` `["all", "entry_capped", "trimmed", "all_trimmed", "read_failed"]`, and the table: `{read_failed:true, available:3, shown:0}` → `none/read_failed`; `{false, 2, 2}` → `inject/all`; `{false, 6, 6}` → `inject/all`; `{false, 8, 6}` → `inject/entry_capped`; `{false, 8, 5}` → `inject/trimmed`; `{false, 3, 2}` → `inject/trimmed`; `{false, 1, 0}` → `none/all_trimmed`; and `inject` ⇔ `shown > 0 && !read_failed` over `read_failed ∈ {t,f} × available ∈ 0..8 × shown ∈ 0..min(available,6)`.

`tests/decisions/context-lessons.test.ts` pins `{ id: "context.lessons", stage: "pre_model", input: "tool", verdicts: ["full", "capped", "none"], defaultVerdict: "full", fail: "full" }`, `alwaysRecord` undefined, `reasonCodes` `["char_cap", "render_failed"]`, and: `{rendered:3, skipped:0, failed:false}` → `full` (no reason) and **zero rows** through `storeRecorder` on an in-memory store (`RunStore.openInMemory()`; read `decisions` via P11); `{2, 1, false}` → `capped/char_cap`, one row; `{0, 0, true}` → `none/render_failed`, one row; a rule planted to throw (a copy of the entry whose `ladder[0].decide` throws) → one row, `rung: "fail"`, verdict `full`.

`tests/decisions/turn-clarify-cap.test.ts` pins `{ id: "turn.clarify_cap", stage: "pre_model", input: "tool", verdicts: ["allow", "cap"], defaultVerdict: "allow", fail: "allow" }`, `reasonCodes` `["cap_reached"]`; `clarifyCapOf` table `{0,1}`→false, `{1,1}`→true, `{2,1}`→true, `{0,0}`→true; the rule's `cap` ⇔ `clarifyCapOf` over `trailing 0..3 × max 0..3`; `{1,1}` → one `cap/cap_reached` row through `storeRecorder`, `{0,1}` → zero rows; a throwing copy → one `fail`-rung `allow` row.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/decisions/context-recall.test.ts tests/decisions/context-catch-up.test.ts tests/decisions/context-lessons.test.ts tests/decisions/turn-clarify-cap.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement.** `src/capabilities/intent.ts`, after `countTrailingClarifyTurns`:

```ts
/** The consecutive-clarify cap's two numbers (spec R5 §4.4): the trailing clarify turns and the configured maximum. */
export interface ClarifyCapInput { trailing: number; max: number }

/** The one predicate the prompt and the `turn.clarify_cap` rule share: `max = 0` caps every turn. */
export function clarifyCapOf(s: ClarifyCapInput): boolean {
  return s.trailing >= s.max;
}
```

`src/decisions/entries/context-recall.ts`:

```ts
import type { Entry, RungAnswer } from "../types.js";

export const RECALL_REASONS = ["embedded", "fts_only", "embed_failed", "dropped_after_gate", "below_gate", "unscored"] as const;
export type RecallVerdict = "include" | "none";
/** Captured in buildTurnPrompt from the returned TurnRetrieval (spec R5 §4.1): counts and the two sides' best scores, never ids or text. */
export interface RecallInput { embedding: boolean; facts: number; pages: number; best_admitted: number | null; best_rejected: number | null }

function rule(s: RecallInput): RungAnswer<RecallVerdict> {
  if (s.facts + s.pages > 0) return { verdict: "include", reason: s.embedding ? "embedded" : "fts_only" };
  if (!s.embedding) return { verdict: "none", reason: "embed_failed" };
  if (s.best_admitted !== null) return { verdict: "none", reason: "dropped_after_gate" };
  if (s.best_rejected !== null) return { verdict: "none", reason: "below_gate" };
  return { verdict: "none", reason: "unscored" };
}

export const CONTEXT_RECALL: Entry<RecallInput, RecallVerdict> = {
  id: "context.recall", version: 1, stage: "pre_model", input: "mixed",
  question: "Which retrieved episodic facts and wiki pages enter the turn's [context] block?",
  verdicts: ["include", "none"],
  ladder: [{ kind: "rule", name: "relevance_gate", decide: rule }],
  fail: "none", defaultVerdict: "none", outcomes: [], armed: { rule: "on" }, alwaysRecord: true,
  effects: {
    include: { kind: "effect", reversible: true, announced: "none", what: "the admitted facts and pages are in the planner prompt's [context] block; the next turn retrieves afresh" },
    none: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: [...RECALL_REASONS],
};
```

`src/decisions/entries/context-catch-up.ts`:

```ts
import type { Entry, RungAnswer } from "../types.js";

/** The catch-up block shows at most this many of the newest lane turns (moved here from turn-context.ts, which re-exports it). */
export const CATCH_UP_MAX_ENTRIES = 6;
export const CATCH_UP_REASONS = ["all", "entry_capped", "trimmed", "all_trimmed", "read_failed"] as const;
export type CatchUpVerdict = "inject" | "none";
/** Captured in buildTurnPrompt from the one laneTurnsSince read and renderCatchUp's result (spec R5 §4.2). */
export interface CatchUpInput { read_failed: boolean; available: number; shown: number }

function rule(s: CatchUpInput): RungAnswer<CatchUpVerdict> {
  if (s.read_failed) return { verdict: "none", reason: "read_failed" };
  if (s.shown === 0) return { verdict: "none", reason: "all_trimmed" };
  if (s.shown === s.available) return { verdict: "inject", reason: "all" };
  return { verdict: "inject", reason: s.shown === CATCH_UP_MAX_ENTRIES ? "entry_capped" : "trimmed" };
}

export const CONTEXT_CATCH_UP: Entry<CatchUpInput, CatchUpVerdict> = {
  id: "context.catch_up", version: 1, stage: "pre_model", input: "mixed",
  question: "Does the planner prompt carry the quick replies Paco got from the lanes since the planner last answered, and how many fit?",
  verdicts: ["inject", "none"],
  ladder: [{ kind: "rule", name: "catch_up_fit", decide: rule }],
  fail: "none", defaultVerdict: "none", outcomes: [], armed: { rule: "on" }, alwaysRecord: true,
  effects: {
    inject: { kind: "effect", reversible: true, announced: "none", what: "the fenced quick-replies block is in the planner prompt" },
    none: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: [...CATCH_UP_REASONS],
};
```

`src/decisions/entries/context-lessons.ts`:

```ts
import type { Entry, RungAnswer } from "../types.js";

export type LessonsVerdict = "full" | "capped" | "none";
/** Captured in preparePaths from the spawned prompt's snapshot (spec R5 §4.3). */
export interface LessonsInput { rendered: number; skipped: number; failed: boolean }

function rule(s: LessonsInput): RungAnswer<LessonsVerdict> | LessonsVerdict {
  if (s.failed) return { verdict: "none", reason: "render_failed" };
  if (s.skipped > 0) return { verdict: "capped", reason: "char_cap" };
  return "full";
}

export const CONTEXT_LESSONS: Entry<LessonsInput, LessonsVerdict> = {
  id: "context.lessons", version: 1, stage: "pre_model", input: "tool",
  question: "Which active lessons does the spawned planner's system prompt hold under the char cap?",
  verdicts: ["full", "capped", "none"],
  ladder: [{ kind: "rule", name: "lesson_char_cap", decide: rule }],
  fail: "full", defaultVerdict: "full", outcomes: [], armed: { rule: "on" },
  effects: {
    full: { kind: "none", reversible: true, announced: "none" },
    capped: { kind: "tighten", reversible: true, announced: "none", what: "lessons the char cap hid are absent until the next spawn; each raises today's lesson_dropped incident" },
    none: { kind: "tighten", reversible: true, announced: "none", what: "the prompt holds no lessons; today's lesson_render_failed incident is raised" }
  },
  reasonCodes: ["char_cap", "render_failed"],
};
```

`src/decisions/entries/turn-clarify-cap.ts`:

```ts
import { clarifyCapOf, type ClarifyCapInput } from "../../capabilities/intent.js";
import type { Entry, RungAnswer } from "../types.js";

export type ClarifyCapVerdict = "allow" | "cap";

function rule(s: ClarifyCapInput): RungAnswer<ClarifyCapVerdict> | ClarifyCapVerdict {
  return clarifyCapOf(s) ? { verdict: "cap", reason: "cap_reached" } : "allow";
}

export const TURN_CLARIFY_CAP: Entry<ClarifyCapInput, ClarifyCapVerdict> = {
  id: "turn.clarify_cap", version: 1, stage: "pre_model", input: "tool",
  question: "Houge has asked its limit of clarifying questions in a row: does this prompt carry the do-not-ask-another line?",
  verdicts: ["allow", "cap"],
  ladder: [{ kind: "rule", name: "clarify_cap", decide: rule }],
  fail: "allow", defaultVerdict: "allow", outcomes: [], armed: { rule: "on" },
  effects: {
    allow: { kind: "none", reversible: true, announced: "none" },
    cap: { kind: "tighten", reversible: true, announced: "none", what: "CLARIFY_CAP_NOTICE is in the planner prompt; the next non-clarify reply resets the streak" }
  },
  reasonCodes: ["cap_reached"],
};
```

`entry-ids.ts`: append `"context.recall", "context.catch_up", "context.lessons", "turn.clarify_cap"` to `ENTRY_IDS` (after `"turn.retry"`). `registry.ts`: import the four and append `CONTEXT_RECALL as unknown as AnyEntry, CONTEXT_CATCH_UP as unknown as AnyEntry, CONTEXT_LESSONS as unknown as AnyEntry, TURN_CLARIFY_CAP as unknown as AnyEntry` after `TURN_RETRY`. `tests/decisions/registry.test.ts`: every `toHaveLength(32)` → `36` (read each test; if one enumerates stages or ids, extend it with the four). `scripts/live-gate-ladder-stage4b.mjs:172`: `=== 32` → `=== 36`.

- [ ] **Step 4: Run.** The four files → PASS; `npx vitest run tests/decisions` → PASS (registry `entryProblems` empty for all 36); `npm run typecheck` → clean. Plant: swap `embedded`/`fts_only` in the recall rule → the table fails; revert.
- [ ] **Step 5: Commit** (stage by name) — `feat(decisions): context.recall, context.catch_up, context.lessons, turn.clarify_cap entries (rule-only, record-never-steer)`.

---

### Task 2: `turn-context.ts` — recorder, `live`, captures, records; `CoreWorker` passes the recorder

**Files:**
- Modify: `src/omp/turn-context.ts` (`TurnContextDeps`, `TurnPromptInput`, `clarifyCapReached` → `clarifyCapState`, `catchUp`, `buildTurnPrompt`, re-exports), `src/core/core-worker.ts:2395–2405`
- Test: `tests/omp/context-decisions.test.ts` (new), `tests/omp/turn-context.test.ts` (only if a test imports `clarifyCapReached` or `CATCH_UP_MAX_ENTRIES` — the re-export keeps the latter), `tests/core/supervisor-decision-wiring.test.ts`

**Interfaces:**
- Consumes (Task 1): the four entries; `clarifyCapOf`, `ClarifyCapInput`; `CATCH_UP_MAX_ENTRIES`.
- Produces: `TurnContextDeps.recorder?: DecisionRecorder`; `TurnPromptInput.live?: () => boolean`; exported `clarifyCapState(d, chatId): ClarifyCapInput`, `recallInputOf(r: TurnRetrieval): RecallInput | null`, `lessonsInputOf(s: PromptSnapshot): LessonsInput`; re-exports `clarifyCapOf`, `CATCH_UP_MAX_ENTRIES`. `clarifyCapReached` is removed (no importer outside the file).

- [ ] **Step 1: Write the failing tests** — `tests/omp/context-decisions.test.ts`, driving `buildTurnPrompt` directly (pattern: `tests/omp/turn-context.test.ts` — read its store/chat-turn/lane-row seeding helpers and reuse them). A `deps(store, over)` helper builds `TurnContextDeps` with `recorder: storeRecorder(store)` and a counting wrapper; `rows(store)` reads `SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE entry_id IN ('context.recall','context.catch_up','context.lessons','turn.clarify_cap') ORDER BY rowid`. Cases, each asserting the prompt text equals what a deps object **without** a recorder builds for the same store state (the raw answer drives) and the exact rows:
  1. retrieve returns 2 facts with telemetry `{facts:{admitted:2,best_admitted:0.7,best_rejected:0.2,embedding:true,fts_only:false}, pages:{admitted:0,best_admitted:null,best_rejected:null,embedding:true,fts_only:false}}` → `[["context.recall","include","embedded",run,null]]`; recorder calls `{ "context.recall": 1, "turn.clarify_cap": 1 }`.
  2. no telemetry → no `context.recall` call.
  3. `embedding:false`, nothing → `none/embed_failed`; `embedding:true`, nothing, `best_admitted:0.8` on the facts side → `none/dropped_after_gate`; pages-side `best_rejected:0.3` only → `none/below_gate`; all null → `none/unscored`.
  4. two lane rows after the planner's last answer, Telegram → `inject/all`; eight short rows → `inject/entry_capped`; rows whose newest six exceed 2 000 chars → `inject/trimmed`; one 2 100-char row → `none/all_trimmed`; `laneTurnsSince` throwing (a store proxy) → `none/read_failed`; schedule source with rows → no catch-up call; Telegram with no rows → no catch-up call.
  5. one trailing clarify assistant turn, default env → `turn.clarify_cap` `cap/cap_reached` and the prompt contains `CLARIFY_CAP_NOTICE`; a clarify then a `loop` assistant turn → no row, recorder call 1; `HOUGE_MAX_CONSECUTIVE_CLARIFY: "0"` → `cap/cap_reached`.
  6. `live: () => false` → zero recorder calls, zero rows, the prompt and the `loop_started` row identical to a live call's.
  7. one read: a store proxy counting `getRecentChatTurns` and `laneTurnsSince` calls → exactly 1 each per `buildTurnPrompt` (with and without a recorder); `retrieve` called once.
  8. a recorder whose `record` throws → `buildTurnPrompt` resolves, the prompt unchanged.
  9. `lessonsInputOf`: `{ lessonIds:[1,2], skipped:[{lesson_id:3,chars:900,cap:100}], lessonRenderFailed: undefined }` → `{ rendered:2, skipped:1, failed:false }`; `lessonRenderFailed: true` → `failed:true`.
  
  In `tests/core/supervisor-decision-wiring.test.ts` (read whole; it drives `CoreWorker.submitTurn` with a fake omp): seed one `clarify` assistant `chat_turns` row for the chat, run one turn → exactly one `turn.clarify_cap` `cap/cap_reached` row on the run. This fails until `ompTurnContext` passes the recorder.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/omp/context-decisions.test.ts tests/core/supervisor-decision-wiring.test.ts` → FAIL.

- [ ] **Step 3: Implement** in `src/omp/turn-context.ts`. Imports:

```ts
import { chatContextSince, clarifyCapOf, countTrailingClarifyTurns, feedTurnText, resolveChatContextTurnChars, resolveChatContextTurns, resolveMaxConsecutiveClarify, type ClarifyCapInput } from "../capabilities/intent.js";
import { decideSync } from "../decisions/decide.js";
import { CONTEXT_CATCH_UP, CATCH_UP_MAX_ENTRIES } from "../decisions/entries/context-catch-up.js";
import type { LessonsInput } from "../decisions/entries/context-lessons.js";
import { CONTEXT_RECALL, type RecallInput } from "../decisions/entries/context-recall.js";
import { TURN_CLARIFY_CAP } from "../decisions/entries/turn-clarify-cap.js";
import type { DecisionRecorder, Entry } from "../decisions/types.js";
export { clarifyCapOf, CATCH_UP_MAX_ENTRIES };
```

`TurnContextDeps` gains `/** Spec R5 §4.5: recall, catch-up and the cap are recorded through it; absent → no consult. */ recorder?: DecisionRecorder;`. `TurnPromptInput` gains `/** Spec R5 §4.0: false once the turn's end signal fired → no row; absent → live. */ live?: () => boolean;`. Delete the local `export const CATCH_UP_MAX_ENTRIES = 6;` (now re-exported).

Replace `clarifyCapReached`:

```ts
/** The cap's numbers from one read of the chat's recent turns (spec R5 §4.4): the prompt and the row use the same values. */
export function clarifyCapState(d: TurnContextDeps, chatId: string): ClarifyCapInput {
  const turns = d.store.getRecentChatTurns(chatId, resolveChatContextTurns(d.env), chatContextSince(d.env, d.now?.() ?? new Date()));
  return { trailing: countTrailingClarifyTurns(turns), max: resolveMaxConsecutiveClarify(d.env) };
}
```

Captures:

```ts
const bestOf2 = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** context.recall's input (spec R5 §4.1) from the returned retrieval; null when no retrieval was attempted (both memory flags off). */
export function recallInputOf(r: TurnRetrieval): RecallInput | null {
  const t = r.telemetry;
  if (!t) return null;
  return {
    embedding: t.facts.embedding, facts: r.facts.length, pages: r.pages.length,
    best_admitted: bestOf2(t.facts.best_admitted, t.pages.best_admitted), best_rejected: bestOf2(t.facts.best_rejected, t.pages.best_rejected)
  };
}

/** context.lessons' input (spec R5 §4.3) from the spawned prompt's snapshot. */
export function lessonsInputOf(s: PromptSnapshot): LessonsInput {
  return { rendered: s.lessonIds.length, skipped: s.skipped.length, failed: s.lessonRenderFailed === true };
}
```

`catchUp` keeps what it returns today and adds the two capture fields:

```ts
interface CaughtUp { text: string; run_ids: string[]; available: number; read_failed: boolean }

/** Telegram turns only: the lane replies since the planner last answered in this chat (code-only boundary). Never throws. */
function catchUp(d: TurnContextDeps, i: TurnPromptInput, seededRunIds: readonly string[]): CaughtUp {
  if (i.source !== "telegram") return { ...NO_CATCH_UP, available: 0, read_failed: false };
  let available = 0;
  try {
    const rows = d.store.laneTurnsSince(i.chat_id, d.store.plannerLastAnsweredAt(i.chat_id));
    available = rows.length;
    return { ...renderCatchUp(rows, new Set(seededRunIds), resolveChatContextTurnChars(d.env)), available, read_failed: false };
  } catch (e) {
    console.error(`[turn-context] catch-up read failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...NO_CATCH_UP, available, read_failed: true };
  }
}
```

Recording:

```ts
/** decideSync for a rule-only entry on the turn's own run (spec R5 §4.0, §4.5): no recorder or a turn that ended → no call; never throws into the turn. */
function record<S, V extends string>(d: TurnContextDeps, i: TurnPromptInput, entry: Entry<S, V>, s: S): void {
  if (!d.recorder || i.live?.() === false) return;
  try {
    decideSync(entry, s, { run_id: i.run_id, tool_call_id: null, recorder: d.recorder });
  } catch (e) {
    console.error(`[turn-context] decision record failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The three prompt-time consults, after the prompt's pieces are computed (one read each, spec R5 §4.0). */
function recordContextDecisions(d: TurnContextDeps, i: TurnPromptInput, r: TurnRetrieval, caught: CaughtUp, cap: ClarifyCapInput): void {
  const recall = recallInputOf(r);
  if (recall) record(d, i, CONTEXT_RECALL, recall);
  if (i.source === "telegram" && (caught.read_failed || caught.available > 0)) {
    record(d, i, CONTEXT_CATCH_UP, { read_failed: caught.read_failed, available: caught.available, shown: caught.run_ids.length });
  }
  record(d, i, TURN_CLARIFY_CAP, cap);
}
```

`buildTurnPrompt` (only the marked lines change):

```ts
export async function buildTurnPrompt(d: TurnContextDeps, i: TurnPromptInput): Promise<TurnPrompt> {
  const retrieval = await d.retrieve(i.chat_id, i.message);                               // changed: keep the whole result
  const { facts, pages, telemetry } = retrieval;                                         // changed
  const s = sessionSeed(d, i);
  const caught = catchUp(d, i, s.pending ? s.run_ids : []);
  recordAttribution(d, i.run_id, i.applied ?? appliedOf(buildSystemPrompt(d, i.chat_id)), { facts, pages, ...(telemetry ? { telemetry } : {}) }, caught.run_ids);
  const context = renderContextBlock({ facts, pages });
  const prefix = i.source === "schedule" ? SCHEDULED_PREFIX(i.goal ?? i.message) : "";
  const capState = clarifyCapState(d, i.chat_id);                                        // changed
  const cap = clarifyCapOf(capState) ? CLARIFY_CAP_NOTICE : "";                          // changed
  // a schedule fire is not Paco talking: it neither shows nor uses the note, so his first real turn gets it
  const note = i.source === "schedule" ? "" : restartNote(d, i.chat_id);
  recordContextDecisions(d, i, retrieval, caught, capState);                             // new: after every read
  return { /* unchanged */ };
}
```

`src/core/core-worker.ts` `ompTurnContext`: add `recorder: this.decisionRecorder,` beside `env: process.env`.

- [ ] **Step 4: Run.** The two test files → PASS; `npx vitest run tests/omp tests/core` → PASS **except** exact recorder tallies in `tests/omp/supervisor-decisions.test.ts` / `supervision-decisions.test.ts` — those use the TS harness, whose `turnContext` has no recorder yet, so they must still PASS here (Task 3 adds the pass-through and moves them); if any fails, stop and report. `npm run typecheck` clean. Plants: (a) record before `clarifyCapState` with a second `getRecentChatTurns` read → case 7 fails; (b) drop the `live` check → case 6 fails; revert each.
- [ ] **Step 5: Commit** — `feat(omp): record context.recall, context.catch_up and turn.clarify_cap at prompt build, for the live turn's run`.

---

### Task 3: Supervisor — end signal, threaded spawn turn, `context.lessons`, `live`; harness pass-through and tallies

**Files:**
- Modify: `src/omp/planner-supervisor.ts` (`GuardTurn` `:204`, `Turn` `:212`/`:238`, `newDeferred` `:303–307` + new `armEnd`, turn creation `:570–578`, `startTurn` `:627–630`, `retryNextLeg` `:951`, `ensureSession` `:999`, `preflightThenSpawn` `:1004–1013`, `preparePaths` `:1116–1129`, `spawn` `:1131–1134`), `tests/helpers/supervisor-harness.ts:203–207`
- Test: `tests/omp/lessons-decisions.test.ts` (new), `tests/omp/supervisor-decisions.test.ts`, `tests/omp/supervision-decisions.test.ts` (tallies; the two seam calls at `:127`, `:137` gain `endSignalled`), `tests/core/supervisor-decision-wiring.test.ts`

**Interfaces:**
- Consumes (Tasks 1–2): `CONTEXT_LESSONS`, `lessonsInputOf`, `TurnPromptInput.live`, `TurnContextDeps.recorder`.
- Produces: `Turn.endSignalled: boolean`; `GuardTurn = Pick<Turn, "finished" | "endSignalled" | "req">`; private `preflightThenSpawn(fresh: boolean, turn: GuardTurn)`, `spawn(model: ModelString, turn: GuardTurn)`, `preparePaths(turn: GuardTurn)`.

- [ ] **Step 0: Grep the gates (P4)** and write the list into the task report: each of the nine scripts named in P4 → "filters by entry" (cite the line) or "updated".

- [ ] **Step 1: Write the failing tests** — `tests/omp/lessons-decisions.test.ts` on the TS harness with the lazy recorder (`withRecorder` pattern, P11), lessons seeded through the store's lesson API (read `tests/run/lesson-render.test.ts` for the insert helper) and `HOUGE_LESSON_CHAR_CAP` set through the harness `env` **and** `turnContext.env` (the renderer reads `turnContext.env`; pass `extra.turnContext` with the harness's own fields plus `env`):
  1. lessons under the cap, one turn → zero `context.lessons` rows; tally includes one `context.lessons` call.
  2. three lessons, cap 120 chars so one is skipped → one `capped/char_cap` row on the run; one `lesson_dropped` incident (as today).
  3. a store whose `getActiveLessons` throws → one `none/render_failed` row; one `lesson_render_failed` incident.
  4. seam, ended-not-finished: `priv(h.sup).preflightThenSpawn(true, { finished: false, endSignalled: true, req: { run_id: "late" } })` with lessons over the cap → resolves; the system prompt file exists (`join(h.data, "omp", "system-chat-42.md")`); one `lesson_dropped` incident; **zero** `context.lessons` rows and zero recorder calls for it.
  5. seam, live: the same with `endSignalled: false` → one `capped/char_cap` row naming `"late"`.
  6. the end signal: a turn whose `/kill` arrives while `retrieve` is held (`extra.turnContext.retrieve` returns a promise the test resolves; `sup.abort` or the harness's kill path — read `tests/omp/planner-supervisor.test.ts` for how a test kills a running turn) and whose settle is held in `drainJudges` (a read judgement pending — or, if the harness cannot hold it, assert at the seam that `turn.endSignalled` is true while `turn.finished` is false right after `done("abort")`), then the retrieval resolves → the run's `loop_started` row exists and **zero** R5 rows.
  7. `armEnd` re-arms: after `retryNextLeg` (a quota error then success, `quotaThenOk` in `supervision-decisions.test.ts`) the turn's `endSignalled` is false until the retried leg ends (read through the private turn after the first `agent_end` and after `setModel`).
  
  In `tests/core/supervisor-decision-wiring.test.ts`: lessons over a lowered cap → one `context.lessons` `capped/char_cap` row on the first turn's run (production wiring through `CoreWorker`).

- [ ] **Step 2: Run to verify they fail** → FAIL (no row / private methods take no turn).

- [ ] **Step 3: Implement** in `src/omp/planner-supervisor.ts`:

```ts
/** What the crash guard and the lessons consult need of the launching turn (spec R4 §4.0, R5 §4.0). */
type GuardTurn = Pick<Turn, "finished" | "endSignalled" | "req">;
```

In `Turn`, beside `done`/`ended`: `/** Spec R5 §4.0: true from the tick \`ended\` resolves (done called) until a retried leg re-arms it; \`finished\` lags it across settle. */ endSignalled: boolean;`

After `newDeferred`:

```ts
/** A fresh end signal for the turn (creation, each retried leg): `endSignalled` turns true in the tick `ended` resolves (spec R5 §4.0, plan P10). */
function armEnd(t: Pick<Turn, "done" | "ended" | "endSignalled">): void {
  const d = newDeferred();
  t.endSignalled = false;
  t.ended = d.ended;
  t.done = (r) => { t.endSignalled = true; d.done(r); };
}
```

Turn creation: in the literal, `...newDeferred(),` → `...newDeferred(), endSignalled: false,`; right after the literal (before `active.onSendBack = …`): `armEnd(turn);`. `retryNextLeg`: `Object.assign(turn, newDeferred());` → `armEnd(turn);`.

`startTurn`'s `buildTurnPrompt` call gains `live: () => !turn.endSignalled,` in its input object.

`ensureSession`: `this.preflightThenSpawn(fresh)` → `this.preflightThenSpawn(fresh, turn)`. `preflightThenSpawn(fresh: boolean, turn: GuardTurn)`: `return this.spawn(head);` → `return this.spawn(head, turn);`. `spawn(model: ModelString, turn: GuardTurn)`: `const p = this.preparePaths();` → `const p = this.preparePaths(turn);`. `preparePaths(turn: GuardTurn)`:

```ts
    const { path: systemPromptFile, snapshot } = writeSystemPromptFile(turnContext, chatId);
    this.fingerprint = promptTextFingerprint(snapshot.text);
    this.applied = appliedOf(snapshot);
    this.lessonFingerprint = snapshot.lessonFingerprint;
    this.stale = false;
    // spec R5 §4.3: the prompt the child will hold; no row once the launching turn's end signal fired (§4.0)
    if (!turn.endSignalled) this.record(CONTEXT_LESSONS, lessonsInputOf(snapshot), turn.req.run_id);
    return { sessionDir, systemPromptFile, configFile, bridgeDir };
```

Imports: `CONTEXT_LESSONS` from `../decisions/entries/context-lessons.js`; `lessonsInputOf` added to the existing `./turn-context.js` import.

`tests/helpers/supervisor-harness.ts` `harness()`: the `turnContext` literal gains `...(extra.recorder ? { recorder: extra.recorder } : {})` (an `extra.turnContext` still replaces the whole object, as today). `tests/omp/supervision-decisions.test.ts:127`, `:137`: the seam turns gain `endSignalled: true` / `false` matching their `finished`. Then update every exact `counts` array in `supervisor-decisions.test.ts` and `supervision-decisions.test.ts` to the consult order queue/idle → crash guard → `context.lessons` (at a spawn) → `turn.clarify_cap` (at each `buildTurnPrompt` on a live turn), recomputed per test from P4's rule — never by filtering.

- [ ] **Step 4: Run.** `npx vitest run tests/omp tests/core tests/decisions` → PASS, 0 skipped (P12 for the two known flakes); `npm run typecheck && npm test && npm run build` → green. Plants: (a) `!turn.finished` instead of `!turn.endSignalled` in `preparePaths` → case 4 fails; (b) `armEnd` without the `endSignalled = false` reset → case 7 fails; revert each.
- [ ] **Step 5: Commit** — `feat(omp): end signal and the spawning turn reach preparePaths; context.lessons recorded at the spawn`.

---

### Task 4: Harness — `r5` pair, fixture additions, R3/R4 corpus tallies

**Files:** Modify `scripts/stage4-diff-lib.mjs` (`DISTS`, `R5_IDS`, `NEW_ROW_IDS`), `scripts/check-ladder-stage4-differential.mjs` (flags, provenance, ctx, usage, full post-merge command comment), `scripts/stage4-supervisor-fixture.mjs`, `scripts/stage4-corpora/supervisor.mjs`, `scripts/stage4-corpora/supervision.mjs` (tallies).

- [ ] **Step 1: old build (P1).** `MB=$(git merge-base HEAD main)`; verify `git diff --stat 28c4990 $MB -- src scripts tests` is empty (stop and report if not); `git worktree add .worktrees/base-${MB:0:12} $MB`; in it `npm ci && npm run build && node scripts/stamp-dist.mjs <that worktree>` (read `stamp-dist.mjs` for its arguments).
- [ ] **Step 2: lib/CLI.** `DISTS.r5`; `export const R5_IDS = ["context.recall", "context.catch_up", "context.lessons", "turn.clarify_cap"]`; every `NEW_ROW_IDS` set gains `...R5_IDS` (incl. `r3`, `r4`); `r5: new Set(R5_IDS)`; `--old-dist-r5 <dir>` (required; provenance `omp/turn-context.js`) and `--old-base-r5 <sha>` (post-merge only); the header's full post-merge command gains `--old-base-r5 <sha>` (filled in at merge).
- [ ] **Step 3: fixture.** `mkSupervisor`: `opts.recorder` is also passed as `turnContext.recorder`; `opts.turnContext` (an object) is merged over the default `turnContext` (`retrieve`, `env`, `store` proxies); `opts.extra.versionCheck` works as today (the late-launcher item supplies a function that holds its second call on a promise the item releases). A seed helper module section: `seedLessons(store, n, chars)`, `seedClarify(store, chatId)` (one `clarify` assistant `chat_turns` row), `seedLaneRows(store, chatId, texts)` (lane rows after a planner answer — read `laneTurnsSince` / `plannerLastAnsweredAt` in `run-store.ts` for which tables and fields) — ported from `tests/omp/turn-context.test.ts` where it has them. Keep every R3/R4 caller's behaviour.
- [ ] **Step 4: R3/R4 corpus tallies.** Each item's `calls` gains `["context.lessons"]` per spawn and `["turn.clarify_cap"]` per live `buildTurnPrompt` (P4); rows unchanged (both write none on the default path). Measure on the new dist first, then set the literals; each change must match P4's rule — a mismatch is a finding, not a re-pin.
- [ ] **Step 5: verify** — `npm run build`; full differential with every pair's flags plus `--old-dist-r5 /Users/xiaochuan/Projects/adventure/.worktrees/base-<sha>/dist` → every existing corpus PASS; `same_build` mutation (point `--old-dist-r5` at the new dist) → exit 2.
- [ ] **Step 6: commit** — `test(gate): differential gains the r5 pair; supervisor fixture passes the recorder to the turn context and seeds lessons, clarify turns, lane rows`.

---

### Task 5: Corpus `context`

**Files:** Create `scripts/stage4-corpora/context.mjs` (pattern: `scripts/stage4-corpora/supervision.mjs`, read whole).

- [ ] **Step 1: items** — spec §6's list, each on a fresh store and supervisor, the same scenario on old (`DISTS.r5`, no recorder) and new dist (`countingRecorder` over `d.storeRecorder(store)`), no item intaking more than 5 runs per actor (the gateway rate limit). Recall items script `opts.turnContext.retrieve` with fixed blocks and telemetry (synthetic text); catch-up items seed lane rows; lessons items seed lessons and pass `HOUGE_LESSON_CHAR_CAP` in `opts.turnContext.env`; cap items seed a clarify turn or set `HOUGE_MAX_CONSECUTIVE_CLARIFY`. The end-signal recall item holds `retrieve`, kills the turn, holds a judgement so `finished` lags (or, if the dist supervisor gives no hold, drives the kill then releases `retrieve` in the next microtask after `done`), then releases. The late-launcher lessons item follows spec §3/§6 (lane turn B joins A's start, B's `finishLane` times out, B launches its own start whose second `versionCheck` is held, released after B's `done`; real timers) and **asserts the spawn** (system prompt file written, `lesson_dropped` incident present) beside zero `context.lessons` rows; its seam twin calls `sup.preflightThenSpawn(true, { finished: false, endSignalled: true, req: { run_id: "late" } })`. The stale item uses a bridge drop mid-prompt-build (ported from `tests/omp/planner-supervisor.test.ts:741`) and expects `calls` `planner.crash_guard` 2, `context.lessons` 2. Fault items plant a throwing rule per entry (a patched copy of the entry in the dist registry is not possible — instead wrap the counting recorder so `record` receives the entry and the item asserts the `fail`-rung row by running `decideSync` on a throwing copy against the same store; read how `supervision.mjs` planted its mutations and follow that mechanism).
- [ ] **Step 2: project / required** — compared: the session's ordered `log` (full prompt text), the sink's `done`/`failed`/`incidents` (worker ids scrubbed), the system prompt file bytes per spawn, and `dumpDb(store, { dropDecisionIds: [...new-row ids] })` → `relabelClocks` → `scrubIds`; the old side throws if any `R5_IDS` row exists. Required: exact new rows per item `[entry, verdict, reason, run label, null]` and exact per-entry recorder call counts. Coverage + determinism self-tests; two planted mutations each fail `required` once: recall's `embedded`/`fts_only` swapped; catch-up's `all`/`trimmed` swapped.
- [ ] **Step 3: run** `--only context`, then the full differential → every corpus PASS (15 corpora).
- [ ] **Step 4: commit** — `test(gate): context corpus — recall, catch-up, lessons and the clarify cap over the dist supervisor`.

---

### Task 6: Live gate `scripts/live-gate-ladder-remainder-r5.mjs`

Pattern: `scripts/live-gate-ladder-remainder-r4.mjs` (read whole). The Task 4 fixture's supervisor on a VACUUM copy (chat id `-1003`), a fake session (no real omp child), stub Telegram, P2/P3 pins. Spec §7's eight lines with exact values (P5): line 1 a turn whose `retrieve` is the real `CoreWorker` retrieval over the copy (build a `CoreWorker` on the copy and use its `ompTurnContext`-equivalent deps, or drive line 1 through `CoreWorker.submitTurn` with a fake omp) → exactly one `context.recall` row, `include` ⇔ the prompt holds `[context]`, and the `loop_started` payload's keys equal the merge-base build's for the same turn; line 2 `HOUGE_OLLAMA_URL` (read `configuration.md` for the embed URL variable) pointed at a closed local port → reason `embed_failed` or `fts_only`, never `embedded`; line 3 two lane rows → `inject/all`; line 4 a clarify turn → `cap/cap_reached`, notice in the prompt; line 5 lessons over a lowered `HOUGE_LESSON_CHAR_CAP` → `capped/char_cap` on the spawning run, `lesson_dropped` incident; line 6 through `CoreWorker.submitTurn` (production deps) → line 4's row; line 7 insert faulted → `decision_record_failed`, exactly one alert to the stub chat, the prompt unchanged; a throwing recorder → zero `decision_record_failed`, prompt unchanged; line 8 `/status` count lines for the four ids from SQL over the 24 h window. Show lines 1, 4 and 7 failing once each under a planted mutation. Rerun the R4, R3, R2, R1, 4C (`--old-dist .../base-c558413/dist --old-base c558413…`) and 4B (P8) gates: exit 0; `live-gate-jev-tree` compared against `main` (P8). Commit `test(gate): remainder R5 live gate — context decisions on a copy of the live DB, faults`.

---

### Task 7: Rollback check `scripts/check-ladder-remainder-r5-rollback.mjs`

Pattern: `scripts/check-ladder-remainder-r4-rollback.mjs` (read whole). Seed rows of each new id through the real paths on copy F (`include/embedded`, `none/embed_failed`, `inject/all`, `none/read_failed`, `capped/char_cap`, `cap/cap_reached`), dated inside the `/status` 24 h window; the old build (`base-<sha>` from Task 4) opens A and F with no migration, renders `/status` (the four count lines exact from SQL; every other line byte-identical A vs F) and the digest (raw arrays identical A vs F), reads every row unchanged (`rung`, `entry_version`, `verdict`, `reason_code`, `run_id`), and refuses `review_ok` naming each new id; the new build reopens F. Run: every line PASS, exit 0; one planted mutation failing. Commit `test(gate): remainder R5 rollback — the merge-base build reads the new context rows`.

---

## After the tasks (orchestrator)
Full suite + typecheck + build on a quiet machine; the full differential (every pair, 15 corpora); R5, R4, R3, R2, R1, 4C, 4B gates; R5 rollback; final whole-branch reviews (most capable non-orchestrator model, a mutation pass, codex whole-diff); one fix wave; docs sync — ADR 0030 amendment "awaiting Paco's signature" (four entries; rows only while the turn is live, on `endSignalled`, and why `finished` lags; lessons through the supervisor's helper; one read, one predicate; Decisions 1-A, 2-A; the R12 consequence for the two `mixed` entries with an `effect` verdict; the follow-up that R4's crash guard still reads `finished`), index row, ladder §6.1 note, ROADMAP delta, state block, lessons, sessions; merge, push, rebuild, kickstart (Tier A).
