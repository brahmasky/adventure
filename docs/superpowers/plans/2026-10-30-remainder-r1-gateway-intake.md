# Remainder slice R1 — gateway intake entries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `intake.rate_limit`, `intake.rating_reply` and `intake.budget_fuse` (locked) as rule-only, record-never-steer ladder entries at today's `Gateway.intake` decision points, and prove zero behaviour change with the stamped merge-base differential, a live gate and a rollback check.

**Architecture:** Three entry modules under `src/decisions/entries/` (protected), each a total rule over a closed input. `Gateway` keeps deciding exactly as today; at each existing decision point a `decideSync` call records the answer through a lazily built `storeRecorder(this.runStore)`, and its result is discarded. Rows carry `run_id: null` (no run exists at intake). The differential gains an `r1` pair (the stamped merge base of this branch) and an `intake` corpus compared over a whole-DB dump.

**Tech Stack:** Node 25, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest. Zero runtime deps.

**Spec:** `docs/superpowers/specs/2026-10-30-ladder-remainder-r1-gateway-intake-design.md` (Rev 1.3, APPROVED by Paco 2026-10-30: 1-A, 2-A, 3-A). Read it before any task.

## Rulings from the plan review (senior Sonnet 5.5, Fable 429 — ran Tasks 1–3 in a worktree: 47 + 6 tests green, typecheck clean, mutation checks on the exemption pins: 0 B on Tasks 1–3, 1 B / 4 W / 4 S overall; codex: 5 B / 3 W)
- **P1 (codex B1) — `/kill` writes the real tombstone.** `handleKill` → `writeTombstone`, default cwd-relative `houge.kill` (`run/tombstone.ts:20`): a probe run from the repo root kills the live daemon. Every place that intakes `kill` (Task 2 test, Task 5 fixture, Task 6 gate) pins `HOUGE_TOMBSTONE_PATH` and `HOUGE_DISARM_PATH` to a temp file and restores them in `finally`, exactly as `tests/gateway/kill-switch.test.ts:24–34` does (`PINNED_ENV`). Never run a kill probe without it.
- **P2 (senior B1) — the whole-DB dump must be deterministic.** Store writes stamp the wall clock (`schema_migrations.applied_at`, `decisions.created_at` `record.ts:42`, ledger `occurred_at`), so two runs differ in clock ranks. Each item runs under a **fake `Date`** (a `globalThis.Date` subclass whose `new Date()`/`Date.now()` return `NOW + n` ms from a per-item counter, restored in `finally`; pattern: `withFixedClock` in `stage4-admit-fixture.mjs`). Order inside `project`: **filter** the intake `decisions` rows out of the dump, **then** `relabelClocks`, **then** `scrubIds` (a filtered row's `created_at` must not occupy a rank). A determinism self-test runs one item twice on the new dist and requires equal projections.
- **P3 (codex W1) — keep raw JSON.** `dumpDb` does **not** parse `*_json` columns: the raw string is compared (byte-identical claim), and `relabelClocks` already relabels clocks inside `_json` strings textually.
- **P4 (codex B3, senior W3) — seeding the limiter.** `active_runs` counts `runs.type = 'run'` only, by actor (`run-store.ts:2666–2674`); turn runs never count. `pending_approvals` counts `approvals.state = 'pending'` by requester. `createApprovalRequest` throws unless the run is `running` (`run-store.ts:6717`). Seeds: active runs = intake `n` type-`run` events from actor `paco` on chat `999`; pending approvals = intake **one** run on chat `999`, `claimRun` it, create `n` approvals with distinct fingerprints on it, then move that run out of the active states with the store's own transition (read `run-store.ts` for the method that sets `cancelled`/`failed`; name it in the fixture comment) so `active_runs` stays at 0.
- **P5 (codex B4) — helper identity.** Every fixture helper takes `{ chat, actor }` explicitly; the corpus passes `222`/`paco`, the gate `gate-r1-chat`/`gate-r1-actor`.
- **P6 (codex B2) — the gate's `/status` clock.** Rows are stamped with the wall clock; the gate calls `decisionStatusLines(store, new Date().toISOString())`, never the fixture `NOW`.
- **P7 (codex B5) — rollback after merge.** The rollback check takes `--old-base-r1 <full sha>` (required once merged, as `mergeBaseOf` refuses a merge base equal to HEAD, `old-dist-provenance.mjs:45`), and the post-merge command passes it.
- **P8 (senior W1) — provenance file.** `verifyStampedDist` hard-codes `core/core-worker.js` (`old-dist-provenance.mjs:77`), which R1 does not change → `same_build`. Add a fourth parameter `file = "core/core-worker.js"`; pass `"gateway/gateway.js"` for `r1`. Unconditional.
- **P9 (senior W2) — no `WITHOUT ROWID` table exists** today; `dumpDb` asserts it (throws naming the table) instead of a pre-check.
- **P10 (senior W4) — pin the exempt set's contents**, not only its relationships: `[...RATE_LIMIT_EXEMPT].sort()` equals `["decision_review", "improvement_tap", "jev_accept_tap", "kill"]`.
- **P11 (codex W2) — "no other decision rows" boundary:** `required` reads only `decisions` rows with `rowid` greater than the max `rowid` taken after seeding.
- **P12 (senior S1) — memory-lane fuse:** a `memlane_ask` under a tripped fuse writes the `intake.budget_fuse` row (inside `admitMemLaneAsk`'s transaction, which commits on `ok: false`, `run-store.ts:4711`) and returns the unchanged result (Task 2 test).
- **P13 (codex W3) — commit trailer:** every commit recipe below carries `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
- Settled by the senior run (no change needed): no import cycle `src/decisions` → `src/budget` (drop the fallback); no second fuse site; `limit.error.reason` is already the three-string union (`run-store.ts:244`, no cast); the `recorderCache` override works (the gate reaches it by the same cast); the re-wrapped scheduled event compiles. `intake()` and `captureRatingReply` already exceed 50 lines; the slice adds 1–3 lines each (named in the commit bodies, split left as a follow-up).

## Global Constraints

- `dependencies: {}` stays empty; Node stdlib plus devDeps only.
- **Behaviour identical:** every `GatewayIntakeResult`, error code and message, `telegram_command_audit` row, ledger event, outbox row, rating/lesson/wiki/verdict row, run row and their order stay byte-identical to the merge base. The only new rows are `decisions` rows with `entry_id` in `intake.rate_limit`, `intake.rating_reply`, `intake.budget_fuse` — plus, only when a decision insert fails, the existing `decision_record_failed` incident and its alert (spec §4.4, stated delta).
- **Raw answer drives (Stage 4B R1):** `decideSync`'s result is never used for a branch.
- **Order kept:** in `Gateway.intake`: exemption check → rate limit → … → rating capture (turns only) → `handleTaskIntake` (contract compile → budget fuse → `createOrGet`). Nothing new runs before an existing return.
- **Exemption outside the entry (Decision 3-A):** `RATE_LIMIT_EXEMPT` stays a code check in front of `decideSync`; an exempt command never reaches `intake.rate_limit`.
- Entries: `version: 1`, `stage: "intake"`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`. `intake.budget_fuse` is `locked: true` (already in `LOCKED_ENTRY_IDS`); the other two are not locked.
- Exactly: `intake.rate_limit` — verdicts `allow | limit`, default `allow`, `fail: "limit"`, input `"tool"`, no `alwaysRecord`, reasons `command_window`, `active_runs`, `pending_approvals`. `intake.rating_reply` — verdicts `consume | forward | lapse`, default `lapse`, `fail: "lapse"`, input `"paco"`, `alwaysRecord: true`, reasons `bare_digit`, `digit_comment`, `not_rating` (1:1 with the verdicts). `intake.budget_fuse` — verdicts `admit | refuse`, default `admit`, `fail: "refuse"`, input `"tool"`, no `alwaysRecord`, reasons `runs`, `tool_calls`, `gated_attempts` (the first breached kind in `GLOBAL_BUDGET_KINDS` order).
- Every row: `run_id: null`, `tool_call_id: null`.
- No user message text, goal text, comment text or chat content in any decision row, test print or script print. Tests use synthetic text only (the repo is public).
- `HOUGE_TELEGRAM_CHAT_ID`: cleared (tests, differential) or pinned to a stub (live gate) wherever a recorder fault is provoked — `Gateway`'s recorder has no env, so a `decision_record_failed` alert would otherwise target the real chat.
- Functions under 50 lines (new ones); match surrounding style; tests in `tests/<area>/` mirroring `src/`.
- Never write the live DB (`houge.sqlite`); live checks use a `VACUUM INTO` copy deleted on every exit path.
- Commits: Conventional Commits, one concern each, stage files by name, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/decisions/entries/intake-rate-limit.ts` (new) | 1 | entry + `IntakeRateLimitInput` |
| `src/decisions/entries/intake-rating-reply.ts` (new) | 1 | entry + `RatingReplyOutcome` |
| `src/decisions/entries/intake-budget-fuse.ts` (new) | 1 | locked entry + `firstBreach` |
| `src/decisions/entry-ids.ts`, `src/decisions/registry.ts` | 1 | 23 → 26 ids |
| `tests/decisions/{intake-rate-limit,intake-rating-reply,intake-budget-fuse}.test.ts` (new), `tests/decisions/registry.test.ts` | 1 | entry pins, counts 26, locked test |
| `scripts/live-gate-ladder-stage4b.mjs:172` | 1 | count 23 → 26 |
| `src/gateway/gateway.ts` (recorder, rate limit, fuse; export `RATE_LIMIT_EXEMPT`) | 2 | two call sites |
| `tests/gateway/intake-decisions.test.ts` (new) | 2 | limiter + fuse rows, exemption pins, faults |
| `src/gateway/gateway.ts` (`captureRatingReply`) | 3 | three rating call sites |
| `tests/gateway/rating-reply-decisions.test.ts` (new) | 3 | rating rows, replay, conflict |
| `scripts/stage4-diff-lib.mjs`, `scripts/check-ladder-stage4-differential.mjs` | 4 | `r1` pair, `NEW_ROW_IDS`, `dumpDb` |
| `scripts/stage4-intake-fixture.mjs` (new), `scripts/stage4-corpora/intake.mjs` (new) | 5 | intake corpus |
| `scripts/live-gate-ladder-remainder-r1.mjs` (new) | 6 | live gate |
| `scripts/check-ladder-remainder-r1-rollback.mjs` (new) | 7 | rollback check |

---

### Task 1: The three entries on the registry

**Files:**
- Create: `src/decisions/entries/intake-rate-limit.ts`, `src/decisions/entries/intake-rating-reply.ts`, `src/decisions/entries/intake-budget-fuse.ts`
- Modify: `src/decisions/entry-ids.ts:5`, `src/decisions/registry.ts` (imports + `REGISTRY`), `tests/decisions/registry.test.ts:122-142`, `scripts/live-gate-ladder-stage4b.mjs:172`
- Test: `tests/decisions/intake-rate-limit.test.ts`, `tests/decisions/intake-rating-reply.test.ts`, `tests/decisions/intake-budget-fuse.test.ts`

**Interfaces:**
- Produces:
  - `INTAKE_RATE_LIMIT: Entry<IntakeRateLimitInput, IntakeRateLimitVerdict>`; `type IntakeRateLimitVerdict = "allow" | "limit"`; `INTAKE_RATE_LIMIT_REASONS = ["command_window", "active_runs", "pending_approvals"] as const`; `type IntakeRateLimitReason`; `interface IntakeRateLimitInput { limited: IntakeRateLimitReason | null }`.
  - `INTAKE_RATING_REPLY: Entry<RatingReplyInput, RatingReplyOutcome>`; `type RatingReplyOutcome = "consume" | "forward" | "lapse"`; `interface RatingReplyInput { outcome: RatingReplyOutcome }`.
  - `INTAKE_BUDGET_FUSE: Entry<BudgetFuseInput, BudgetFuseVerdict>`; `type BudgetFuseVerdict = "admit" | "refuse"`; `interface BudgetFuseInput { breached: readonly GlobalBudgetKind[] }` (the kinds in breach order; empty = admit).

- [ ] **Step 1: Write the failing entry tests**

`tests/decisions/intake-rate-limit.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_RATE_LIMIT, INTAKE_RATE_LIMIT_REASONS } from "../../src/decisions/entries/intake-rate-limit.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_RATE_LIMIT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: null, tool_call_id: null, recorder };

describe("intake.rate_limit — a Telegram command the per-chat limiter refuses leaves a row naming the check", () => {
  it("is rule-only, unlocked, refusal-only, fails to limit (consulted only after a denial), sound", () => {
    expect(INTAKE_RATE_LIMIT.locked).toBeUndefined();
    expect(INTAKE_RATE_LIMIT.alwaysRecord).toBeUndefined();
    expect(INTAKE_RATE_LIMIT.stage).toBe("intake");
    expect(INTAKE_RATE_LIMIT.fail).toBe("limit");
    expect(INTAKE_RATE_LIMIT.reasonCodes).toEqual(["command_window", "active_runs", "pending_approvals"]);
    expect(entryProblems(INTAKE_RATE_LIMIT as unknown as AnyEntry)).toEqual([]);
  });
  it("not limited → allow, not recorded (the accepted audit row already counts it)", () => {
    expect(decideSync(INTAKE_RATE_LIMIT, { limited: null }, ctx).verdict).toBe("allow");
    expect(rows).toEqual([]);
  });
  it.each([...INTAKE_RATE_LIMIT_REASONS])("limited by %s → limit with that reason, recorded", (code) => {
    expect(decideSync(INTAKE_RATE_LIMIT, { limited: code }, ctx)).toMatchObject({ verdict: "limit", reason: code });
    expect(rows).toEqual([{ verdict: "limit", reason: code }]);
  });
});
```

`tests/decisions/intake-rating-reply.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_RATING_REPLY } from "../../src/decisions/entries/intake-rating-reply.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_RATING_REPLY as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: null, tool_call_id: null, recorder };

