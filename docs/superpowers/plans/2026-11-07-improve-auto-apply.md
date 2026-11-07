# Improvement proposals apply on their own; the nightly digest goes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lesson or fact `improve.route` drafts from a correction Paco typed on the memory lane is saved at the tick with a `/changes` line and an undo command; every other proposal is one card; standing-grant endings become `/changes` rows; a failing tick pages `improve_tick_degraded`; the 21:00 digest, its Unsure ✅/❌ taps and `HOUGE_DECISION_DIGEST_AT` go.

**Architecture:** The provenance gate is one pure predicate on the registry entry (`autoApplies`, named as `pacoWordsOnly`), checked by `entryProblems`; the tick's per-group transaction gains the save (through `saveMemoryPlan`, never through `acceptProposal`), the `accepted` transition and the `improve_log` change-log row, else a card on topic `improve_card`. Undo paths (`/forget`, `/forget_memory`) move the proposal to `reverted` inside the removal's transaction; `endStandingTx` writes its row; a degraded evaluator judges `improve_ticks` rows at the end of each date. `digest.ts` shrinks to its kept constants; its `/status` helpers move to `status-lines.ts`.

**Tech stack:** Node + TypeScript (ESM), `node:sqlite` through `RunStore`, vitest; `dependencies: {}` stays empty.

**Spec:** `docs/superpowers/specs/2026-11-07-improve-auto-apply-design.md` (Rev 2.1, approved by Paco 2026-11-07). ADR 0034 rules 2.2, 2.5, 6.6, 10.2, 10.5, 13.1, 13.2 and ADR 0031's chat list change (drafted in Task 10, awaiting Paco's signature).

## Global Constraints

- `improve_signals.origin` is a nullable `TEXT` column, values `memlane_fix | dig_deeper | escalation | rating` (CHECK-bound); rows older builds wrote and mirrored outcomes are null and never auto-apply.
- `autoApplies(g, s, verdict)`: every row `origin === "memlane_fix"`, `run_id !== null`, `run_id !== about_run_id`; verdict `lesson` or `fact`; signal `correction`; not the "lesson did not hold" rewrite (accepted lesson on the scope within 30 days).
- The auto-apply draft calls the distill with `prior: ""` (asserted on the seat input).
- No pile-up: `proposalBlocks` counts `open`, and `dismissed | expired | accepted | reverted` with `resolved_at` within **14 days** (`PROPOSAL_TTL_DAYS`).
- Change-log keys: `improve_applied:<proposal_id>` (topic `improve_log`), card key `improve_proposal:<proposal_id>` (topic `improve_card`, chat), `standing_end:<standing_id>` (topic `standing_log`).
- `/changes` lines: `📒 Lesson #57 learned from your correction (ask): <60 chars> — undo: /forget 57` · `🧠 Fact #214 learned from your correction: <60 chars> — undo: /forget_memory 214`; excerpts are **60 code points** after `redactForImprove`.
- The save uses `saveMemoryPlan(store, plan, { run_id: <about run>, chat_id, source: "improve", now })` directly inside the group's `BEGIN IMMEDIATE`; a capped lesson or a save with no change id → the proposal stays `open` and gets a card; a throw rolls the group back (unconsumed, `record_failed`); `TickCounts` are bumped after the commit.
- No chat (`g.newest.chat_id ?? d.chatId` null): the proposal stays `open`, one log line, no save, no card.
- Undo: `/forget <id>`, `/forget <scope>`, `/forget_memory <id>` find the proposal by `result_json.lesson_id` / `fact_id` (`proposalBySaved`) and move it `accepted → reverted` in the removal's transaction; `proposalByChange` stays for old buttons.
- Faults: incident kind `improve_tick_degraded` (route `page`, topic `incident_page`), subject `improve`; read from `improve_ticks` rows via `listImproveTicksSince`; bad = `failed`, or the previous date's row still `running`, or `decided === 0` with `deferred_outage | record_failed | embed_unavailable > 0`; healthy = `done` ∧ (`decided > 0` ∨ `groups === 0`) ∧ `embed_unavailable === 0`; `stopped` is neutral; opens at once on failed/stuck or when the run of consecutive bad dates reaches **3**; resolves on a healthy date; only the newest date is judged.
- `HOUGE_IMPROVE_AT` (`HH:MM` in `HOUGE_DISPLAY_TZ`, default `21:00`, no `off`) is read by `improveTickDue`; `HOUGE_DECISION_DIGEST_AT` is removed, named once at boot if still set, and joins `ENV_NOT_CONFIGURATION`.
- Kept: `REVIEW_PREFIX`, `DIGEST_PR_PREFIX`, `DIGEST_LM_PREFIX`, `STANDING_DIGEST_TEXT`, the `decision_digests` table. Removed: `runDecisionDigestTick`, `enqueueDigest`, `buildDecisionDigest`, `unsureSection`, topic `digest`. Old ✅/❌ taps answer `This review has closed.` and write nothing.
- Telegram text goes through the outbox and the rich renderer (never plain text); functions under 50 lines; tests under `tests/<area>/` mirroring `src/`, ADR rules under `tests/adr/`, docs parity under `tests/docs/`.
- Commit messages: Conventional Commits, files staged by name, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Plan rulings (the spec is the authority on intent; the code on fact)

- **P1.** `src/core/standing-approval.ts` does not exist; the module is `src/decisions/standing-approval.ts`, and the one central end transition is `RunStore.endStandingTx` (`src/run/run-store.ts:5735`). Its tests mirror the store: `tests/run/standing-end-log.test.ts`, not `tests/core/`.
- **P2.** `STANDING_DIGEST_TEXT` moves into `run-store.ts` (next to `StandingEndReason`): `endStandingTx` cannot import `digest.ts` (digest → registry → … → run-store would be a cycle). `digest.ts` re-exports it, so the kept constant keeps its import path.
- **P3.** `autoApplies(g, s, verdict)` is the pure provenance predicate (spec §3 items 1–3); item 4 (no pile-up) stays `proposalBlocks` before the draft (`already_proposed`), item 5 (a chat) is checked where the proposal is placed. The registry entry names the predicate as `pacoWordsOnly`.
- **P4.** The "lesson did not hold" rule leaves `evidenceOf` for `lessonRewrite(s)` in `improve-route.ts`, so the predicate and the evidence read one rule (`LESSON_REWRITE_DAYS = 30`).
- **P5.** Spec §8 ("`wasDecisionOffered` keeps reading it for old taps") contradicts §9 ("no `review_ok`/`review_bad` labels") and the 6.6 amendment. §9 wins: an old ✅/❌ answers `This review has closed.` and writes nothing; `wasDecisionOffered`, `recordDecisionDigest`, `getDecisionDigest`, `lastSentDecisionDigestAt` and `DecisionDigestRow` are orphans of this change and go. The `decision_digests` table stays (additive DDL).
- **P6.** Spec §12 says "a memlane-fix and a Dig-deeper correction apply"; §3.1 leaves Dig deeper out (it copies the original request, no new words). §3 wins (R12 reason): Dig deeper is a card, and the test asserts it.
- **P7.** Digest helpers only tests read (`unsureOf`, `barOf`, `reviewButtons`, `trustLines`, `reaskLines`, `UNSURE_MAX`, `UNSURE_BAND`, `DIGEST_PROPOSALS_MAX`, `DRAFT_LINE_CHARS`, `DIGEST_WAIT_FOR_TICK_MS`, `watchLines`, `improvementsToday`, `standingLines`, `proposalsWaiting`) go with their tests; `tests/decisions/injection-judge.test.ts:267` reads `injectionCounts(rows).lost` instead. `digest.ts` stays as the constants module the parser imports.
- **P8.** Topics: `improve_card` (chat), `improve_log` (log) as the spec names them; the standing row needs its own log topic, `standing_log` (`TOPIC_ROUTE` is a closed set).
- **P9.** The tap's reply carries its Undo / Revert / Revoke button: `replyTo` gains an optional `buttons` parameter and the proposal handlers return `TapReply = string | { text; buttons }`.
- **P10.** `TickCounts` gains `applied` and `cards`; `commitGroup` collects bumps in a local record and adds them to the tick's counts after the transaction returns (codex: today they move inside it).
- **P11.** `/forget <scope>`: `forgetScope` returns the pruned ids so each reverts its proposal; `/forget_memory`: `retireMemoryRowsTx` runs inside one `inTransaction` with the revert, and `RunStore.MEMORY_REFUSED` becomes public (it was `private static`).
- **P12.** Rollback scripts that load an OLD dist (`mOld.`/`old.buildDecisionDigest`) are untouched; `check-ladder-stage4b/4c-rollback.mjs` drop the digest from `render` (status and list stay compared); `live-gate-decisions-parity.mjs` retires `checkDigest`/`checkRender`/`checkTap`/`ensureUnsure`/`clearDigestLatch`/`claimDigest` for `checkNoDigest`; `live-gate-decisions-2a.mjs` keeps C9's `/status` half.
- **P13.** The gate's case 7 positive control ("a clean turn's prior reached the distill") moves to a `dig_deeper` correction (card path, prior allowed); case 3's `memlane_fix` correction asserts the empty prior.
- **P14.** `improve_tick_degraded` is evaluated after `finishImproveTick` in `runImproveTick`, inside its own try/catch, on every tick end (a `stopped` end is neutral and changes nothing).
- **P15.** `tests/decisions/improve-route.test.ts:25` pins every non-`nothing` verdict as `proposal/card`; it is split into lesson/fact (`effect/changes`) and the rest.

## File Structure

| File | Responsibility |
|---|---|
| `src/run/run-store.ts` | `ImproveOrigin`, `origin` column + migration + insert; `proposalBlocks` (accepted/reverted), `proposalBySaved`; `forgetScope` returns ids; `STANDING_DIGEST_TEXT` + `logStandingEnd` in `endStandingTx`; public `MEMORY_REFUSED`; digest methods removed |
| `src/decisions/improve-signals.ts` | `recordCorrection` takes `origin` |
| `src/core/core-worker.ts`, `src/gateway/memlane-commands.ts`, `src/gateway/gateway.ts` | the four producers name their origin; `/forget` reverts in one transaction; `/status` line |
| `src/decisions/types.ts` | `Announce` gains `"changes"`; `Entry.pacoWordsOnly` |
| `src/decisions/registry.ts` | the gated allowance in `effectProblems` and `shapeProblems` |
| `src/decisions/entries/improve-route.ts` | `autoApplies`, `lessonRewrite`, `LESSON_REWRITE_DAYS`, `ProvenanceRows`; lesson/fact effects `effect/changes`; `pacoWordsOnly` |
| `src/improve/proposals.ts` | `DraftDeps.noPrior`; `evidenceOf` reads `lessonRewrite` |
| `src/improve/apply.ts` (new) | `applyProposal`, `appliedLine`, `memoryPlanOf`, `APPLIED_EXCERPT_CHARS` |
| `src/improve/proposal-card.ts` (new) | `queueProposalCard`, `proposalCardText`, `proposalCardButtons`, `draftSummary`, `avoidSummary`, `clip`, `parsed`, `str`, `button` |
| `src/improve/tick.ts` | `TickCounts.applied/cards`; `runGroup` computes `auto`; `commitGroup` bumps after commit; `placeProposal`; degraded evaluation; `resolveImproveAt` |
| `src/improve/flag.ts` | `resolveImproveAt`, `DEFAULT_IMPROVE_AT`, `warnRetiredDigestAt` |
| `src/improve/degraded.ts` (new) | `judgeTickDate`, `badRun`, `evaluateImproveDegraded`, kind/subject constants |
| `src/gateway/improve-undo.ts` | `revertSavedProposal` |
| `src/gateway/memory-commands.ts` | `replyTo(…, buttons?)`; `/forget_memory` reverts in one transaction |
| `src/gateway/improvement-commands.ts` | `TapReply`; Accept replies carry Undo / Revert / Revoke |
| `src/gateway/decision-commands.ts` | old ✅/❌ answer closed |
| `src/notifications/topics.ts` | `improve_card`, `improve_log`, `standing_log`; `digest` removed |
| `src/run/incident-route.ts` | `improve_tick_degraded` pages |
| `src/decisions/status-lines.ts` (new) | `countLines`, `decisionWindow`, `deciderLabel`, `injectionCounts`, `settleHealthLine`, `trustTops`, `improvementLine` |
| `src/decisions/status-view.ts` | imports from `status-lines.ts`; appends the improvement line |
| `src/decisions/digest.ts` | constants only: `REVIEW_PREFIX`, `DIGEST_PR_PREFIX`, `DIGEST_LM_PREFIX`, re-export `STANDING_DIGEST_TEXT` |
| `src/telegram/telegram-daemon.ts` | digest tick removed; `warnRetiredDigestAt` at boot |
| `scripts/live-gate-improve-route.mjs`, `check-ladder-stage4b/4c-rollback.mjs`, `live-gate-decisions-parity.mjs`, `live-gate-decisions-2a.mjs` | gate updates (Tasks 8–9) |
| `tests/run/improve-signals-origin.test.ts`, `tests/run/improvement-proposals-store.test.ts`, `tests/run/standing-end-log.test.ts`, `tests/improve/apply.test.ts`, `tests/improve/degraded.test.ts`, `tests/gateway/improve-undo.test.ts`, `tests/decisions/status-lines.test.ts`, `tests/adr/0034-paco-words-only.test.ts` (new) + edits listed per task | tests |
| `docs/decisions/0034-…`, `0031-…`, `docs/decisions/README.md`, `docs/reference/{configuration,jev-decision-layer,decision-map}.md`, `README.md`, `CONTEXT.md`, `docs/ROADMAP.md`, `tasks/todo.md`, `tasks/lessons.md`, `sessions.md`, `tests/docs/parity.ts` | docs sync (Task 10) |

---

## Task 1: `improve_signals.origin` — column, insert, `recordCorrection(origin)`, the four producers

**Files:** `src/run/run-store.ts` (types at 1054–1055, `IMPROVE_ROUTE_DDL` 1291–1301, `insertImproveSignal` 5234–5240, `applyImproveRouteMigration` 8651–8658), `src/decisions/improve-signals.ts:36-39`, `src/core/core-worker.ts:2584,3261`, `src/gateway/memlane-commands.ts:70`, `src/gateway/gateway.ts:1268`, `tests/decisions/improve-signals.test.ts`, `tests/improve/groups.test.ts:15-16`, `tests/improve/proposals.test.ts:13`, new `tests/run/improve-signals-origin.test.ts`.

**Interfaces.** Produces: `export type ImproveOrigin = "memlane_fix" | "dig_deeper" | "escalation" | "rating"`; `ImproveSignalInsert.origin?: ImproveOrigin | null`; `ImproveSignalRow.origin: ImproveOrigin | null`; `recordCorrection(store, { about: JevVerdictRow; run_id: string | null; chat_id: string; origin: ImproveOrigin; now?: string }): boolean`. Consumes: `tableColumns(name)` (private, run-store), `OutcomeRejected`.

- [ ] **Red — the store test.** Create `tests/run/improve-signals-origin.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-11-07 §3.1: the inbox row names its producer. Only memlane_fix rows may ever auto-apply, so the column is
// additive (old rows null), CHECK-bound (a stray word cannot pass as Paco's words) and comes back after a rebuild.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const cols = (s: RunStore) => (db(s).prepare("PRAGMA table_info(improve_signals)").all() as Array<{ name: string }>).map((c) => c.name);
const row = (origin: "memlane_fix" | "dig_deeper" | "escalation" | "rating" | null | undefined) => ({ signal: "correction" as const, value: "answer", run_id: "run_b", chat_id: "555", about_run_id: "run_a", ...(origin === undefined ? {} : { origin }) });

describe("improve_signals.origin", () => {
  it("is stored and read back; an omitted origin is null (mirrored outcomes, old producers)", () => {
    const s = RunStore.openInMemory();
    expect(s.insertImproveSignal(row("memlane_fix"))).toBeGreaterThan(0);
    expect(s.insertImproveSignal({ ...row(undefined), run_id: "run_c" })).toBeGreaterThan(0);
    expect(s.listUnconsumedSignals(5).map((r) => r.origin)).toEqual(["memlane_fix", null]);
  });
  it("refuses a word outside the four origins at the schema", () => {
    const s = RunStore.openInMemory();
    expect(() => s.insertImproveSignal({ ...row(undefined), origin: "paco_said_so" as "rating" })).toThrow(/CHECK/);
  });
  it("the migration adds the column to a table an older build created and keeps the old rows null", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-origin-")); dirs.push(dir);
    const path = join(dir, "houge.sqlite");
    const first = RunStore.open(path);
    expect(cols(first)).toContain("origin");
    db(first).exec("ALTER TABLE improve_signals DROP COLUMN origin"); // the table as the 2026-10-21 build left it
    db(first).prepare("INSERT INTO improve_signals (signal, value, run_id, chat_id, about_run_id, created_at) VALUES ('correction', 'answer', 'run_b', '555', 'run_a', '2026-10-01T00:00:00.000Z')").run();
    first.close();
    const second = RunStore.open(path);
    try {
      expect(cols(second)).toContain("origin");
      expect(second.listUnconsumedSignals(5).map((r) => r.origin)).toEqual([null]);
    } finally { second.close(); }
  });
});
```

Run `npx vitest run tests/run/improve-signals-origin.test.ts` — expected: TS/runtime failures (`origin` unknown on the insert type; `r.origin` undefined; no CHECK).

- [ ] **Green — the store.** In `src/run/run-store.ts`:

After the `LadderMoveInsert` interface (ends line 1053) add:

```ts
/** Spec 2026-11-07 §3.1: which producer wrote a correction row. Only `memlane_fix` (the memory lane's fix hand-off) carries a message Paco typed; null on rows older builds wrote and on mirrored outcomes. */
export type ImproveOrigin = "memlane_fix" | "dig_deeper" | "escalation" | "rating";
```

Edit the two interfaces (1054–1055): add `origin?: ImproveOrigin | null;` to `ImproveSignalInsert` (after `source_outcome_id`) and `origin: ImproveOrigin | null;` to `ImproveSignalRow` (after `consumed_at`).

In `IMPROVE_ROUTE_DDL`, replace `    consumed_at TEXT\n  );` (the `improve_signals` table, lines 1300–1301) with:

```sql
    consumed_at TEXT,
    origin TEXT CHECK (origin IS NULL OR origin IN ('memlane_fix', 'dig_deeper', 'escalation', 'rating'))
  );
```

In `insertImproveSignal` (5234–5240) change the statement and run call to:

```ts
      INSERT OR IGNORE INTO improve_signals (signal, value, run_id, chat_id, about_run_id, source_outcome_id, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.signal, value, s.run_id, s.chat_id, s.about_run_id, s.source_outcome_id ?? null, s.created_at ?? new Date().toISOString(), s.origin ?? null);
```

In `applyImproveRouteMigration` (8651–8658), after `this.db.exec(IMPROVE_ROUTE_DDL);` add (the 2a pattern at 8837: checked on every open, so a table an older build created gets its column):

```ts
      // spec 2026-11-07 §3.1: additive; the CHECK closes the set the way the DDL does for a new table
      if (!this.tableColumns("improve_signals").has("origin")) this.db.exec(`ALTER TABLE improve_signals ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('memlane_fix', 'dig_deeper', 'escalation', 'rating'))`);
```

Update the docblock of `applyImproveRouteMigration` to end "…like the 2a migration; the `origin` column is added to an older table on every open."

- [ ] **Red — the producer test.** In `tests/decisions/improve-signals.test.ts`, change the `recordCorrection` test (31–36) to pass and assert the origin, and add the producer-shape test:

```ts
  it("recordCorrection labels the corrected turn with its category, the correcting run and its producer (spec 2026-11-07 §3.1: the origin decides what may apply on its own)", () => {
    const s = RunStore.openInMemory();
    const a = createQueuedTurnRun(s, "a");
    const v = verdictOf(s, a, "lookup");
    expect(recordCorrection(s, { about: v, run_id: "run_b", chat_id: "555", origin: "memlane_fix", now: NOW })).toBe(true);
    expect(s.listUnconsumedSignals(5).map((r) => [r.signal, r.value, r.run_id, r.about_run_id, r.chat_id, r.origin])).toEqual([["correction", "lookup", "run_b", a, "555", "memlane_fix"]]);
  });
  it("each producer names its own origin, and only the memory lane's fix hand-off is memlane_fix (the one correction that holds a message Paco typed)", () => {
    const worker = readFileSync("src/core/core-worker.ts", "utf8"); const gateway = readFileSync("src/gateway/gateway.ts", "utf8"); const memlane = readFileSync("src/gateway/memlane-commands.ts", "utf8");
    const all = `${worker}\n${gateway}\n${memlane}\n${readFileSync("src/omp/bridge-handler.ts", "utf8")}`;
    expect((all.match(/origin: "memlane_fix"/g) ?? []).length).toBe(1);
    expect(worker.slice(worker.indexOf("private noteFixCorrection"))).toMatch(/recordCorrection\(this\.runStore, \{ about: prev, run_id, chat_id: chat, origin: "memlane_fix" \}\)/);
    expect(worker).toContain('recordCorrection(this.runStore, { about: v, run_id: i.run_id, chat_id: this.chatOf(i.run_id), origin: "escalation" })');
    expect(memlane).toContain('recordCorrection(store, { about: verdict, run_id: new_run_id, chat_id, origin: "dig_deeper", now })');
    expect(gateway).toContain('recordCorrection(this.runStore, { about: v, run_id: null, chat_id, origin: "rating", now })');
  });
```

Run `npx vitest run tests/decisions/improve-signals.test.ts` — expected: fails (no `origin` parameter; call sites unchanged).

