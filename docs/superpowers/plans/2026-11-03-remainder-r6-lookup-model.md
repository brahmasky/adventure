# Remainder slice R6 — `lookup.rewrite`, `lookup.thin`, `turn.model` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the lookup lane's two decisions and the planner pin as rule-only, record-never-steer entries — the lane's decided at the branch and written at the lane's end while the signal is unaborted, `turn.model` written after each pin walk while the turn is live — and prove zero behaviour change with the stamped merge-base differential, a live gate and a rollback check.

**Architecture:** Three entry modules under `src/decisions/entries/`. The lane's predicates (`rewriteFilterOf`, `queryCheckOf`, `thinOf`) live in a new leaf module `src/core/lanes/lookup-predicates.ts`; `needsRewrite`/`validateQuery` become thin wrappers and the lane branches on the same functions the rules call. `runLookupLane` owns a per-run pending list that `lookupQuery` and `readStep` push to; its `finally` writes the list. The supervisor captures the pin walk's outcome in `pinFirst` and `promptRetry` and records through its existing `record()` helper, before any failure path.

**Tech Stack:** Node 25, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest. Zero runtime deps.

**Spec:** `docs/superpowers/specs/2026-11-03-ladder-remainder-r6-lookup-model-design.md` (Rev 1.2, Decisions 1-A, 2-A by Paco 2026-11-03). Read it before any task. Pattern slice: R5 (`docs/superpowers/plans/2026-11-02-remainder-r5-context-clarify.md`, shipped `088ccb5`).

## Rulings (orchestrator)
- **P1 — merge base and old builds.** The branch `remainder-r6` is cut from `main` after this plan's commit. Every commit on `main` after `088ccb59` is docs-only (verified at plan time: `git diff --stat 088ccb59 HEAD -- src scripts tests` empty; Task 4 re-verifies against the merge base and stops if not). The `r6` old build is the merge base, built and stamped in `.worktrees/base-<12-char sha>` (`npm ci && npm run build && node scripts/stamp-dist.mjs <worktree>`); after the merge it is passed as `--old-base-r6 <full sha>`. Older pairs keep their invocations (the differential's header comment); R5's is `--old-dist-r5 .worktrees/base-9c23f084be37/dist` + post-merge `--old-base-r5 9c23f084be37adad90cd8030c94430e9bed798c3`. Post-merge runs from the main checkout also pass `--live-db /Users/xiaochuan/Projects/adventure/houge.sqlite` (the redaction corpus's default path assumes a `.worktrees/<name>/` cwd) and check the node exit code directly, never through a pipe.
- **P2 — `/kill`.** Any test, corpus or gate that could intake `kill` pins `HOUGE_TOMBSTONE_PATH` / `HOUGE_DISARM_PATH` to a temp dir and asserts no `houge.kill` in the cwd afterwards.
- **P3 — `HOUGE_TELEGRAM_CHAT_ID`** cleared (tests, differential) or a stub (gates) wherever a recorder fault is provoked.
- **P4 — exact tallies, never filters.** `record()` is called on every consult (row or not). New event rules: `turn.model` +1 per pin walk that returns other than `ENDED` while `!turn.endSignalled`, on the first leg after `turn.clarify_cap`/`context.*`, on a retry leg after `turn.retry`; `lookup.rewrite` +1 per lookup run entering `lookupQuery` (written at the lane's end, if unaborted); `lookup.thin` +1 per successful first read (same). Measured sites (senior spec review; Task 4 re-measures on the new dist before setting literals, a mismatch with the rule is a finding, not a re-pin): `scripts/stage4-corpora/supervisor.mjs:116–132` (17 items), `supervision.mjs:106–140` (18; `claimed_elsewhere_latched` and `late_consult` never reach `promptTop`), `context.mjs:186` (`TURN`) and its items. Keyed/filtered (no churn, verify): R3/R4/R5 gates, `tests/omp/{supervisor,supervision,context,lessons}-decisions.test.ts`, `tests/core/supervisor-decision-wiring.test.ts`.
- **P5 — exact PASS values; one planted mutation per new assertion** (R2 lesson).
- **P6 — module names.** `scrubIds` from `scripts/stage4-bind-fixture.mjs`; `withPinnedEnv`, `withCountingClock` from `scripts/stage4-intake-fixture.mjs`; `countingRecorder` from `scripts/stage4-sender-fixture.mjs`; `mkStore`, `mkTemp`, `dumpDb`, `relabelClocks`, `requireNew`, `canon`, `DISTS`, `NEW_ROW_IDS` from `scripts/stage4-diff-lib.mjs`; `fakeSession`, `heldSession`, `sink`, `mkSupervisor`, `intakeRun`, `req`, `until`, `untilState`, `cleanup`, `cleanupSettled`, `removeDataDirsSync` from `scripts/stage4-supervisor-fixture.mjs`.
- **P7 — commit trailer** names the implementing model (`Co-Authored-By: Claude <Model> 5.5 <noreply@anthropic.com>`).
- **P8 — live gates read live data.** The `command`/`path` corpora pin exact counts over live omp transcripts (re-pin in a `fix(gate):` commit if they drift); the 4B gate needs a scratch copy without `approval.bind`/`secret.redact` rows. `live-gate-jev-tree` cases 3 and 7 fail on `main`: compare against `main`.
- **P9 — the predicates live in a leaf, `src/core/lanes/lookup-predicates.ts`** (no imports). The spec places them in `lane-compose.ts` "so the entry imports them without a cycle", but `lane-compose.ts` imports `omp/turn-context.ts`, which imports decision entries; a leaf meets the spec's stated purpose strictly. `REWRITE_MAX_CHARS`, `REWRITE_RECENT_MS`, `QUERY_MAX_CHARS` move there; `lane-compose.ts` imports them. `queryCheckOf` takes only `raw` (the spec's `message` argument is unused by the classifier; `validateQuery` keeps it). Cost if wrong: none (one definition either way).
- **P10 — the pending list.** `runLookupLane` creates `const pending: Array<(r: DecisionRecorder) => void> = []`, passes it down, and writes it in `finally` (after `lookupSteps` returned or threw, the `lane_threw` path included) only when `d.recorder` exists and `!i.signal.aborted`; each thunk's call is wrapped in a try that logs `lookup lane: decision record threw on <run_id>: <safeReason>` (spec §4.4: guards only the rung-shape misconfiguration). Cost if wrong: none.
- **P11 — `turn.model` capture.** `pinFirst` and `promptRetry` read `const before = { role: turn.role, tried: turn.legsTried }` immediately before `pinWalk`, and call `this.recordModel(turn, leg, r, before)` as the first statement after `if (r === ENDED) return …`. `recordModel` maps `r` to `outcome` (`"ok"` / `"exhausted"` / `{error}` → `"pin_failed"`), computes `iterations = turn.legsTried − before.tried`, `refused = outcome === "exhausted" ? iterations : iterations − 1`, `stepped = turn.role !== before.role`, and records only when `!turn.endSignalled`.
- **P12 — test-store access:** `store.db` is private; use `(store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db` (R3 P13). Known flakes: "aborts on the turn deadline" and "a start slower than the deadline is cancelled" in `planner-supervisor.test.ts` — rerun alone before chasing.
- **P13 — a planted throwing rule runs through the production consult** (R5 P14): replace the real entry's `ladder[0].decide` for the case and restore it in `finally`; required: one `fail`-rung row with the entry's `fail` verdict, and everything else identical to the unplanted run. Row projections that check faults include `rung`.
- **P14 — mutation list** (each must fail a named test once, then reverted): (1) lane rows written mid-lane instead of at the end — Task 2 timing case; (2) the lane's abort check dropped at write time — Task 2 `/kill` case; (3) `lookupQuery` consulting on one return path only — Task 2 `no_recent_line` case; (4) `thinOf` replaced by a copy that treats `no_url` as `thin` — Task 1 equivalence + Task 2; (5) `turn.model` consult moved after `failTurn` in `pinFirst` — Task 3 `none/no_leg` case; (6) `refused` read from the raw `legsTried` — Task 3 retry-after-refusal case; (7) `alwaysRecord` removed from `lookup.thin` — Task 1/2 (`none/answered` row vanishes); (8) `alwaysRecord` added to `turn.model` — Task 1 (`head` writes a row); (9) `lookupLaneDepsForTest` returning deps without `recorder` — Task 2 wiring; (10) `rpcSetModelRefuse` ignored by the fake — Task 3 wiring.