describe("intake.rating_reply — an open rating ask that meets a message leaves one row for what happened to it", () => {
  it("is rule-only, unlocked, always recorded, reads Paco's own message, sound", () => {
    expect(INTAKE_RATING_REPLY.locked).toBeUndefined();
    expect(INTAKE_RATING_REPLY.alwaysRecord).toBe(true);
    expect(INTAKE_RATING_REPLY.input).toBe("paco");
    expect(INTAKE_RATING_REPLY.reasonCodes).toEqual(["bare_digit", "digit_comment", "not_rating"]);
    expect(entryProblems(INTAKE_RATING_REPLY as unknown as AnyEntry)).toEqual([]);
  });
  it.each([["consume", "bare_digit"], ["forward", "digit_comment"], ["lapse", "not_rating"]] as const)("%s → reason %s (a 1:1 map), recorded", (outcome, reason) => {
    expect(decideSync(INTAKE_RATING_REPLY, { outcome }, ctx)).toMatchObject({ verdict: outcome, reason });
    expect(rows).toEqual([{ verdict: outcome, reason }]);
  });
});
```

`tests/decisions/intake-budget-fuse.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_BUDGET_KINDS } from "../../src/budget/global-budget-ledger.js";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_BUDGET_FUSE } from "../../src/decisions/entries/intake-budget-fuse.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_BUDGET_FUSE as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: null, tool_call_id: null, recorder };