- [ ] **Green — the producers.** `src/decisions/improve-signals.ts`: import `type ImproveOrigin` from `../run/run-store.js` and replace lines 35–39 with:

```ts
/** One correction row on the corrected turn (`about`), by the correcting run (null for a rating, which has none), stamped with its producer (spec 2026-11-07 §3.1: only `memlane_fix` may apply on its own). */
export function recordCorrection(store: RunStore, i: { about: JevVerdictRow; run_id: string | null; chat_id: string; origin: ImproveOrigin; now?: string }): boolean {
  return recordImproveSignal(store, { signal: "correction", value: correctionValue(i.about.category), run_id: i.run_id, chat_id: i.chat_id, about_run_id: i.about.run_id, origin: i.origin,
    ...(i.now ? { created_at: i.now } : {}) });
}
```

Call sites — add the `origin` field exactly as the test spells them: `core-worker.ts:2584` → `origin: "escalation"`; `core-worker.ts:3261` → `origin: "memlane_fix"`; `memlane-commands.ts:70` → `origin: "dig_deeper"` (before `now`); `gateway.ts:1268` → `origin: "rating"` (before `now`).

Row literals in tests: add `origin: null,` after `source_outcome_id: null,` in `tests/improve/groups.test.ts:16` and `tests/improve/proposals.test.ts:13`.

- [ ] Run `npm run typecheck && npx vitest run tests/run/improve-signals-origin.test.ts tests/decisions/improve-signals.test.ts tests/improve` — all green, none skipped.
- [ ] Commit:

```
git add src/run/run-store.ts src/decisions/improve-signals.ts src/core/core-worker.ts src/gateway/memlane-commands.ts src/gateway/gateway.ts tests/run/improve-signals-origin.test.ts tests/decisions/improve-signals.test.ts tests/improve/groups.test.ts tests/improve/proposals.test.ts
git commit -m "feat(improve): improve_signals.origin names each correction's producer

Spec 2026-11-07 §3.1. Additive CHECK-bound column, recordCorrection takes
origin, the four producers name theirs; only memlane_fix will auto-apply.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: `proposalBlocks` counts accepted and reverted; `proposalBySaved`

**Files:** `src/run/run-store.ts:5591-5600`, new `tests/run/improvement-proposals-store.test.ts`.

**Interfaces.** Produces: `proposalBlocks(target, scope, sinceIso): boolean` (states `open | dismissed | expired | accepted | reverted`); `proposalBySaved(kind: "lesson" | "fact", id: number): ImprovementProposalRow | undefined`. Consumes: `insertImprovementProposal`, `transitionProposal`, `insertDecision`.

- [ ] **Red.** Create `tests/run/improvement-proposals-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Spec 2026-11-07 §3.4 and §6: an applied (accepted) or undone (reverted) proposal blocks the same (target, scope) for 14 days —
// without it the next tick would re-learn the lesson Paco just undid; the undo commands find the proposal by the saved id.
const NOW = "2026-10-21T10:00:00.000Z";
const SINCE = "2026-10-07T10:00:00.000Z"; // now − 14 d
const D: DecisionInsert = { entry_id: "improve.route", entry_version: 1, run_id: null, tool_call_id: null, stage: "after_turn", rung: "system_one", verdict: "lesson", p: 0.7, reason_code: "jev_choice",
  fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: NOW };
function proposal(s: RunStore, state: "accepted" | "reverted" | "dismissed", resolved_at: string, result_json?: string, target: "lesson" | "fact" = "lesson"): string {
  const id = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target, scope: "answer", chat_id: "555", draft_json: "{}", evidence: "e", created_at: "2026-09-01T00:00:00.000Z" });
  s.transitionProposal({ proposal_id: id, from: ["open"], to: "accepted", now: resolved_at, ...(result_json ? { result_json } : {}) });
  if (state !== "accepted") s.transitionProposal({ proposal_id: id, from: ["accepted"], to: state === "reverted" ? "reverted" : "dismissed", now: resolved_at });
  return id;
}

describe("proposalBlocks", () => {
  it("an accepted or reverted proposal within 14 days blocks its (target, scope); one older than 14 days, or another scope or target, does not", () => {
    const s = RunStore.openInMemory();
    proposal(s, "accepted", "2026-10-20T00:00:00.000Z");
    expect(s.proposalBlocks("lesson", "answer", SINCE)).toBe(true);
    expect(s.proposalBlocks("lesson", "lookup", SINCE)).toBe(false);
    expect(s.proposalBlocks("fact", "answer", SINCE)).toBe(false);
    const s2 = RunStore.openInMemory();
    proposal(s2, "reverted", "2026-10-15T00:00:00.000Z");
    expect(s2.proposalBlocks("lesson", "answer", SINCE)).toBe(true);
    const s3 = RunStore.openInMemory();
    proposal(s3, "accepted", "2026-10-01T00:00:00.000Z"); proposal(s3, "reverted", "2026-10-02T00:00:00.000Z");
    expect(s3.proposalBlocks("lesson", "answer", SINCE)).toBe(false);
  });
});

describe("proposalBySaved", () => {
  it("finds the accepted proposal by the lesson or fact id it saved; a reverted one, another id or the change id finds nothing", () => {
    const s = RunStore.openInMemory();
    const lesson = proposal(s, "accepted", NOW, JSON.stringify({ change_id: "lc_1", lesson_id: 57 }));
    const fact = proposal(s, "accepted", NOW, JSON.stringify({ change_id: "mc_1", fact_id: 214 }), "fact");
    proposal(s, "reverted", NOW, JSON.stringify({ change_id: "lc_2", lesson_id: 58 }));
    expect(s.proposalBySaved("lesson", 57)?.proposal_id).toBe(lesson);
    expect(s.proposalBySaved("fact", 214)?.proposal_id).toBe(fact);
    expect(s.proposalBySaved("lesson", 58)).toBeUndefined();
    expect(s.proposalBySaved("fact", 57)).toBeUndefined();
    expect(s.proposalBySaved("lesson", 214)).toBeUndefined();
  });
});
```

Run `npx vitest run tests/run/improvement-proposals-store.test.ts` — expected: the accepted/reverted cases fail (`false`), `proposalBySaved` is not a function.

- [ ] **Green.** Replace `proposalBlocks` (5591–5595) and add `proposalBySaved` right after it:

```ts
  /** Final fix D3 + spec 2026-11-07 §3.4: an open proposal on (target, scope), or one dismissed, expired, accepted or reverted after `sinceIso`, blocks a new one (Dismiss sticks; an applied or undone one does not pile up). */
  proposalBlocks(target: ProposalTarget, scope: string, sinceIso: string): boolean {
    return this.db.prepare(`SELECT 1 AS hit FROM improvement_proposals WHERE target = ? AND scope = ? AND (state = 'open' OR (state IN ('dismissed', 'expired', 'accepted', 'reverted') AND resolved_at > ?)) LIMIT 1`)
      .get<{ hit: number }>(target, scope, sinceIso) !== undefined;
  }
  /** Spec 2026-11-07 §6: the accepted proposal whose save made this lesson or fact (its result_json names the id), for /forget and /forget_memory. */
  proposalBySaved(kind: "lesson" | "fact", id: number): ImprovementProposalRow | undefined {
    return this.db.prepare(`SELECT * FROM improvement_proposals WHERE state = 'accepted' AND target = ? AND json_extract(result_json, ?) = ? LIMIT 1`)
      .get<ImprovementProposalRow>(kind, kind === "lesson" ? "$.lesson_id" : "$.fact_id", id);
  }
```

- [ ] Run `npm run typecheck && npx vitest run tests/run/improvement-proposals-store.test.ts tests/improve/tick.test.ts` — green (the D2/D3 tick test still passes: dismissed/expired behaviour is unchanged).
- [ ] Commit:

```
git add src/run/run-store.ts tests/run/improvement-proposals-store.test.ts
git commit -m "feat(improve): accepted and reverted proposals block their pair; proposalBySaved

Spec 2026-11-07 §3.4, §6: no pile-up after an auto-apply or an undo; the
undo commands find a proposal by the lesson or fact id it saved.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: the effect contract — `Announce "changes"`, `pacoWordsOnly`, the gated allowance, `autoApplies`, the ADR pin

**Files:** `src/decisions/types.ts:30-31,62-87`, `src/decisions/registry.ts:57-119`, `src/decisions/entries/improve-route.ts:7,107-132`, `src/improve/proposals.ts:26-34`, `tests/decisions/registry.test.ts`, `tests/decisions/improve-route.test.ts:25`, new `tests/adr/0034-paco-words-only.test.ts`.

**Interfaces.** Produces: `type Announce = "card" | "changes" | "none"`; `Entry.pacoWordsOnly?: (...args: never[]) => boolean`; `LESSON_REWRITE_DAYS = 30`; `lessonRewrite(s: Pick<ImproveState, "signal" | "lastImprovement">): boolean`; `type ProvenanceRows = { rows: readonly Pick<ImproveSignalRow, "origin" | "run_id" | "about_run_id">[] }`; `autoApplies(g: ProvenanceRows, s: Pick<ImproveState, "signal" | "lastImprovement">, verdict: ImproveTarget): boolean`. Consumes: `ImproveSignalRow` (Task 1), `entryProblems`.

- [ ] **Red — registry.** Append to `tests/decisions/registry.test.ts` inside `describe("the registry")`:

```ts
  // Spec 2026-11-07 §4 (ADR 0034 2.5): one allowance over mixed input — an `effect` behind a code-owned provenance predicate,
  // reversible and announced (card or a /changes line). Everything that drops one leg of it must FAIL here.
  it("improve.route's lesson and fact are effects over mixed input only behind pacoWordsOnly, reversible and announced; a copy without the predicate, irreversible, unannounced, a reply, or over tool input fails", () => {
    const route = entryById("improve.route") as AnyEntry;
    expect(typeof route.pacoWordsOnly).toBe("function");
    expect([shape(route).lesson, shape(route).fact]).toEqual([["effect", true, "changes"], ["effect", true, "changes"]]);
    expect(entryProblems(route)).toEqual([]);
    const { pacoWordsOnly: _drop, ...bare } = route;
    const bareProblems = entryProblems(bare as AnyEntry);
    expect(bareProblems).toEqual(expect.arrayContaining(["a jev/model rung over mixed input can choose lesson, which is not tightening", "a jev/model rung over mixed input can choose fact, which is not tightening"]));
    expect(bareProblems.some((p) => p.startsWith("provisional bar"))).toBe(true); // the 0.67 bar needs the same gate
    const withFx = (v: string, f: VerdictEffect): AnyEntry => ({ ...route, effects: { ...route.effects, [v]: f } });
    expect(entryProblems(withFx("lesson", fx("effect", false, "changes")))).toContain("a jev/model rung over mixed input can choose lesson, which is not tightening");
    expect(entryProblems(withFx("fact", fx("effect", true, "none")))).toContain("a jev/model rung over mixed input can choose fact, which is not tightening");
    expect(entryProblems(withFx("lesson", fx("reply", true, "changes")))).toContain("a jev/model rung over mixed input can choose lesson, which is not tightening");
    expect(entryProblems({ ...route, input: "tool" })).toContain("a jev/model rung over tool input can choose lesson, which is not tightening");
  });
  it("over Paco's own message `changes` is not an announcement: that path still needs a card", () => {
    expect(entryProblems(base({ input: "paco", effects: { ...HANDLER.effects, answer: fx("effect", true, "changes") } }))).toContain("a jev/model rung can choose answer, an effect not reversible or not announced on a card");
  });
```

Edit `tests/decisions/improve-route.test.ts:25` to:

```ts
    for (const v of ["lesson", "fact"] as const) expect(e.effects[v]).toMatchObject({ kind: "effect", reversible: true, announced: "changes" });
    for (const v of IMPROVE_TARGETS.filter((t) => !["nothing", "lesson", "fact"].includes(t))) expect(e.effects[v]).toMatchObject({ kind: "proposal", reversible: true, announced: "card" });
    expect(e.pacoWordsOnly).toBe(autoApplies);
```

and add `autoApplies` to that file's import from `../../src/decisions/entries/improve-route.js`.

- [ ] **Red — the ADR pin.** Create `tests/adr/0034-paco-words-only.test.ts`:

```ts
/**
 * Rule: ADR 0034 rule 10.5 (spec 2026-11-07 §3): a lesson or fact proposal applies on its own only through the code-owned
 * provenance predicate `autoApplies`, which `improve.route` names as `pacoWordsOnly`: every row of the group a correction
 * Paco typed on the memory lane (`memlane_fix`, a new run of his, never the corrected run), verdict lesson or fact, no rewrite.
 * Any other origin, a null origin (rows older builds wrote), a run-less row, or a rewrite is a card. Changing this rule changes this test.
 */
import { describe, expect, it } from "vitest";
import { autoApplies, IMPROVE_ROUTE, LESSON_REWRITE_DAYS, lessonRewrite } from "../../src/decisions/entries/improve-route.js";

type Row = { origin: "memlane_fix" | "dig_deeper" | "escalation" | "rating" | null; run_id: string | null; about_run_id: string | null };
const fix: Row = { origin: "memlane_fix", run_id: "run_b", about_run_id: "run_a" };
const s = { signal: "correction" as const, lastImprovement: null };

describe("ADR 0034 rule 10.5: autoApplies", () => {
  it("is the entry's named predicate", () => { expect(IMPROVE_ROUTE.pacoWordsOnly).toBe(autoApplies); });
  it("applies a lesson or fact from memlane_fix rows only", () => {
    expect(autoApplies({ rows: [fix] }, s, "lesson")).toBe(true);
    expect(autoApplies({ rows: [fix, fix] }, s, "fact")).toBe(true);
    for (const v of ["nothing", "skill", "schedule", "knowledge", "tool_gap", "ladder"] as const) expect([v, autoApplies({ rows: [fix] }, s, v)]).toEqual([v, false]);
  });
  it.each<[string, Row]>([
    ["dig_deeper (the original request, no new words)", { ...fix, origin: "dig_deeper" }],
    ["escalation (run = about)", { origin: "escalation", run_id: "run_a", about_run_id: "run_a" }],
    ["rating (no run)", { origin: "rating", run_id: null, about_run_id: "run_a" }],
    ["null origin (an older build's row)", { ...fix, origin: null }],
    ["memlane_fix whose run is the corrected run", { ...fix, run_id: "run_a" }],
    ["memlane_fix with no run", { ...fix, run_id: null }]
  ])("%s is a card", (_name, row) => {
    expect(autoApplies({ rows: [row] }, s, "lesson")).toBe(false);
    expect(autoApplies({ rows: [fix, row] }, s, "lesson")).toBe(false); // one foreign row taints the group
  });
  it("an empty group, a non-correction signal, and the lesson-did-not-hold rewrite are cards", () => {
    expect(autoApplies({ rows: [] }, s, "lesson")).toBe(false);
    expect(autoApplies({ rows: [fix] }, { signal: "dig_deeper", lastImprovement: null }, "lesson")).toBe(false);
    const rewrite = { signal: "correction" as const, lastImprovement: { target: "lesson", ageDays: LESSON_REWRITE_DAYS } };
    expect(lessonRewrite(rewrite)).toBe(true);
    expect(autoApplies({ rows: [fix] }, rewrite, "lesson")).toBe(false);
    expect(autoApplies({ rows: [fix] }, { signal: "correction", lastImprovement: { target: "lesson", ageDays: LESSON_REWRITE_DAYS + 1 } }, "lesson")).toBe(true);
    expect(autoApplies({ rows: [fix] }, { signal: "correction", lastImprovement: { target: "fact", ageDays: 1 } }, "lesson")).toBe(true);
  });
});
```

Run `npx vitest run tests/decisions/registry.test.ts tests/decisions/improve-route.test.ts tests/adr/0034-paco-words-only.test.ts` — expected: fails to compile (`pacoWordsOnly`, `autoApplies`, `"changes"` unknown).

- [ ] **Green — types.** `src/decisions/types.ts:30-31` becomes:

```ts
/** How Paco learns of it: a code-built card (with its Undo / Dig deeper), a `/changes` row naming the undo command (spec 2026-11-07 §4), or not at all. The turn's reply is not an announcement (Paco 2026-10-12). */
export type Announce = "card" | "changes" | "none";
```

In `Entry` (after `effects`, line 84) add:

```ts
  /**
   * Spec 2026-11-07 §4 (ADR 0034 2.5): a code-owned provenance predicate, true only when what the effect would store is
   * Paco's own typed words. A `mixed`-input entry whose judge may cause a reversible, announced `effect` must name one;
   * `entryProblems` refuses such an effect without it.
   */
  pacoWordsOnly?: (...args: never[]) => boolean;
```

- [ ] **Green — registry.** In `src/decisions/registry.ts` after line 60 (`ANNOUNCED`) add:

```ts
/** Spec 2026-11-07 §4: the gated effect over mixed input is announced on a card or on a `/changes` line naming its undo. */
const GATED_ANNOUNCED: ReadonlySet<Announce> = new Set(["card", "changes"]);
```

Change the `shapeProblems` condition (84–86) to:

```ts
  if (provisional && !e.monotone && !failOpen && !reversibleOverPaco(e) && !gatedPacoWords(e)) {
    p.push("provisional bar on an entry that is not monotone, not fail-open without direct effects, not over Paco's words with every effect reversible and announced, and not gated by pacoWordsOnly");
  }
```

After `reversibleOverPaco` add:

```ts
/** Spec 2026-11-07 §4: a mixed-input entry naming a provenance predicate whose every effect is passive, or an `effect` reversible and announced (card or /changes). */
function gatedPacoWords(e: AnyEntry): boolean {
  return e.input === "mixed" && typeof e.pacoWordsOnly === "function" && e.verdicts.every((v) => {
    const fx = e.effects[v];
    return fx !== undefined && (PASSIVE.has(fx.kind) || (fx.kind === "effect" && fx.reversible && GATED_ANNOUNCED.has(fx.announced)));
  });
}
```

Replace the loop body of `effectProblems` (114–116) with:

```ts
    if (!judged || PASSIVE.has(fx.kind)) continue;
    if (e.input === "paco") { if (!fx.reversible || !ANNOUNCED.has(fx.announced)) p.push(`a jev/model rung can choose ${v}, an effect not reversible or not announced on a card`); continue; }
    // spec 2026-11-07 §4 (ADR 0034 2.5): over mixed input one allowance — a reversible, announced `effect` behind a code-owned provenance predicate
    if (e.input === "mixed" && fx.kind === "effect" && typeof e.pacoWordsOnly === "function" && fx.reversible && GATED_ANNOUNCED.has(fx.announced)) continue;
    p.push(`a jev/model rung over ${e.input} input can choose ${v}, which is not tightening`);
```

and extend its docblock: "One allowance (spec 2026-11-07 §4): over `mixed` input an `effect` passes when the entry names `pacoWordsOnly`, and it is reversible and announced on a card or a `/changes` line."

- [ ] **Green — the entry.** In `src/decisions/entries/improve-route.ts` add `import type { ImproveSignalRow } from "../../run/run-store.js";` and, before `const NONE` (line 107):

```ts
/** 2b-ii §7: a correction on a scope that got a lesson this recently is "lesson did not hold" evidence; its proposal is a rewrite, which only a tap may apply (saveMemoryPlan adds, never replaces). */
export const LESSON_REWRITE_DAYS = 30;
export const lessonRewrite = (s: Pick<ImproveState, "signal" | "lastImprovement">): boolean =>
  s.signal === "correction" && s.lastImprovement?.target === "lesson" && s.lastImprovement.ageDays <= LESSON_REWRITE_DAYS;

/** A group's rows as the provenance gate reads them (SignalGroup.rows, improve/groups.ts). */
export type ProvenanceRows = { rows: readonly Pick<ImproveSignalRow, "origin" | "run_id" | "about_run_id">[] };

/**
 * Spec 2026-11-07 §3 (ADR 0034 10.5, R12): a lesson or fact applies on its own only when every row of the group is a
 * correction Paco typed on the memory lane (`memlane_fix`: its correcting run is a new message of his, never the corrected
 * run) and the proposal is no rewrite. Pure: the no-pile-up check (proposalBlocks) and the chat check live at the commit.
 */
export function autoApplies(g: ProvenanceRows, s: Pick<ImproveState, "signal" | "lastImprovement">, verdict: ImproveTarget): boolean {
  if (verdict !== "lesson" && verdict !== "fact") return false;
  if (s.signal !== "correction" || lessonRewrite(s)) return false;
  return g.rows.length > 0 && g.rows.every((r) => r.origin === "memlane_fix" && r.run_id !== null && r.run_id !== r.about_run_id);
}
```

After `const proposal = …` (108) add `const applied = (what: string): VerdictEffect => ({ kind: "effect", reversible: true, announced: "changes", what });` and in `IMPROVE_ROUTE` replace the `lesson` and `fact` lines with:

```ts
    lesson: applied("from a correction Paco typed (autoApplies): saved at the tick, one /changes line with /forget <id>; otherwise a card whose Accept saves it with ↩️ Undo"),
    fact: applied("from a correction Paco typed (autoApplies): saved at the tick, one /changes line with /forget_memory <id>; otherwise a card whose Accept saves it with ↩️ Undo"),
```

and add `pacoWordsOnly: autoApplies,` after `armed: { … },`. Update the entry's docblock sentence "Jev … only propose" to "Jev … propose, except a lesson or fact behind `autoApplies` (spec 2026-11-07 §3), which applies with a /changes line".

In `src/improve/proposals.ts` import `lessonRewrite` from `../decisions/entries/improve-route.js` (join the existing type import as a value import) and replace line 29's condition with `if (lessonRewrite(s)) return …` (same text).

- [ ] Run `npm run typecheck && npx vitest run tests/decisions tests/adr tests/improve` — green.
- [ ] Commit:

```
git add src/decisions/types.ts src/decisions/registry.ts src/decisions/entries/improve-route.ts src/improve/proposals.ts tests/decisions/registry.test.ts tests/decisions/improve-route.test.ts tests/adr/0034-paco-words-only.test.ts
git commit -m "feat(decisions): improve.route lesson/fact are gated effects behind autoApplies

Spec 2026-11-07 §3-4 (ADR 0034 2.5, 10.5, to be amended): Announce gains
changes, entries may name pacoWordsOnly, entryProblems allows one reversible
announced effect over mixed input behind it; the ADR rule is pinned in tests/adr.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4a: the auto-apply modules — `apply.ts`, `proposal-card.ts`, `noPrior`, topics, tap replies with buttons

**Files:** new `src/improve/apply.ts`, new `src/improve/proposal-card.ts`, `src/improve/proposals.ts:20,61-64`, `src/notifications/topics.ts`, `src/gateway/memory-commands.ts:33-39`, `src/gateway/improvement-commands.ts`, new `tests/improve/apply.test.ts`, `tests/improve/proposals.test.ts`, `tests/notifications/topics.test.ts`, `tests/gateway/improvement-commands.test.ts`.

**Interfaces.** Produces: `applyProposal(store, { proposal_id; target: "lesson"|"fact"; draft_json; run_id; chat_id; now }): AppliedResult | null` (`AppliedResult = { change_id; lesson_id } | { change_id; fact_id }`); `appliedLine(store, target, result, draft): string`; `APPLIED_EXCERPT_CHARS = 60`; `queueProposalCard(store, p: CardProposal, chat_id, now): void`; `proposalCardText`, `proposalCardButtons`, `draftSummary`, `avoidSummary`, `clip`, `parsed`, `str`, `button`; `DraftDeps.noPrior?: boolean`; `replyTo(store, event, suffix, text, buttons?: NotificationButton[])`; `TapReply`. Consumes: `saveMemoryPlan` (`src/capabilities/memory-save.ts`), `redactForImprove`, `DIGEST_PR_PREFIX`/`DIGEST_LM_PREFIX` (`digest.ts`), `memlaneUndoButton` (`src/core/memory-lane-card.ts`), `memoryUndoButton` (`src/capabilities/memory-correct.ts`), `transitionProposal`, `enqueueNotification`, `markProposalsOffered`.

- [ ] **Red.** Create `tests/improve/apply.test.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyProposal, appliedLine, APPLIED_EXCERPT_CHARS } from "../../src/improve/apply.js";
import { proposalCardButtons, proposalCardText, queueProposalCard } from "../../src/improve/proposal-card.js";
import { parseImprovementCallback } from "../../src/triggers/telegram-command-parser.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { createTelegramTurn } from "../helpers/runs.js";

// Spec 2026-11-07 §5: inside the group's transaction an applied proposal is the memory lane's own save, `accepted` with the
// ids, and one /changes row naming the undo command; a capped lesson applies nothing (its card follows); the card of every
// other proposal is keyed by proposal with Accept/Dismiss and starts the 14-day tap window (offered_at).
const NOW = "2026-10-21T10:00:00.000Z";
const D: DecisionInsert = { entry_id: "improve.route", entry_version: 1, run_id: null, tool_call_id: null, stage: "after_turn", rung: "system_one", verdict: "lesson", p: 0.7, reason_code: "jev_choice",
  fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: NOW };
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const logRow = (s: RunStore, key: string) => db(s).prepare("SELECT topic, text FROM change_log WHERE idempotency_key = ?").get(key) as { topic: string; text: string } | undefined;
function open(s: RunStore, target: "lesson" | "fact", draft: unknown) {
  const run_id = createTelegramTurn(s, "please always answer in one line").run_id;
  const proposal_id = s.insertImprovementProposal({ decision_id: s.insertDecision({ ...D, run_id }), target, scope: "answer", chat_id: "555", draft_json: JSON.stringify(draft), evidence: "correction on 2026-10-21, scope answer", created_at: NOW });
  return { proposal_id, run_id, draft_json: JSON.stringify(draft) };
}

describe("applyProposal", () => {
  it("saves the lesson with source improve under the about run, marks the proposal accepted with the ids, and writes the /changes row with /forget <id>", () => {
    const s = RunStore.openInMemory();
    const p = open(s, "lesson", { scope: "ask", text: "Answer in one line.", avoid: "long stories" });
    const r = s.inTransaction(() => applyProposal(s, { ...p, target: "lesson", chat_id: "555", now: NOW }));
    expect(r).toMatchObject({ change_id: expect.stringMatching(/^lc_/), lesson_id: expect.any(Number) });
    const id = (r as { lesson_id: number }).lesson_id;
    expect(s.getLesson(id)).toMatchObject({ source: "improve", status: "active", scope: "ask" });
    expect(s.getLessonChange((r as { change_id: string }).change_id)).toMatchObject({ run_id: p.run_id, chat_id: "555", new_id: id });
    expect(s.getImprovementProposal(p.proposal_id)).toMatchObject({ state: "accepted", result_json: JSON.stringify(r) });
    expect(logRow(s, `improve_applied:${p.proposal_id}`)).toEqual({ topic: "improve_log", text: `📒 Lesson #${id} learned from your correction (ask): Answer in one line. — undo: /forget ${id}` });
    expect(s.countNotificationsByIdempotencyKey(`improve_proposal:${p.proposal_id}`)).toBe(0); // no chat row
  });
  it("a fact: the /changes row names /forget_memory <id>; the excerpt is 60 code points after redaction", () => {
    const s = RunStore.openInMemory();
    const long = "我".repeat(70);
    const p = open(s, "fact", { text: long, evidence: { line: 1, quote: "x" }, source_turn_ids: [] });
    const r = s.inTransaction(() => applyProposal(s, { ...p, target: "fact", chat_id: "555", now: NOW }));
    expect(r).toMatchObject({ change_id: expect.stringMatching(/^mc_/), fact_id: expect.any(Number) });
    const id = (r as { fact_id: number }).fact_id;
    expect(logRow(s, `improve_applied:${p.proposal_id}`)?.text).toBe(`🧠 Fact #${id} learned from your correction: ${"我".repeat(APPLIED_EXCERPT_CHARS)} — undo: /forget_memory ${id}`);
    expect(appliedLine(s, "fact", { change_id: "mc_x", fact_id: 7 }, { text: "k=SECRET_VALUE_ABCDEFGHIJKLMNOP" })).not.toContain("SECRET_VALUE_ABCDEFGHIJKLMNOP");
  });
  it("a capped lesson applies nothing: null, the proposal stays open, no row, no change (the caller queues the card)", () => {
    const s = RunStore.openInMemory();
    const p = open(s, "lesson", { scope: "ask", text: "x".repeat(300) });
    expect(s.inTransaction(() => applyProposal(s, { ...p, target: "lesson", chat_id: "555", now: NOW }))).toBeNull();
    expect(s.getImprovementProposal(p.proposal_id)?.state).toBe("open");
    expect(logRow(s, `improve_applied:${p.proposal_id}`)).toBeUndefined();
    expect(s.listLessons("ask")).toHaveLength(0);
  });
  it("a proposal no longer open throws apply_lost (the save must not outlive a lost transition)", () => {
    const s = RunStore.openInMemory();
    const p = open(s, "lesson", { scope: "ask", text: "Answer in one line." });
    s.transitionProposal({ proposal_id: p.proposal_id, from: ["open"], to: "dismissed", now: NOW });
    expect(() => s.inTransaction(() => applyProposal(s, { ...p, target: "lesson", chat_id: "555", now: NOW }))).toThrow("apply_lost");
    expect(s.listLessons("ask")).toHaveLength(0); // rolled back with the transaction
  });
});

describe("queueProposalCard", () => {
  it("one improve_card outbox row keyed by proposal with Accept/Dismiss that parse back, and offered_at set; a second call is a duplicate, not a second card", () => {
    const s = RunStore.openInMemory();
    const p = open(s, "schedule", { schedule_id: "sch_1", hour_from: 11, hour_to: 20, before: {}, after: {} });
    const card = { proposal_id: p.proposal_id, target: "schedule" as const, draft_json: p.draft_json, evidence: "2 approval_expired on shell_external in 14 days" };
    s.inTransaction(() => queueProposalCard(s, card, "555", NOW));
    s.inTransaction(() => queueProposalCard(s, card, "555", NOW));
    expect(s.countNotificationsByIdempotencyKey(`improve_proposal:${p.proposal_id}`)).toBe(1);
    expect(s.getImprovementProposal(p.proposal_id)?.offered_at).toBe(NOW);
    const note = s.claimNextNotification("t", 30)!;
    expect(note.topic).toBe("improve_card");
    expect(note.payload.text).toBe(proposalCardText(s, card));
    expect(String(note.payload.text)).toContain("move sch_1 to 20:00");
    const buttons = proposalCardButtons(p.proposal_id);
    expect(note.payload.buttons).toEqual(buttons);
    expect(buttons.map((b) => parseImprovementCallback(b.data))).toEqual([{ kind: "pr", id: p.proposal_id, action: "acc" }, { kind: "pr", id: p.proposal_id, action: "dis" }]);
  });
  it("a lesson card shows the redacted text and its AVOID, clipped at 120 code points", () => {
    const s = RunStore.openInMemory();
    const text = proposalCardText(s, { proposal_id: "pr_x", target: "lesson", draft_json: JSON.stringify({ scope: "ask", text: "a".repeat(130), avoid: "long stories" }), evidence: "e" });
    expect(text).toBe(`📒 Lesson proposal · ${"a".repeat(120)} · AVOID: long stories · e`);
  });
});
```

Run `npx vitest run tests/improve/apply.test.ts` — expected: cannot resolve `../../src/improve/apply.js` / `proposal-card.js`.

- [ ] **Green — topics.** In `src/notifications/topics.ts` add to `TOPIC_ROUTE`: `improve_card: "chat"` (after `improve_job`) and `improve_log: "log"` (after `decision_internal`). In `tests/notifications/topics.test.ts` add `"improve_log"` to the sorted log list (`["decision_internal", "improve_log", "incident_log", "jev_notice", "model_change"]`) and `"improve_card"` to the chat loop.

- [ ] **Green — `proposal-card.ts`.** Create `src/improve/proposal-card.ts`:

```ts
import { DIGEST_PR_PREFIX } from "../decisions/digest.js";
import { redactForImprove } from "../decisions/egress.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { ImprovementProposalRow, ProposalTarget, RunStore } from "../run/run-store.js";

/**
 * Spec 2026-11-07 §2, §5: a proposal that does not apply on its own is one card at the tick (topic improve_card, chat),
 * Accept / Dismiss, offered as the digest once offered it (offered_at starts the 14-day tap window). Code-built lines:
 * the redacted draft, its AVOID, the evidence. (The digest's private copies of these helpers go with it, Task 8.)
 */
export const DRAFT_LINE_CHARS = 120;
export const CARD_LABEL: Readonly<Record<ProposalTarget, string>> = { lesson: "📒 Lesson", fact: "🧠 Fact", skill: "🛠 Skill", schedule: "⏰ Schedule", knowledge: "📚 Knowledge", tool_gap: "🔧 Tool gap", ladder: "🪜 Ladder" };
export type CardProposal = Pick<ImprovementProposalRow, "proposal_id" | "target" | "draft_json" | "evidence">;