## Global Constraints

- `dependencies: {}` stays empty.
- **Behaviour identical** to the merge base: the searched query and the reader objective; whether and which URL is fetched; every `setModel` target and its order; every ledger row (`web_search_performed`, `http_fetch_performed`, `routed_escalation`, `llm_attempt` incl. `model_missing`), incident and its order; the lane's result and catch-up line; every prompt. The only new rows are `decisions` rows with `entry_id` in `lookup.rewrite`, `lookup.thin`, `turn.model` — plus, only on an insert fault, `decision_record_failed` and its one operator alert. Residual (spec §4.0, ruled): wall-clock cost ≤ one synchronous insert per row.
- **Raw answer drives:** `rewriteFilterOf`, `queryCheckOf` (through `needsRewrite`/`validateQuery`), `thinOf` and `pinWalk` decide; `decideSync` results are never used.
- **Recording rule (spec §4.0):** rows carry the turn's own `run_id`, `tool_call_id` null, no text, no model id. Lane rows: decided at the branch, written at the lane's end iff `!i.signal.aborted`. `turn.model`: written at the consult iff `!turn.endSignalled`, before `noLeg`/`failTurn`/`turn.pinFailed = true`/the incident/the `throw`.
- `lookup.rewrite`: `stage "pre_model"`, `input "mixed"`, unlocked, verdicts `rewrite | bare`, default `bare`, `fail: "bare"`, `alwaysRecord: true` (Decision 2-A); reasons `rewritten`, `no_recent_line`, `long_message`, `no_time`, `late`, `failed`, `same`, `invalid`.
- `lookup.thin`: `stage "pre_model"`, `input "tool"`, unlocked, verdicts `fetch | none`, default `none`, `fail: "none"`, `alwaysRecord: true` (Decision 2-A); reasons `thin`, `answered`, `no_url`.
- `turn.model`: `stage "pre_model"`, `input "tool"`, unlocked, verdicts `head | fallback | held | none`, default `head`, `fail: "head"`, **no** `alwaysRecord` (Decision 1-A); reasons `stepped_up`, `refused`, `next_leg`, `pin_failed`, `no_leg`.
- `src/omp/` and `src/decisions/` are protected: edits only as specified. `src/core/lanes/*`, `src/core/core-worker.ts`, `tests/fixtures/fake-omp.mjs` are not.
- Never write `houge.sqlite`; gates use a VACUUM copy deleted on every exit path. Synthetic text only.
- New functions under 50 lines; tests in `tests/<area>/`.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/lanes/lookup-predicates.ts` (new) | 1 | `rewriteFilterOf`, `queryCheckOf`, `thinOf`, the three constants |
| `src/core/lanes/lane-compose.ts` | 1 | `needsRewrite`/`validateQuery` wrap the predicates |
| `src/decisions/entries/lookup-rewrite.ts`, `lookup-thin.ts`, `turn-model.ts` (new) | 1 | entries |
| `src/decisions/entry-ids.ts`, `registry.ts`, `tests/decisions/registry.test.ts:132`, `scripts/live-gate-ladder-stage4b.mjs:172` | 1 | 36 → 39 |
| `tests/core/lanes/lookup-predicates.test.ts`, `tests/decisions/lookup-rewrite.test.ts`, `lookup-thin.test.ts`, `turn-model.test.ts` (new) | 1 | pins |
| `src/core/lanes/lookup-lane.ts` | 2 | pending list, consults, end-of-lane write |
| `src/core/core-worker.ts` | 2 | `lookupLaneDepsForTest` |
| `tests/core/lanes/lookup-decisions.test.ts` (new), `tests/core/lookup-lane-wiring.test.ts` (new) | 2 | rows, timing, wiring |
| `src/omp/planner-supervisor.ts` | 3 | `recordModel`, consults in `pinFirst`/`promptRetry` |
| `tests/fixtures/fake-omp.mjs` | 3 | `rpcSetModelRefuse` |
| `tests/omp/model-decisions.test.ts` (new), `tests/core/supervisor-decision-wiring.test.ts` | 3 | rows, wiring |
| `scripts/stage4-diff-lib.mjs`, `check-ladder-stage4-differential.mjs`, `stage4-supervisor-fixture.mjs`, `stage4-lane-fixture.mjs` (new), `stage4-corpora/{supervisor,supervision,context}.mjs` | 4 | `r6` pair, fixtures, tallies |
| `scripts/stage4-corpora/lookup.mjs`, `model.mjs` (new) | 5 | corpora |
| `scripts/live-gate-ladder-remainder-r6.mjs` (new) | 6 | live gate |
| `scripts/check-ladder-remainder-r6-rollback.mjs` (new) | 7 | rollback |

---

### Task 1: Predicates and the three entries

**Files:**
- Create: `src/core/lanes/lookup-predicates.ts`, `src/decisions/entries/lookup-rewrite.ts`, `lookup-thin.ts`, `turn-model.ts`, `tests/core/lanes/lookup-predicates.test.ts`, `tests/decisions/lookup-rewrite.test.ts`, `lookup-thin.test.ts`, `turn-model.test.ts`
- Modify: `src/core/lanes/lane-compose.ts:14–19, 62–82`, `src/decisions/entry-ids.ts:5`, `src/decisions/registry.ts` (imports + list), `tests/decisions/registry.test.ts:132`, `scripts/live-gate-ladder-stage4b.mjs:172`

**Interfaces:**
- Produces: `rewriteFilterOf(message: string, quoted: boolean, ageMs: number | null): RewriteFilter`; `queryCheckOf(raw: string): QueryCheck`; `thinOf(s: ThinInput): ThinStep`; `REWRITE_MAX_CHARS`, `REWRITE_RECENT_MS`, `QUERY_MAX_CHARS`; `LOOKUP_REWRITE: Entry<RewriteInput, RewriteVerdict>`, `RewriteStep`, `REWRITE_STEPS`; `LOOKUP_THIN: Entry<ThinInput, ThinVerdict>`; `TURN_MODEL: Entry<ModelInput, ModelVerdict>`, `ModelInput`.

- [ ] **Step 1: failing tests.** `tests/core/lanes/lookup-predicates.test.ts` — equivalence against today's bodies, kept verbatim in the test as `oldNeedsRewrite`/`oldValidateQuery` (copied from `lane-compose.ts:63–82` at the merge base), over a table: messages `""`, `"a".repeat(40)`, `"a".repeat(41)`, `"😀".repeat(40)` (40 code points, 80 UTF-16 units), `"😀".repeat(41)`, `"  x  "`; quoted true/false; ages `null`, `0`, `30*60_000`, `30*60_000+1`, `-5`, `NaN`. Raw answers `""`, `"SAME"`, `"same."`, `"SAME!"`, `"same。"`, `"\"same\""`, `"「Sydney weather」"`, `"a\nb"`, `"x".repeat(120)`, `"x".repeat(121)`, `"see https://x.y"`, `"www.x.y"`, `"Sydney weather tomorrow"`. Assert `needsRewrite(m,q,a) === oldNeedsRewrite(m,q,a)` and `validateQuery(r,"MSG") === oldValidateQuery(r,"MSG")` for every row, plus exact classifier values for: `rewriteFilterOf("a".repeat(41), false, 0) === "long_message"`, `(…, true, 0) === "needed"`, `(x, false, null) === "no_recent_line"`, `(x, false, 30*60_000+1) === "no_recent_line"`, `(x, false, NaN) === "needed"` for a short x; `queryCheckOf("") → invalid`, `"same。" → same`, `"a\nb" → invalid`, `"x".repeat(121) → invalid`, `"「Sydney」" → { kind: "query", q: "Sydney" }`; `thinOf({answered:true,url:true})==="answered"`, `({answered:false,url:false})==="no_url"`, `({answered:false,url:true})==="thin"`.
  Entry tests, each asserting verdict and reason through `decideSync` with a capturing recorder (pattern: `tests/decisions/context-catch-up.test.ts`): every `REWRITE_STEPS` value (`rewritten` → `rewrite/rewritten`, else `bare/<step>`); thin's three; `turn.model` table:
  ```ts
  const cases: Array<[ModelInput, string, string | null]> = [
    [{ leg: "first", outcome: "ok", stepped: false, refused: 0 }, "head", null],
    [{ leg: "first", outcome: "ok", stepped: false, refused: 1 }, "fallback", "refused"],
    [{ leg: "first", outcome: "ok", stepped: true, refused: 2 }, "fallback", "stepped_up"],
    [{ leg: "retry", outcome: "ok", stepped: false, refused: 0 }, "fallback", "next_leg"],
    [{ leg: "retry", outcome: "ok", stepped: false, refused: 1 }, "fallback", "refused"],
    [{ leg: "first", outcome: "pin_failed", stepped: false, refused: 0 }, "held", "pin_failed"],
    [{ leg: "retry", outcome: "pin_failed", stepped: false, refused: 0 }, "none", "pin_failed"],
    [{ leg: "first", outcome: "exhausted", stepped: true, refused: 3 }, "none", "no_leg"],
  ];
  ```
  Row tests with `storeRecorder(RunStore.openInMemory())` (run seeded via `tests/helpers/runs.ts`): `turn.model` `head` writes **no** row, `fallback` writes one; `lookup.thin` `none/answered` and `lookup.rewrite` `bare/same` **write** a row. Registry test: `ENTRY_IDS` length 39; the three registered, unlocked, `ladder.map(r => r.kind)` equals `["rule"]`, `entryProblems` empty.
- [ ] **Step 2: run** `npx vitest run tests/core/lanes/lookup-predicates.test.ts tests/decisions` → FAIL (modules missing).
- [ ] **Step 3: implement.** `src/core/lanes/lookup-predicates.ts`:
  ```ts
  /** Stage B §5 step 2 constants; the lane's rewrite filter and query check live here so the decision entries import a leaf (spec R6 §4.1, plan P9). */
  export const REWRITE_MAX_CHARS = 40;
  export const REWRITE_RECENT_MS = 30 * 60_000;
  export const QUERY_MAX_CHARS = 120;

  export type RewriteFilter = "no_recent_line" | "long_message" | "needed";
  /** Paco's previous Telegram line at most 30 min old, AND quoting or at most 40 code points. `ageMs > …` as today: NaN or a negative age passes. */
  export function rewriteFilterOf(message: string, quoted: boolean, ageMs: number | null): RewriteFilter {
    if (ageMs === null || ageMs > REWRITE_RECENT_MS) return "no_recent_line";
    return quoted || [...message.trim()].length <= REWRITE_MAX_CHARS ? "needed" : "long_message";
  }

  export type QueryCheck = { kind: "same" } | { kind: "invalid" } | { kind: "query"; q: string };
  /** The model's rewrite: stripped as today; SAME (any case, optional . ! 。); empty, multi-line, over 120 UTF-16 units or a URL is invalid. */
  export function queryCheckOf(raw: string): QueryCheck {
    const q = raw.trim().replace(/^["'`“”「]+|["'`“”」]+$/g, "").trim();
    if (q.length === 0) return { kind: "invalid" };
    if (/^same[.!。]?$/i.test(q)) return { kind: "same" };
    if (q.includes("\n") || q.length > QUERY_MAX_CHARS || /https?:\/\/|www\./i.test(q)) return { kind: "invalid" };
    return { kind: "query", q };
  }

  export interface ThinInput { answered: boolean; url: boolean }
  export type ThinStep = "thin" | "answered" | "no_url";
  /** Stage B §5 step 5 trigger: the first read left the objective unanswered and a listable URL exists. */
  export function thinOf(s: ThinInput): ThinStep {
    if (s.answered) return "answered";
    return s.url ? "thin" : "no_url";
  }
  ```
  `lane-compose.ts`: delete the three local consts (keep `REWRITE_INPUT_CHARS`, `FINAL_QUERY_CHARS`), `import { QUERY_MAX_CHARS, queryCheckOf, rewriteFilterOf } from "./lookup-predicates.js";` (drop `QUERY_MAX_CHARS` from the import if no longer used), and:
  ```ts
  export function needsRewrite(message: string, quoted: boolean, previousTelegramLineAgeMs: number | null): boolean {
    return rewriteFilterOf(message, quoted, previousTelegramLineAgeMs) === "needed";
  }
  export function validateQuery(raw: string, message: string): string {
    const c = queryCheckOf(raw);
    return c.kind === "query" ? c.q : message;
  }
  ```
  `src/decisions/entries/lookup-rewrite.ts`:
  ```ts
  import type { Entry, RungAnswer } from "../types.js";

  /** Where lookupQuery decided (spec R6 §4.1): code before the call, the call's outage, the model's answer, code over it. */
  export const REWRITE_STEPS = ["rewritten", "no_recent_line", "long_message", "no_time", "late", "failed", "same", "invalid"] as const;
  export type RewriteStep = (typeof REWRITE_STEPS)[number];
  export type RewriteVerdict = "rewrite" | "bare";
  export interface RewriteInput { step: RewriteStep }

  function rule(s: RewriteInput): RungAnswer<RewriteVerdict> {
    return s.step === "rewritten" ? { verdict: "rewrite", reason: "rewritten" } : { verdict: "bare", reason: s.step };
  }

  export const LOOKUP_REWRITE: Entry<RewriteInput, RewriteVerdict> = {
    id: "lookup.rewrite", version: 1, stage: "pre_model", input: "mixed",
    question: "Does the lookup lane search a rewritten query or Paco's bare message?",
    verdicts: ["rewrite", "bare"],
    ladder: [{ kind: "rule", name: "rewrite_step", decide: rule }],
    fail: "bare", defaultVerdict: "bare", outcomes: [], armed: { rule: "on" }, alwaysRecord: true,
    effects: {
      rewrite: { kind: "effect", reversible: true, announced: "none", what: "the validated rewrite is the query selected for the search and the reader's objective" },
      bare: { kind: "none", reversible: true, announced: "none" }
    },
    reasonCodes: [...REWRITE_STEPS],
  };
  ```
  `lookup-thin.ts`:
  ```ts
  import { thinOf, type ThinInput } from "../../core/lanes/lookup-predicates.js";
  import type { Entry, RungAnswer } from "../types.js";

  export type ThinVerdict = "fetch" | "none";

  function rule(s: ThinInput): RungAnswer<ThinVerdict> {
    const step = thinOf(s);
    return step === "thin" ? { verdict: "fetch", reason: "thin" } : { verdict: "none", reason: step };
  }

  export const LOOKUP_THIN: Entry<ThinInput, ThinVerdict> = {
    id: "lookup.thin", version: 1, stage: "pre_model", input: "tool",
    question: "Did the first strict read leave the objective unanswered, so the lane fetches the top listed result and reads again?",
    verdicts: ["fetch", "none"],
    ladder: [{ kind: "rule", name: "thin_read", decide: rule }],
    fail: "none", defaultVerdict: "none", outcomes: [], armed: { rule: "on" }, alwaysRecord: true,
    effects: {
      fetch: { kind: "effect", reversible: true, announced: "none", what: "one fetch of the top listed result through the SSRF floor and a second strict read; http_fetch_performed as today" },
      none: { kind: "none", reversible: true, announced: "none" }
    },
    reasonCodes: ["thin", "answered", "no_url"],
  };
  ```
  `turn-model.ts`:
  ```ts
  import type { Entry, RungAnswer } from "../types.js";

  export const MODEL_REASONS = ["stepped_up", "refused", "next_leg", "pin_failed", "no_leg"] as const;
  export type ModelVerdict = "head" | "fallback" | "held" | "none";
  /** Captured around one pin walk (spec R6 §4.3, plan P11): refused counts only this walk's refusals. */
  export interface ModelInput { leg: "first" | "retry"; outcome: "ok" | "pin_failed" | "exhausted"; stepped: boolean; refused: number }

  function rule(s: ModelInput): RungAnswer<ModelVerdict> | ModelVerdict {
    if (s.outcome === "exhausted") return { verdict: "none", reason: "no_leg" };
    if (s.outcome === "pin_failed") return { verdict: s.leg === "first" ? "held" : "none", reason: "pin_failed" };
    if (s.stepped) return { verdict: "fallback", reason: "stepped_up" };
    if (s.refused > 0) return { verdict: "fallback", reason: "refused" };
    return s.leg === "retry" ? { verdict: "fallback", reason: "next_leg" } : "head";
  }

  export const TURN_MODEL: Entry<ModelInput, ModelVerdict> = {
    id: "turn.model", version: 1, stage: "pre_model", input: "tool",
    question: "Which leg of the turn's role is the planner child pinned to: its first eligible candidate, a later leg or the next role up, the model it already holds, or none?",
    verdicts: ["head", "fallback", "held", "none"],
    ladder: [{ kind: "rule", name: "pin_walk", decide: rule }],
    fail: "head", defaultVerdict: "head", outcomes: [], armed: { rule: "on" },
    effects: {
      head: { kind: "none", reversible: true, announced: "none" },
      fallback: { kind: "effect", reversible: true, announced: "none", what: "a later leg of the role, or the next role up, answers; a step-up is ledgered routed_escalation as today; a refusal lasts for the child's life" },
      held: { kind: "effect", reversible: true, announced: "none", what: "the turn answers on the model the child already holds; planner_model_reset_failed as today" },
      none: { kind: "none", reversible: true, announced: "none", what: "the turn fails no_planner_leg or retry_failed with today's text and incident" }
    },
    reasonCodes: [...MODEL_REASONS],
  };
  ```
  `entry-ids.ts`: append `"lookup.rewrite", "lookup.thin", "turn.model"`. `registry.ts`: import and append the three in the same order as R5's block. `registry.test.ts:132` → 39; `live-gate-ladder-stage4b.mjs:172` → 39. If `entryProblems` rejects a `none` effect with a `what` or the `kind: "none"` on a non-default verdict, read `registry.ts:100–108` and report — do not change the registry's rules.
- [ ] **Step 4: run** the Step 2 command plus `npx vitest run tests/core/lanes` and `npm run typecheck` → PASS, 0 skipped.
- [ ] **Step 5: commit** `feat(decisions): lookup.rewrite, lookup.thin, turn.model entries; lookup predicates in a leaf`.

---

### Task 2: The lane records `lookup.rewrite` and `lookup.thin`

**Files:**
- Modify: `src/core/lanes/lookup-lane.ts` (`runLookupLane`, `lookupSteps`, `lookupQuery`, `readStep`), `src/core/core-worker.ts` (after `lookupLaneDeps`, ~`:3527`)
- Create: `tests/core/lanes/lookup-decisions.test.ts`, `tests/core/lookup-lane-wiring.test.ts`

**Interfaces:**
- Consumes: Task 1's predicates and entries.
- Produces: `CoreWorker.lookupLaneDepsForTest(run_id: string, chatId: string, state: { threadCutAt: string; turnCtx: LoopTurnContext; anchor: { priorAnswer: string; defaultScope: string } }): LookupLaneDeps` (`@internal`).

- [ ] **Step 1: failing tests** (`lookup-decisions.test.ts`, the `setup()` of `tests/core/lanes/lookup-lane.test.ts:20–37` copied, plus `recorder` = a capturing recorder `{ calls: [entryId, verdict, reason, run_id][], record(e, r, c) { calls.push([e.id, r.verdict, r.reason, c.run_id]); return null; } }`):
  1. no previous line → recorder calls exactly `[["lookup.rewrite","bare","no_recent_line","run_1"], ["lookup.thin","none","answered","run_1"]]` in that order, after `tool.wall`/`reader.family` (assert the full ordered id list: `["tool.wall","reader.family","lookup.rewrite","lookup.thin"]`).
  2. each rewrite step: a 41-char message with a 5-min-old Paco line → `long_message`, `rewrite` not called; quoted + rewrite answers `"Sydney weather tomorrow"` → `rewrite/rewritten` and `search` called with that query; `"SAME"` → `same`; `"a\nb"` → `invalid`; a rewrite resolving after the bound (fake timers, as `lookup-lane.test.ts:120`) → `late`; rewrite rejects → `failed`; `{ ok: false }` → `failed`; `deadlineAt` inside the reserve → `no_time`, `rewrite` not called.
  3. thin: answered → `none/answered`, no fetch; `read("…")` returning `answer_to_objective: null` with a listable URL → `fetch/thin`, one fetch; null answer with every result URL failing `sourceUrl` (e.g. `"ftp://x"`) → `none/no_url`, no fetch; first read `{ ok: false, why: "unreadable" }` → no `lookup.thin` call, `lookup.rewrite` still written.
  4. **write timing** (P14-1): a recorder whose `record` advances `clock.t` by `COMPOSE_RESERVE_MS + 1` **only** when `e.id` is one of the three R6 ids; a thin path whose `deadlineAt` leaves the fetch just inside its bound → `fetch` called once, the result `kind: "reply"`, and the recorder's R6 calls happen after `compose` was called (assert via a shared log array).
  5. `/kill`: abort the signal while `rewrite` is held → result `fallthrough` `aborted`, **zero** R6 recorder calls (P14-2); abort during the first read → zero R6 calls.
  6. a search adapter that throws synchronously → `lane_threw`, `lookup.rewrite` written (selection recorded), no `lookup.thin`.
  7. no recorder → no throw, result unchanged.
  8. P13 planted throw on `LOOKUP_REWRITE.ladder[0]` → one call with `rung: "fail"` (record `r.rung` in this test's recorder), `verdict: "bare"`, the searched query unchanged.
  Wiring (`tests/core/lookup-lane-wiring.test.ts`, setup as `tests/core/supervisor-decision-wiring.test.ts:1–21`): build `worker = ompWorker(store, tmp.dir)`, a queued run `createQueuedTurnRun(store, "short?")`, seed one Paco Telegram `chat_turns` row 5 min old in that chat; `const d = { ...worker.lookupLaneDepsForTest(run, chat, state), search, fetch, read, rewrite }` with scripted network deps (rewrite answers `"Sydney weather tomorrow"`, read thin with a listable URL), `state` = `{ threadCutAt: new Date().toISOString(), turnCtx: <the helper the worker uses — read core-worker.ts for its constructor, or cast a minimal object with `sourceUrls: []`>, anchor: { priorAnswer: "", defaultScope: "chat" } }`; run `runLookupLane`; `store.listDecisionsForRun(run)` filtered to the two ids equals `[["lookup.rewrite","rewrite","rewritten"],["lookup.thin","fetch","thin"]]` (P14-9).
- [ ] **Step 2: run** `npx vitest run tests/core/lanes/lookup-decisions.test.ts tests/core/lookup-lane-wiring.test.ts` → FAIL.
- [ ] **Step 3: implement** in `lookup-lane.ts`:
  ```ts
  type Pending = Array<(recorder: DecisionRecorder) => void>;

  export async function runLookupLane(i: LaneInput, d: LookupLaneDeps): Promise<LaneResult> {
    const pending: Pending = [];
    try {
      return await lookupSteps(i, d, pending);
    } catch (e) {
      console.error(`lookup lane: threw on ${i.run_id}: ${safeReason(e)}`);
      return fall("lane_threw");
    } finally {
      writePending(i, d, pending);
    }
  }

  /** Spec R6 §4.0: lane rows are decided at the branch and written here, after every budget read, only while the turn is live. */
  function writePending(i: LaneInput, d: LookupLaneDeps, pending: Pending): void {
    const recorder = d.recorder;
    if (!recorder || i.signal.aborted) return;
    for (const write of pending) {
      try { write(recorder); } catch (e) { console.error(`lookup lane: decision record threw on ${i.run_id}: ${safeReason(e)}`); }
    }
  }

  const consult = <S, V extends string>(pending: Pending, i: LaneInput, entry: Entry<S, V>, s: S): void => {
    pending.push((recorder) => { decideSync(entry, s, { run_id: i.run_id, tool_call_id: null, recorder }); });
  };
  ```
  `lookupSteps(i, d, pending)` passes `pending` to `lookupQuery` and `readStep`. `lookupQuery` becomes:
  ```ts
  /** Step 2: the pre-filter, then one bounded Tiny rewrite whose answer code validates; every return path is one lookup.rewrite consult. */
  async function lookupQuery(i: LaneInput, d: LookupLaneDeps, pending: Pending): Promise<string> {
    const { step, query } = await rewriteStep(i, d);
    consult(pending, i, LOOKUP_REWRITE, { step });
    return query;
  }

  async function rewriteStep(i: LaneInput, d: LookupLaneDeps): Promise<{ step: RewriteStep; query: string }> {
    const prev = d.previousTelegramTurns(i.chat_id);
    const lastPaco = [...prev].reverse().find((t) => t.role === "user");
    const age = lastPaco ? d.now() - Date.parse(lastPaco.created_at) : null;
    const filter = rewriteFilterOf(i.userText, i.quoted !== null, age);
    if (filter !== "needed") return { step: filter, query: finalQuery(i.userText) };
    const bound = Math.min(REWRITE_MS, beforeReserve(i, d));
    if (bound <= 0) return { step: "no_time", query: finalQuery(i.userText) };
    const r = await within(bound, d.rewrite({ prompt: rewritePrompt(prev, i.quoted, i.userText), deadlineMs: bound, signal: i.signal }).catch((): null => null), i.signal);
    const answered = r !== LATE && r !== null && r.ok;
    const check = answered ? queryCheckOf(r.answer).kind : null;
    const step: RewriteStep = r === LATE ? "late" : !answered ? "failed" : check === "query" ? "rewritten" : check!;
    return { step, query: finalQuery(validateQuery(answered ? r.answer : "SAME", i.userText)) };
  }
  ```
  (Type-narrowing of `r.answer` after `answered` may need an explicit `r !== LATE && r !== null && r.ok ? r.answer : "SAME"` as today; keep the old expression for the query and compute `step` separately if TS objects. `needsRewrite` import may become unused in the lane: remove it from the import.) In `readStep`, after the two existing ok-path consults and the `read` object, replace the trigger:
  ```ts
  const thin: ThinInput = { answered: first.extraction.answer_to_objective !== null, url: urls[0] !== undefined };
  consult(pending, i, LOOKUP_THIN, thin);
  if (thinOf(thin) === "thin") await thinFetch(i, d, urls[0]!, objective, read);
  ```
  Imports: `DecisionRecorder`, `Entry` types from `../../decisions/types.js`; `LOOKUP_REWRITE`, `RewriteStep`; `LOOKUP_THIN`; `queryCheckOf`, `rewriteFilterOf`, `thinOf`, `ThinInput` from `./lookup-predicates.js`. `core-worker.ts`, after `lookupLaneDeps`:
  ```ts
  /** @internal Test seam (spec R6 §4.4): the production lookup deps, recorder included. */
  lookupLaneDepsForTest(run_id: string, chatId: string, state: OmpTurnState): LookupLaneDeps { return this.lookupLaneDeps(run_id, chatId, state); }
  ```
  (If `OmpTurnState` is not exported, export the interface — `core-worker.ts` is unprotected.)
- [ ] **Step 4: run** Step 2's files, `tests/core/lanes`, `npm run typecheck` → PASS; `npx vitest run tests/core` → PASS, 0 skipped. Show P14-1, -2, -3, -9 each failing once, reverted.
- [ ] **Step 5: commit** `feat(lanes): lookup lane records lookup.rewrite and lookup.thin at the lane's end`.

---

### Task 3: The supervisor records `turn.model`; fake omp refuses per model

**Files:**
- Modify: `src/omp/planner-supervisor.ts` (`pinFirst` `:743–751`, `promptRetry` `:974–990`, a new private `recordModel`), `tests/fixtures/fake-omp.mjs:66`, `tests/core/supervisor-decision-wiring.test.ts`
- Create: `tests/omp/model-decisions.test.ts`

**Interfaces:**
- Consumes: `TURN_MODEL`, `ModelInput` (Task 1).

- [ ] **Step 1: failing tests** (`model-decisions.test.ts`, on `tests/helpers/supervisor-harness.ts` with a recorder over the harness store as `tests/omp/supervision-decisions.test.ts:23–28`; `fakeRoles(over)` sets lists; the session's `setModel(n)` script throws `new PlannerRpcError("command_failed:set_model", "Model not found: <p/m>")` for a refusal or `new Error("transport")` for a failure, by call number — remember `n === 1` is the spawn's pin when the child spawns fresh; read `planner-supervisor.test.ts:1552–1580` first). Each asserts `rows(run, "turn.model")` as `[verdict, reason, rung]` and the `turn.model` recorder call count:
  1. head accepted → no row, 1 call.
  2. head refused, second pinned → `[["fallback","refused","rule"]]`, one `model_missing` attempt row.
  3. routed Fast turn (route via the harness's triage stub, as `supervisor-decisions` does), every Fast leg refused → `fallback/stepped_up`, `routed_escalation` present.
  4. unrouted, every Default leg refused → `none/no_leg`, `planner_no_leg` incident, run failed `no_planner_leg` — and the row exists (P14-5).
  5. `setModel` throws transport → `held/pin_failed`, `planner_model_reset_failed` incident.
  6. a `quota` model error on the first leg, next leg answers → `turn.retry retry/quota` then `turn.model fallback/next_leg` in that order (assert decision ids order).
  7. retry after an earlier leg's refusal (head refused on the first walk, the second leg errors quota, the third answers) → rows `[fallback/refused, fallback/next_leg]` (P14-6).
  8. retry pin throws transport → `none/pin_failed`, run failed `retry_failed`.
  9. two turns on one child, head refused on turn 1 → turn 1 `fallback/refused`, turn 2 no `turn.model` row and its `setModel` target is candidate two.
  10. abort while `setModel` is held (`setModel` awaiting a promise; `abortAll("killed")`) → no `turn.model` call.
  11. P13 planted throw → `head` at rung `fail`, pins unchanged.
  `fake-omp.mjs` change, then wiring cases in `supervisor-decision-wiring.test.ts`: R6 (a) `useFakeOmp({ "*": { rpcText: "ok", rpcSetModelRefuse: ["anthropic/claude-opus-5-5"] } }, tmp.dir)` (the scenario key the fake reads is the top-level scenario object: put `rpcSetModelRefuse` where `rpcSetModelError` lives — read `fake-omp.mjs:55–70` for which object `scen` is) → `turn.model` `[["fallback","refused"]]` and the argv log shows a second `set_model` to the next Default candidate (P14-10); R6 (b) R4 (a)'s quota scenario → `turn.model [["fallback","next_leg"]]`.
- [ ] **Step 2: run** `npx vitest run tests/omp/model-decisions.test.ts tests/core/supervisor-decision-wiring.test.ts` → FAIL.
- [ ] **Step 3: implement.** `fake-omp.mjs`, before the `rpcSetModelError` line:
  ```js
  if (cmd.type === "set_model" && Array.isArray(scen.rpcSetModelRefuse) && scen.rpcSetModelRefuse.includes(`${cmd.provider}/${cmd.modelId}`))
    return out({ id: cmd.id, type: "response", command: "set_model", success: false, error: `Model not found: ${cmd.provider}/${cmd.modelId}` });
  ```
  `planner-supervisor.ts`:
  ```ts
  /** turn.model (spec R6 §4.3, plan P11): one consult per completed pin walk, before any failure path; only this walk's refusals count. */
  private recordModel(turn: Turn, leg: ModelInput["leg"], r: Exclude<PinResult, "refused" | typeof ENDED> | "exhausted", before: { role: TurnRole; tried: number }): void {
    if (turn.endSignalled) return;
    const outcome: ModelInput["outcome"] = r === "ok" ? "ok" : r === "exhausted" ? "exhausted" : "pin_failed";
    const iterations = turn.legsTried - before.tried;
    const input: ModelInput = { leg, outcome, stepped: turn.role !== before.role, refused: outcome === "exhausted" ? iterations : iterations - 1 };
    this.record(TURN_MODEL, input, turn.req.run_id);
  }
  ```
  `pinFirst`:
  ```ts
  const before = { role: turn.role, tried: turn.legsTried };
  const r = await this.pinWalk(turn, s, "model_missing");
  if (r === ENDED) return ENDED;
  this.recordModel(turn, "first", r, before);
  // … unchanged
  ```
  `promptRetry`: the same three lines around its `pinWalk(turn, s, kind)` with `"retry"`, the record before `if (r === "exhausted")`. Imports: `TURN_MODEL`, `type ModelInput` from `../decisions/entries/turn-model.js`.
- [ ] **Step 4: run** Step 2's files, `npx vitest run tests/omp tests/core tests/decisions`, `npm run typecheck`, `npm test` → PASS, 0 skipped (P12 flakes rerun alone). Show P14-5, -6, -8, -10 failing once, reverted.
- [ ] **Step 5: commit** `feat(omp): supervisor records turn.model after each pin walk; fake omp refuses per model`.

---

### Task 4: Harness — `r6` pair, fixtures, corpus tallies

**Files:** Modify `scripts/stage4-diff-lib.mjs` (`DISTS`, `R6_IDS`, `NEW_ROW_IDS`), `scripts/check-ladder-stage4-differential.mjs` (flags, provenance, ctx, usage, the post-merge command comment), `scripts/stage4-supervisor-fixture.mjs`, `scripts/stage4-corpora/supervisor.mjs`, `supervision.mjs`, `context.mjs`. Create `scripts/stage4-lane-fixture.mjs`.

- [ ] **Step 1: old build (P1).** `MB=$(git merge-base HEAD main)`; verify `git diff --stat 088ccb59 $MB -- src scripts tests` is empty (stop and report if not); `git worktree add .worktrees/base-${MB:0:12} $MB`; in it `npm ci && npm run build && node scripts/stamp-dist.mjs <that worktree>`.
- [ ] **Step 2: lib/CLI.** `DISTS.r6`; `export const R6_IDS = ["lookup.rewrite", "lookup.thin", "turn.model"]`; every `NEW_ROW_IDS` set gains `...R6_IDS`; `r6: new Set(R6_IDS)`; `--old-dist-r6 <dir>` (required; provenance `core/lanes/lookup-lane.js`) and `--old-base-r6 <sha>` (post-merge only); the header's full post-merge command gains `--old-base-r6 <sha>` (filled in at merge).
- [ ] **Step 3: supervisor fixture.** `script.setModel(m)` hook in `fakeSession` — awaited inside `setModel` after the log push; may throw (a refusal carries `Model not found: <p/m>` with the dist's `PlannerRpcError` if the dist exports it, else an `Error` whose shape `isModelRefusal` accepts — read `planner-supervisor.ts:291` in the dist); `opts.lists` passed to `fakeRoles`. Keep every existing caller's behaviour.
- [ ] **Step 4: lane fixture** `scripts/stage4-lane-fixture.mjs`: `runLane(dist, script)` imports `core/lanes/lookup-lane.js` from `dist`, builds `LookupLaneDeps` from `script` (rewrite/search/read/fetch/previousTelegramTurns, a fixed clock object, `fastChain`, `compose`, `retrieve`, `systemPrompt`, ledger spies, an optional recorder) and returns `{ result, log }` where `log` is the ordered call list (`["rewrite", prompt]`, `["search", query]`, `["read", objective, output]`, `["fetch", url]`, `["ledger", kind, payload]`, `["compose", prompt]`). Ported from `tests/core/lanes/lookup-lane.test.ts:20–37`.
- [ ] **Step 5: tallies.** On the new dist, each `supervisor`/`supervision`/`context` item's `calls` gains `turn.model` per P4's rule; rows unchanged (the fixture's single-leg lists pin the head: no row). Measure, check each against the rule, then set the literals.
- [ ] **Step 6: verify** — `npm run build`; the full differential with every pair's flags plus `--old-dist-r6 /Users/xiaochuan/Projects/adventure/.worktrees/base-<sha>/dist` → every existing corpus PASS; `same_build` mutation (point `--old-dist-r6` at the new dist) → exit 2.
- [ ] **Step 7: commit** `test(gate): differential gains the r6 pair, a lane fixture, scripted pins; corpus tallies gain turn.model`.

---

### Task 5: Corpora `lookup` and `model`

**Files:** Create `scripts/stage4-corpora/lookup.mjs` (lane fixture), `scripts/stage4-corpora/model.mjs` (supervisor fixture). Pattern: `scripts/stage4-corpora/context.mjs` (read whole).

- [ ] **Step 1: items** — spec §6's two lists verbatim, each fresh, the same scenario on old (`DISTS.r6`, the R6 rows absent) and new dist (`countingRecorder` over `d.storeRecorder(store)` for `model`; the lane fixture's recorder for `lookup`). The lane-liveness item ("the warm child exits while the rewrite is held") belongs in `model.mjs` (it needs the supervisor and a triage that routes to the lookup lane: drive `opts.extra.triage` to call the dist's `runLookupLane` with scripted deps). Fault items per P13 on the new dist's entry object. The write-timing item delays only R6 calls (spec §4.0).
- [ ] **Step 2: project / required** — `lookup`: compared the fixture `log`, the result object, and the recorder's non-R6 calls; required exact R6 calls per item `[entry, verdict, reason, run]` and their position after the lane's other calls. `model`: compared the session's ordered `log` (prompts, `set_model` targets), the sink's calls, and `dumpDb(...)` → `relabelClocks` → `scrubIds` with R6 rows dropped; required exact rows `[entry, verdict, reason, run label, rung]` and exact per-entry call counts. Coverage + determinism self-tests; planted mutations each fail `required` once: `lookup` `same`/`invalid` swapped in the rule; `model` `refused`/`next_leg` swapped.
- [ ] **Step 3: run** `--only lookup`, `--only model`, then the full differential → every corpus PASS (17 corpora).
- [ ] **Step 4: commit** `test(gate): lookup and model corpora over the dist lane and supervisor`.

---

### Task 6: Live gate `scripts/live-gate-ladder-remainder-r6.mjs`

Pattern: `scripts/live-gate-ladder-remainder-r5.mjs` (read whole). VACUUM copy, refuses outside `.worktrees/`, copy deleted on every exit path, stub Telegram, P2/P3 pins; no real omp child, no web search, no subscription call. Spec §7's seven lines with exact values (P5): line 1 `CoreWorker.lookupLaneDepsForTest` over the copy (real `previousTelegramTurns` over a seeded 5-min-old synthetic Paco line in a stub chat; network deps scripted) → `rewrite/rewritten` with the searched query equal to the scripted answer; late rewrite → `bare/late`, the bare message searched; line 2 thin read → `fetch/thin`, one fetch, one `http_fetch_performed` row, row order `tool.wall, reader.family, tool.wall, reader.family, lookup.rewrite, lookup.thin`; answered → `none/answered`, no fetch; line 3 the real `RoleResolver` on the copy (`readCatalog` injected; static and resolved modes; precondition `candidates("default").length >= 2` asserted with its own message) with a fixture session refusing the head → `fallback/refused`, second `set_model` target equal to `candidates("default")[1]`; head accepted → no row; line 4 `CoreWorker.submitTurn` over `fake-omp.mjs` with `rpcSetModelRefuse` on the head → `fallback/refused`; line 5 quota on the first leg → `turn.retry` then `turn.model fallback/next_leg`; line 6 insert faulted → `decision_record_failed`, exactly one alert to the stub chat, query and pin unchanged; throwing recorder → no incident; line 7 `/status` count lines for the three ids from SQL. Show lines 1, 3 and 6 failing once each under a planted mutation. Rerun the R5, R4, R3, R2, R1, 4C and 4B (P8) gates: exit 0; `live-gate-jev-tree` compared against `main`. Commit `test(gate): remainder R6 live gate — lookup and pin decisions on a copy of the live DB, faults`.

---

### Task 7: Rollback check `scripts/check-ladder-remainder-r6-rollback.mjs`

Pattern: `scripts/check-ladder-remainder-r5-rollback.mjs` (read whole). Seed rows through the real paths on copy F (`rewrite/rewritten`, `bare/late`, `fetch/thin`, `none/answered`, `fallback/refused`, `none/no_leg`), dated inside the `/status` 24 h window; the old build (`base-<sha>` from Task 4) opens A and F with no migration, renders `/status` (the three count lines exact from SQL; every other line byte-identical A vs F) and the digest (identical A vs F), reads every row unchanged (`rung`, `entry_version`, `verdict`, `reason_code`, `run_id`), refuses `review_ok` naming each new id; the new build reopens F. Every line PASS, exit 0; one planted mutation failing. Commit `test(gate): remainder R6 rollback — the merge-base build reads the new rows`.

---

## After the tasks (orchestrator)
Full suite + typecheck + build on a quiet machine; the full differential (every pair, 17 corpora); R6, R5, R4, R3, R2, R1, 4C, 4B gates; R6 rollback; final whole-branch reviews (most capable non-orchestrator model, a mutation pass over P14, codex whole-diff); one fix wave; docs sync — ADR 0030 amendment "awaiting Paco's signature" (three entries; rule-only with the rewrite's model step named in reasons and why a model rung is a later slice; lane rows written at the lane's end and the stated residual; `head` = first eligible candidate; Decisions 1-A, 2-A; the R12 consequence for `lookup.rewrite`'s `effect` over `mixed`; follow-up: the lane's second-read `tool.wall`/`reader.family` pair unguarded and mid-lane), index row, ladder §6.1 note, ROADMAP delta, state block, lessons, sessions; merge, push, rebuild, kickstart (Tier A).