describe("intake.budget_fuse — a run the global 24h fuse refuses leaves a row (ADR 0003, locked)", () => {
  it("is locked, rule-only, refusal-only, sound", () => {
    expect(INTAKE_BUDGET_FUSE.locked).toBe(true);
    expect(LOCKED_ENTRY_IDS).toContain("intake.budget_fuse");
    expect(INTAKE_BUDGET_FUSE.alwaysRecord).toBeUndefined();
    expect(INTAKE_BUDGET_FUSE.reasonCodes).toEqual([...GLOBAL_BUDGET_KINDS]);
    expect(entryProblems(INTAKE_BUDGET_FUSE as unknown as AnyEntry)).toEqual([]);
  });
  it("no breach → admit, not recorded (an admitted run is already a global_budget_events row)", () => {
    expect(decideSync(INTAKE_BUDGET_FUSE, { breached: [] }, ctx).verdict).toBe("admit");
    expect(rows).toEqual([]);
  });
  it.each([...GLOBAL_BUDGET_KINDS])("%s breached → refuse with that kind", (kind) => {
    expect(decideSync(INTAKE_BUDGET_FUSE, { breached: [kind] }, ctx)).toMatchObject({ verdict: "refuse", reason: kind });
  });
  it("two kinds breached → the first one is the row's reason (the full list stays in the global_budget_fuse event)", () => {
    expect(decideSync(INTAKE_BUDGET_FUSE, { breached: ["tool_calls", "gated_attempts"] }, ctx)).toMatchObject({ verdict: "refuse", reason: "tool_calls" });
  });
});
```

In `tests/decisions/registry.test.ts`: change both `expect(ENTRY_IDS).toHaveLength(23);` (`:132`, `:142`) to `toHaveLength(26)`, and after the Stage 4C block (ends `:143`) add:
```ts
  it("intake.rate_limit, intake.rating_reply (unlocked) and intake.budget_fuse (locked) are registered rule-only intake entries (remainder R1)", () => {
    for (const [id, locked] of [["intake.rate_limit", false], ["intake.rating_reply", false], ["intake.budget_fuse", true]] as const) {
      const e = entryById(id) as AnyEntry;
      expect(e).toBeDefined();
      expect(e.stage).toBe("intake");
      expect(e.locked === true).toBe(locked);
      expect(e.ladder.map((r) => r.kind)).toEqual(["rule"]);
      expect((LOCKED_ENTRY_IDS as readonly string[]).includes(id)).toBe(locked);
    }
    expect(ENTRY_IDS).toHaveLength(26);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/decisions/intake-rate-limit.test.ts tests/decisions/intake-rating-reply.test.ts tests/decisions/intake-budget-fuse.test.ts tests/decisions/registry.test.ts`
Expected: FAIL — cannot resolve the three entry modules; registry length 23.

- [ ] **Step 3: Write the entries**

`src/decisions/entries/intake-rate-limit.ts`:
```ts
import type { Entry, RungAnswer } from "../types.js";

export type IntakeRateLimitVerdict = "allow" | "limit";
/** RunStore.checkTelegramRateLimit's reasons verbatim, in its check order (spec 2026-10-30 R1 §3.1). */
export const INTAKE_RATE_LIMIT_REASONS = ["command_window", "active_runs", "pending_approvals"] as const;
export type IntakeRateLimitReason = (typeof INTAKE_RATE_LIMIT_REASONS)[number];
/** The exempt commands never reach this entry (Decision 3-A): RATE_LIMIT_EXEMPT is checked in Gateway.intake first. */
export interface IntakeRateLimitInput { limited: IntakeRateLimitReason | null }

function rule(s: IntakeRateLimitInput): RungAnswer<IntakeRateLimitVerdict> {
  return s.limited === null ? { verdict: "allow" } : { verdict: "limit", reason: s.limited };
}

export const INTAKE_RATE_LIMIT: Entry<IntakeRateLimitInput, IntakeRateLimitVerdict> = {
  id: "intake.rate_limit", version: 1, stage: "intake", input: "tool",
  question: "Does this Telegram command pass the per-chat rate limit?",
  verdicts: ["allow", "limit"],
  ladder: [{ kind: "rule", name: "checkTelegramRateLimit", decide: rule }],
  fail: "limit", defaultVerdict: "allow", outcomes: [], armed: { rule: "on" },
  effects: { allow: { kind: "none", reversible: true, announced: "none" }, limit: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [...INTAKE_RATE_LIMIT_REASONS],
};
```

`src/decisions/entries/intake-rating-reply.ts`:
```ts
import type { Entry, RungAnswer } from "../types.js";

/** What an open, in-window rating ask did with the next message (spec 2026-10-30 R1 §4.2). */
export type RatingReplyOutcome = "consume" | "forward" | "lapse";
export interface RatingReplyInput { outcome: RatingReplyOutcome }
const REASON = { consume: "bare_digit", forward: "digit_comment", lapse: "not_rating" } as const satisfies Record<RatingReplyOutcome, string>;

function rule(s: RatingReplyInput): RungAnswer<RatingReplyOutcome> {
  return { verdict: s.outcome, reason: REASON[s.outcome] };
}

export const INTAKE_RATING_REPLY: Entry<RatingReplyInput, RatingReplyOutcome> = {
  id: "intake.rating_reply", version: 1, stage: "intake", input: "paco",
  question: "Does this message answer the open rating ask (consume a bare digit, forward a comment) or let it lapse?",
  verdicts: ["consume", "forward", "lapse"],
  ladder: [{ kind: "rule", name: "parseBareRating", decide: rule }],
  fail: "lapse", defaultVerdict: "lapse", alwaysRecord: true, outcomes: [], armed: { rule: "on" },
  effects: {
    consume: { kind: "reply", reversible: false, announced: "none", what: "the rating is banked; the code-owned ack is the reply" },
    forward: { kind: "effect", reversible: false, announced: "none", what: "the rating is banked; the comment runs as the turn" },
    lapse: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: [REASON.consume, REASON.forward, REASON.lapse],
};
```

`src/decisions/entries/intake-budget-fuse.ts`:
```ts
import type { GlobalBudgetKind } from "../../budget/global-budget-ledger.js";
import type { Entry, RungAnswer } from "../types.js";

export type BudgetFuseVerdict = "admit" | "refuse";
/** computeBreaches' kinds, in GLOBAL_BUDGET_KINDS order; empty = under every cap. */
export interface BudgetFuseInput { breached: readonly GlobalBudgetKind[] }

function rule(s: BudgetFuseInput): RungAnswer<BudgetFuseVerdict> {
  const first = s.breached[0];
  return first === undefined ? { verdict: "admit" } : { verdict: "refuse", reason: first };
}

export const INTAKE_BUDGET_FUSE: Entry<BudgetFuseInput, BudgetFuseVerdict> = {
  id: "intake.budget_fuse", version: 1, stage: "intake", input: "tool", locked: true,
  question: "Is every rolling-24h global cap under its limit, so a new run may be admitted (ADR 0003)?",
  verdicts: ["admit", "refuse"],
  ladder: [{ kind: "rule", name: "checkGlobalBudget", decide: rule }],
  fail: "refuse", defaultVerdict: "admit", outcomes: [], armed: { rule: "on" },
  effects: { admit: { kind: "none", reversible: true, announced: "none" }, refuse: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["runs", "tool_calls", "gated_attempts"],
};
```

In `src/decisions/entry-ids.ts:5` append `"intake.rate_limit", "intake.rating_reply", "intake.budget_fuse"` to `ENTRY_IDS` after `"memory.correct_preflight"`. In `src/decisions/registry.ts` import the three constants beside the other entry imports and append `INTAKE_RATE_LIMIT as unknown as AnyEntry, INTAKE_RATING_REPLY as unknown as AnyEntry, INTAKE_BUDGET_FUSE as unknown as AnyEntry` to `REGISTRY` after `MEMORY_CORRECT_PREFLIGHT`. In `scripts/live-gate-ladder-stage4b.mjs:172` change `=== 23` to `=== 26` (and any "23" in that line's label).

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/decisions/ && npm run typecheck`
Expected: PASS; typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/entries/intake-rate-limit.ts src/decisions/entries/intake-rating-reply.ts src/decisions/entries/intake-budget-fuse.ts src/decisions/entry-ids.ts src/decisions/registry.ts tests/decisions/intake-rate-limit.test.ts tests/decisions/intake-rating-reply.test.ts tests/decisions/intake-budget-fuse.test.ts tests/decisions/registry.test.ts scripts/live-gate-ladder-stage4b.mjs
git commit -m "feat(decisions): register intake.rate_limit, intake.rating_reply, intake.budget_fuse (rule-only, record never steer)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Rate-limit and budget-fuse call sites in `Gateway`

**Files:**
- Modify: `src/gateway/gateway.ts` (`:139` export `RATE_LIMIT_EXEMPT`; a lazy `decisionRecorder` getter; `intake` `:165–191`; `handleTaskIntake` `:1083–1120`)
- Test: `tests/gateway/intake-decisions.test.ts` (new)

**Interfaces:**
- Consumes: `INTAKE_RATE_LIMIT`, `INTAKE_BUDGET_FUSE` (Task 1); `decideSync` (`src/decisions/decide.js`); `storeRecorder` (`src/decisions/record.js`).
- Produces: `export const RATE_LIMIT_EXEMPT` (gateway.ts); `private get decisionRecorder(): DecisionRecorder` on `Gateway` (Task 3 uses it).

- [ ] **Step 1: Write the failing test** — `tests/gateway/intake-decisions.test.ts`

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_BUDGET_CAPS } from "../../src/budget/global-budget-ledger.js";
import { buildTypedTaskEvent, type TypedTaskEvent } from "../../src/domain/types.js";
import { Gateway, RATE_LIMIT_EXEMPT } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-10-30 R1 §4.1, §4.3: the limiter and the fuse record what they refused; nothing they return changes.
const CHAT = "222";
const NOW = "2026-07-03T12:00:00.000Z";
let seq = 0;
// P1: kill writes a tombstone; HOUGE_TOMBSTONE_PATH/HOUGE_DISARM_PATH MUST point at a temp dir or the probe stops the live daemon.
const PINNED = ["HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH"] as const;
const saved: Partial<Record<(typeof PINNED)[number], string>> = {};
let dir = "";
beforeEach(() => {
  for (const k of PINNED) { if (process.env[k] !== undefined) saved[k] = process.env[k]; else delete saved[k]; }
  dir = mkdtempSync(join(tmpdir(), "hg-intake-"));
  delete process.env.HOUGE_TELEGRAM_CHAT_ID;
  process.env.HOUGE_TOMBSTONE_PATH = join(dir, "test.kill");
  process.env.HOUGE_DISARM_PATH = join(dir, "test.disarm");
});
afterEach(() => {
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function ev(type: string, extra: Record<string, unknown> = {}, source: "telegram" | "schedule" = "telegram"): TypedTaskEvent {
  seq += 1;
  return buildTypedTaskEvent({ source, type, program: "turn", goal: "synthetic", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `t:${seq}`, source_reference: `telegram:update:${seq}:message:${seq}`, ...extra } as never);
}
function saturate(store: RunStore, command = "turn", n = 5): void {
  for (let i = 0; i < n; i += 1) store.recordTelegramCommandAudit({ actor_id: "paco", chat_id: CHAT, command, source_reference: `s${i}`, decision: "accepted", occurred_at: NOW });
}
const intakeRows = (store: RunStore) => (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db
  .prepare("SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE entry_id LIKE 'intake.%' ORDER BY rowid").all();

describe("intake.rate_limit at Gateway.intake", () => {
  it("a sixth command in the window → TELEGRAM_RATE_LIMITED as before, one limit/command_window row with no run", () => {
    const store = RunStore.openInMemory();
    saturate(store);
    const r = new Gateway(store).intake(ev("turn"), NOW);
    expect(r).toEqual({ ok: false, error: { code: "TELEGRAM_RATE_LIMITED", message: "Telegram command rate limit exceeded" } });
    expect(intakeRows(store)).toEqual([{ entry_id: "intake.rate_limit", verdict: "limit", reason_code: "command_window", run_id: null, tool_call_id: null }]);
  });
  it("an admitted command writes no rate-limit row", () => {
    const store = RunStore.openInMemory();
    expect(new Gateway(store).intake(ev("turn"), NOW).ok).toBe(true);
    expect(intakeRows(store).filter((r) => r.entry_id === "intake.rate_limit")).toEqual([]);
  });
  it.each([...RATE_LIMIT_EXEMPT])("exempt %s on a saturated window never reaches the entry (Decision 3-A: no rung can delay it)", (type) => {
    const store = RunStore.openInMemory();
    saturate(store);
    const spy = vi.fn();
    const g = new Gateway(store);
    (g as unknown as { recorderCache: unknown }).recorderCache = { record: spy };
    g.intake(ev(type), NOW);
    expect(spy.mock.calls.filter(([e]) => (e as { id: string }).id === "intake.rate_limit")).toEqual([]);
    expect(intakeRows(store).filter((r) => r.entry_id === "intake.rate_limit")).toEqual([]);
  });
  it("the exempt set is exactly kill and the three digest taps (dropping one would silently rate-limit it)", () => {
    expect([...RATE_LIMIT_EXEMPT].sort()).toEqual(["decision_review", "improvement_tap", "jev_accept_tap", "kill"]);
  });
  it("the TS exemption and the SQL window exclusion agree: every exempt command except kill never counts toward the window", () => {
    for (const cmd of RATE_LIMIT_EXEMPT) {
      const store = RunStore.openInMemory();
      saturate(store, cmd);
      const limited = !new Gateway(store).intake(ev("turn"), NOW).ok;
      expect([cmd, limited]).toEqual([cmd, cmd === "kill"]); // kill is absent from the SQL NOT IN on purpose (run-store.ts checkTelegramRateLimit)
    }
  });
  it("a scheduled source is never limited and writes no row", () => {
    const store = RunStore.openInMemory();
    saturate(store);
    expect(new Gateway(store).intake(ev("turn", {}, "schedule"), NOW).ok).toBe(true);
    expect(intakeRows(store)).toEqual([]);
  });
  it("the denied audit row is still written, after the decision row, exactly as before", () => {
    const store = RunStore.openInMemory();
    saturate(store);
    new Gateway(store).intake(ev("turn"), NOW);
    const audit = (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db
      .prepare("SELECT decision, reason_code FROM telegram_command_audit WHERE decision = 'denied'").all();
    expect(audit).toEqual([{ decision: "denied", reason_code: "command_window" }]);
  });
});

describe("intake.budget_fuse at handleTaskIntake", () => {
  it("runs cap reached → GLOBAL_BUDGET_FUSE as before, one alert, one refuse/runs row; a second refusal → no second alert, a second row", () => {
    const store = RunStore.openInMemory();
    const g = new Gateway(store, { ...DEFAULT_GLOBAL_BUDGET_CAPS, runs: 0 });
    expect(g.intake(ev("turn"), NOW)).toEqual({ ok: false, error: { code: "GLOBAL_BUDGET_FUSE", message: "Global 24h budget reached; new runs are paused until the window clears" } });
    g.intake(ev("turn"), NOW);
    expect(intakeRows(store).map((r) => [r.entry_id, r.verdict, r.reason_code, r.run_id])).toEqual([["intake.budget_fuse", "refuse", "runs", null], ["intake.budget_fuse", "refuse", "runs", null]]);
    const alerts = (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db.prepare("SELECT 1 FROM notification_outbox WHERE idempotency_key LIKE 'global-budget-fuse:%'").all();
    expect(alerts).toHaveLength(1);
  });
  it("two kinds breached → the first kind in GLOBAL_BUDGET_KINDS order", () => {
    const store = RunStore.openInMemory();
    new Gateway(store, { ...DEFAULT_GLOBAL_BUDGET_CAPS, tool_calls: 0, gated_attempts: 0 }).intake(ev("turn"), NOW);
    expect(intakeRows(store).map((r) => r.reason_code)).toEqual(["tool_calls"]);
  });
  it("a memory-lane Dig deeper under a tripped fuse writes the fuse row inside its transaction and returns the unchanged refusal (P12)", () => {
    const store = RunStore.openInMemory();
    const original = createQueuedTurnRun(store, "synthetic rule");
    store.insertJevVerdict({ run_id: original, category: "memory", breadth: 1, reasoning: 1, actions: 0, sets_rule: 0.95, rule_scope: "ask",
      lane: "memory", role: "default", effort: null, cascade: null, save_outcome: "saved", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });
    const g = new Gateway(store, { ...DEFAULT_GLOBAL_BUDGET_CAPS, runs: 0 }, undefined, undefined, undefined, { dataDir: dir });
    const r = g.intake(buildTypedTaskEvent({ source: "telegram", type: "memlane_ask", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "mla:1", source_reference: "mla:1",
      metadata: { telegram_update_id: 1, telegram_callback_id: "mla:1", run_id: original } }), NOW);
    expect(r).toMatchObject({ ok: false, error: { code: "GLOBAL_BUDGET_FUSE" } });
    expect(intakeRows(store).map((x) => [x.entry_id, x.verdict, x.reason_code])).toEqual([["intake.budget_fuse", "refuse", "runs"]]);
  });
  it("under every cap → no fuse row", () => {
    const store = RunStore.openInMemory();
    new Gateway(store).intake(ev("turn"), NOW);
    expect(intakeRows(store).filter((r) => r.entry_id === "intake.budget_fuse")).toEqual([]);
  });
});

describe("a failing decision write never changes the intake result (spec §4.4)", () => {
  it("insert fault → decision_record_failed opened, result and audit row unchanged", () => {
    const store = RunStore.openInMemory();
    saturate(store);
    vi.spyOn(store, "insertDecision").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(new Gateway(store).intake(ev("turn"), NOW)).toMatchObject({ ok: false, error: { code: "TELEGRAM_RATE_LIMITED" } });
    const kinds = (store as unknown as { db: { prepare(s: string): { all(): Array<{ kind: string }> } } }).db.prepare("SELECT kind FROM incidents").all().map((r) => r.kind);
    expect(kinds).toContain("decision_record_failed");
  });
  it("a recorder that throws past itself → logged, no incident, result unchanged", () => {
    const store = RunStore.openInMemory();
    saturate(store);
    const g = new Gateway(store);
    (g as unknown as { recorderCache: unknown }).recorderCache = { record: () => { throw new Error("boom"); } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(g.intake(ev("turn"), NOW)).toMatchObject({ ok: false, error: { code: "TELEGRAM_RATE_LIMITED" } });
    expect(err).toHaveBeenCalled();
    const n = (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db.prepare("SELECT 1 FROM incidents").all();
    expect(n).toEqual([]);
  });
});
```
The memory-lane case (setup from `tests/gateway/memlane-commands.test.ts:16–45`): `createQueuedTurnRun` uses default caps, so the seed run is admitted; run the case once on the unmodified gateway first and confirm the merge base also returns `GLOBAL_BUDGET_FUSE` there (if it returns something else, pin what it returns — the row assertion is the new part). Add `import { createQueuedTurnRun } from "../helpers/runs.js";`. Before writing: confirm `store.insertDecision` is the method `storeRecorder` calls (read `src/decisions/record.ts:50`); confirm the type names the exempt commands need in `buildTypedTaskEvent` (`kill`, `decision_review`, `improvement_tap`, `jev_accept_tap` — copy each one's required fields from its existing test: `tests/gateway/kill-switch.test.ts`, `tests/gateway/decision-commands.test.ts`, `tests/gateway/improvement-commands.test.ts`, `tests/gateway/jev-accept-commands.test.ts`; the `ev` helper takes them in `extra`). Use synthetic text only.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/gateway/intake-decisions.test.ts`
Expected: FAIL — `RATE_LIMIT_EXEMPT` is not exported; no `intake.*` rows.

- [ ] **Step 3: Implement**

Imports in `gateway.ts`:
```ts
import { decideSync } from "../decisions/decide.js";
import { INTAKE_BUDGET_FUSE } from "../decisions/entries/intake-budget-fuse.js";
import { INTAKE_RATE_LIMIT } from "../decisions/entries/intake-rate-limit.js";
import { storeRecorder } from "../decisions/record.js";
import type { DecisionRecorder } from "../decisions/types.js";
```
`:139`: `export const RATE_LIMIT_EXEMPT …` (add `export`, nothing else).
In the class, beside the other private fields:
```ts
  private recorderCache?: DecisionRecorder;
  /** Lazy, like CoreWorker's (core-worker.ts:560): the intake entries' rows have no run (spec 2026-10-30 R1 §4). No env: a record failure pages HOUGE_TELEGRAM_CHAT_ID. */
  private get decisionRecorder(): DecisionRecorder { return (this.recorderCache ??= storeRecorder(this.runStore)); }
```
In `intake`, inside `if (!limit.ok) {`, as its first statement:
```ts
        decideSync(INTAKE_RATE_LIMIT, { limited: limit.error.reason }, { run_id: null, tool_call_id: null, recorder: this.decisionRecorder });
```
(Check `TelegramRateLimitResult`'s error type: `limit.error.reason` must type as the three-string union; if it is `string`, add `as IntakeRateLimitReason` only after confirming `telegramRateLimited`'s parameter type lists exactly those three.)
In `handleTaskIntake`, inside `if (!budget.ok) {`, as its first statement:
```ts
      decideSync(INTAKE_BUDGET_FUSE, { breached: budget.breaches.map((b) => b.kind) }, { run_id: null, tool_call_id: null, recorder: this.decisionRecorder });
```
Run `grep -n "budget.ok\|checkGlobalBudget" src/gateway/gateway.ts` first: if a second fuse site exists (e.g. in `admitMemLaneAsk`), it gets the same line; record the site list in the commit body.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/gateway/ tests/decisions/ && npm run typecheck`
Expected: PASS (the existing gateway suites unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/gateway.ts tests/gateway/intake-decisions.test.ts
git commit -m "feat(gateway): intake.rate_limit and intake.budget_fuse record the intake refusals; exemption stays in front of the entry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `intake.rating_reply` call sites

**Files:**
- Modify: `src/gateway/gateway.ts` (`captureRatingReply` `:311–400`)
- Test: `tests/gateway/rating-reply-decisions.test.ts` (new)

**Interfaces:**
- Consumes: `INTAKE_RATING_REPLY`, `RatingReplyOutcome` (Task 1); `this.decisionRecorder` (Task 2).

- [ ] **Step 1: Write the failing test** — `tests/gateway/rating-reply-decisions.test.ts`

Copy the env pinning, `NOW`, `CHAT`, `minutesAgo`, `turnEvent` and `notificationText` from `tests/gateway/rating-capture.test.ts:1–50`; add the `HOUGE_TELEGRAM_CHAT_ID` save/delete/restore from Task 2's test. Helper:
```ts
const ratingRows = (store: RunStore) => (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db
  .prepare("SELECT verdict, reason_code, run_id FROM decisions WHERE entry_id = 'intake.rating_reply' ORDER BY rowid").all();
const ask = (store: RunStore, minutes = 40) => store.writePendingRating({ chat_id: CHAT, asked_at: minutesAgo(minutes), window_start: minutesAgo(120) });
```
Cases:
```ts
describe("intake.rating_reply — one row per fresh decision an open ask makes", () => {
  it("bare digit → consumed with the ack as before, one consume/bare_digit row with no run", () => {
    const store = RunStore.openInMemory(); ask(store);
    const r = new Gateway(store).intake(turnEvent("3", "k1"), NOW);
    expect(r).toMatchObject({ ok: true, status: "rating_captured", rating: 3 });
    expect(notificationText(store, "telegram:k1:rating")).toBe(RATING_ACK_TEXT);
    expect(ratingRows(store)).toEqual([{ verdict: "consume", reason_code: "bare_digit", run_id: null }]);
  });
  it("digit + comment → the turn runs on the comment, one forward/digit_comment row", () => {
    const store = RunStore.openInMemory(); ask(store);
    const r = new Gateway(store).intake(turnEvent("2，synthetic comment", "k2"), NOW);
    expect(r).toMatchObject({ ok: true, status: "created" });
    expect(ratingRows(store)).toEqual([{ verdict: "forward", reason_code: "digit_comment", run_id: null }]);
  });
  it("an ordinary message → the ask lapses, the turn runs, one lapse/not_rating row", () => {
    const store = RunStore.openInMemory(); ask(store);
    new Gateway(store).intake(turnEvent("synthetic question", "k3"), NOW);
    expect(store.getPendingRating(CHAT)?.active).toBeFalsy();
    expect(ratingRows(store)).toEqual([{ verdict: "lapse", reason_code: "not_rating" }].map((x) => ({ ...x, run_id: null })));
  });
  it("no ask, an expired ask, an inactive ask, a scheduled source → no row", () => {
    const none = RunStore.openInMemory();
    new Gateway(none).intake(turnEvent("3", "n1"), NOW);
    const expired = RunStore.openInMemory(); ask(expired, 24 * 60 * 30);
    new Gateway(expired).intake(turnEvent("3", "n2"), NOW);
    const inactive = RunStore.openInMemory(); ask(inactive); inactive.cancelPendingRating(CHAT);
    new Gateway(inactive).intake(turnEvent("3", "n3"), NOW);
    const sched = RunStore.openInMemory(); ask(sched);
    new Gateway(sched).intake(buildTypedTaskEvent({ ...turnEvent("3", "n4"), source: "schedule" } as never), NOW);
    for (const s of [none, expired, inactive, sched]) expect(ratingRows(s)).toEqual([]);
  });
  it("a replayed bare digit or comment repeats its result and writes no second row (A6 idempotency is mechanics)", () => {
    const store = RunStore.openInMemory(); ask(store);
    const g = new Gateway(store);
    const first = g.intake(turnEvent("3", "r1"), NOW);
    expect(g.intake(turnEvent("3", "r1"), NOW)).toEqual(first);
    const s2 = RunStore.openInMemory(); ask(s2);
    const g2 = new Gateway(s2);
    g2.intake(turnEvent("1 synthetic", "r2"), NOW);
    g2.intake(turnEvent("1 synthetic", "r2"), NOW);
    expect(ratingRows(store)).toHaveLength(1);
    expect(ratingRows(s2)).toHaveLength(1);
  });
  it("an idempotency conflict → the same conflict result as before, no row", () => {
    const store = RunStore.openInMemory(); ask(store);
    const g = new Gateway(store);
    g.intake(turnEvent("3", "c1"), NOW);
    const r = g.intake(turnEvent("2", "c1"), NOW);
    expect(r).toMatchObject({ ok: false });
    expect(ratingRows(store)).toHaveLength(1);
  });
});
```
Read `captureRatingReply` before writing: confirm the expired-ask arithmetic uses `HOUGE_RATING_PENDING_MINUTES` (default from `resolveRatingPendingMinutes`) so `minutesAgo(24*60*30)` is past it; confirm what `intake` returns for the comment case (`status: "created"` from `handleTaskIntake`) by reading `rating-capture.test.ts`'s comment case.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/gateway/rating-reply-decisions.test.ts`
Expected: FAIL — no `intake.rating_reply` rows.

- [ ] **Step 3: Implement**

Import in `gateway.ts`:
```ts
import { INTAKE_RATING_REPLY, type RatingReplyOutcome } from "../decisions/entries/intake-rating-reply.js";
```
New private method beside `captureRatingReply`:
```ts
  /** intake.rating_reply (spec 2026-10-30 R1 §4.2): one row per fresh decision of an open, in-window ask; never on a replay or conflict. */
  private recordRatingReply(outcome: RatingReplyOutcome): void {
    decideSync(INTAKE_RATING_REPLY, { outcome }, { run_id: null, tool_call_id: null, recorder: this.decisionRecorder });
  }
```
Call it at exactly three places in `captureRatingReply`, and nowhere else:
- `if (!parsed) { this.runStore.cancelPendingRating(chat_id); this.recordRatingReply("lapse"); return undefined; }`
- in `if (parsed.comment) {`, after `this.runStore.recordTriggerProcessed(event, marker);` and before the `return`: `this.recordRatingReply("forward");`
- after `this.recordTelegramAccepted(event, now);` and before `return { kind: "consumed", result };`: `this.recordRatingReply("consume");`

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/gateway/ && npm run typecheck`
Expected: PASS (`rating-capture.test.ts` unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/gateway.ts tests/gateway/rating-reply-decisions.test.ts
git commit -m "feat(gateway): intake.rating_reply records what an open rating ask did with the next message" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Harness — `r1` pair, row filters, whole-DB dump

**Files:**
- Modify: `scripts/stage4-diff-lib.mjs` (`DISTS`, `NEW_ROW_IDS`, new `dumpDb`, `EXPORTS`), `scripts/check-ladder-stage4-differential.mjs` (args, provenance, ctx, usage comment)

**Interfaces:**
- Produces: `DISTS.r1`, `ctx.dists.r1`; corpora use `pairs: [["r1", "new"]]`; `NEW_ROW_IDS.r1`; `export function dumpDb(store): Record<string, Array<Record<string, unknown>>>`; `export const INTAKE_IDS` (the three new ids).

- [ ] **Step 1: lib** — 
  - `DISTS = { new: null, s3: null, s4a: null, s4b: null, r1: null }`.
  - `export const INTAKE_IDS = ["intake.rate_limit", "intake.rating_reply", "intake.budget_fuse"];` and `NEW_ROW_IDS` becomes:
```js
export const NEW_ROW_IDS = {
  s3: new Set(["approval.bind", "secret.redact", ...INTAKE_IDS]),
  s4a: new Set(["approval.bind", "secret.redact", ...INTAKE_IDS]),
  s4b: new Set(["memory.lesson_admit", "schedule.admit", "memory.correct_preflight", ...INTAKE_IDS]),
  r1: new Set(INTAKE_IDS)
};
```
    (Spec §6: the branch build is the new side of every pair; an existing corpus whose fixture intakes through `Gateway` could trip a limiter or fuse and would otherwise show a spurious difference.) Update the doc comment above it.
  - `dumpDb(store, { dropDecisionIds })` (P2, P3, P9):
```js
/**
 * Every table's rows in rowid order, FTS shadow tables and sqlite_* excluded: the whole-DB projection (spec R1 §6). Raw column
 * values, `*_json` strings NOT parsed (byte-identical compare; relabelClocks reaches clocks inside them textually). `decisions` rows
 * whose entry_id is in dropDecisionIds are removed HERE, before any clock relabelling, so they never occupy a clock rank (P2).
 */
export function dumpDb(store, { dropDecisionIds = [] } = {}) {
  const tables = store.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts*' ORDER BY name").all();
  const drop = new Set(dropDecisionIds);
  const out = {};
  for (const { name, sql } of tables) {
    if (/WITHOUT\s+ROWID/i.test(sql ?? "")) throw new Error(`dumpDb: ${name} is WITHOUT ROWID; order it by its primary key first`);
    let rows = store.db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}" ORDER BY rowid`).all();
    if (name === "decisions") rows = rows.filter((r) => !drop.has(r.entry_id));
    if (rows.length) out[name] = rows.map((r) => ({ ...r }));
  }
  return out;
}
```
  - `EXPORTS`: add `DEFAULT_GLOBAL_BUDGET_CAPS: "budget/global-budget-ledger.js"`.

- [ ] **Step 2: CLI** — `--old-dist-r1 <dir>` (required; must contain `gateway/gateway.js`); `verifyProvenance` also runs `verifyStampedDist(a.oldR1, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBaseR1 ?? undefined))` with a new `--old-base-r1 <sha>` (required once the branch is merged) and prints `r1  old build pinned to merge base: worktree HEAD …, dist stamp …`. `--old-dist-4b` and `--old-base` keep meaning the 4C merge base (`c558413`) and stay required. **Provenance file (P8):** `verifyStampedDist` hard-codes `core/core-worker.js` (`old-dist-provenance.mjs:77`); add a fourth parameter `file = "core/core-worker.js"` used in that `same_build` comparison, and pass `"gateway/gateway.js"` for `r1` (the file this slice changes; lesson 2026-10-29). The s4b call is unchanged. `DISTS.r1`, `ctx.dists.r1 = await loadDist(args.oldR1)`. Usage comment gains both flags.

- [ ] **Step 3: Verify** — create the merge-base worktree (the commit `main` was at when this branch was cut): `git worktree add .worktrees/base-<mb7> <mb>`; `ln -s ../../node_modules .worktrees/base-<mb7>/node_modules`; `node scripts/stamp-dist.mjs .worktrees/base-<mb7>`. Then on the branch: `npm run build && node scripts/check-ladder-stage4-differential.mjs --old-dist-3 .worktrees/base-548cb87/dist --old-dist-4a .worktrees/base-1451a66/dist --old-dist-4b .worktrees/base-c558413/dist --old-base c558413<full sha> --old-dist-r1 .worktrees/base-<mb7>/dist`
Expected: the nine existing corpora PASS unchanged; exit 0. Then `touch .worktrees/base-<mb7>/dist/x.js` → exit 2 with the stamp error; remove it → exit 0. Then pass `--old-dist-r1 dist` (the new build itself) → exit 2 `same_build` on `gateway/gateway.js` (P8 mutation proof). (If `.worktrees/base-c558413` no longer exists, recreate and stamp it the same way; `git rev-parse c558413` gives the full sha.)

- [ ] **Step 4: Commit**

```bash
git add scripts/stage4-diff-lib.mjs scripts/check-ladder-stage4-differential.mjs scripts/old-dist-provenance.mjs
git commit -m "test(gate): differential gains the r1 stamped pair, a whole-DB dump, and filters the intake rows on every pair" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Corpus `intake`

**Files:**
- Create: `scripts/stage4-intake-fixture.mjs`, `scripts/stage4-corpora/intake.mjs`

**Interfaces:**
- Consumes: `DISTS`, `mkStore`, `mkTemp`, `requireNew`, `dumpDb`, `relabelClocks`, `INTAKE_IDS` (Task 4); each dist's `Gateway`, `buildTypedTaskEvent`, `DEFAULT_GLOBAL_BUDGET_CAPS`.
- Produces (P5: identity explicit everywhere; `who = { chat, actor }`): `intakeEvent(d, who, { type, goal, source, key, extra })`, `saturateWindow(store, who, command, n, now)`, `seedActiveRuns(d, store, who, n, now)`, `seedPendingApprovals(d, store, who, n, now)`, `seedAsk(store, who, now, minutesAgo, active)`, `withPinnedEnv(dir, fn)` (P1: sets `HOUGE_TOMBSTONE_PATH`, `HOUGE_DISARM_PATH` under `dir`, deletes `HOUGE_TELEGRAM_CHAT_ID` and `HOUGE_RATING_PENDING_MINUTES`, restores all in `finally`), `withCountingClock(now, fn)` (P2) in `stage4-intake-fixture.mjs` (Task 6 reuses them).

Corpus module shape: copy `scripts/stage4-corpora/schedule.mjs` (`export default { name, pairs, min: { items, branches }, load, project, required }`).

- [ ] **Step 1: Fixture** — `stage4-intake-fixture.mjs`. Fixed `NOW = "2026-07-03T12:00:00.000Z"`; the corpus's `who = { chat: "222", actor: "paco" }`; synthetic goals only. `intakeEvent` wraps that dist's `buildTypedTaskEvent` with the same shape as Task 2's `ev`, using `who`. `saturateWindow` writes `n` accepted `telegram_command_audit` rows for `who` through `store.recordTelegramCommandAudit`. `seedActiveRuns` (P4) intakes `n` **type-`run`** events (`type: "run"`, the shape `tests/gateway/gateway-telegram.test.ts` uses for a run intake — read it) from `who.actor` on chat `999`, so the window for `who.chat` stays empty. `seedPendingApprovals` (P4) intakes one run on chat `999`, `store.claimRun`s it, calls `store.createApprovalRequest` `n` times with distinct `action_fingerprint`s and requester `{ kind: "user", id: who.actor }` (fields from `ApprovalRequestInput`), then moves that run out of `queued`/`running`/`waiting_for_approval` with the store's own transition (name the method in a comment), and asserts `active_runs` would not fire (count it with the same SQL). `seedAsk` calls `store.writePendingRating` for `who.chat` and, for `active: false`, `store.cancelPendingRating`. Every item runs inside `withPinnedEnv(tempDir, () => withCountingClock(NOW, …))`.

- [ ] **Step 2: Items** (tags in brackets; every item on its own fresh temp-file store via `mkStore(d, "bare", …)`, `new d.Gateway(store, caps)` with caps from `{ ...d.DEFAULT_GLOBAL_BUDGET_CAPS, ...item.caps }`, every `intake(event, NOW)` given `NOW`):
  - rate limit: window at 5 and at 4 [`command_window`, `under`]; active runs at the threshold and one under [`active_runs`, `under`]; pending approvals at the threshold and one under [`pending_approvals`, `under`]; each of the four exempt commands on a saturated window [`exempt`]; each exempt command's accepted rows saturating the window then a `turn` [`exempt_count`]; a scheduled source on a saturated window [`schedule`].
  - rating: active in-window ask × {bare `3`, `2，synthetic`, `0 synthetic`, `1.synthetic`, an ordinary sentence} [`consume`, `forward`, `lapse`]; low rating `0` with a seeded routed verdict for the chat (`markLowRating` → `jev_verdicts` + correction; seed through the store method `tests/gateway/rating-capture.test.ts` uses for its low-rating case) [`low`]; expired ask, inactive ask, no ask, scheduled source with an ask [`no_ask`]; replay of a bare digit and of a comment (same idempotency key twice) [`replay`]; idempotency conflict (same key, different text) [`conflict`].
  - fuse: each kind breached alone (`caps: { runs: 0 }` etc.), two kinds, under cap [`fuse`, `fuse_multi`, `under`]; first trip then a second intake in the same item (one alert, two rows) [`fuse_repeat`]; a scheduled source breached [`schedule`].
- [ ] **Step 3: project / required** — `project` (P2 order): take `seedMax = max(rowid)` of `decisions` after seeding; run the item; read the intake rows `SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > seedMax` into `view.intake` (marked `__strip` so it is not compared, and checked by `required`); then `relabelClocks({ results, db: dumpDb(store, { dropDecisionIds: INTAKE_IDS }) }, (k) => /(_at|_since|^since|^now)$/.test(k))`; then `scrubIds` (from `stage4-bind-fixture.mjs`, as `schedule.mjs` does). On the old side throw if `view.intake` holds any `INTAKE_IDS` row (control). Coverage self-test in `project`: `Object.keys(db)` must equal the set of tables with rows per a direct `sqlite_master` + `count(*)` loop (minus the dropped rows) — throw on a mismatch. Determinism self-test (P2): the corpus's `load` runs its first rating item twice on `DISTS.new` and throws unless the two projections are `canon`-equal. `required` (P11): `view.intake` (rows after `seedMax` only) equals the item's `expect` table of `[entry_id, verdict, reason_code, null, null]`, and holds no other entry id. `min.items` = the item count; `min.branches` = every tag above.

- [ ] **Step 4: Run**

Run: `npm run build && node scripts/check-ladder-stage4-differential.mjs <the five old-dist flags of Task 4> --only intake`, then the whole differential without `--only`.
Expected: `PASS intake`, self-test ok; then all ten corpora PASS, `STAGE 4 DIFFERENTIAL: PASS`, exit 0, no `hg-s4d-*` left under `/tmp`.

- [ ] **Step 5: Commit**

```bash
git add scripts/stage4-intake-fixture.mjs scripts/stage4-corpora/intake.mjs
git commit -m "test(gate): intake corpus for the differential — limiter, rating capture and fuse over a whole-DB dump" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Live gate `scripts/live-gate-ladder-remainder-r1.mjs`

**Files:**
- Create: `scripts/live-gate-ladder-remainder-r1.mjs`

Pattern: `scripts/live-gate-ladder-stage4c.mjs` (read whole first): refuses to run outside `.worktrees/`, imports `../dist/`, `HOUGE_ENV_FILE` for env, a `VACUUM INTO` copy of `houge.sqlite` under a temp root removed in `finally` and on SIGINT/SIGTERM/SIGHUP, numbered `check(n, label, ok, detail)` lines, exit 0 only if all pass, prints counts and codes, never text. **Set `process.env.HOUGE_TELEGRAM_CHAT_ID = "gate-stub-chat"` before any store opens** (line 6 must not page Paco), and **`HOUGE_TOMBSTONE_PATH` / `HOUGE_DISARM_PATH` under the gate's temp root before line 2** (P1: line 2 intakes `kill`; with the default path it would write `houge.kill` in the cwd and stop the live daemon) — all restored on exit, and the gate asserts after line 2 that `<cwd>/houge.kill` does not exist.

- [ ] **Step 1: Write the eight lines of spec §7** on the copy (`RunStore.open(copy, storeOptionsFor(undefined, {}))`, `new Gateway(store, caps)`, the Task 5 fixture helpers imported from `./stage4-intake-fixture.mjs` with the gate's own dist module object `{ Gateway, buildTypedTaskEvent, DEFAULT_GLOBAL_BUDGET_CAPS }` and `who = { chat: "gate-r1-chat", actor: "gate-r1-actor" }` (P5; the copy's real rows never count toward that window); the gate reaches `recorderCache` by the same cast as the unit test):
1. a sixth command in the window → `TELEGRAM_RATE_LIMITED`; one row `limit/command_window`, `run_id` null; the denied audit row present.
2. `kill` on the same saturated window → not `TELEGRAM_RATE_LIMITED`; no new `intake.rate_limit` row.
3. an active ask + bare `3` → `rating_captured`, the `:rating` ack queued, row `consume/bare_digit`; the same update again → same result, still one row.
4. an active ask + `2，synthetic` → `created`, row `forward/digit_comment`; a fresh ask + an ordinary message → ask inactive, row `lapse/not_rating`.
5. caps `{ runs: 0 }` → `GLOBAL_BUDGET_FUSE`, one `global-budget-fuse:` alert, row `refuse/runs`; a second message → no second alert, two rows. (The copy's fuse latch may already be set from history: read `global_budget_fuse_state` first and, if latched, assert "no new alert, rows written" instead of "one alert", printing which.)
6. `store.insertDecision` faulted once → `decision_record_failed` incident opened, line 1's result unchanged; any alert row it queued targets `gate-stub-chat`, never the real chat; separately a recorder that throws (set `gateway.recorderCache`) → no incident, result unchanged, the `decideSync` error logged (capture `console.error`).
7. `decisionStatusLines(store, new Date().toISOString())` (P6: rows carry the wall clock) from `dist/decisions/status-view.js` contains one count line per new id.
8. `store.insertLadderMove(...)` naming `intake.budget_fuse` → refused (locked). Read `insertLadderMove`'s signature and copy the minimal valid move from `scripts/check-ladder-stage4b-rollback.mjs` or its tests.

- [ ] **Step 2: Run**

Run: `npm run build && HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-remainder-r1.mjs`
Expected: `8/8 PASS`, exit 0; the temp root gone. Then rerun `scripts/live-gate-ladder-stage4b.mjs` (count now 26) and `scripts/live-gate-ladder-stage4c.mjs`: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/live-gate-ladder-remainder-r1.mjs
git commit -m "test(gate): remainder R1 live gate — intake rows on a copy of the live DB, faults, /status lines, the lock" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Rollback check `scripts/check-ladder-remainder-r1-rollback.mjs`

**Files:**
- Create: `scripts/check-ladder-remainder-r1-rollback.mjs`

Pattern: `scripts/check-ladder-stage4c-rollback.mjs` (read whole; it uses `verifyStampedDist` for `--old-dist`). Flags: `--old-dist <dir>` (required), `--old-base-r1 <full sha>` (P7, passed to `mergeBaseOf`), provenance file `gateway/gateway.js` (P8). Any 4C assertion dropped here is named in the script header with why.

- [ ] **Step 1: Lines** — on a VACUUM copy: the new build writes one row of each new id through `Gateway.intake` (as the live gate does; all three `run_id` null); the old build (the r1 merge-base dist, `--old-dist`) then opens the copy (no migration, no error), renders `/status` (`decisionStatusLines`) and the digest (no throw), lists `decisions` (every stored row present, count unchanged; the digest's chat-bound review omitting null-run rows is by design, spec §5 — not a loss), and calls its `ENTRY_IDS`-validated writer naming each new id — `review_ok` in `outcomes.ts` — asserting it refuses with its normal error, not a crash; the new build reopens the copy and still reads all rows.

- [ ] **Step 2: Run**

Run (before merge): `npm run build && node scripts/check-ladder-remainder-r1-rollback.mjs --old-dist .worktrees/base-<mb7>/dist`; after merge on `main`: add `--old-base-r1 <full merge-base sha>` (P7; `mergeBaseOf` refuses a base equal to HEAD).
Expected: every line PASS, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-ladder-remainder-r1-rollback.mjs
git commit -m "test(gate): remainder R1 rollback — the merge-base build reads the null-run intake rows and refuses writes naming the new ids" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks (orchestrator, not a task)
Full suite + typecheck + build; the differential (all ten corpora), the R1 live gate, the 4B and 4C live gates and the rollback on the final head; whole-branch reviews (most capable non-orchestrator model + codex whole-diff + security/correctness/testing/adversarial); docs sync — ADR 0030 amendment row drafted "awaiting Paco's signature" (the three entries; §6.1 corrections from Decision 2-A: `memory.rule_save` absorbed, `notify.page` not an entry; Decision 3-A: the rate-limit exemption is code in front of the entry) + index row, ladder design §6.1 table note, ROADMAP delta, `tasks/todo.md` state block, `tasks/lessons.md`, `sessions.md`; follow-up noted: `countLines`'s stale doc comment (`digest.ts:90`); merge, push, rebuild, kickstart (Tier A).