/** Code points, not UTF-16 units: a split surrogate pair would make Telegram reject the HTML send. */
export const clip = (text: string, n: number): string => Array.from(text.replace(/\s+/g, " ").trim()).slice(0, n).join("");
export function button(text: string, data: string): NotificationButton {
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("proposal callback_data exceeds 64 bytes");
  return { text, data };
}
/** A stored JSON object, or {} for anything else: a corrupt row never breaks a card or a /changes line. */
export function parsed(json: string | null): Record<string, unknown> {
  try { const v: unknown = JSON.parse(json ?? "{}"); return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}
export const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What a proposal's draft says in one line (redacted before the cut so a secret is never half-shown). */
export function draftSummary(store: RunStore, p: Pick<ImprovementProposalRow, "target" | "draft_json">, chars: number): string {
  const d = parsed(p.draft_json);
  const raw = p.target === "lesson" || p.target === "fact" ? str(d.text)
    : p.target === "schedule" ? `move ${str(d.schedule_id).slice(0, 12)} to ${String(d.hour_to ?? "?")}:00`
    : p.target === "ladder" ? `${str(d.move)} on ${str(d.entry_id)}` : str(d.text);
  return clip(redactForImprove(store, raw), chars);
}
/** A lesson's AVOID enters every planner prompt, so the card shows it, redacted then clipped like the text (final fix A2). */
export function avoidSummary(store: RunStore, p: Pick<ImprovementProposalRow, "target" | "draft_json">, chars: number): string {
  const avoid = p.target === "lesson" ? str(parsed(p.draft_json).avoid) : "";
  return avoid ? ` · AVOID: ${clip(redactForImprove(store, avoid), chars)}` : "";
}
export function proposalCardText(store: RunStore, p: CardProposal): string {
  return `${CARD_LABEL[p.target]} proposal · ${draftSummary(store, p, DRAFT_LINE_CHARS)}${avoidSummary(store, p, DRAFT_LINE_CHARS)} · ${p.evidence}`;
}
export function proposalCardButtons(proposal_id: string): NotificationButton[] {
  return [button("✅ Accept", `${DIGEST_PR_PREFIX}${proposal_id}:acc`), button("🗑 Dismiss", `${DIGEST_PR_PREFIX}${proposal_id}:dis`)];
}
/** Inside the group's transaction: the card row (keyed by proposal, so a redelivery is a duplicate) and offered_at. A refused enqueue throws: no silent card loss. */
export function queueProposalCard(store: RunStore, p: CardProposal, chat_id: string, now: string): void {
  const r = store.enqueueNotification({ topic: "improve_card", target: { kind: "telegram", chat_id }, intent_type: "progress", idempotency_key: `improve_proposal:${p.proposal_id}`,
    correlation_id: `improve_proposal:${p.proposal_id}`, payload: { text: proposalCardText(store, p), buttons: proposalCardButtons(p.proposal_id) } });
  if (r.status !== "queued" && r.status !== "duplicate") throw new Error(`proposal card not queued: ${r.status}`);
  store.markProposalsOffered([p.proposal_id], now);
}
```

- [ ] **Green — `apply.ts`.** Create `src/improve/apply.ts`:

```ts
import { saveMemoryPlan, type MemoryPlan } from "../capabilities/memory-save.js";
import { redactForImprove } from "../decisions/egress.js";
import type { RunStore } from "../run/run-store.js";
import { clip, parsed, str } from "./proposal-card.js";

/** Spec 2026-11-07 §5: the /changes line of an applied proposal — id, scope, a 60-code-point excerpt of the stored text and the undo command. */
export const APPLIED_EXCERPT_CHARS = 60;
export type AppliedResult = { change_id: string; lesson_id: number } | { change_id: string; fact_id: number };
export interface ApplyInput { proposal_id: string; target: "lesson" | "fact"; draft_json: string; run_id: string; chat_id: string; now: string }

export function memoryPlanOf(target: "lesson" | "fact", draft: Record<string, unknown>): MemoryPlan {
  return target === "lesson" ? { lesson: draft as unknown as NonNullable<MemoryPlan["lesson"]> } : { fact: draft as unknown as NonNullable<MemoryPlan["fact"]> };
}

export function appliedLine(store: RunStore, target: "lesson" | "fact", result: AppliedResult, draft: Record<string, unknown>): string {
  const text = clip(redactForImprove(store, str(draft.text)), APPLIED_EXCERPT_CHARS);
  return "lesson_id" in result
    ? `📒 Lesson #${result.lesson_id} learned from your correction (${str(draft.scope) || "ask"}): ${text} — undo: /forget ${result.lesson_id}`
    : `🧠 Fact #${(result as { fact_id: number }).fact_id} learned from your correction: ${text} — undo: /forget_memory ${(result as { fact_id: number }).fact_id}`;
}

/**
 * Inside the group's transaction (never through acceptProposal, whose inTransaction would nest): the memory lane's writers,
 * then `accepted` with the ids, then the /changes row keyed by proposal. A capped lesson or a save with no change id applies
 * nothing and returns null (the caller queues the card); a lost transition or a refused log row throws, rolling the group back.
 */
export function applyProposal(store: RunStore, i: ApplyInput): AppliedResult | null {
  const draft = parsed(i.draft_json);
  const saved = saveMemoryPlan(store, memoryPlanOf(i.target, draft), { run_id: i.run_id, chat_id: i.chat_id, source: "improve", now: i.now });
  const result: AppliedResult | null = saved.lesson && !("capped" in saved.lesson) ? { change_id: saved.lesson.change_id, lesson_id: saved.lesson.id }
    : saved.fact ? { change_id: saved.fact.change_id, fact_id: saved.fact.id } : null;
  if (!result) return null;
  if (!store.transitionProposal({ proposal_id: i.proposal_id, from: ["open"], to: "accepted", now: i.now, result_json: JSON.stringify(result) })) throw new Error("apply_lost");
  const r = store.enqueueNotification({ topic: "improve_log", idempotency_key: `improve_applied:${i.proposal_id}`, correlation_id: `improve_proposal:${i.proposal_id}`, text: appliedLine(store, i.target, result, draft), now: i.now });
  if (r.status !== "logged") throw new Error(`apply_log_${r.status}`);
  return result;
}
```

- [ ] **Green — `noPrior`.** In `src/improve/proposals.ts` add to `DraftDeps` (line 20): `/** Spec 2026-11-07 §3.2: the auto-apply draft sends no prior — Houge's reply, and any tool text through it, never reaches the seat. */ noPrior?: boolean` and change line 64 to `const prior = d.noPrior ? "" : priorOf(d.store, g.newest.about_run_id, d.redact);`. In `tests/improve/proposals.test.ts` add after the first `draftFor` test:

```ts
  it("noPrior (spec 2026-11-07 §3.2): the auto-apply draft sends an empty prior even for a clean turn, so the reply never reaches the seat", async () => {
    const s = RunStore.openInMemory();
    const about = createQueuedTurnRun(s, "q");
    s.recordChatTurn({ chat_id: "555", run_id: about, role: "assistant", text: "Lima is the capital and a long story", created_at: NOW });
    s.appendRunLedgerEvent(about, "turn_trust_final", "core", { max_level: "clean" });
    const correcting = createTelegramTurn(s, "please always answer in one line").run_id;
    const calls: string[] = [];
    const d = await draftFor("lesson", group(row({ run_id: correcting, about_run_id: about })), state(), { ...deps(s, '{"kind":"rule","lesson":"Answer in one line."}', calls), noPrior: true });
    expect(d).toMatchObject({ target: "lesson" });
    expect(calls[0]).not.toContain("Lima is the capital");
  });
```

- [ ] **Green — tap replies with buttons (P9).** `src/gateway/memory-commands.ts:33-39`:

```ts
export function replyTo(store: RunStore, event: TypedTaskEvent, suffix: string, text: string, buttons?: NotificationButton[]): void {
  store.enqueueNotification({
    topic: "reply",
    target: event.notify, intent_type: "progress", idempotency_key: `${event.idempotency_key}:${suffix}`,
    correlation_id: event.source_reference, payload: { text, ...(buttons && buttons.length > 0 ? { buttons } : {}) }
  });
}
```

(import `type NotificationButton` from `../notifications/notification-types.js`). In `src/gateway/improvement-commands.ts`: import `memlaneUndoButton` (`../core/memory-lane-card.js`), `memoryUndoButton` (`../capabilities/memory-correct.js`), `button` (`../improve/proposal-card.js`), `DIGEST_LM_PREFIX, DIGEST_PR_PREFIX` (`../decisions/digest.js`), `type NotificationButton`; add after line 30:

```ts
/** Spec 2026-11-07 §2: the tap's own reply carries the Undo / Revert / Revoke button (the digest line that carried it is gone). */
export type TapReply = string | { text: string; buttons: NotificationButton[] };
const textOf = (r: TapReply): string => (typeof r === "string" ? r : r.text);
```

In `handleImprovementTap` rename the local to `reply: TapReply`, compute `const text = textOf(reply);` before the `result` line, and call `replyTo(store, event, "improvement_tap", text, typeof reply === "string" ? undefined : reply.buttons);`. Change the return types of `proposalTap`, `acceptProposal`, `acceptMemory`, `applySchedule`, `acceptLadder` to `TapReply`, and the three success returns to:

```ts
  return saved.lesson ? { text: `📒 Lesson #${(saved.lesson as { id: number }).id} saved.`, buttons: [memlaneUndoButton(result.change_id)] } : { text: `🧠 Fact #${saved.fact!.id} saved.`, buttons: [memoryUndoButton(result.change_id)] };
```
```ts
  return { text: `⏰ Moved to ${String(d.hour_to).padStart(2, "0")}:00.`, buttons: [button("↩️ Revert", `${DIGEST_PR_PREFIX}${p.proposal_id}:rev`)] };
```
```ts
    return { text: `🪜 Recorded: ${move} on ${entry_id}. Nothing changes until a human edit.`, buttons: [button("⏪ Revoke", `${DIGEST_LM_PREFIX}${move_id}:revoke`)] };
```

In `tests/gateway/improvement-commands.test.ts` extend the first proposal-tap test: after `expect(reply(s)[0]).toMatch(/lesson #\d+ saved/i);` the reply payload carries the Undo button — replace `const reply = (s: RunStore) => […].map((p) => String(p.text));` with a `payloads = (s) => [...drainOutbox(s).values()]` helper used there: `const first = payloads(s)[0]!; expect(String(first.text)).toMatch(/lesson #\d+ saved/i); expect(first.buttons).toEqual([{ text: "↩️ Undo", data: expect.stringMatching(/^mem:undo:lc_|^ml:undo:lc_/) }]);` — read `memlaneUndoButton`'s prefix (`MEMLANE_UNDO_PREFIX` in `src/core/memory-lane-card.ts`) and pin the exact prefix instead of the alternation. Add the same shape check for the schedule Accept (`[{ text: "↩️ Revert", data: \`dec:pr:${id}:rev\` }]`) and ladder Accept (`[{ text: "⏪ Revoke", data: expect.stringMatching(/^dec:lm:lm_/) }]`) in their existing tests.

- [ ] Run `npm run typecheck && npx vitest run tests/improve tests/gateway/improvement-commands.test.ts tests/notifications tests/gateway/memory-commands.test.ts tests/gateway/memlane-commands.test.ts` — green.
- [ ] Commit:

```
git add src/improve/apply.ts src/improve/proposal-card.ts src/improve/proposals.ts src/notifications/topics.ts src/gateway/memory-commands.ts src/gateway/improvement-commands.ts tests/improve/apply.test.ts tests/improve/proposals.test.ts tests/notifications/topics.test.ts tests/gateway/improvement-commands.test.ts
git commit -m "feat(improve): applyProposal, proposal cards, empty-prior drafts, tap replies carry their undo button

Spec 2026-11-07 §2, §3.2, §5: the save through saveMemoryPlan with the
improve_log /changes row; improve_card cards keyed by proposal; noPrior.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4b: the tick commits the apply — `commitGroup`, `placeProposal`, counts after commit, the negative cases

**Files:** `src/improve/tick.ts` (imports 1–19, `TickCounts`/`zero` 55–57, `runGroup` 182–194, `commitGroup` 201–234), `tests/improve/tick.test.ts`.

**Interfaces.** Produces: `TickCounts` gains `applied: number; cards: number`; `runGroup` passes `{ draft, duplicate, auto }`; `commitGroup(d, g, s, r, pre: { draft; duplicate; auto }, flush, c): GroupOutcome` (bumps `c` after the commit); `placeProposal(d, g, s, draft, decision_id, auto, bumps): void`. Consumes: `autoApplies` (Task 3), `applyProposal`, `queueProposalCard` (Task 4a), `DraftDeps.noPrior`.

- [ ] **Red.** Append to `tests/improve/tick.test.ts` (imports: `type ImproveOrigin` from run-store, `type DatabaseSync` from `node:sqlite`):

```ts
/** Spec 2026-11-07 §3: a correction row stamped with its producer; memlane_fix is a new run of Paco's, escalation the corrected run itself, rating no run. */
function corrected(store: RunStore, origin: ImproveOrigin, o: { text?: string; reply?: string; chat?: string | null } = {}): { about: string; correcting: string | null } {
  const about = turn(store, "what is the capital of peru").run_id;
  store.insertJevVerdict({ run_id: about, category: "answer", breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "answer", role: "default", effort: null, cascade: null,
    save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null, quoted_turn_id: null });
  if (o.reply) { store.recordChatTurn({ chat_id: "555", run_id: about, role: "assistant", text: o.reply, created_at: "2026-10-21T01:30:00.000Z" }); store.appendRunLedgerEvent(about, "turn_trust_final", "core", { max_level: "clean" }); }
  const correcting = origin === "rating" ? null : origin === "escalation" ? about : turn(store, o.text ?? "please always answer in one line").run_id;
  store.insertImproveSignal({ signal: "correction", value: "answer", run_id: correcting, chat_id: o.chat === undefined ? "555" : o.chat, about_run_id: about, origin, created_at: "2026-10-21T02:00:00.000Z" });
  return { about, correcting };
}
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const logRow = (s: RunStore, key: string) => db(s).prepare("SELECT topic, text FROM change_log WHERE idempotency_key = ?").get(key) as { topic: string; text: string } | undefined;
const routeRows = (s: RunStore) => s.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").filter((x) => x.entry_id === "improve.route");
const distillSpy = () => vi.fn(async (i: { question: string }) => ({ ok: true as const, answer: '{"kind":"rule","lesson":"Answer in one line."}' }));

// Spec 2026-11-07 §3, §5, §12: only a correction Paco typed on the memory lane applies, with no prior at the seat, inside the
// group's commit, with one /changes row and no chat row; every other correction is a card; a failure never half-applies.
describe("runImproveTick — auto-apply (spec 2026-11-07)", () => {
  it("a memlane_fix correction applies: lesson saved (source improve, the about run), proposal accepted with the ids, one improve_applied row, no chat row, consumed; the distill saw no prior", async () => {
    const s = RunStore.openInMemory();
    const { about } = corrected(s, "memlane_fix", { reply: "Lima is the capital, founded in 1535." });
    const distill = distillSpy();
    const r = await runImproveTick(deps(s, { llm: { ...deps(s).llm, distill } }));
    expect(r).toMatchObject({ ran: true, result: "done", counts: { decided: 1, proposals: 1, applied: 1, cards: 0 } });
    const [p] = s.listProposalsResolvedSince("2026-01-01T00:00:00.000Z");
    expect(p).toMatchObject({ state: "accepted", target: "lesson", scope: "answer" });
    const result = JSON.parse(p!.result_json!) as { change_id: string; lesson_id: number };
    expect(s.getLesson(result.lesson_id)).toMatchObject({ source: "improve", status: "active", text: "Answer in one line." });
    expect(s.getLessonChange(result.change_id)).toMatchObject({ run_id: about, chat_id: "555" });
    expect(logRow(s, `improve_applied:${p!.proposal_id}`)).toEqual({ topic: "improve_log", text: `📒 Lesson #${result.lesson_id} learned from your correction (ask): Answer in one line. — undo: /forget ${result.lesson_id}` });
    expect(s.countNotificationsByIdempotencyKey(`improve_proposal:${p!.proposal_id}`)).toBe(0);
    expect(s.listUnconsumedSignals(10)).toEqual([]);
    expect(distill).toHaveBeenCalledTimes(1);
    expect(distill.mock.calls[0]![0].question).not.toContain("founded in 1535"); // §3.2: the prior is empty on the auto-apply path
  });
  it("a dig_deeper correction is a card, and its distill still sees the clean prior (the positive control for the empty-prior assertion above)", async () => {
    const s = RunStore.openInMemory();
    corrected(s, "dig_deeper", { reply: "Lima is the capital, founded in 1535." });
    const distill = distillSpy();
    expect(await runImproveTick(deps(s, { llm: { ...deps(s).llm, distill } }))).toMatchObject({ ran: true, counts: { proposals: 1, applied: 0, cards: 1 } });
    expect(distill.mock.calls[0]![0].question).toContain("founded in 1535");
    const [p] = s.listOpenProposals();
    expect(p!.offered_at).toBe(NOW);
    expect(s.countNotificationsByIdempotencyKey(`improve_proposal:${p!.proposal_id}`)).toBe(1);
    expect(logRow(s, `improve_applied:${p!.proposal_id}`)).toBeUndefined();
  });
  it("an escalation correction (run = about) and a rating correction (no run) become cards with Accept/Dismiss, never applied", async () => {
    for (const origin of ["escalation", "rating"] as const) {
      const s = RunStore.openInMemory();
      corrected(s, origin);
      expect([origin, await runImproveTick(deps(s))]).toMatchObject([origin, { ran: true, counts: { proposals: 1, applied: 0, cards: 1 } }]);
      const [p] = s.listOpenProposals();
      const note = s.claimNextNotification("t", 30)!;
      expect([origin, note.topic, note.idempotency_key]).toEqual([origin, "improve_card", `improve_proposal:${p!.proposal_id}`]);
      expect((note.payload.buttons as Array<{ data: string }>).map((b) => b.data)).toEqual([`dec:pr:${p!.proposal_id}:acc`, `dec:pr:${p!.proposal_id}:dis`]);
      expect(s.listLessons("ask")).toHaveLength(0);
    }
  });
  it("a 'lesson did not hold' rewrite (an accepted lesson on the scope 20 days ago) is a card, not an apply", async () => {
    const s = RunStore.openInMemory();
    const old = s.insertImprovementProposal({ decision_id: s.insertDecision(D({ entry_id: "improve.route", stage: "after_turn", verdict: "lesson" })), target: "lesson", scope: "answer", chat_id: "555", draft_json: "{}", evidence: "e", created_at: "2026-10-01T00:00:00.000Z" });
    s.transitionProposal({ proposal_id: old, from: ["open"], to: "accepted", now: "2026-10-01T00:00:00.000Z", result_json: "{}" });
    corrected(s, "memlane_fix");
    expect(await runImproveTick(deps(s))).toMatchObject({ ran: true, counts: { proposals: 1, applied: 0, cards: 1, already_proposed: 0 } });
    const fresh = s.listOpenProposals();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.evidence).toMatch(/^lesson did not hold/);
  });
  it("a capped lesson is a card and the proposal stays open (nothing half-saved)", async () => {
    const s = RunStore.openInMemory();
    corrected(s, "memlane_fix");
    vi.spyOn(s, "saveReconciledLesson").mockReturnValue({ verb: "capped" } as never);
    expect(await runImproveTick(deps(s))).toMatchObject({ ran: true, counts: { proposals: 1, applied: 0, cards: 1 } });
    expect(s.listOpenProposals()).toHaveLength(1);
    expect(s.countNotificationsByIdempotencyKey(`improve_proposal:${s.listOpenProposals()[0]!.proposal_id}`)).toBe(1);
  });
  it("no chat (row and tick both chat-less): the proposal stays open, no save, no card, no row — logged", async () => {
    const s = RunStore.openInMemory();
    corrected(s, "memlane_fix", { chat: null });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runImproveTick(deps(s, { chatId: null }))).toMatchObject({ ran: true, counts: { proposals: 1, applied: 0, cards: 0 } });
      expect(log.mock.calls.some(([m]) => String(m).includes("has no chat: it stays open"))).toBe(true);
    } finally { log.mockRestore(); }
    expect(s.listOpenProposals()).toHaveLength(1);
    expect(s.listLessons("ask")).toHaveLength(0);
    expect(db(s).prepare("SELECT COUNT(*) AS n FROM notification_outbox").get()).toEqual({ n: 0 });
  });
  it("a throw inside the save rolls the group back: no decision row, rows unconsumed, no lesson, no change row, counts unchanged but record_failed", async () => {
    const s = RunStore.openInMemory();
    corrected(s, "memlane_fix");
    vi.spyOn(s, "saveReconciledLesson").mockImplementation(() => { throw new Error("boom"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try { expect(await runImproveTick(deps(s))).toMatchObject({ ran: true, result: "done", counts: { decided: 0, proposals: 0, applied: 0, cards: 0, record_failed: 1 } }); } finally { err.mockRestore(); }
    expect(routeRows(s)).toHaveLength(0);
    expect(s.listUnconsumedSignals(10)).toHaveLength(1);
    expect(s.listOpenProposals()).toHaveLength(0);
    expect(db(s).prepare("SELECT COUNT(*) AS n FROM change_log").get()).toEqual({ n: 0 });
  });
  it("a second memlane_fix correction on the scope within 14 days is already_proposed (the applied one blocks), with no distill call", async () => {
    const s = RunStore.openInMemory();
    corrected(s, "memlane_fix");
    expect(await runImproveTick(deps(s))).toMatchObject({ ran: true, counts: { applied: 1 } });
    corrected(s, "memlane_fix", { text: "and once more: one line only" });
    const distill = distillSpy();
    const next = await runImproveTick(deps(s, { now: "2026-10-22T11:00:00.000Z", embed: async () => null, llm: { ...deps(s).llm, distill } }));
    expect(next).toMatchObject({ ran: true, counts: { already_proposed: 1, applied: 0, proposals: 0 } });
    expect(distill).not.toHaveBeenCalled();
    expect(routeRows(s).at(-1)).toMatchObject({ verdict: "nothing", reason_code: "already_proposed" });
  });
});
```

Run `npx vitest run tests/improve/tick.test.ts` — expected: `applied`/`cards` missing from counts, the memlane_fix case stays `open`, no change_log row.

- [ ] **Green.** In `src/improve/tick.ts`:

Imports: replace `import type { ImproveState, ImproveTarget } from "../decisions/entries/improve-route.js";` with `import { autoApplies, type ImproveState, type ImproveTarget } from "../decisions/entries/improve-route.js";`; add `import { applyProposal } from "./apply.js";` and `import { queueProposalCard } from "./proposal-card.js";`.

`TickCounts` (55) gains `applied: number; cards: number` after `proposals`; `zero()` (57) gains `applied: 0, cards: 0`.

`runGroup` (188–193): after `const wantsDraft = …` add `const auto = autoApplies(g, s, r.verdict); // spec 2026-11-07 §3: decided before the draft, so the draft can run without a prior`; pass `noPrior: auto` into the `draftFor` deps object; call `commitGroup(d, g, s, r, { draft, duplicate, auto }, rec2.flush, c)`.

Replace `commitGroup` (201–234) with:

```ts
/**
 * §3.1's commit boundary: the decision row (through the real recorder, patched when the proposal is not written — ruling 6),
 * one outcome row per inbox row (the stored text back through its check: outcomeValueOf), the proposal (applied, or its
 * card: placeProposal) or the queued job, and consumed_at — one transaction. A recorder that returns null (its write failed)
 * consumes nothing: the rows are read again tomorrow. Counts are bumped AFTER the commit (spec 2026-11-07 §5, codex): a
 * rolled-back group bumps nothing.
 */
function commitGroup(d: ImproveTickDeps, g: SignalGroup, s: ImproveState, r: DecideResult<ImproveTarget, unknown>, pre: { draft: Draft | null; duplicate: boolean; auto: boolean },
  flush: (real: ReturnType<typeof storeRecorder>, patch?: RecordPatch) => string | null, c: TickCounts): GroupOutcome {
  // final fix C5: the backstop of the pre-check — a rule-rung job while skills are disarmed writes nothing and consumes nothing
  if (r.rung === "rule" && r.verdict === "skill" && !resolveSkillsEnabled(d.env)) return "deferred";
  const bumps = zero();
  const outcome = d.store.inTransaction((): GroupOutcome => {
    const job = r.rung === "rule" && r.verdict === "skill" && s.recurrence !== null && d.jobs !== undefined;
    const wantsProposal = !job && NEEDS_DRAFT.has(r.verdict);
    const draft = pre.draft;
    const duplicate = wantsProposal && (pre.duplicate || (draft !== null && d.store.proposalBlocks(draft.target, s.scope, ttlSince(d.now))));
    const patch: RecordPatch | undefined = duplicate ? { verdict: "nothing", reason: "already_proposed" } : wantsProposal && draft === null ? { verdict: "nothing", reason: "no_text" } : undefined;
    const decision_id = flush(storeRecorder(d.store, { env: d.env, now: () => d.now }), patch);
    if (!decision_id) return "record_failed";
    for (const row of g.rows) {
      try { d.store.insertDecisionOutcome({ decision_id, signal: row.signal, value: outcomeValueOf(row.signal, row.value), source: "code", created_at: d.now }); }
      catch (e) { if (!(e instanceof OutcomeRejected)) throw e; console.error(`[improve] outcome row refused: ${row.signal}`); }
    }
    let queued = false;
    if (job) {
      const origin = { turn_ids: s.recurrence!.turnIds, run_ids: g.rows.map((x) => x.about_run_id).filter((x): x is string => x !== null), category: s.category ?? "other", text_hashes: textHashes(g) };
      queued = d.jobs!.enqueueFromRecurrence(d.store, { decision_id, proposal_id: null, chat_id: g.newest.chat_id ?? d.chatId, origin, idempotency_key: s.recurrence!.idempotencyKey, now: d.now }) !== null;
      if (queued) bumps.jobs_queued += 1;
    } else if (patch?.reason === "already_proposed") bumps.already_proposed += 1;
    else if (patch?.reason === "no_text") bumps.no_draft += 1;
    else if (draft) placeProposal(d, g, s, draft, decision_id, pre.auto, bumps);
    d.store.consumeSignals(g.rows.map((x) => x.signal_id), d.now);
    return queued ? "queued" : "committed";
  });
  for (const k of Object.keys(bumps) as Array<keyof TickCounts>) c[k] += bumps[k];
  return outcome;
}

/**
 * Spec 2026-11-07 §5: the proposal row (`open`), then — from a correcting turn Paco typed (autoApplies), with a chat — the
 * memory lane's save, `accepted` and its /changes line; every other proposal, and one the save could not apply (a capped
 * lesson, no change id), is one card offered now. No chat: it stays open until it expires (logged; no card could be
 * delivered and §3.5 forbids the save).
 */
function placeProposal(d: ImproveTickDeps, g: SignalGroup, s: ImproveState, draft: Draft, decision_id: string, auto: boolean, bumps: TickCounts): void {
  const chat_id = g.newest.chat_id ?? d.chatId;
  const proposal_id = d.store.insertImprovementProposal({ decision_id, target: draft.target, scope: s.scope, chat_id, draft_json: draft.draft_json, evidence: draft.evidence, created_at: d.now });
  bumps.proposals += 1;
  if (chat_id === null) { console.log(`[improve] proposal ${proposal_id} (${draft.target}) has no chat: it stays open`); return; }
  const about = g.newest.about_run_id;
  if (auto && about !== null && (draft.target === "lesson" || draft.target === "fact")
    && applyProposal(d.store, { proposal_id, target: draft.target, draft_json: draft.draft_json, run_id: about, chat_id, now: d.now }) !== null) { bumps.applied += 1; return; }
  queueProposalCard(d.store, { proposal_id, target: draft.target, draft_json: draft.draft_json, evidence: draft.evidence }, chat_id, d.now);
  bumps.cards += 1;
}
```

Update the file header comment (21–25): "…then commit one transaction per group — a lesson or fact from a correction Paco typed applies inside it with a /changes row, the rest become cards (spec 2026-11-07 §5)…".

- [ ] Run `npm run typecheck && npx vitest run tests/improve` — green, none skipped. The pre-existing throw/record_failed tests keep passing (`counts.proposals` 1 for the group that committed).
- [ ] Commit:

```
git add src/improve/tick.ts tests/improve/tick.test.ts
git commit -m "feat(improve): the tick applies lessons and facts from Paco's own corrections, cards the rest

Spec 2026-11-07 §5: one transaction per group — save, accepted, improve_applied
row — or an improve_card card; counts bumped after the commit; no chat stays open.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: `/forget <id>`, `/forget <scope>`, `/forget_memory <id>` revert the applied proposal

**Files:** `src/gateway/improve-undo.ts`, `src/run/run-store.ts:1929-1932` (`forgetScope`), `:4802` (`MEMORY_REFUSED`), `src/gateway/gateway.ts:609-616` (`handleForget`), `src/gateway/memory-commands.ts:105-120` (`handleForgetMemory`), new `tests/gateway/improve-undo.test.ts`, `tests/gateway/gateway-telegram.test.ts:211-245` (unchanged behaviour; re-run).

**Interfaces.** Produces: `revertSavedProposal(store, kind: "lesson" | "fact", id: number, now: string): boolean`; `forgetScope(scope): number[]`; `static readonly MEMORY_REFUSED` (public); `handleForgetMemory(store, event, now = new Date().toISOString())`. Consumes: `proposalBySaved` (Task 2), `forgetLesson`, `retireMemoryRowsTx`, `transitionProposal`, `inTransaction`.

- [ ] **Red.** Create `tests/gateway/improve-undo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyProposal } from "../../src/improve/apply.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { createTelegramTurn } from "../helpers/runs.js";

// Spec 2026-11-07 §6: the undo commands Paco already has are the undo of an auto-applied proposal. Each moves it
// accepted → reverted in the removal's own transaction, so the next tick sees the block (§3.4) and never re-learns it.
const NOW = "2026-10-21T10:00:00.000Z";
const SINCE = "2026-10-07T10:00:00.000Z";
const D: DecisionInsert = { entry_id: "improve.route", entry_version: 1, run_id: null, tool_call_id: null, stage: "after_turn", rung: "system_one", verdict: "lesson", p: 0.7, reason_code: "jev_choice",
  fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: NOW };
let seq = 0;
const cmd = (type: "forget" | "forget_memory", program: string) => buildTypedTaskEvent({ source: "telegram", type, program, requested_by: { kind: "user", id: "paco" },
  notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `telegram:undo-${++seq}`, source_reference: `telegram:update:${seq}:message:1` });
function applied(s: RunStore, target: "lesson" | "fact", draft: unknown, scope = "answer") {
  const run_id = createTelegramTurn(s, "x").run_id;
  const proposal_id = s.insertImprovementProposal({ decision_id: s.insertDecision({ ...D, run_id }), target, scope, chat_id: "555", draft_json: JSON.stringify(draft), evidence: "e", created_at: NOW });
  const r = s.inTransaction(() => applyProposal(s, { proposal_id, target, draft_json: JSON.stringify(draft), run_id, chat_id: "555", now: NOW }))!;
  return { proposal_id, id: "lesson_id" in r ? r.lesson_id : r.fact_id };
}

describe("undo of an applied proposal", () => {
  it("/forget <id> prunes the lesson and reverts its proposal; the pair is blocked for 14 days", () => {
    const s = RunStore.openInMemory();
    const { proposal_id, id } = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });
    expect(new Gateway(s).intake(cmd("forget", String(id)))).toMatchObject({ ok: true, status: "forgotten" });
    expect(s.getLesson(id)?.status).toBe("pruned");
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("reverted");
    expect(s.proposalBlocks("lesson", "answer", SINCE)).toBe(true);
  });
  it("/forget <scope> reverts the proposal of every lesson it prunes and leaves a lesson with no proposal alone", () => {
    const s = RunStore.openInMemory();
    const a = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });
    const b = applied(s, "lesson", { scope: "ask", text: "Name the source." }, "lookup");
    const plain = s.addLesson({ scope: "ask", text: "prefer primary sources", source: "user_feedback", created_at: NOW });
    expect(new Gateway(s).intake(cmd("forget", "ask"))).toMatchObject({ ok: true, status: "forgotten" });
    expect([a.proposal_id, b.proposal_id].map((p) => s.getImprovementProposal(p)?.state)).toEqual(["reverted", "reverted"]);
    expect([a.id, b.id, plain].map((id) => s.getLesson(id)?.status)).toEqual(["pruned", "pruned", "pruned"]);
  });
  it("/forget_memory <id> retires the fact and reverts its proposal in one transaction; a refused id reverts nothing", () => {
    const s = RunStore.openInMemory();
    const { proposal_id, id } = applied(s, "fact", { text: "Paco's sister lives in Lima.", evidence: { line: 1, quote: "sister lives in lima" }, source_turn_ids: [] });
    expect(new Gateway(s).intake(cmd("forget_memory", String(id)))).toMatchObject({ ok: true, status: "memory_forgotten" });
    expect(s.getEpisodicFact(id)?.status).toBe("pruned");
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("reverted");
    expect(s.proposalBlocks("fact", "answer", SINCE)).toBe(true);
    const s2 = RunStore.openInMemory();
    const other = applied(s2, "fact", { text: "Paco's sister lives in Lima.", evidence: { line: 1, quote: "sister lives in lima" }, source_turn_ids: [] });
    expect(new Gateway(s2).intake(cmd("forget_memory", String(other.id + 100))).ok).toBe(false);
    expect(s2.getImprovementProposal(other.proposal_id)?.state).toBe("accepted");
  });
  it("a lesson that was not an applied proposal: /forget works as before and no proposal changes", () => {
    const s = RunStore.openInMemory();
    const { proposal_id } = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });
    const plain = s.addLesson({ scope: "research", text: "prefer primary sources", source: "user_feedback", created_at: NOW });
    expect(new Gateway(s).intake(cmd("forget", String(plain)))).toMatchObject({ ok: true, status: "forgotten" });
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("accepted");
  });
});
```

Run `npx vitest run tests/gateway/improve-undo.test.ts` — expected: the proposal stays `accepted` in every case.

- [ ] **Green.** `src/gateway/improve-undo.ts` — append:

```ts
/** Spec 2026-11-07 §6: /forget <id>, /forget <scope> and /forget_memory <id> undo an applied proposal — found by the saved id, moved accepted → reverted in the caller's transaction (it then blocks its (target, scope) for 14 days). */
export function revertSavedProposal(store: RunStore, kind: "lesson" | "fact", id: number, now: string): boolean {
  const p = store.proposalBySaved(kind, id);
  return p !== undefined && store.transitionProposal({ proposal_id: p.proposal_id, from: ["accepted"], to: "reverted", now });
}
```

`src/run/run-store.ts:1929-1932` → 

```ts
  /** Prune a scope's active lessons (the `/forget <scope>` control command) — reversible; returns the pruned ids (spec 2026-11-07 §6: each reverts its proposal). */
  forgetScope(scope: string): number[] {
    const ids = this.db.prepare(`SELECT id FROM lessons WHERE scope = ? AND status = 'active' ORDER BY id ASC`).all<{ id: number }>(scope).map((r) => r.id);
    if (ids.length > 0) this.db.prepare(`UPDATE lessons SET status = 'pruned' WHERE id IN (${ids.map(() => "?").join(", ")}) AND status = 'active'`).run(...ids);
    return ids;
  }
```

`run-store.ts:4802`: `private static readonly MEMORY_REFUSED` → `/** Thrown by the *Tx memory writers on a refused row; a caller that wraps one in its own transaction maps it to null (memory-commands.ts). */ static readonly MEMORY_REFUSED`.

`src/gateway/gateway.ts:609-616` (import `revertSavedProposal` from `./improve-undo.js`):

```ts
    let text: string;
    if (/^\d+$/.test(arg)) {
      const id = Number(arg);
      // spec 2026-11-07 §6: the prune and its proposal's revert commit together
      const pruned = this.runStore.inTransaction(() => { const ok = this.runStore.forgetLesson(id); if (ok) revertSavedProposal(this.runStore, "lesson", id, now); return ok; });
      text = pruned ? `Forgotten ✓ — pruned lesson #${arg}` : `No active lesson #${arg} to forget.`;
    } else {
      this.runStore.inTransaction(() => { for (const id of this.runStore.forgetScope(arg)) revertSavedProposal(this.runStore, "lesson", id, now); });
      text = `Forgotten ✓ — cleared lessons for "${arg}"`;
    }
```

`src/gateway/memory-commands.ts` (import `revertSavedProposal` is already there for `revertImproveSave`; extend the import): replace `handleForgetMemory`'s signature with `export function handleForgetMemory(store: RunStore, event: TypedTaskEvent, now: string = new Date().toISOString()): GatewayIntakeResult` and its `const change = …` with `const change = Number.isSafeInteger(id) && id > 0 ? forgetFact(store, id, chatOf(event), now) : null;`, then add:

```ts
/** The retire and the applied proposal's revert in one transaction (spec 2026-11-07 §6); a refused id (inactive, another chat) is null and writes nothing. */
function forgetFact(store: RunStore, id: number, chat_id: string, now: string): MemoryChange | null {
  try {
    return store.inTransaction(() => { const c = store.retireMemoryRowsTx({ kind: "fact", ids: [id], chat_id, run_id: null, now }); revertSavedProposal(store, "fact", id, now); return c; });
  } catch (e) {
    if (e === RunStore.MEMORY_REFUSED) return null;
    throw e;
  }
}
```

(`RunStore` becomes a value import in memory-commands.ts.)

- [ ] Run `npm run typecheck && npx vitest run tests/gateway tests/run/lesson-blocks.test.ts` — green (`gateway-telegram.test.ts` `/forget <scope>` still passes: same prune, same reply).
- [ ] Commit:

```
git add src/gateway/improve-undo.ts src/run/run-store.ts src/gateway/gateway.ts src/gateway/memory-commands.ts tests/gateway/improve-undo.test.ts
git commit -m "feat(gateway): /forget and /forget_memory revert the applied proposal in the same transaction

Spec 2026-11-07 §6: proposalBySaved per removed id; forgetScope returns the
pruned ids; /forget_memory wraps retireMemoryRowsTx with the revert.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: a `/changes` row at every standing-grant end (`endStandingTx`)

**Files:** `src/run/run-store.ts` (after `StandingEndReason` ~1072; `endStandingTx` 5735–5745; imports 1–63), `src/notifications/topics.ts`, `src/decisions/digest.ts:271-278`, `tests/notifications/topics.test.ts`, new `tests/run/standing-end-log.test.ts`.

**Interfaces.** Produces: `export const STANDING_DIGEST_TEXT` in run-store (same five reasons and texts as today's digest.ts:272-278; digest.ts re-exports it); `private logStandingEnd(row: StandingApprovalRow, reason: StandingEndReason, now: string): void`; topic `standing_log: "log"`. Consumes: `logChange`, `scheduleDisplayName` (`./schedule-spec.js`, which imports only a type from run-store: no cycle), `getScheduledTask`.

- [ ] **Red.** Create `tests/run/standing-end-log.test.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RunStore, STANDING_DIGEST_TEXT } from "../../src/run/run-store.js";

// Spec 2026-11-07 §8: the digest's standing line becomes a change-log row written in the one central end transition, so
// every path (settle, sweep, schedule cancel, mismatch, denial) writes it exactly once, and Paco's own acts write none.
const NOW = "2026-10-21T10:00:00.000Z";
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const rows = (s: RunStore, standing_id: string) => db(s).prepare("SELECT topic, text FROM change_log WHERE idempotency_key = ?").all(`standing_end:${standing_id}`) as Array<{ topic: string; text: string }>;
function standing(s: RunStore, fp = "fp_1") {
  const sched = s.addScheduledTask({ chat_id: "555", goal: "check the mailbox and summarise it", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z" });
  return s.insertStandingApprovalForTest({ schedule_id: sched.schedule_id, chat_id: "555", action_fingerprint: fp, state: "standing", label: "HTTP write", created_at: NOW });
}

describe("endStandingTx writes the /changes row", () => {
  it.each(Object.keys(STANDING_DIGEST_TEXT) as Array<keyof typeof STANDING_DIGEST_TEXT>)("%s: one standing_log row with the label, the schedule name and the reason text; a second end writes none", (reason) => {
    const s = RunStore.openInMemory();
    const row = standing(s);
    expect(s.endStandingApproval({ standing_id: row.standing_id, reason, now: NOW })).toBe(true);
    expect(rows(s, row.standing_id)).toEqual([{ topic: "standing_log", text: `🔏 HTTP write · check the mailbox and summarise it — ${STANDING_DIGEST_TEXT[reason]}` }]);
    expect(s.endStandingApproval({ standing_id: row.standing_id, reason, now: NOW })).toBe(false);
    expect(rows(s, row.standing_id)).toHaveLength(1);
  });
  it.each(["revoked", "schedule_ended", "tampered_use", "unverified_use"] as const)("%s (Paco's act, or already an urgent card) writes no row", (reason) => {
    const s = RunStore.openInMemory();
    const row = standing(s);
    expect(s.endStandingApproval({ standing_id: row.standing_id, reason, now: NOW })).toBe(true);
    expect(rows(s, row.standing_id)).toEqual([]);
  });
  it("the row rides the end's transaction: a cancelled schedule ends its grant (schedule_ended, no row) and nothing else is logged", () => {
    const s = RunStore.openInMemory();
    const row = standing(s);
    expect(s.cancelScheduledTask(row.schedule_id, NOW)).toBe(true);
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "schedule_ended" });
    expect(db(s).prepare("SELECT COUNT(*) AS n FROM change_log").get()).toEqual({ n: 0 });
  });
  it("a denial on the (chat, fingerprint) from a run of that chat ends the grant denied with its row (the deny hook's raw BEGIN: plain statements)", () => {
    const s = RunStore.openInMemory();
    const row = standing(s);
    const run_id = s.insertRun({ /* a telegram-notified run of chat 555 — use createTelegramTurn from ../helpers/runs.js instead if insertRun needs a full contract */ } as never);
    void run_id;
  });
});
```

For the last case use `createTelegramTurn(s, "x").run_id` (its notify target is chat `555`), then `s.createToolApproval({...})` as `tests/decisions/improve-signals.test.ts` does, and resolve it with `s.resolveApproval({ approval_id, decision: "denied", … })` — read `resolveApprovalWithinTransaction` (`run-store.ts:8243`) for the exact input and replace the placeholder body; assert `ended_reason: "denied"` and one `standing_log` row ending with `STANDING_DIGEST_TEXT.denied`.

Run `npx vitest run tests/run/standing-end-log.test.ts` — expected: `STANDING_DIGEST_TEXT` is not exported from run-store; no rows.

- [ ] **Green.** In `src/run/run-store.ts`: add `import { scheduleDisplayName } from "./schedule-spec.js";` to the imports; after `StandingEndReason` (~1072) add:

```ts
/** An end Paco did not cause by his own tap: Revoke and a cancelled schedule are his acts, and a tampered or unverified use already sent an urgent card, so none gets a line (spec 2026-11-07 §8: a /changes row at the end; formerly the digest's standing line). */
export const STANDING_DIGEST_TEXT = {
  sealed_trial_failed: "the sealed run did not seal; it keeps asking",
  denied: "denied; no standing approval for these bytes for 30 days",
  expired: "the 30 days ran out; it asks again",
  stale: "no approval in 30 days; the streak was dropped",
  mismatch: "the command changed under the grant; it asks again"
} as const;
```

In `endStandingTx`, after `this.appendStandingLedgerEvent("standing_ended", …);` add `this.logStandingEnd(row, i.reason, i.now);` and after the method add:

```ts
  /** Spec 2026-11-07 §8: one change-log row per ended grant Paco did not end himself, in the end's own transaction (plain statements: the deny hook's raw BEGIN); keyed by row, so every path writes it once. */
  private logStandingEnd(row: StandingApprovalRow, reason: StandingEndReason, now: string): void {
    if (!Object.hasOwn(STANDING_DIGEST_TEXT, reason)) return;
    const name = scheduleDisplayName(this.getScheduledTask(row.schedule_id)?.goal ?? "") || row.schedule_id;
    const r = this.logChange({ topic: "standing_log", idempotency_key: `standing_end:${row.standing_id}`, correlation_id: `standing:${row.standing_id}`,
      text: `🔏 ${row.label} · ${name} — ${STANDING_DIGEST_TEXT[reason as keyof typeof STANDING_DIGEST_TEXT]}`, now });
    if (r.status === "conflict") console.error(`[standing] end row for ${row.standing_id} not logged (${r.error})`);
  }
```

`src/notifications/topics.ts`: add `standing_log: "log"`; `tests/notifications/topics.test.ts` log list becomes `["decision_internal", "improve_log", "incident_log", "jev_notice", "model_change", "standing_log"]`.

`src/decisions/digest.ts:271-278`: delete the constant and add `import { STANDING_DIGEST_TEXT } from "../run/run-store.js"; export { STANDING_DIGEST_TEXT };` (join the existing run-store import). `standingLines` keeps working until Task 8 removes it.

- [ ] Run `npm run typecheck && npx vitest run tests/run tests/decisions/standing-approval.test.ts tests/decisions/digest.test.ts tests/notifications` — green.
- [ ] Commit:

```
git add src/run/run-store.ts src/notifications/topics.ts src/decisions/digest.ts tests/run/standing-end-log.test.ts tests/notifications/topics.test.ts
git commit -m "feat(standing): a /changes row at every grant end, written in endStandingTx

Spec 2026-11-07 §8: key standing_end:<id>, topic standing_log, text from
STANDING_DIGEST_TEXT (now in run-store); every end path writes it once.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: `improve_tick_degraded` — the faults page

**Files:** new `src/improve/degraded.ts`, `src/run/incident-route.ts:55`, `src/improve/tick.ts:89-91`, new `tests/improve/degraded.test.ts`, `tests/improve/tick.test.ts`, `tests/run/incident-route.test.ts:40-47`.

**Interfaces.** Produces: `IMPROVE_DEGRADED_KIND = "improve_tick_degraded"`, `IMPROVE_DEGRADED_SUBJECT = "improve"`, `DEGRADED_RUN = 3`, `DEGRADED_LOOKBACK_DAYS = 14`; `judgeTickDate(row: ImproveTickRow, previous: ImproveTickRow | undefined): "bad" | "healthy" | "neutral"`; `badRun(rows: readonly ImproveTickRow[]): number`; `evaluateImproveDegraded(d: { store; now; env; chatId: string | null }, date: string): "opened" | "resolved" | "none"`. Consumes: `listImproveTicksSince`, `incidentFingerprint`, `findOpenIncident`, `resolveIncident`, `openAlertedIncident` (`src/run/incident-alert.ts`), `routeOf`.

- [ ] **Red.** Create `tests/improve/degraded.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateImproveDegraded, judgeTickDate, IMPROVE_DEGRADED_KIND } from "../../src/improve/degraded.js";
import { routeOf } from "../../src/run/incident-route.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-11-07 §7: a failing tick must reach Paco now that the digest's Watch line is gone. Read from improve_ticks rows,
// one judgement per date at its end, in date order; a failed or stuck date pages at once, three no-decision degraded dates
// page once, a healthy date resolves, stopped changes nothing, and an older date never reopens what a newer one resolved.
const ENV = { HOUGE_TELEGRAM_CHAT_ID: "555" };
const at = (date: string) => `${date}T11:00:00.000Z`;
function tick(s: RunStore, date: string, result: "done" | "stopped" | "failed" | "running", detail: Record<string, number> = {}): void {
  s.beginImproveTick(date, at(date));
  if (result !== "running") s.finishImproveTick(date, result, detail, at(date));
}
const evalDate = (s: RunStore, date: string, chatId: string | null = null) => evaluateImproveDegraded({ store: s, now: at(date), env: ENV, chatId }, date);
const open = (s: RunStore) => s.listOpenIncidents().filter((i) => i.kind === IMPROVE_DEGRADED_KIND);
const pages = (s: RunStore) => open(s).map((i) => s.countNotificationsByIdempotencyKey(`incident_opened:${i.incident_id}`));

describe("judgeTickDate", () => {
  const row = (result: "done" | "stopped" | "failed" | "running", detail: Record<string, number> = {}) => ({ local_date: "2026-11-02", started_at: at("2026-11-02"), finished_at: null, result, detail });
  it("failed, a stuck previous date, or no decision with an outage count → bad; done with a decision (or no group) and the embedder up → healthy; stopped → neutral", () => {
    expect(judgeTickDate(row("failed"), undefined)).toBe("bad");
    expect(judgeTickDate(row("done", { decided: 2 }), row("running"))).toBe("bad");
    expect(judgeTickDate(row("done", { decided: 0, groups: 3, deferred_outage: 1 }), undefined)).toBe("bad");
    expect(judgeTickDate(row("done", { decided: 0, groups: 1, record_failed: 1 }), undefined)).toBe("bad");
    expect(judgeTickDate(row("done", { decided: 0, groups: 0, embed_unavailable: 1 }), undefined)).toBe("bad");
    expect(judgeTickDate(row("done", { decided: 1, groups: 2, deferred_outage: 1 }), undefined)).toBe("healthy");
    expect(judgeTickDate(row("done", { decided: 0, groups: 0 }), undefined)).toBe("healthy");
    expect(judgeTickDate(row("done", { decided: 1, embed_unavailable: 1 }), undefined)).toBe("neutral"); // recurrence groups could not form
    expect(judgeTickDate(row("done", { decided: 0, groups: 2 }), undefined)).toBe("neutral"); // deferred for budget, not an outage
    expect(judgeTickDate(row("stopped", { decided: 0, deferred_outage: 5 }), undefined)).toBe("neutral");
  });
});

describe("evaluateImproveDegraded", () => {
  it("routes page", () => { expect(routeOf(IMPROVE_DEGRADED_KIND)).toBe("page"); });
  it("opens at once on a failed date, pages the operator chat once, and does not open twice", () => {
    const s = RunStore.openInMemory();
    tick(s, "2026-11-01", "failed");
    expect(evalDate(s, "2026-11-01")).toBe("opened");
    expect(open(s)).toHaveLength(1); expect(pages(s)).toEqual([1]);
    tick(s, "2026-11-02", "failed");
    expect(evalDate(s, "2026-11-02")).toBe("none");
    expect(open(s)).toHaveLength(1);
  });
  it("opens at once when the previous date's row is still running (a throw out of finishImproveTick)", () => {
    const s = RunStore.openInMemory();
    tick(s, "2026-11-01", "running"); tick(s, "2026-11-02", "done", { decided: 1 });
    expect(evalDate(s, "2026-11-02")).toBe("opened");
  });
  it("three consecutive no-decision degraded dates open once; two do not; stopped in between neither counts nor resets", () => {
    const s = RunStore.openInMemory();
    const bad = { decided: 0, groups: 2, deferred_outage: 2 };
    tick(s, "2026-11-01", "done", bad); expect(evalDate(s, "2026-11-01")).toBe("none");
    tick(s, "2026-11-02", "done", bad); expect(evalDate(s, "2026-11-02")).toBe("none");
    tick(s, "2026-11-03", "stopped", bad); expect(evalDate(s, "2026-11-03")).toBe("none");
    expect(open(s)).toHaveLength(0);
    tick(s, "2026-11-04", "done", bad); expect(evalDate(s, "2026-11-04")).toBe("opened");
    expect(open(s)[0]!.detail_json).toContain('"run":3');
  });
  it("a date that decided something resets the run and resolves an open page; an older bad date evaluated later never reopens it", () => {
    const s = RunStore.openInMemory();
    tick(s, "2026-11-01", "failed"); expect(evalDate(s, "2026-11-01")).toBe("opened");
    tick(s, "2026-11-02", "done", { decided: 1, groups: 1 }); expect(evalDate(s, "2026-11-02")).toBe("resolved");
    expect(open(s)).toHaveLength(0);
    expect(evalDate(s, "2026-11-01")).toBe("none"); // not the newest date: not judged
    expect(open(s)).toHaveLength(0);
    const bad = { decided: 0, groups: 1, deferred_outage: 1 };
    tick(s, "2026-11-03", "done", bad); tick(s, "2026-11-04", "done", bad); expect(evalDate(s, "2026-11-04")).toBe("none"); // the run restarted at 11-03
  });
  it("a healthy date with nothing open is none; no row for the date is none", () => {
    const s = RunStore.openInMemory();
    tick(s, "2026-11-01", "done", { decided: 1 });
    expect(evalDate(s, "2026-11-01")).toBe("none");
    expect(evalDate(s, "2026-11-02")).toBe("none");
  });
});
```

And in `tests/improve/tick.test.ts` (uses `IMPROVE_DEGRADED_KIND`):

```ts
  it("a tick that fails pages improve_tick_degraded from the tick itself (spec 2026-11-07 §7: the Watch line is gone)", async () => {
    const s = RunStore.openInMemory();
    correction(s);
    vi.spyOn(s, "mirrorOutcomesIntoInbox").mockImplementation(() => { throw new Error("disk"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try { expect(await runImproveTick(deps(s, { env: { ...ENV, HOUGE_TELEGRAM_CHAT_ID: "555" } }))).toMatchObject({ ran: true, result: "failed" }); } finally { err.mockRestore(); }
    expect(s.listOpenIncidents().map((i) => i.kind)).toContain(IMPROVE_DEGRADED_KIND);
  });
```

Run `npx vitest run tests/improve/degraded.test.ts tests/improve/tick.test.ts` — expected: module not found; `routeOf` returns `page` for an unknown kind (so pin the table membership too: `isRoutedKind(IMPROVE_DEGRADED_KIND)` must be true — add that `expect` to the "routes page" case).

- [ ] **Green — `degraded.ts`.**

```ts
import { openAlertedIncident } from "../run/incident-alert.js";
import type { ImproveTickRow, RunStore } from "../run/run-store.js";

/**
 * Spec 2026-11-07 §7: the faults page that replaces the digest's Watch alarm. Read from improve_ticks rows (one per local
 * date with its final result and accumulated counts, never from the ledger: a resumed date emits several events), judged
 * once per tick date at its end, on that date's row only, in date order. Text: kinds, counts and dates only.
 */
export const IMPROVE_DEGRADED_KIND = "improve_tick_degraded";
export const IMPROVE_DEGRADED_SUBJECT = "improve";
export const DEGRADED_RUN = 3;
export const DEGRADED_LOOKBACK_DAYS = 14;
export type DateHealth = "bad" | "healthy" | "neutral";
const n = (row: ImproveTickRow, k: string): number => (typeof row.detail[k] === "number" ? (row.detail[k] as number) : 0);

/** failed, a stuck previous date, or nothing decided while an outage count was above 0 → bad; done ∧ (decided ∨ no group) ∧ embedder up → healthy; else (stopped; budget deferrals) neutral. */
export function judgeTickDate(row: ImproveTickRow, previous: ImproveTickRow | undefined): DateHealth {
  if (row.result === "failed" || previous?.result === "running") return "bad";
  if (row.result !== "done") return "neutral";
  const decided = n(row, "decided");
  if (decided === 0 && (n(row, "deferred_outage") > 0 || n(row, "record_failed") > 0 || n(row, "embed_unavailable") > 0)) return "bad";
  return (decided > 0 || n(row, "groups") === 0) && n(row, "embed_unavailable") === 0 ? "healthy" : "neutral";
}

/** The run of consecutive bad dates ending at the newest row: neutral dates are skipped, a healthy one ends the run. */
export function badRun(rows: readonly ImproveTickRow[]): number {
  let run = 0;
  for (let k = rows.length - 1; k >= 0; k -= 1) {
    const h = judgeTickDate(rows[k]!, rows[k - 1]);
    if (h === "healthy") break;
    if (h === "bad") run += 1;
  }
  return run;
}

export interface DegradedDeps { store: RunStore; now: string; env: NodeJS.ProcessEnv; chatId: string | null }

/** Opens at once on a failed or stuck date, or when the run reaches DEGRADED_RUN; resolves on a healthy date. Only the newest date is judged, so an older bad date never reopens a page a newer healthy date resolved. */
export function evaluateImproveDegraded(d: DegradedDeps, date: string): "opened" | "resolved" | "none" {
  const since = new Date(Date.parse(d.now) - DEGRADED_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = d.store.listImproveTicksSince(since);
  const row = rows.at(-1);
  if (!row || row.local_date !== date) return "none";
  const health = judgeTickDate(row, rows.at(-2));
  const fingerprint = d.store.incidentFingerprint(IMPROVE_DEGRADED_KIND, IMPROVE_DEGRADED_SUBJECT);
  if (health === "healthy") {
    const open = d.store.findOpenIncident(fingerprint);
    if (!open) return "none";
    d.store.resolveIncident(open.incident_id, d.now);
    return "resolved";
  }
  if (health === "neutral") return "none";
  const run = badRun(rows);
  if (row.result !== "failed" && rows.at(-2)?.result !== "running" && run < DEGRADED_RUN) return "none";
  const detail = { date, result: row.result, run, decided: n(row, "decided"), deferred_outage: n(row, "deferred_outage"), record_failed: n(row, "record_failed"), embed_unavailable: n(row, "embed_unavailable") };
  return openAlertedIncident(d.store, { kind: IMPROVE_DEGRADED_KIND, subject: IMPROVE_DEGRADED_SUBJECT, detail, now: d.now, env: d.env, chat_id: d.chatId }) ? "opened" : "none";
}
```

`src/run/incident-route.ts`: after the `decision_fallback_streak` row add `improve_tick_degraded: page("The nightly improvement tick keeps failing; your corrections are not being learned.", "check `/status` (the Improvement line) and the daemon log's [improve] lines"),`.

`src/improve/tick.ts` after line 90 (`recordMemoryEvent("improve_tick", { phase: "end", … })`):

```ts
  // spec 2026-11-07 §7: judged on the date's final row, after it is written; never costs the tick its result
  try { evaluateImproveDegraded({ store: d.store, now: d.now, env: d.env, chatId: d.chatId }, date); }
  catch (e) { console.error(`[improve] degraded check failed: ${errorCode(e)}`); }
```

(import `evaluateImproveDegraded` from `./degraded.js`). `tests/run/incident-route.test.ts`: `expect(keys).toHaveLength(55)` → `56`, `expect(pages).toHaveLength(32)` → `33`, and the comment above the counts names the new kind.

- [ ] Run `npm run typecheck && npx vitest run tests/improve tests/run/incident-route.test.ts tests/run/incident-alert.test.ts` — green.
- [ ] Commit:

```
git add src/improve/degraded.ts src/run/incident-route.ts src/improve/tick.ts tests/improve/degraded.test.ts tests/improve/tick.test.ts tests/run/incident-route.test.ts
git commit -m "feat(improve): improve_tick_degraded pages a failing or set-aside tick

Spec 2026-11-07 §7 (ADR 0034 13.2, to be amended): judged per date on the
improve_ticks row; failed or stuck at once, three no-decision degraded dates,
a healthy date resolves.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8a: `HOUGE_IMPROVE_AT`, `status-lines.ts`, the `/status` improvement line, the old ✅/❌ closed

**Files:** `src/improve/flag.ts`, `src/improve/tick.ts:5,21-22,59-62`, new `src/decisions/status-lines.ts`, `src/decisions/status-view.ts`, `src/gateway/decision-commands.ts`, `src/gateway/gateway.ts:249`, `src/telegram/telegram-daemon.ts:456` (`bootPlanners`), `tests/docs/parity.ts:10-21`, `tests/improve/tick.test.ts:16-20,53-62`, `tests/decisions/status-view.test.ts`, new `tests/decisions/status-lines.test.ts`, `tests/gateway/decision-commands.test.ts` (rewritten), `tests/decisions/injection-judge.test.ts:3,267`, new `tests/improve/flag.test.ts`.

**Interfaces.** Produces: `DEFAULT_IMPROVE_AT = "21:00"`, `resolveImproveAt(env): string`, `warnRetiredDigestAt(env, log = console.error): boolean`; `status-lines.ts` exports `countLines`, `decisionWindow`, `DECISION_WINDOW_MS`, `deciderLabel`, `injectionCounts`, `InjectionCounts`, `NEAR_BAR_BAND = 0.15`, `settleHealthLine`, `trustTops`, `improvementLine(store, now, env = process.env): string | null`, `IMPROVE_WINDOW_DAYS = 7`; `REVIEW_CLOSED_TEXT = "This review has closed."`; `handleDecisionReview(store, event)`. Consumes: `resolveImproveEnabled`, `listImproveSignalsSince`, `listImproveTicksSince`, `listDecisionsBetween`, `listLedgerEventsByTypeSince`, `listOpenProposals`, `listProposalsResolvedSince`.

- [ ] **Red — flag.** Create `tests/improve/flag.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_IMPROVE_AT, resolveImproveAt, warnRetiredDigestAt } from "../../src/improve/flag.js";

// Spec 2026-11-07 §10: the tick's time is its own variable with no `off` (R13: HOUGE_IMPROVE_ENABLED=false is the one switch);
// the digest's variable is retired and named once at boot, never read.
describe("resolveImproveAt", () => {
  it("HH:MM is itself; unset, a typo, and `off` are all the 21:00 default", () => {
    expect(resolveImproveAt({ HOUGE_IMPROVE_AT: "20:30" })).toBe("20:30");
    expect(resolveImproveAt({})).toBe(DEFAULT_IMPROVE_AT);
    expect(resolveImproveAt({ HOUGE_IMPROVE_AT: "off" })).toBe("21:00");
    expect(resolveImproveAt({ HOUGE_IMPROVE_AT: "25:00" })).toBe("21:00");
    expect(resolveImproveAt({ HOUGE_DECISION_DIGEST_AT: "20:00" })).toBe("21:00"); // the retired name moves nothing
  });
});
describe("warnRetiredDigestAt", () => {
  it("names a still-set HOUGE_DECISION_DIGEST_AT once and says the digest is gone; silent when unset", () => {
    const lines: string[] = [];
    expect(warnRetiredDigestAt({ HOUGE_DECISION_DIGEST_AT: "ON" }, (l) => lines.push(l))).toBe(true);
    expect(lines).toEqual(["improve: HOUGE_DECISION_DIGEST_AT is retired (ADR 0034 13.1: no digest) and ignored; the tick's time is HOUGE_IMPROVE_AT; remove it from .env"]);
    expect(warnRetiredDigestAt({}, (l) => lines.push(l))).toBe(false);
    expect(lines).toHaveLength(1);
  });
});
```

In `tests/improve/tick.test.ts`: `ENV` → `{ HOUGE_DISPLAY_TZ: "Australia/Sydney" }`; the `improveTickDue` test → `HOUGE_IMPROVE_AT: "20:00"` in place of `HOUGE_DECISION_DIGEST_AT: "20:00"`, plus `expect(improveTickDue(s, { ...ENV, HOUGE_IMPROVE_AT: "off" }, EARLY)).toBeNull();` (no off: 21:00 stands) and the `it` title "due once per local date at or after HOUGE_IMPROVE_AT (default 21:00); not before; not twice; `off` is no value". In `tests/docs/parity.ts` `ENV_NOT_CONFIGURATION` add `HOUGE_DECISION_DIGEST_AT: "retired (spec 2026-11-07 §10: the digest is gone); named once at boot by warnRetiredDigestAt, never read"`.

- [ ] **Green — flag and tick.** Rewrite `src/improve/flag.ts`:

```ts
/**
 * The improvement tick's two knobs (spec 2026-11-07 §10). `HOUGE_IMPROVE_ENABLED` (2b-ii follow-up 2): the STOP switch, read
 * live at every tick so `/disarm` (which writes "false" into the running process env) stops it. Default ON; only the exact
 * word `false`, any case, turns it off, so a typo keeps the loop running instead of silencing it. `HOUGE_IMPROVE_AT`: the
 * tick's local time; no `off` (R13). The digest's `HOUGE_DECISION_DIGEST_AT` is retired: named once at boot, never read.
 */
export function resolveImproveEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.HOUGE_IMPROVE_ENABLED?.trim().toLowerCase() !== "false";
}

export const DEFAULT_IMPROVE_AT = "21:00";
/** `HH:MM` in HOUGE_DISPLAY_TZ; anything else (unset, a typo, `off`) is the default: a typo never moves the tick. */
export function resolveImproveAt(env: NodeJS.ProcessEnv): string {
  const raw = env.HOUGE_IMPROVE_AT?.trim();
  return raw !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_IMPROVE_AT;
}

/** Boot only: the digest is gone (ADR 0034 13.1); a still-set HOUGE_DECISION_DIGEST_AT is named once and ignored. */
export function warnRetiredDigestAt(env: NodeJS.ProcessEnv, log: (line: string) => void = console.error): boolean {
  if (env.HOUGE_DECISION_DIGEST_AT === undefined) return false;
  log("improve: HOUGE_DECISION_DIGEST_AT is retired (ADR 0034 13.1: no digest) and ignored; the tick's time is HOUGE_IMPROVE_AT; remove it from .env");
  return true;
}
```

`src/improve/tick.ts`: delete `import { resolveDigestAt } from "../decisions/digest.js";`; `import { resolveImproveAt, resolveImproveEnabled } from "./flag.js";`; line 62 → `if (time < resolveImproveAt(env)) return null;`; comments 21–22 and 59 → "once per local date at `HOUGE_IMPROVE_AT`". `src/telegram/telegram-daemon.ts` `bootPlanners`: after `warnRetiredJevFlags(process.env);` add `warnRetiredDigestAt(process.env);` (import from `../improve/flag.js`).

- [ ] **Red — status-lines.** Create `tests/decisions/status-lines.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { countLines, improvementLine, injectionCounts, settleHealthLine } from "../../src/decisions/status-lines.js";
import { DIGEST_LM_PREFIX, DIGEST_PR_PREFIX } from "../../src/decisions/digest.js";
import { LM_PREFIX, PR_PREFIX } from "../../src/triggers/telegram-command-parser.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Spec 2026-11-07 §8: the counting code /status reads moved out of the digest unchanged; the digest's diagnostic Watch
// lines (not its alarms) are one /status line, and nothing when there is nothing to say.
const NOW = "2026-10-21T10:00:00.000Z";
const D = (o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id: "turn.handler", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_model", rung: "system_one", verdict: "planner", p: 0.9,
  reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: "2026-10-21T01:00:00.000Z", ...o });
const row = (o: Partial<DecisionInsert>) => ({ ...D(o), decision_id: "dec_x", p_index: null, reask: null, p_first: null });

describe("countLines / settleHealthLine / injectionCounts", () => {
  it("counts per entry by decider label and suffixes only secret.redact; settle health names each reason; injection counts lost judgements", () => {
    const rows = [row({ entry_id: "secret.redact", rung: "rule" }), row({ entry_id: "turn.handler", rung: "fail" }), row({ entry_id: "turn.handler", rung: "system_one" })];
    expect(countLines(rows)).toEqual(["· secret.redact 1 — code 1 (final, failure and evolution reports only)", "· turn.handler 2 — Jev 1 · fallback 1"]);
    expect(settleHealthLine([row({ entry_id: "turn.settle", reason_code: "budget" })])).toBe("· turn.settle unfinished: budget 1 · todo_unavailable 0 · pass_errored 0");
    expect(settleHealthLine(rows)).toBeNull();
    expect(injectionCounts([row({ entry_id: "tool.injection", rung: "fail", fallback_rung: "system_one", verdict: "pass" })])).toMatchObject({ results: 1, lost: 1, withheld: 0 });
  });
  it("the card prefixes equal the parser's, so a card built from them parses there", () => {
    expect(DIGEST_PR_PREFIX).toBe(PR_PREFIX); expect(DIGEST_LM_PREFIX).toBe(LM_PREFIX);
  });
});

describe("improvementLine", () => {
  it("is null on a quiet week with the tick on", () => { expect(improvementLine(RunStore.openInMemory(), NOW, {})).toBeNull(); });
  it("names the tick off, unattached families, silent families, deferrals, wiki-disarmed topics, inapplicable tops and lessons not holding, non-zero parts only", () => {
    const s = RunStore.openInMemory();
    s.insertImproveSignal({ signal: "correction", value: "answer", run_id: null, chat_id: "555", about_run_id: null, created_at: "2026-10-20T00:00:00.000Z" });
    s.recordMemoryEvent("improve_signal_skipped", { signal: "rating", code: "no_run" }, "improve");
    s.beginImproveTick("2026-10-20", "2026-10-20T11:00:00.000Z"); s.finishImproveTick("2026-10-20", "done", { deferred: 2, deferred_outage: 1 }, "2026-10-20T11:00:00.000Z");
    s.insertDecision(D({ entry_id: "improve.route", stage: "after_turn", rung: "rule", verdict: "knowledge", reason_code: "wiki_disarmed", created_at: "2026-10-20T11:00:00.000Z" }));
    s.insertDecision(D({ entry_id: "improve.route", stage: "after_turn", verdict: "nothing", reason_code: "inapplicable_top", created_at: "2026-10-20T11:00:00.000Z" }));
    s.insertImprovementProposal({ decision_id: s.insertDecision(D({ entry_id: "improve.route", stage: "after_turn", verdict: "lesson", created_at: "2026-10-20T11:00:00.000Z" })), target: "lesson", scope: "answer", chat_id: "555", draft_json: "{}", evidence: "lesson did not hold: 2 corrections since (5 d)", created_at: "2026-10-20T11:00:00.000Z" });
    expect(improvementLine(s, NOW, { HOUGE_IMPROVE_ENABLED: "false" }))
      .toBe("Improvement (7 d): tick off · unattached rating 1 · silent review_unsure, lesson_unfollowed, dig_deeper · deferred 2 · deferred on an outage 1 · wiki disarmed 1 · inapplicable top 1 · lessons not holding 1");
    expect(improvementLine(s, "2026-10-29T10:00:00.000Z", {})).toBeNull(); // everything older than 7 days
  });
});
```

Also add to `tests/decisions/status-view.test.ts` a case: with `HOUGE_IMPROVE_ENABLED=false` in `process.env` (set/restore inside the test) and no decisions, `decisionStatusLines(store, NOW)` is `["", "Improvement (7 d): tick off"]`; with decisions, the line is last.

- [ ] **Green — status-lines.** Create `src/decisions/status-lines.ts` by moving from `digest.ts` (unchanged bodies): `RUNG_ORDER`, `FRONT_DOOR`, `RUNG_LABEL`, `deciderLabel`, `settledRows`, `countLines`, `settleHealthLine`, `InjectionCounts`, `injectionCounts` (its `UNSURE_BAND` → `NEAR_BAR_BAND = 0.15`, exported, "a Jev verdict within 0.15 of 0.5"), `trustTops`, `decisionWindow` (`DIGEST_WINDOW_MS` → `DECISION_WINDOW_MS`), with their imports (`DecisionRow`, `RunStore`, `SETTLE_HEALTH_REASONS`, `TURN_SETTLE_ID`, `TRUST_ORDER`, `rankOf`, `TrustLevel`, `DecidedBy`), plus `resolveImproveEnabled` and:

```ts
export const IMPROVE_WINDOW_DAYS = 7;
const SILENT_FAMILIES = ["review_unsure", "lesson_unfollowed", "dig_deeper"] as const;
const LESSON_NOT_HOLDING = "lesson did not hold";
const sumDetail = (ticks: readonly { detail: Record<string, unknown> }[], key: string): number => ticks.reduce((a, t) => a + (typeof t.detail[key] === "number" ? (t.detail[key] as number) : 0), 0);

/** Spec 2026-11-07 §8: the digest's diagnostic Watch lines (not its alarms: a failing tick pages improve_tick_degraded) as one /status line; null when every part is zero and the tick is on. */
export function improvementLine(store: RunStore, now: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const since = new Date(Date.parse(now) - IMPROVE_WINDOW_DAYS * 86_400_000).toISOString();
  const signals = store.listImproveSignalsSince(since);
  const ticks = store.listImproveTicksSince(since);
  const route = store.listDecisionsBetween(since, now).filter((r) => r.entry_id === "improve.route");
  const skipped = new Map<string, number>();
  for (const e of store.listLedgerEventsByTypeSince("improve_signal_skipped", since)) { const k = typeof e.payload.signal === "string" ? e.payload.signal : "unknown"; skipped.set(k, (skipped.get(k) ?? 0) + 1); }
  // with no signal at all in the window "silent" would be every week's line
  const silent = signals.length === 0 ? [] : SILENT_FAMILIES.filter((f) => !signals.some((r) => r.signal === f));
  const made = new Map([...store.listOpenProposals(), ...store.listProposalsResolvedSince(since)].map((p) => [p.proposal_id, p] as const));
  const holding = [...made.values()].filter((p) => p.created_at > since && p.evidence.startsWith(LESSON_NOT_HOLDING)).length;
  const reasons = (code: string): number => route.filter((r) => r.reason_code === code).length;
  const parts: Array<[number, string]> = [
    [resolveImproveEnabled(env) ? 0 : 1, "tick off"],
    [skipped.size, `unattached ${[...skipped].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(", ")}`],
    [silent.length, `silent ${silent.join(", ")}`],
    [sumDetail(ticks, "deferred"), `deferred ${sumDetail(ticks, "deferred")}`],
    [sumDetail(ticks, "deferred_outage"), `deferred on an outage ${sumDetail(ticks, "deferred_outage")}`],
    [reasons("wiki_disarmed"), `wiki disarmed ${reasons("wiki_disarmed")}`],
    [reasons("inapplicable_top"), `inapplicable top ${reasons("inapplicable_top")}`],
    [holding, `lessons not holding ${holding}`]
  ];
  const shown = parts.filter(([n]) => n > 0).map(([, t]) => t);
  return shown.length === 0 ? null : `Improvement (${IMPROVE_WINDOW_DAYS} d): ${shown.join(" · ")}`;
}
```

`src/decisions/status-view.ts`: import the six helpers and `improvementLine` from `./status-lines.js`; `decisionStatusLines` becomes:

```ts
export function decisionStatusLines(store: RunStore, now: string): string[] {
  const { since, all, rows } = decisionWindow(store, now);
  const tail = [proposalsLine(store, now), improvementLine(store, now)].filter((l): l is string => l !== null);
  if (rows.length === 0) return tail.length > 0 ? ["", ...tail] : [];
  const inj = injectionCounts(rows);
  const hostile = [...trustTops(rows).values()].filter((l) => l === "hostile").length;
  return ["", "🪜 DECISIONS (24h)", ...countLines(rows), jevFailureLine(store, since, now),
    `Injection: withheld ${inj.withheld} · framed ${inj.framed} · not checked ${inj.lost}`, `Hostile turns: ${hostile}`, ...healthLines(store, all, since, now), ...tail];
}
```

and its docblocks lose "the digest's" ("a short section over the ladder's counting code"). In `digest.ts` delete the moved functions and their now-unused imports (Task 8b trims the rest). `tests/decisions/injection-judge.test.ts`: import `injectionCounts` from `../../src/decisions/status-lines.js` (drop `trustLines`), line 267 → `expect(injectionCounts(rows).lost).toBe(4);` and drop the unused `now`.

- [ ] **Red/Green — the old ✅/❌.** Rewrite `tests/gateway/decision-commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { REVIEW_CLOSED_TEXT } from "../../src/gateway/decision-commands.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec 2026-11-07 §8-9 (ADR 0034 6.6): the digest and its Unsure section are gone, so a ✅/❌ on an old message answers
// "closed" and writes NO label — a review_bad here would feed improve.route a ladder proposal from a surface that no longer exists.
const NOW = "2026-11-08T11:00:00.000Z";
let seq = 0;
const tap = (decision_id: string, label: string, key = `k${++seq}`) => buildTypedTaskEvent({ source: "telegram", type: "decision_review",
  requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" }, idempotency_key: key, source_reference: key,
  metadata: { telegram_update_id: seq, telegram_callback_id: key, decision_id, label } });
const decision = (store: RunStore): string => store.insertDecision({ entry_id: "turn.handler", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_model",
  rung: "system_one", verdict: "planner", p: 0.6, reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1 });

describe("decision_review taps after the digest", () => {
  it("❌ and ✅ answer closed and write no outcome, for a real decision as for an unknown id", () => {
    const store = RunStore.openInMemory();
    const id = decision(store);
    for (const [d, label] of [[id, "bad"], [id, "ok"], ["dec_nope", "bad"]] as const) expect(new Gateway(store).intake(tap(d, label), NOW)).toMatchObject({ ok: true, status: "decision_reviewed" });
    expect(store.listDecisionOutcomes(id)).toEqual([]);
    expect([...drainOutbox(store).values()].map((p) => p.text)).toEqual([REVIEW_CLOSED_TEXT, REVIEW_CLOSED_TEXT, REVIEW_CLOSED_TEXT]);
    store.close();
  });
  it("a redelivered update is replayed: one reply; taps stay exempt from the 5-a-minute command window", () => {
    const store = RunStore.openInMemory();
    const id = decision(store);
    const e = tap(id, "bad");
    new Gateway(store).intake(e, NOW); new Gateway(store).intake(e, NOW);
    expect(drainOutbox(store).size).toBe(1);
    for (let i = 0; i < 8; i += 1) expect(new Gateway(store).intake(tap(id, "ok"), NOW)).toMatchObject({ ok: true });
    expect(store.checkTelegramRateLimit({ actor_id: "paco", chat_id: "555", command: "turn", now: NOW }).ok).toBe(true);
    store.close();
  });
});
```

Rewrite `src/gateway/decision-commands.ts`:

```ts
import type { TypedTaskEvent } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/**
 * Old digest ✅/❌ taps (the digest is gone: spec 2026-11-07 §8-9; ADR 0034 6.6: calibration labels come from taps on cards
 * only). A button on an old message still parses (`REVIEW_PREFIX`); it answers REVIEW_CLOSED_TEXT and writes nothing, once per trigger.
 */
export const REVIEW_CLOSED_TEXT = "This review has closed.";

export function handleDecisionReview(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    replyTo(store, event, "decision_review", REVIEW_CLOSED_TEXT);
    return { ok: true, status: "decision_reviewed", run_id: "" };
  });
}
```

`src/gateway/gateway.ts:249` → `handleDecisionReview(this.runStore, event)`. In `run-store.ts` delete `recordDecisionDigest`, `getDecisionDigest`, `lastSentDecisionDigestAt`, `wasDecisionOffered` (5180–5200) and `DecisionDigestRow` (1090) — grep each name first; the only other readers are `digest.ts` (Task 8b) and the deleted tests. `src/triggers/telegram-command-parser.ts:343` comment → "Old digest review taps (answered closed): …".

- [ ] Run `npm run typecheck` — expect only `digest.ts`/its tests to complain about the moved helpers until 8b; then `npx vitest run tests/improve tests/decisions/status-lines.test.ts tests/decisions/status-view.test.ts tests/gateway/decision-commands.test.ts tests/decisions/injection-judge.test.ts tests/docs` — green.
- [ ] Commit (with 8b, below, if typecheck is not clean in between; otherwise):

```
git add src/improve/flag.ts src/improve/tick.ts src/decisions/status-lines.ts src/decisions/status-view.ts src/decisions/digest.ts src/gateway/decision-commands.ts src/gateway/gateway.ts src/run/run-store.ts src/telegram/telegram-daemon.ts src/triggers/telegram-command-parser.ts tests/docs/parity.ts tests/improve/tick.test.ts tests/improve/flag.test.ts tests/decisions/status-lines.test.ts tests/decisions/status-view.test.ts tests/gateway/decision-commands.test.ts tests/decisions/injection-judge.test.ts
git commit -m "refactor(decisions): HOUGE_IMPROVE_AT, status-lines.ts, the /status improvement line, old review taps answer closed

Spec 2026-11-07 §8-10.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8b: the digest goes — `digest.ts` to constants, daemon wiring, topic, tests, scripts

**Files:** `src/decisions/digest.ts`, `src/telegram/telegram-daemon.ts:12,594-595,607,638,650,662,674-681`, `src/notifications/topics.ts`, `tests/notifications/topics.test.ts`, `tests/telegram/telegram-daemon-improve.test.ts`, `tests/decisions/standing-approval.test.ts:6,323`, delete `tests/decisions/digest.test.ts`, `tests/decisions/digest-2a.test.ts`, `tests/decisions/digest-helpers.test.ts`; scripts `check-ladder-stage4b-rollback.mjs:175-179,217,231,233`, `check-ladder-stage4c-rollback.mjs:203-204,246-247,271-274`, `live-gate-decisions-parity.mjs:364-379,380-400,404-451,455-475,499,527`, `live-gate-decisions-2a.mjs:518-536`.

**Interfaces.** Produces: `digest.ts` exports exactly `REVIEW_PREFIX`, `DIGEST_PR_PREFIX`, `DIGEST_LM_PREFIX`, `STANDING_DIGEST_TEXT` (re-export); `TOPIC_ROUTE` without `digest`. Removes: `runDecisionDigestTick`, `enqueueDigest`, `buildDecisionDigest`, `unsureSection`, `unsureOf`, `barOf`, `reviewButtons`, `watchLines`, `improvementsToday`, `standingLines`, `proposalsWaiting`, `trustLines`, `reaskLines`, `digestOff`, `resolveDigestAt`, `DEFAULT_DIGEST_AT`, `UNSURE_*`, `DIGEST_*_MAX`, `DRAFT_LINE_CHARS`, `WATCH_WINDOW_DAYS`, `DIGEST_WAIT_FOR_TICK_MS`, `DIGEST_WINDOW_MS`, `runDigestTick` (daemon).

- [ ] **Red.** `tests/telegram/telegram-daemon-improve.test.ts`: delete the `digest` entry of `calls`, the `vi.mock("../../src/decisions/digest.js", …)` block and the `calls.digest` expectation; `expect(calls.order).toEqual(["boot", "improve"])`; header comment → "…the signal-path tick runs the improve tick WITH the job hooks and the operator chat; there is no digest tick (spec 2026-11-07)". Add: `expect(Object.keys(await import("../../src/decisions/digest.js")).sort()).toEqual(["DIGEST_LM_PREFIX", "DIGEST_PR_PREFIX", "REVIEW_PREFIX", "STANDING_DIGEST_TEXT"]);` — the module is constants only. `tests/notifications/topics.test.ts`: remove `"digest"` from the chat loop and add `expect("digest" in TOPIC_ROUTE).toBe(false); // spec 2026-11-07: no digest topic`. `tests/decisions/standing-approval.test.ts`: drop the `standingLines` import; line 323 → `expect([name, (db(s).prepare("SELECT COUNT(*) AS n FROM change_log WHERE idempotency_key = ?").get(\`standing_end:${row.standing_id}\`) as { n: number }).n]).toEqual([name, 0]); // the urgent card already told him` (add a `db` helper as in `tests/run/change-log.test.ts`). Delete the three digest test files (`git rm`).

Run `npx vitest run tests/telegram/telegram-daemon-improve.test.ts tests/notifications tests/decisions/standing-approval.test.ts` — expected: the daemon still calls the digest; the module exports more; `digest` is still a topic.

- [ ] **Green.** `src/decisions/digest.ts` becomes exactly:

```ts
import { STANDING_DIGEST_TEXT } from "../run/run-store.js";

/**
 * What is left of the daily decision digest (gone since spec 2026-11-07; ADR 0034 13.1): improvements apply on their own or
 * arrive as cards (improve/proposal-card.ts), applied improvements and standing-grant ends are /changes rows, faults page
 * `improve_tick_degraded`, and the counts live in /status (decisions/status-lines.ts). The callback prefixes stay so every
 * card and every button on an old message still parses; the standing text stays with its row.
 */
export { STANDING_DIGEST_TEXT };
/** The review tap's callback prefix (`dec:rv:<decision_id>:<ok|bad>`); the parser imports it and an old tap is answered "closed". */
export const REVIEW_PREFIX = "dec:rv:";
/** The callback prefixes of telegram-command-parser.ts (`PR_PREFIX` / `LM_PREFIX`); that file imports this one, so they are literals here and a test pins the pair. */
export const DIGEST_PR_PREFIX = "dec:pr:";
export const DIGEST_LM_PREFIX = "dec:lm:";
```

`src/telegram/telegram-daemon.ts`: delete line 12 (`import { runDecisionDigestTick } …`), line 595 (`runDigestTick(…)`), the `runDigestTick` function (674–681); comments at 607, 638, 650, 662: "never skips the digest or the sweep" → "never skips the sweep", and 607 → "2b-ii §3.1: the daily improvement tick (spec 2026-11-07: it applies, cards and pages on its own; no digest follows)". `src/notifications/topics.ts`: remove `digest: "chat"`. Grep `src` for `digest` (case-insensitive) and fix every remaining comment that still describes the digest as sending (tick.ts header, `improvement-commands.ts` docblock "tonight's digest line" strings were removed in 4a; `skill-job.ts`, `promote.ts`, `run-store.ts` method docblocks that say "the digest shows" → "the card / `/changes` shows"); reader digests (`quarantine.ts`, `lookup-lane.ts`, `time-convert.ts`) are a different word and stay.

Scripts (P12):
- `check-ladder-stage4b-rollback.mjs`: `render` returns `{ status, list }` (drop the `dg` line and the comment at 177); delete `cmpDigest` (217); line 231 → `const bad = [...cmpStatus(…), ...cmpList(…)];`; line 233 label drops "digest equal,"; header line 8 and docblock 175 drop "the digest". Same in `check-ladder-stage4c-rollback.mjs` (203–204, 246–247, 271–274, header line 10). Both `mods()` loaders keep importing `decisions/digest.js` (constants) — harmless; the old dist still exports the digest, unused.
- `live-gate-decisions-parity.mjs`: delete `clearDigestLatch`, `claimDigest`, `ensureUnsure`, `checkRender`, `SECTION_HEADERS`, `digestShapeOk`, `checkDigest`, `tapUpdate`, `checkTap` and the header comment at 39; add and call from `main` in place of lines 526–527:

```js
/** Spec 2026-11-07 §8: the digest is gone. The new build must export no digest tick, route no `digest` topic, and queue no digest row after a cycle. */
function checkNoDigest(g) {
  const d = g.newMods;
  check("no digest: the module exports only the kept constants", Object.keys(d).filter((k) => /Digest|digest|unsure|Unsure|watchLines|standingLines|proposalsWaiting|improvementsToday/.test(k)).every((k) => ["DIGEST_PR_PREFIX", "DIGEST_LM_PREFIX", "STANDING_DIGEST_TEXT"].includes(k)), Object.keys(d).join(","));
  check("no digest: `digest` is not a notification topic", !("digest" in d.TOPIC_ROUTE), Object.keys(d.TOPIC_ROUTE).join(","));
  const n = g.newSide.store.countNotificationsByIdempotencyKey(`decision_digest:${new Date().toISOString().slice(0, 10)}`);
  check("no digest: no decision_digest outbox row on copy B", n === 0, `rows=${n}`);
}
```

and add `"notifications/topics.js"` to the `loadBuild(NEW_DIST, […])` list (486). Remove the `DatabaseSync` import if it becomes unused.
- `live-gate-decisions-2a.mjs`: rename `caseDigest` → `caseStatus`, keep lines 520–523 (`/status` carries the injection counts), delete 524–535 (the digest build, enqueue, claim, render) and the docblock's digest half; update the case list (580).

- [ ] Run `npm run typecheck && npm test && npm run build` — green, none skipped; then `node -e "import('./dist/decisions/digest.js').then((m) => console.log(Object.keys(m)))"` prints the four names.
- [ ] Commit:

```
git add src/decisions/digest.ts src/telegram/telegram-daemon.ts src/notifications/topics.ts tests/notifications/topics.test.ts tests/telegram/telegram-daemon-improve.test.ts tests/decisions/standing-approval.test.ts scripts/check-ladder-stage4b-rollback.mjs scripts/check-ladder-stage4c-rollback.mjs scripts/live-gate-decisions-parity.mjs scripts/live-gate-decisions-2a.mjs
git rm tests/decisions/digest.test.ts tests/decisions/digest-2a.test.ts tests/decisions/digest-helpers.test.ts
git commit -m "feat(decisions): the nightly digest goes

Spec 2026-11-07 §8 (ADR 0034 13.1, ADR 0031, to be amended): no digest tick,
no digest topic, digest.ts keeps its callback prefixes and the standing text;
gates that rendered the digest check its absence instead.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: the live gate — `scripts/live-gate-improve-route.mjs`

**Files:** `scripts/live-gate-improve-route.mjs` (load 44–46, gateEnv 58, plantDay1 136–142, case3 201–216, case4 261–269, case5Propose/Taps 218–227/271–280, case6 229–243, case7 282–296, TITLES 350, main 379–405). Run from a worktree after `npm run build` there: `HOUGE_ENV_FILE=<main checkout>/.env node scripts/live-gate-improve-route.mjs`. Every case's PASS criterion names a product fault; a planted-token or injection-phrase egress still fails the whole gate.

**Interfaces.** Consumes from `dist/`: `improve/degraded.js` (`evaluateImproveDegraded`, `IMPROVE_DEGRADED_KIND`), `notifications/topics.js` (`TOPIC_ROUTE`), `recordCorrection` with `origin`, `handleImprovementTap` replies with buttons.

- [ ] `load()`: add `"improve/degraded.js", "notifications/topics.js"`; keep `"decisions/digest.js"` (constants). `gateEnv`: `HOUGE_DECISION_DIGEST_AT: "21:00"` → `HOUGE_IMPROVE_AT: "21:00"`; `main`'s banner → `improve at ${process.env.HOUGE_IMPROVE_AT}`.
- [ ] `plantDay1`: `f.c3`'s `recordCorrection` gains `origin: "memlane_fix"`; `f.c7`'s gains `origin: "dig_deeper"` (P13: the card path keeps the prior, so the positive control stays live); add a clean control for case 7 on the card path: `const a3 = plantTurn(g, { text: "How old is the Sydney Opera House?", at: dayAt(g, -1, "20:10"), category: "answer", reply: "It opened in 1973, so about fifty years.", clean: true }); const b3 = plantTurn(g, { text: "Too wordy, always give the year first.", at: dayAt(g, -1, "20:12") }); f.c7clean = { a: a3, b: b3, ok: m.recordCorrection(g.store, { about: g.store.getJevVerdictForRun(a3), run_id: b3, chat_id: CHAT, origin: "dig_deeper", now: dayAt(g, -1, "20:14") }) };`.
- [ ] Replace `case3` with:

```js
/** Case 3: the memlane_fix correction applies at the tick: accepted with the ids, a lessons row (source improve), one improve_applied /changes row, NO chat row, and an empty prior at the distill. Returns the proposal or null. */
function case3(g, f) {
  const c = "3 correction applies"; const sig = g.q.get(`SELECT * FROM improve_signals WHERE signal = 'correction' AND run_id = ?`, f.c3.b);
  check(c, "the correction inbox row exists (origin memlane_fix) and was consumed", f.c3.ok && sig?.origin === "memlane_fix" && sig?.consumed_at != null);
  const row = routeRows(g).find((d) => d.run_id === f.c3.a);
  if (!row) { check(c, "an improve.route row on the corrected run", false, "none"); return null; }
  if (row.rung === "fail" || row.fallback_reason) { unsure(c, "decision", `rung=${row.rung} fallback=${row.fallback_reason ?? "-"} (an outage, not a result)`); return null; }
  if (row.verdict !== "lesson" && row.verdict !== "fact") { unsure(c, "apply", `the verdict was ${row.verdict}, so the apply path was not exercised`); return null; }
  const p = g.q.get(`SELECT * FROM improvement_proposals WHERE decision_id = ?`, row.decision_id);
  if (!p) { unsure(c, "apply", "verdict lesson/fact but no proposal (the distill returned nothing usable: see the no_text outcome)"); return null; }
  const result = JSON.parse(p.result_json ?? "{}"); const id = result.lesson_id ?? result.fact_id;
  const saved = result.lesson_id ? g.q.get(`SELECT id, source FROM lessons WHERE id = ?`, result.lesson_id) : g.q.get(`SELECT id FROM episodic_facts WHERE id = ?`, result.fact_id ?? -1);
  check(c, "applied: proposal accepted with the saved id, the row exists (a lesson with source improve)", p.state === "accepted" && saved !== undefined && (!result.lesson_id || saved.source === "improve"), `state=${p.state} id=${id ?? "none"}`);
  const log = g.q.get(`SELECT topic, text FROM change_log WHERE idempotency_key = ?`, `improve_applied:${p.proposal_id}`);
  check(c, "one improve_log /changes row naming the undo command", log?.topic === "improve_log" && new RegExp(`undo: /forget(_memory)? ${id}$`).test(log?.text ?? ""), log ? excerpt(g, log.text) : "no row");
  check(c, "no chat row for the applied proposal", g.q.get(`SELECT 1 AS hit FROM notification_outbox WHERE idempotency_key = ?`, `improve_proposal:${p.proposal_id}`) === undefined);
  check(c, "the draft and the row carry no planted token", !p.draft_json.includes(TOKEN) && !(log?.text ?? "").includes(TOKEN));
  const distill = g.seatInputs.filter((x) => x.name === "improve_distill").map((x) => x.text);
  check(c, "the auto-apply draft's distill input carried no prior (the corrected reply's words are absent)", distill.length > 0 && distill.every((t) => !t.includes("founded in 1535")), `distill_inputs=${distill.length}`);
  say(`  excerpt 3 applied ${result.lesson_id ? "lesson" : "fact"} (redacted): ${excerpt(g, log?.text ?? "")}`);
  return { ...p, saved_id: id, kind: result.lesson_id ? "lesson" : "fact" };
}
```

- [ ] Replace `case4` with (planted before case 8's day-2 tick; checked after it):

```js
/** Case 4 (part 1): /forget (or /forget_memory) through the real intake reverts the applied proposal in the same transaction. */
function case4Undo(g, p, now) {
  const c = "4 undo then already_proposed"; if (!p) { unsure(c, "undo", "case 3 applied nothing"); return; }
  const m = g.m; g.seq += 1;
  const r = g.gateway.intake(m.buildTypedTaskEvent({ source: "telegram", type: p.kind === "lesson" ? "forget" : "forget_memory", program: String(p.saved_id), requested_by: { kind: "user", id: "gate" }, notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: `gate-improve:undo:${g.seq}`, source_reference: `gate-improve:undo:${g.seq}` }));
  const after = g.store.getImprovementProposal(p.proposal_id);
  const gone = p.kind === "lesson" ? g.q.get(`SELECT status FROM lessons WHERE id = ?`, p.saved_id)?.status : g.q.get(`SELECT status FROM episodic_facts WHERE id = ?`, p.saved_id)?.status;
  check(c, `${p.kind === "lesson" ? "/forget" : "/forget_memory"} <id>: the row is pruned and the proposal is reverted`, r.ok && gone === "pruned" && after?.state === "reverted", `ok=${r.ok} status=${gone} state=${after?.state}`);
  // the same scope corrected again on day 2 must be already_proposed: the reverted proposal blocks it for 14 days
  const a = plantTurn(g, { text: "What is the population of Lima today?", at: dayAt(g, 1, "20:30"), category: "answer" });
  const b = plantTurn(g, { text: "Again too long: three sentences at most, always.", at: dayAt(g, 1, "20:32") });
  g.c4 = { a, ok: m.recordCorrection(g.store, { about: g.store.getJevVerdictForRun(a), run_id: b, chat_id: CHAT, origin: "memlane_fix", now: dayAt(g, 1, "20:33") }) };
  void now;
}
/** Case 4 (part 2, after the day-2 tick): the second correction on the scope recorded nothing/already_proposed with no new proposal. */
function case4Block(g) {
  const c = "4 undo then already_proposed"; if (!g.c4) return;
  const row = routeRows(g).find((d) => d.run_id === g.c4.a);
  if (!row) { unsure(c, "day-2 decision", "the second correction was not decided (deferred or capped)"); return; }
  check(c, "the next correction on the same scope is already_proposed (reverted blocks for 14 days)", row.verdict === "nothing" && row.reason_code === "already_proposed", `verdict=${row.verdict} reason=${row.reason_code}`);
}
```

- [ ] `case5Propose`: add after the draft check: `const card = outboxText(g, \`improve_proposal:${p.proposal_id}\`); check(c, "one improve_card card with Accept/Dismiss (dec:pr:) and offered_at set", card !== null && (card.buttons ?? []).length === 2 && card.buttons.every((b) => b.data.startsWith("dec:pr:")) && g.store.getImprovementProposal(p.proposal_id)?.offered_at !== null, \`card=${card !== null}\`); check(c, "no /changes row for a card proposal", g.q.get(\`SELECT 1 AS hit FROM change_log WHERE idempotency_key = ?\`, \`improve_applied:${p.proposal_id}\`) === undefined);`. `case5Taps`: also check the Accept reply payload carries one `↩️ Revert` button (`outboxText(g, \`${e.idempotency_key}:improvement_tap\`).buttons`) — adapt `tap()` to return the payload.
- [ ] Replace `case6` with:

```js
/** Case 6: no digest. Nothing in the build sends one and the outbox holds no digest row after the tick. */
function case6(g) {
  const c = "6 no digest"; const d = g.m;
  check(c, "the build exports no digest tick or builder", d.runDecisionDigestTick === undefined && d.buildDecisionDigest === undefined && d.unsureSection === undefined);
  check(c, "`digest` is not a notification topic; improve_card is chat, improve_log and standing_log are log", !("digest" in d.TOPIC_ROUTE) && d.TOPIC_ROUTE.improve_card === "chat" && d.TOPIC_ROUTE.improve_log === "log" && d.TOPIC_ROUTE.standing_log === "log");
  const rows = g.q.get(`SELECT COUNT(*) AS n FROM notification_outbox WHERE idempotency_key LIKE 'decision_digest:%' AND created_at >= ?`, g.realStart).n;
  check(c, "no decision_digest outbox row from the gate's ticks", rows === 0, `rows=${rows}`);
}
```

- [ ] `case7`: the positive control reads the clean dig_deeper correction: `distill.some((t) => t.includes("opened in 1973"))`; add `check(c, "no applied lesson or fact carries the phrase or the token", [...g.q.all(\`SELECT text AS t FROM lessons WHERE source = 'improve'\`), ...g.q.all(\`SELECT fact AS t FROM episodic_facts WHERE id IN (SELECT json_extract(result_json, '$.fact_id') FROM improvement_proposals WHERE state IN ('accepted','reverted'))\`)].every((r) => !INJ_RE.test(r.t) && !r.t.includes(TOKEN)));` (confirm the `episodic_facts` text column name from `run-store.ts`'s `getEpisodicFact` before running).
- [ ] New `case12`:

```js
/** Case 12 (spec §12): a rating correction (no run) is a card, never applied; three degraded dates page improve_tick_degraded once. */
async function case12(g) {
  const c = "12 rating card and degraded page";
  const a = plantTurn(g, { text: "Summarise the quarterly report.", at: dayAt(g, 3, "20:00"), category: "answer", reply: "Revenue grew; costs fell." });
  const ok = g.m.recordCorrection(g.store, { about: g.store.getJevVerdictForRun(a), run_id: null, chat_id: CHAT, origin: "rating", now: dayAt(g, 3, "20:05") });
  if (!ok) { unsure(c, "the rating correction was planted", "recordCorrection refused it"); return; }
  const runs = await runTick(g, g.c.at(g.c.addDays(g.c.d1, 4), "22:00")); const row = routeRows(g).find((d) => d.run_id === a);
  if (!row || row.rung === "fail") { unsure(c, "decision", `rung=${row?.rung ?? "none"} (an outage, not a result)`); }
  else if (row.verdict === "lesson" || row.verdict === "fact") {
    const p = g.q.get(`SELECT * FROM improvement_proposals WHERE decision_id = ?`, row.decision_id);
    check(c, "a rating correction becomes a card (open, offered, a chat row), never applied", p?.state === "open" && p?.offered_at !== null && outboxText(g, `improve_proposal:${p.proposal_id}`) !== null && g.q.get(`SELECT 1 AS hit FROM change_log WHERE idempotency_key = ?`, `improve_applied:${p?.proposal_id}`) === undefined, `state=${p?.state}`);
  } else unsure(c, "card", `verdict ${row.verdict}: the lesson/fact card path was not exercised`);
  void runs;
  // three degraded dates after the real ticks (rows planted, judged through the real evaluator and the real incident route)
  const bad = { decided: 0, groups: 2, deferred_outage: 2 }; const dates = [5, 6, 7].map((n) => g.c.addDays(g.c.d1, n)); const verdicts = [];
  for (const date of dates) { const at = g.c.at(date, "22:30"); g.store.beginImproveTick(date, at); g.store.finishImproveTick(date, "done", bad, at); verdicts.push(g.m.evaluateImproveDegraded({ store: g.store, now: at, env: process.env, chatId: CHAT }, date)); }
  const open = g.store.listOpenIncidents().filter((i) => i.kind === g.m.IMPROVE_DEGRADED_KIND);
  check(c, "two degraded dates page nothing, the third opens improve_tick_degraded once, routed as a page to the chat", JSON.stringify(verdicts) === JSON.stringify(["none", "none", "opened"]) && open.length === 1 && outboxText(g, `incident_opened:${open[0]?.incident_id}`) !== null, `verdicts=${verdicts.join(",")} open=${open.length}`);
  const healthy = g.c.addDays(g.c.d1, 8); const at = g.c.at(healthy, "22:30"); g.store.beginImproveTick(healthy, at); g.store.finishImproveTick(healthy, "done", { decided: 1, groups: 1 }, at);
  check(c, "a healthy date resolves it", g.m.evaluateImproveDegraded({ store: g.store, now: at, env: process.env, chatId: CHAT }, healthy) === "resolved" && g.store.listOpenIncidents().every((i) => i.kind !== g.m.IMPROVE_DEGRADED_KIND));
}
```

- [ ] `TITLES`: `"3 correction applies"`, `"4 undo then already_proposed"`, `"6 no digest"`, add `"12 rating card and degraded page"`. `main`: `const applied = case3(g, f); const schedProposal = case5Propose(g, f); case6(g); case2(…); case4Undo(g, applied, addMin(NOW1, 15)); case5Taps(…); const eight = await case8(g, f, NOW1); case4Block(g); case7(g, f, job); case9(g, eight.deferred); case10(g, args); await case11(g); await case12(g);`. Case 9's "every consumed row has exactly one outcome" keeps holding (the applied group's outcome rows are unchanged); case 9's `improve_tick` start/end count must add the planted case-12 rows? No — `g.ticks` counts real runs and the planted rows write no ledger event; keep case 9 before case 12 as above.
- [ ] Run the gate from the worktree: `npm run build && HOUGE_ENV_FILE=<main>/.env node scripts/live-gate-improve-route.mjs --skip-memory-gate`, then once more with case 10. PASS criterion: cases 1–9, 11, 12 PASS (3: applied + /changes row + no chat row + empty prior; 4: reverted, then already_proposed; 5: one card; 6: no digest; 12: card, then one page). INCONCLUSIVE only on a named outage. Paste the verdict lines into `tasks/todo.md` (Task 10).
- [ ] Commit:

```
git add scripts/live-gate-improve-route.mjs
git commit -m "test(gate): improve-route live gate — applied correction, undo and block, one card, no digest, degraded page

Spec 2026-11-07 §12.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: docs sync (a re-read), ADR 0034 / 0031 amendments drafted for Paco's signature, the ADR-text pin, state files

**Files:** `docs/decisions/0034-decision-ladder-consolidated.md` (rules 2.2, 2.5, 6.6, 10.2, 10.5, 11.3, 13.1, 13.2; the History row; the rule 4 table row for `improve.route` stays `alwaysRecord`), `docs/decisions/0031-chat-carries-what-needs-paco.md` (Consequences), `docs/decisions/README.md:45,48`, `docs/reference/configuration.md:704-706,1121,1131-1148`, `docs/reference/jev-decision-layer.md:77-80,100,102,260,268,291-293`, `docs/reference/decision-map.md:18,29,62,127`, `README.md:204,208,336`, `CONTEXT.md:79,97`, `docs/ROADMAP.md` (one delta), `tasks/todo.md` (state block), `tasks/lessons.md`, `sessions.md`, `tests/adr/0034-paco-words-only.test.ts` (the ADR-text assertion).

- [ ] **Red — the ADR-text pin.** Add to `tests/adr/0034-paco-words-only.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
const adr = readFileSync(join(import.meta.dirname, "..", "..", "docs", "decisions", "0034-decision-ladder-consolidated.md"), "utf8");
const rule = (id: string): string => { const at = adr.indexOf(`- ${id} `); return adr.slice(at, adr.indexOf("\n- ", at + 1)); };
describe("ADR 0034 names the rule the code pins", () => {
  it("10.5 names autoApplies, memlane_fix, the empty prior, the 14-day accepted/reverted block and the card for the rest; 2.5 names pacoWordsOnly; 13.1 says no digest; 13.2 names improve_tick_degraded; 6.6 no longer names digest ✅/❌", () => {
    expect(rule("10.5")).toMatch(/autoApplies/); expect(rule("10.5")).toMatch(/memlane_fix/); expect(rule("10.5")).toMatch(/prior: ""|empty prior|no prior/); expect(rule("10.5")).toMatch(/reverted/);
    expect(rule("2.5")).toMatch(/pacoWordsOnly/);
    expect(rule("13.1")).toMatch(/No digest/); expect(rule("13.2")).toMatch(/improve_tick_degraded/);
    expect(rule("6.6")).not.toMatch(/Digest ✅\/❌/);
    expect(rule("10.2")).toMatch(/HOUGE_IMPROVE_AT/);
  });
});
```

Run `npx vitest run tests/adr/0034-paco-words-only.test.ts` — expected: fails on every regex.

- [ ] **Green — ADR 0034** (each bullet rewritten in place; History row added; the header's status line gains "amended 2026-11-07 (improvement proposals auto-apply, the digest goes — **awaiting Paco's signature**)"):
  - **2.2** append: "…Every automatic lesson save, whatever the route, is announced: on the memory card with Undo, or — for a lesson or fact `improve.route` applies from a correcting turn Paco typed (rule 10.5) — on a `/changes` line with its undo command (`/forget <id>`, `/forget_memory <id>`)."
  - **2.5** append: "One allowance (spec 2026-11-07 §4): over `mixed` input a judged verdict may be a reversible, announced `effect` when the entry names a code-owned provenance predicate (`pacoWordsOnly`; today `improve.route`'s `autoApplies`) that holds by construction — the state the stored text comes from is Paco's own message plus code-built fields. The provisional-bar rule (6.1) extends to that gated case. Every other mixed-input effect still fails `entryProblems`."
  - **6.6** → "**Taps are evidence.** Dig deeper, Undo and 认真想 write `decision_outcomes`; the digest's ✅/❌ are gone (spec 2026-11-07 §9: no `review_ok`/`review_bad` labels, so `review_bad` → ladder proposals stop arising, and a button on an old digest answers 'This review has closed.'). Calibration labels come from taps on cards only; conflicting taps give no label. No row is committed and no bar moves automatically. `lesson_undone` carries the lane the save came from."
  - **10.2** "at the digest's time (also while the digest is `off`), before it" → "at `HOUGE_IMPROVE_AT` (default 21:00; no `off`, R13: `HOUGE_IMPROVE_ENABLED=false` is the switch)".
  - **10.5** → "**Proposals** (lesson, fact, schedule, tool gap, ladder): one open per (target, scope), expiring at 14 days; one dismissed, expired, **accepted or reverted** within 14 days blocks the same pair (`already_proposed`), checked before the draft. **A lesson or fact applies on its own** (spec 2026-11-07 §3) only through `autoApplies` (`improve-route.ts`, pinned by `tests/adr/0034-paco-words-only.test.ts`): every row of the group a correction Paco typed on the memory lane (`improve_signals.origin = memlane_fix`, a new run of his, never the corrected run), verdict lesson or fact, not a 'lesson did not hold' rewrite; its draft is distilled with an empty prior (`prior: ""`: Houge's reply never reaches the seat), passes the memory lane's backstops, and is saved inside the group's commit through `saveMemoryPlan` under the corrected run, `accepted` with the ids, with one `/changes` row (`improve_applied:<proposal_id>`, topic `improve_log`) naming `/forget <id>` or `/forget_memory <id>`; no chat → it stays open. A capped lesson, a save with no change id, and every other proposal (Dig-deeper, escalation and rating corrections, rewrites, schedule, tool gap, ladder, skill) is **one card** at the tick (topic `improve_card`, key `improve_proposal:<proposal_id>`, Accept / Dismiss, `offered_at` set); Accept writes through the memory lane's writers and the reply carries Undo / Revert / Revoke. `/forget <id>`, `/forget <scope>` and `/forget_memory <id>` move the proposal `accepted → reverted` in the removal's transaction; Undo is no `turn.handler` label. Schedule Accept applies only while the row equals `before`; Revert restores; both recompute `next_run_at`. A skill Accept whose job exists dismisses. A ladder Accept records a `ladder_moves` row and changes nothing; a tool gap replies the `self_write_propose` text. Residual (accepted): with no prior and Paco's line as both numbered evidence lines a fact can over-generalise his words; it is his words' reading, never another source's, and one `/forget_memory` away."
  - **11.3** "no digest line" → "no `/changes` row"; "Digest standing lines cover `[previous cutoff, now)`" → "Every other end writes one `/changes` row (`standing_end:<standing_id>`, topic `standing_log`) in `endStandingTx`".
  - **13.1** → "**No digest** (spec 2026-11-07; Paco 2026-10-14 and 2026-11-07). `/status` holds the counts, the `turn.settle` health line, per-entry Jev-skip counts (24 h), the 30-day proposal counts and the 'Improvement (7 d)' line (tick off, unattached, silent families, deferrals, wiki disarmed, inapplicable tops, lessons not holding); `/changes` lists applied improvements and ended standing grants. Urgent cards and proposal cards go out at once."
  - **13.2** append: "`improve_tick_degraded` pages (subject `improve`): judged on each date's `improve_ticks` row at its end — `failed` or a previous date still `running` opens at once, three consecutive dates that decided nothing while `deferred_outage`, `record_failed` or `embed_unavailable` was above 0 open once, `stopped` is neutral, a `done` date that decided something (or had no group) with the embedder up resolves."
  - **Revisit when** (line ~480): "14 days of `improve.route` rows are in for its bar" → add "(outcomes only: no review labels)".
  - History row: `| 2026-11-07 | Improvement proposals auto-apply, the digest goes: 2.2, 2.5 (gated allowance), 6.6 (no digest taps), 10.2 (HOUGE_IMPROVE_AT), 10.5 (autoApplies, origin, no prior, cards, reverted blocks), 11.3 and 13.1 (/changes rows, no digest), 13.2 (improve_tick_degraded) | [auto-apply](../superpowers/specs/2026-11-07-improve-auto-apply-design.md) | awaiting Paco's signature |`.
- [ ] **ADR 0031** Consequences, first bullet: "…memory cards, rating asks, ~~the digest,~~ idea panel, standing cards, **improvement proposal cards** (`improve_card`), self-write notices…" and append to "What else changed in code": "2026-11-07 (spec improve-auto-apply, awaiting Paco's signature): the digest leaves the chat list; applied improvements (`improve_log`) and standing-grant ends (`standing_log`) are change-log rows; `improve_tick_degraded` pages." Index row 45: append "amended 2026-11-07 (the digest leaves chat; improvement cards and two log topics join — awaiting Paco's signature)"; row 48 likewise for 0034.
- [ ] **configuration.md**: table row `HOUGE_DECISION_DIGEST_AT` → `HOUGE_IMPROVE_AT` | `21:00` | "Local time (`HH:MM`, in `HOUGE_DISPLAY_TZ`) of the daily improvement tick. No `off`: `HOUGE_IMPROVE_ENABLED=false` is the switch. A typo keeps 21:00. `HOUGE_DECISION_DIGEST_AT` is retired (named once at boot if still set; delete the `.env` line)."; the `HOUGE_IMPROVE_ENABLED` row drops its digest clauses; §"The digest" (1135–1143) → "**No digest.** A lesson or fact from a correction Paco typed on the memory lane applies at the tick (one `/changes` line: `📒 Lesson #N learned from your correction (scope): … — undo: /forget N`); every other proposal is one card (Accept / Dismiss); ended standing grants are `/changes` rows; a failing tick pages `improve_tick_degraded`; `/status` carries the counts and the Improvement (7 d) line."; 1145–1146 "at `HOUGE_IMPROVE_AT`" (drop "before the digest and also when the digest is off"); 1131–1132 (rollback sentence about a digest in the outbox) → "a card still in the outbox is sent without its buttons; an old ✅/❌ answers 'closed'"; topics paragraph (704–706): "the digest" → "improvement cards"; log list gains `improve_log`, `standing_log`; the incident-route paragraph names `improve_tick_degraded` as a page kind.
- [ ] **jev-decision-layer.md**: 77–80 → "There is no daily digest (spec 2026-11-07): improvements the tick applies and standing-grant ends are `/changes` rows, proposals that need a tap are cards, a failing tick pages `improve_tick_degraded`, and `/status` holds the counts."; 100 drop "The decision digest counts re-asks…"; 102 "Digest ✅/❌, 🔍 Dig deeper" → "🔍 Dig deeper"; 260 drop "which sets the digest's unsure band"; 268 "the digest's Health line" → "`/status`"; 291–293 → "**Effects.** Automatic: the `_pending` skill draft, and a lesson or fact from a correction Paco typed (`autoApplies`: memlane_fix rows, no prior, backstops, one `/changes` line with its undo). Everything else is a card…; the card of a lesson shows its AVOID."
- [ ] **decision-map.md**: 18 "digest ✅/❌" → "Accept on a card"; 29 "The decision digest, approval cards and Undo cards are chat topics" → "Improvement cards, approval cards and Undo cards are chat topics; applied improvements and standing-grant ends are change-log rows"; 62 "digest to chat" → "cards to chat"; 127 → "mixed (`pacoWordsOnly: autoApplies`) | code: the skill-authoring job into `_pending`, and a lesson/fact from a correction Paco typed, applied with a `/changes` line; Jev/Tiny: proposals as cards (schedule, knowledge, tool gap, ladder; lesson/fact from any other correction)".
- [ ] **README.md**: 204 add "the Improvement (7 d) line"; 208 (the five-section digest) → "Improvements learned from your own corrections apply on their own and show in `/changes` with their undo command; anything else arrives as one card with Accept / Dismiss; `/forget <id>` and `/forget_memory <id>` undo an applied one."; 336 "The daily digest, standing approvals" → "Proposal cards, standing approvals". **CONTEXT.md**: 79 "offers as a tap on the daily digest" → "applies on its own (from a correction Paco typed) with a `/changes` line, or offers as one card"; 97 the **Digest** entry → "**Proposal card**: The one Telegram card a proposal that needs a tap arrives on (Accept / Dismiss); the digest it replaced is gone (spec 2026-11-07)." **ROADMAP.md**: one delta paragraph after the 2b-ii entry: "**Improvement auto-apply (2026-11-07):** lessons and facts from Paco's own memory-lane corrections apply at the tick with `/changes` lines and undo commands; every other proposal is a card; the 21:00 digest and its ✅/❌ are gone (`HOUGE_DECISION_DIGEST_AT` → `HOUGE_IMPROVE_AT`); standing ends are `/changes` rows; `improve_tick_degraded` pages. Known gap carried: no review surface produces `review_bad`." and strike the stale "digest on" claims at 304–308 with a one-line note.
- [ ] **State files**: `tasks/todo.md` — a new "CURRENT SYSTEM STATE — 2026-11-07" block (what exists: the file list above; evidence: typecheck, suite count with none skipped, the gate's verdict lines; reviews; Paco's actions owed: sign the ADR 0034/0031 amendments, delete `HOUGE_DECISION_DIGEST_AT=ON` from `.env`); mark the "(b) Improvement proposals auto-apply" item shipped once merged. `tasks/lessons.md` — one lesson: "a spec's file citation (`src/core/standing-approval.ts`) was checked against the tree before the plan; the plan cites the real file and the real transaction". `sessions.md` — one arc entry, newest last. Docs parity: `npx vitest run tests/docs tests/adr` green (commands unchanged; env var documented; ADR index rows; decision-map ids).
- [ ] Run `npm run typecheck && npm test && npm run build` — green, none skipped. Grep `README.md CONTEXT.md docs/reference docs/ROADMAP.md deploy/launchd/README.md` for `digest`, `HOUGE_DECISION_DIGEST_AT`, `Unsure`, `tonight` and confirm every hit is a reader digest or a historical entry.
- [ ] Commit (docs separately from the ADR text):

```
git add docs/reference/configuration.md docs/reference/jev-decision-layer.md docs/reference/decision-map.md README.md CONTEXT.md docs/ROADMAP.md tests/docs/parity.ts
git commit -m "docs: no digest; HOUGE_IMPROVE_AT; cards, /changes rows and improve_tick_degraded

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add docs/decisions/0034-decision-ladder-consolidated.md docs/decisions/0031-chat-carries-what-needs-paco.md docs/decisions/README.md tests/adr/0034-paco-words-only.test.ts
git commit -m "docs(adr): 0034 2.2/2.5/6.6/10.2/10.5/11.3/13.1/13.2 and 0031 amendments drafted, awaiting Paco's signature

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add tasks/todo.md tasks/lessons.md sessions.md
git commit -m "docs(state): improve auto-apply shipped on the branch; evidence and Paco's actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## After the tasks

Per AGENTS.md: parallel independent reviewers over the whole diff (security / correctness / testing / adversarial, model ≠ implementer), codex whole-diff pass, merge to `main`, rebuild `dist/`, check `houge.parked` / `houge.kill` and no run in flight, `launchctl kickstart -k gui/$(id -u)/com.houge.daemon`, verify the new pid and the boot line naming `HOUGE_DECISION_DIGEST_AT` as retired, report. The first 21:00 after deploy sends no digest; Paco deletes the `.env` line at leisure.
