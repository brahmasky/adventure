# Stage 4B — `approval.bind` + `secret.redact` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `approval.bind` and `secret.redact` as locked rule-only decision-ladder entries, each recorded at one call site that wraps today's code unchanged, and prove with one Stage 4 differential gate that nothing behaves differently.

**Architecture:** Each entry is a one-rung rule module under `src/decisions/entries/`. The runner's consume block (P3+P4) moves into a private `bindApproval` helper that calls `decideSync(APPROVAL_BIND, …)` right after the sink returns. The store's three report wrappers go through a private `redactReport` that calls `decideSync(SECRET_REDACT, …)` only when the firewall is armed. The store gets its recorder from an injected factory, built by one importable `storeOptionsFor`. In both seams the raw result still drives the branch (ruling R1). The differential script, live gate and rollback check compare this build against old dists built at `548cb87` and `1451a66`.

**Tech Stack:** Node 25, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest, zero runtime deps.

**Spec:** `docs/superpowers/specs/2026-10-29-ladder-stage4b-bind-redact-design.md` (Rev 2, APPROVED by Paco 2026-10-29: Decisions 1-A, 2-A, 3-A). Executors read the sections each task names.

## Global Constraints

- `dependencies: {}` stays empty. Node stdlib plus devDeps only.
- **Move, don't improve** (ADR 0030 §6.2): no consume, resolve or redaction may change what it does. Byte-identical `CapabilityResult`s, `error_ref` strings, approval rows, outbox `payload_json`/`payload_hash`, and chat-turn text.
- **R1:** the call site branches on the raw sink result or redactor output. The decision result is never read for control flow.
- **R2:** a sink that throws propagates exactly as today, with no bind row.
- Decision 1-A: `authoriseStanding` / the standing CAS is untouched, and a standing use writes no `approval.bind` row.
- Decision 2-A: the resolve side is untouched (`processApprovalTrigger`, `resolveToolApprovalWithinTransaction`, `approvalChatBound`, `standingDeny`).
- Decision 3-A: `secret.redact` covers only the three `truncateForChat` wrappers (`enqueueFinalReportNotification`, `enqueueFailureNotification`, `enqueueEvolutionReportNotification`). R2–R6 are untouched.
- `approval.bind` reason codes, exactly, in this order: `["no_sink", "unknown_approval", "not_approved", "expired", "action_mismatch", "owner_mismatch", "requester_mismatch", "lease_lost"]`. Any other code is recorded with `reason_code` null.
- `secret.redact` reason codes, exactly: `["final_report", "failure_report", "evolution_report"]`. It records only `masked` (no `alwaysRecord`). With the firewall off it makes no decision and writes no row.
- `approval.bind` is `alwaysRecord: true`.
- `ENTRY_IDS` grows from 18 to 20. `"approval.bind"` and `"secret.redact"` are appended after `"posture.kill"`, in that order, and `REGISTRY` gets the same order.
- `run-store.ts` must not import `src/decisions/record.ts` at run time, because that creates a cycle. The recorder is injected as `decisionRecorder?: (store: RunStore) => DecisionRecorder`.
- Store option type: `{ redact: (s: string) => string; decisionRecorder: (store: RunStore) => DecisionRecorder } | { redact?: never; decisionRecorder?: (store: RunStore) => DecisionRecorder }`. `{ redact }` alone must not compile.
- Functions stay under 50 lines. `CapabilityRunner.execute` must not grow in line count.
- Tests live in `tests/<area>/` mirroring `src/`. Every test encodes why the behaviour matters.
- Scripts never write the live DB. They use VACUUM copies under a temp dir that is deleted on every exit path unless `--keep`. Transcripts and seeded values are never printed unredacted and never committed (the repo is PUBLIC).
- Protected files touched under the approved spec (Tier A):
  - `src/decisions/**`
  - `src/capabilities/capability-runner.ts`
  - `src/run/run-store.ts`
  - `src/cli.ts`
  - `src/capabilities/self-write-guard.ts` (`PROTECTED_FILES` gains `src/run/store-options.ts`)
  - `docs/decisions/0030-*`
- Commands:
  - `npm run typecheck && npm test && npm run build`
  - single file: `npx vitest run <file>`
- `codex`: `codex exec … < /dev/null -o <file>`.
- Read-only inputs outside the worktree (gitignored, so absent in `.worktrees/`): transcripts `--transcripts-dir` default `/Users/xiaochuan/Projects/adventure/omp/sessions/chat-8744196214`; live DB `--live-db` default `/Users/xiaochuan/Projects/adventure/houge.sqlite`, only ever `VACUUM INTO` a temp copy, never opened for write. Never copy either into the repo.
- Old dists (built): `.worktrees/base-548cb87/dist`, `.worktrees/base-1451a66/dist`.
- Worktree: `.worktrees/stage4b` on branch `stage4b`. The gates need `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env`.

## Plan-level rulings (read before Task 1)

- **P-R1 (red-first).** Spec §6 asks for characterisation tables "written red-first in the plan's first task". Reading: Task 1 commits today's behaviour pins (results, rows, bytes) against the unchanged code, so they are green there. Every later task adds its own new-row assertions red → green. Every later diff is then checked against pins written before it. Cost if wrong: none, since the pins exist either way.
- **P-R2.** `storeOptionsFor(broker?: SecretBroker, env: NodeJS.ProcessEnv = process.env)` builds `decisionRecorder: (s) => storeRecorder(s, { env })`, matching every other production `storeRecorder` call (`bridge-handler.ts:219`). The spec names only the `broker` parameter, and `env` defaults so the call stays as specified.
- **P-R3.** The digest's `secret.redact` count line carries the scope note ` (final, failure and evolution reports only)` (spec §4, "the digest and ADR wording say so"). This is the one deliberate digest text change.
- **P-R4.** `.mjs` callers that pass `{ redact }` (`scripts/improve-sanity.mjs`) are not typechecked. They are left alone and get the no-op recorder at run time, which is the same as today.

## File map

| File | Change | Task |
|---|---|---|
| `tests/capabilities/approval-bind-matrix.test.ts` | new: binding characterisation matrix | 1, 3 |
| `tests/run/report-redaction-corpus.test.ts` | new: redaction characterisation classes | 1, 5 |
| `src/decisions/entries/approval-bind.ts`, `src/decisions/entries/secret-redact.ts` | new entries | 2 |
| `src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `scripts/live-gate-ladder-stage3-wired.mjs` | 18 → 20 | 2 |
| `src/capabilities/capability-runner.ts` | `bindApproval` | 3 |
| `src/run/store-options.ts`, `src/run/run-store.ts` (ctor), `src/cli.ts`, `src/capabilities/self-write-guard.ts`, 5 test callers | `StoreOptions`, injected recorder | 4 |
| `src/run/run-store.ts` (wrappers) | `redactReport` | 5 |
| `src/decisions/digest.ts` | scope note | 6 |
| `scripts/stage4-diff-lib.mjs`, `scripts/check-ladder-stage4-differential.mjs`, `scripts/stage4-corpora/*.mjs` | differential | 7–10 |
| `scripts/live-gate-ladder-stage4b.mjs` | live gate | 11 |
| `scripts/check-ladder-stage4b-rollback.mjs` | rollback check | 12 |


---

### Task 1: Characterisation pins (today's behaviour, before any change)

**Files:**
- Create: `tests/capabilities/approval-bind-matrix.test.ts`
- Create: `tests/run/report-redaction-corpus.test.ts`

**Interfaces:**
- Consumes: the existing code only.
- Produces: two test files that later tasks extend with new-row assertions. Each file exports nothing. Put each fixture builder in its own top-level function, named below, so Tasks 3 and 5 can add `it` blocks that reuse them.

Read spec §2.1 (P1–P7), §2.2 (R1), §6 items 4 and 5. Existing fixtures:
- omp sink: `src/omp/tool-approval-sink.ts`, `tests/omp/tool-approval-sink.test.ts`
- store approval and standing seeding: `tests/run/run-store-standing.test.ts`, `tests/run/run-store-approvals.test.ts`
- run creation with a Telegram target: `tests/run/run-store-redaction.test.ts` `makeRun`
- runner with a stub registry: `tests/capabilities/capability-runner-approvals.test.ts`

- [ ] **Step 1: Binding matrix — `approval-bind-matrix.test.ts`.**

  Build `bindFixture()`. It returns:
  - a real `RunStore.openInMemory()`;
  - a running run that holds a lease for worker `w1`;
  - a `CapabilityRunner` over a stub registry whose adapter can be set per case to succeed, fail (`{ ok: false, … }`) or time out;
  - the **real** omp sink from `tool-approval-sink.ts`, wired to that store;
  - a helper `approvedRow(overrides)` that inserts a `tool_approvals` row in a chosen state, for a chosen run, worker, requester and capability, with a chosen fingerprint and `expires_at`.

  It also returns `recorded: Array<{ entry_id, verdict, reason_code }>`, a recorder that `execute` receives as `input.recorder`. It collects through `storeRecorder(store)` and reads back with `store` queries on `decisions`.

  One `it` per row of spec §6 item 4. Each case asserts all of the following:
  - (a) the `CapabilityResult`, exactly (status and `error_ref` bytes);
  - (b) the `tool_approvals` row's `state`, read back;
  - (c) the `standing_approvals` / `standing_uses` rows where relevant;
  - (d) the ledger event types for the run.

  The rows:
  - happy path, adapter ok → `succeeded`, row `consumed`;
  - `unknown_approval` (row of another run; no row);
  - `not_approved` for `pending`, `denied` and `consumed`;
  - `expired` (`expires_at` 1 ms in the past);
  - `action_mismatch`, once with the capability changed and once with one byte of input changed;
  - `owner_mismatch` (other worker);
  - `requester_mismatch`;
  - the operator-approver swap on a schedule-born run (expected ok, per P5);
  - `lease_lost` (lease expired; run not `running`);
  - `standing_trial` on a candidate row (`sealing` follows) and on a non-candidate row (no credit);
  - a second consume of the same row → `not_approved`;
  - consume ok then adapter failure, and consume ok then adapter timeout. For both, the row is `consumed` and the result is the adapter's failure;
  - the multi-fault cases:
    - expired + one-byte mismatch → `expired`;
    - wrong owner + wrong requester → `owner_mismatch`;
    - not approved + expired → `not_approved`;
  - P2: a contract that now denies → `denied_on_revalidation`, and the row stays `approved`;
  - P3: a runner built with no sink → `{status:"failed", error_ref:"Approval sink is not available for resume"}`.

  Expected `error_ref` format is `"<code>: <code>"` (P5).

  Add one `it` for the run-level fixture path, through `CoreWorker.executeRun` with `force_gated_capability`, copying the flow of `eval-runner.ts:240–290` (`runApprovalResumeCase`) and `tests/core/core-worker-approvals.test.ts`. This path reaches `runGatedCapability` (`core-worker.ts:801–809`, which passes no recorder) and `store.consumeApprovedApproval` (`run-store.ts:7738`). Cover the happy path and the eight `APPROVAL_*` / `RUN_NOT_RUNNING` codes, and pin the results. Do not substitute a direct `store.consumeApprovedApproval` call: that never goes through the runner, so Task 3's zero-row check would be vacuous. If the seam truly cannot be driven, stop and report NEEDS_CONTEXT. As a control, pin that the `decisions` table holds **zero rows of any entry** after the run-level path, which shows the recorder is genuinely absent there.

- [ ] **Step 2: Redaction classes — `report-redaction-corpus.test.ts`.**

  Build `fakeBroker()`: `createSecretBroker` over nine fake env values with the shapes of spec §6 item 5:
  - `HOUGE_TELEGRAM_BOT_TOKEN`: `123456789:AA` + 33 chars;
  - `KIMI_API_KEY`: `sk-…`;
  - `GEMINI_API_KEY`: `AIza…`;
  - `HOUGE_GMAIL_REFRESH_TOKEN`: `1//0g…`;
  - `TYPESAFE_API_KEY`: 64 hex;
  - `TAVILY_API_KEY`: contains ``$^*+?.()[]{}|\``;
  - `FIRECRAWL_API_KEY`: a substring of the Kimi value, ≥ 6 chars;
  - `HOUGE_GMAIL_CLIENT_SECRET`: 5 chars, must not mask;
  - `CLAUDE_CODE_OAUTH_TOKEN`: contains `\n`.

  Build `reportFixture(redact?)`, which opens `RunStore.openInMemory(redact ? { redact } : {})` plus a run with a Telegram target.

  Pin, for each wrapper (final report, failure notice, evolution report with tool `self_write_propose`), the outbox row's `payload_json`, `payload_hash` and `state`. For the evolution wrapper, also pin the `chat_turns` text and the return value. Cover these classes:
  - **maskable**: each ≥ 6-char value planted at the start, at the end, twice, and at offset 2,000 of a 3,000-char text;
  - **cut boundary**: text = `"x".repeat(3895) + value + " tail"`, with no leading whitespace, so after redaction the 10-char marker starts at index 3895 and straddles 3,900. The fixture asserts its own premise: the stored text contains `"x".repeat(3895) + "«reda"` followed directly by `"\n\n… (truncated)"`. If the premise does not hold, the fixture FAILs; it never passes as an ordinary truncation. Pin the exact stored bytes against the string computed with today's semantics (redact → trim → slice 3900 + `"\n\n… (truncated)"`);
  - **short-value control**: the 5-char value appears in the stored text;
  - **firewall off**: the same maskable texts stored with their raw values;
  - **clean**: empty, whitespace-only, and 3,899 / 3,900 / 3,901-char texts;
  - **enqueue outcomes**:
    - duplicate re-enqueue → `duplicate`, one outbox row;
    - conflict (same key, different text) → `conflict`;
    - insert failure: `CREATE TRIGGER t BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'boom'); END` → the call throws `boom`;
    - outer transaction: `BEGIN` via the store's db, enqueue, `ROLLBACK` → no outbox row.

  For the outer-rollback case, reach the DB through the existing test seam `store["db"]`, or through whatever the existing tests use. Find it with `grep -rn '\["db"\]' tests | head`.

  After the maskable cases, scan every TEXT column of every table (`SELECT name FROM sqlite_master WHERE type='table'`, then `PRAGMA table_info`) for the eight maskable values and assert zero hits. For the short and firewall-off controls, assert the exact hit counts.

- [ ] **Step 3: Run both files. Expected: PASS on the unchanged code.**

  Run: `npx vitest run tests/capabilities/approval-bind-matrix.test.ts tests/run/report-redaction-corpus.test.ts`

  A FAIL here usually means a pin is wrong; fix the pin to today's behaviour and note it in the report. **Exception:** a hit for a maskable (≥ 6-char) value in the full-DB scan is a real leak in today's code, not a wrong pin. Stop, do not edit the assertion, and report BLOCKED with the table and column.

- [ ] **Step 4: Commit.**

```bash
git add tests/capabilities/approval-bind-matrix.test.ts tests/run/report-redaction-corpus.test.ts
git commit -m "test(stage4b): characterise consume binding and report redaction before the move"
```

---

### Task 2: The two entries and the registry (18 → 20)

**Files:**
- Create: `src/decisions/entries/approval-bind.ts`, `src/decisions/entries/secret-redact.ts`
- Modify: `src/decisions/entry-ids.ts:5`, `src/decisions/registry.ts`
- Modify: `scripts/live-gate-ladder-stage3-wired.mjs:35`: append `"approval.bind","secret.redact"` to the `ids` list, as spec §9 names. It asserts "includes", so this only widens the check. Ruling recorded in the plan-review notes.
- Test: `tests/decisions/approval-bind.test.ts`, `tests/decisions/secret-redact.test.ts`, `tests/decisions/registry.test.ts`

**Interfaces:**
- Produces:
  - `APPROVAL_BIND: Entry<{ ok: boolean; code?: string }, ApprovalBindVerdict>`
  - `ApprovalBindVerdict = "bound" | "unbound"`
  - `SECRET_REDACT: Entry<{ masked: boolean; seam: RedactSeam }, SecretRedactVerdict>`
  - `SecretRedactVerdict = "clean" | "masked"`
  - `RedactSeam = "final_report" | "failure_report" | "evolution_report"`

- [ ] **Step 1: Write failing tests.**

  `tests/decisions/approval-bind.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { APPROVAL_BIND } from "../../src/decisions/entries/approval-bind.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
const run = (s: { ok: boolean; code?: string }) => decideSync(APPROVAL_BIND, s, { run_id: "r", tool_call_id: "t", recorder });

describe("approval.bind — a spent Paco tap always leaves a row naming why it bound or not", () => {
  it("is locked, rule-only, always recorded, sound", () => {
    expect(APPROVAL_BIND.locked).toBe(true);
    expect(APPROVAL_BIND.alwaysRecord).toBe(true);
    expect(APPROVAL_BIND.ladder.map((r) => r.kind)).toEqual(["rule"]);
    expect(entryProblems(APPROVAL_BIND as unknown as AnyEntry)).toEqual([]);
  });
  it("ok → bound, no reason", () => { expect(run({ ok: true })).toMatchObject({ verdict: "bound", rung: "rule" }); });
  it.each(["no_sink", "unknown_approval", "not_approved", "expired", "action_mismatch", "owner_mismatch", "requester_mismatch", "lease_lost"])(
    "a listed sink code %s → unbound with that reason", (code) => { expect(run({ ok: false, code })).toMatchObject({ verdict: "unbound", reason: code }); });
  it("an unlisted code (the run-level APPROVAL_* family) → unbound with no reason, so the row's reason_code is null", () => {
    expect(run({ ok: false, code: "APPROVAL_NOT_FOUND" }).reason ?? null).toBeNull();
  });
});
```

  `tests/decisions/secret-redact.test.ts`: the same shape.
  - Locked, rule-only, sound, and `alwaysRecord` not set.
  - `{masked:false, seam:"final_report"}` → `clean`, no reason.
  - `{masked:true, seam}` → `masked` with `reason = seam`, for each of the three seams.

  `tests/decisions/registry.test.ts`: add one `it`. For `approval.bind` and `secret.redact`:
  - `entryById(id)` is defined;
  - `.locked === true`;
  - `ladder.length === 1`, with `ladder[0].kind === "rule"`;
  - the id is in `LOCKED_ENTRY_IDS`;
  - `ENTRY_IDS.length === 20`.

- [ ] **Step 2: Run.** `npx vitest run tests/decisions/approval-bind.test.ts tests/decisions/secret-redact.test.ts tests/decisions/registry.test.ts`. Expected: FAIL, because the modules do not exist.

- [ ] **Step 3: Implement.**

  `src/decisions/entries/approval-bind.ts`:

```ts
import type { Entry, RungAnswer } from "../types.js";

export type ApprovalBindVerdict = "bound" | "unbound";
/** The omp sink's seven refusal codes verbatim (run-store.ts consumeToolApproval) plus no_sink for a resume with no sink. */
export const APPROVAL_BIND_REASONS = ["no_sink", "unknown_approval", "not_approved", "expired", "action_mismatch", "owner_mismatch", "requester_mismatch", "lease_lost"] as const;
const LISTED: ReadonlySet<string> = new Set(APPROVAL_BIND_REASONS);

function rule(s: { ok: boolean; code?: string }): RungAnswer<ApprovalBindVerdict> {
  if (s.ok) return { verdict: "bound" };
  return s.code !== undefined && LISTED.has(s.code) ? { verdict: "unbound", reason: s.code } : { verdict: "unbound" };
}

export const APPROVAL_BIND: Entry<{ ok: boolean; code?: string }, ApprovalBindVerdict> = {
  id: "approval.bind", version: 1, stage: "pre_tool", input: "tool", locked: true,
  question: "Does this consume bind the approved row to this exact action, owner and requester?",
  verdicts: ["bound", "unbound"],
  ladder: [{ kind: "rule", name: "consumeBinding", decide: rule }],
  fail: "unbound", defaultVerdict: "bound", alwaysRecord: true, outcomes: [], armed: { rule: "on" },
  effects: { bound: { kind: "none", reversible: true, announced: "none" }, unbound: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [...APPROVAL_BIND_REASONS],
};
```

  `src/decisions/entries/secret-redact.ts`:

```ts
import type { Entry, RungAnswer } from "../types.js";

export type SecretRedactVerdict = "clean" | "masked";
/** The three report wrappers that redact through truncateForChat (spec §2.2 R1a–c); nothing else is counted. */
export type RedactSeam = "final_report" | "failure_report" | "evolution_report";

function rule(s: { masked: boolean; seam: RedactSeam }): RungAnswer<SecretRedactVerdict> {
  return s.masked ? { verdict: "masked", reason: s.seam } : { verdict: "clean" };
}

export const SECRET_REDACT: Entry<{ masked: boolean; seam: RedactSeam }, SecretRedactVerdict> = {
  id: "secret.redact", version: 1, stage: "settle", input: "tool", locked: true,
  question: "Did this outbound report carry a known secret value (ADR 0015) that was masked before it was cut?",
  verdicts: ["clean", "masked"],
  ladder: [{ kind: "rule", name: "brokerValues", decide: rule }],
  fail: "masked", defaultVerdict: "clean", outcomes: [], armed: { rule: "on" },
  effects: { clean: { kind: "none", reversible: true, announced: "none" }, masked: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["final_report", "failure_report", "evolution_report"],
};
```

  Check that `Entry` accepts `alwaysRecord` (it does: `record.ts` reads `entry.alwaysRecord`) and that `stage: "settle"` is a valid `stage` value (`grep -n "stage:" src/decisions/types.ts`). If `"settle"` is not valid, use the closest existing stage that a post-tool entry uses, and note it in the report.

  In `entry-ids.ts`, append `"approval.bind", "secret.redact"` after `"posture.kill"`. In `registry.ts`, add the imports and append `APPROVAL_BIND as unknown as AnyEntry, SECRET_REDACT as unknown as AnyEntry` after `POSTURE_KILL`.

- [ ] **Step 4: Run the three files, then `npm run typecheck` and `npx vitest run tests/decisions tests/run/run-store-ladder*`.**

  Expected: PASS. Also run `grep -rn "ENTRY_IDS.length\|toHaveLength(18)" tests scripts` and fix every count pin from 18 to 20.

- [ ] **Step 5: Commit.**

```bash
git add src/decisions/entries/approval-bind.ts src/decisions/entries/secret-redact.ts src/decisions/entry-ids.ts src/decisions/registry.ts tests/decisions/approval-bind.test.ts tests/decisions/secret-redact.test.ts tests/decisions/registry.test.ts
git commit -m "feat(decisions): register approval.bind and secret.redact as locked rule-only entries"
```

---

### Task 3: `approval.bind` call site — `bindApproval` in the runner

**Files:**
- Modify: `src/capabilities/capability-runner.ts:192–219`
- Test: extend `tests/capabilities/approval-bind-matrix.test.ts`

**Interfaces:**
- Consumes: `APPROVAL_BIND` (Task 2), `decideSync` (`src/decisions/decide.js`), and the `recorder` that `execute` builds at `:120`.
- Produces: a private `bindApproval(...)` that no other task calls.

- [ ] **Step 1: Add red assertions to the matrix.**

  For every omp-sink case in Task 1, add the expected `approval.bind` rows, read from the `decisions` table with `entry_id = 'approval.bind'` for the run:
  - exactly one row per attempted consume;
  - `verdict` is `bound` iff **that attempt** moved the row `approved → consumed`. Read the state immediately before the call and again after it: `bound` ⇔ before = `approved` ∧ after = `consumed` ∧ the sink returned ok. A second consume of an already-`consumed` row is therefore `unbound` / `not_approved`. Never derive the verdict from the final result;
  - `reason_code` is the sink code when unbound;
  - `tool_call_id` is `input.tool_call_id`, the runner's own id, not the sink's `tool_<uuid>`.

  Also add:
  - P3 → one row `unbound` / `no_sink`;
  - **zero** rows on P2, on a first call that asks, on a standing use (`capability-runner-standing.test.ts` has the fixture), and on the whole run-level fixture path;
  - a sink whose `consumeApprovedApproval` throws → `execute` rejects with the same error and writes zero bind rows.

- [ ] **Step 2: Run the matrix. Expected: FAIL on the new row assertions only. Every Task 1 pin still passes.**

- [ ] **Step 3: Implement.** Replace `:192–219`, the `if (input.approved_approval_id) { … }` block, with:

```ts
    if (input.approved_approval_id) {
      const bound = this.bindApproval(input, input.approved_approval_id, adapter_input_hash, action_fingerprint, recorder);
      if (!bound.ok) return bound.result;
    }
```

  Add the method next to `authoriseStanding`:

```ts
  /**
   * P3+P4 (Stage 4B spec §5): the consume, moved unchanged — same argument object, same random ids, same failure results.
   * approval.bind records the sink's answer before anything branches on it; the raw answer drives (R1). A throwing sink
   * propagates with no row (R2). Not reached by a first call or a standing use.
   */
  private bindApproval(input: CapabilityExecutionInput, approval_id: string, adapter_input_hash: string, action_fingerprint: string,
    recorder: DecisionRecorder): { ok: true } | { ok: false; result: CapabilityResult } {
    const ctx = { run_id: input.run_id ?? null, tool_call_id: input.tool_call_id ?? null, recorder };
    if (!this.approvals) {
      decideSync(APPROVAL_BIND, { ok: false, code: "no_sink" }, ctx);
      return { ok: false, result: { status: "failed", error_ref: "Approval sink is not available for resume" } };
    }
    const consumption = this.approvals.consumeApprovedApproval({
      run_id: input.run_id ?? "",
      approval_id,
      requester: input.requester ?? { kind: "system", id: "core" },
      capability: input.capability,
      adapter_input_hash,
      action_fingerprint,
      tool_call_id: `tool_${randomUUID()}`,
      operation_id: `op_${randomUUID()}`,
      consumed_at: new Date().toISOString(),
      ...(input.standing_trial ? { standing_trial: input.standing_trial } : {})
    });
    decideSync(APPROVAL_BIND, consumption.ok ? { ok: true } : { ok: false, code: consumption.error.code }, ctx);
    if (consumption.ok) return { ok: true };
    return { ok: false, result: { status: "failed", error_ref: `${consumption.error.code}: ${consumption.error.message}` } };
  }
```

  Import `APPROVAL_BIND` beside `TOOL_POLICY` and `DecisionRecorder` from `../decisions/types.js`, matching how the file already imports from `src/decisions`. Make the `recorder` local at `:120` typed as `DecisionRecorder`; it is already `input.recorder ?? { record: () => null }`. Keep the field order of the argument object exactly as above, since it is today's order.

  Check that `execute` did not grow: run `awk` over its line span before and after and record both numbers in the report.

- [ ] **Step 4: Run.**
  - `npx vitest run tests/capabilities tests/omp/tool-approval-sink.test.ts tests/run/run-store-standing.test.ts` → PASS.
  - `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**

```bash
git add src/capabilities/capability-runner.ts tests/capabilities/approval-bind-matrix.test.ts
git commit -m "feat(capabilities): approval.bind records every omp-sink consume (behaviour unchanged)"
```

---

### Task 4: `StoreOptions`, the injected recorder, `storeOptionsFor` (no `secret.redact` yet)

**Files:**
- Create: `src/run/store-options.ts`; test `tests/run/store-options.test.ts`
- Modify: `src/run/run-store.ts` — the options type and constructor (`:1405–1421`)
- Modify: `src/cli.ts:33–34` (`storeOptions` becomes `storeOptionsFor(broker)`)
- Modify: `src/capabilities/self-write-guard.ts` `PROTECTED_FILES` (+ `"src/run/store-options.ts"`, next to `src/cli.ts`'s line). Update the guard test that pins the list, if one does (`grep -rln "PROTECTED_FILES" tests`).
- Modify: every TS caller that passes `{ redact }` alone. `npm run typecheck` is the authority for the list. The review found five files:
  - `tests/decisions/injection-judge.test.ts:174,288`
  - `tests/decisions/jev-anchor-import.test.ts:180`
  - `tests/run/run-store-ladder-2a.test.ts:72`
  - `tests/run/run-store-redaction.test.ts:33,49,62`
  - `tests/helpers/triage-harness.ts:108`

  Each gains `decisionRecorder: () => ({ record: () => null })`, a **no-op** factory, so their decision-row counts cannot change. Only tests that assert on decisions use `storeRecorder`.

**Interfaces:**
- Consumes: `storeRecorder` (`src/decisions/record.ts`); the broker type from `src/config/secret-broker.ts` (find the exported name with `grep -n "^export" src/config/secret-broker.ts`).
- Produces, for Tasks 5, 10, 11 and 12:

```ts
// src/run/run-store.ts (the store owns its option type)
export type StoreOptions =
  | { redact: (s: string) => string; decisionRecorder: (store: RunStore) => DecisionRecorder }
  | { redact?: never; decisionRecorder?: (store: RunStore) => DecisionRecorder };
// RunStore: private readonly decisionRecorder: DecisionRecorder  (built in the constructor after migrate())
// src/run/store-options.ts
export type { StoreOptions } from "./run-store.js";
export function storeOptionsFor(broker?: SecretBroker, env?: NodeJS.ProcessEnv): StoreOptions;
```

- [ ] **Step 1: Write failing tests.** `tests/run/store-options.test.ts`:
  - With a broker, `storeOptionsFor(broker)` carries `redact === broker.redact` and a `decisionRecorder` function. Without one, it has no `redact` and still has a `decisionRecorder`.
  - A store opened with `storeOptionsFor(...)` holds a recorder that writes. Prove it through the store's private `decisionRecorder`: `(store as unknown as { decisionRecorder: DecisionRecorder }).decisionRecorder.record(...)` with a minimal `decideSync` result for `APPROVAL_BIND` writes one `decisions` row. Task 5 replaces this with the real report path.
  - Type pin, inside `if (false as boolean) { … }`:

```ts
// @ts-expect-error — redact without a recorder must not compile (spec §5, senior B1)
RunStore.openInMemory({ redact: (s: string) => s });
```

- [ ] **Step 2: Run. Expected: FAIL. The module is missing, and the type pin is unused, so typecheck reports TS2578.**

- [ ] **Step 3: Implement.**

  `run-store.ts`:

```ts
  private readonly decisionRecorder: DecisionRecorder;

  private constructor(private readonly db: SqliteDatabase, options: StoreOptions = {}) {
    this.redact = options.redact ?? ((s) => s);
    this.redactionEnabled = options.redact !== undefined;
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    // Injected, not imported: record.ts reaches run-store.ts at run time (incident-alert → invariant-sweep), so a store
    // import of it would be a cycle. Absent → no row (tests and tools that open a bare store).
    this.decisionRecorder = options.decisionRecorder?.(this) ?? { record: () => null };
  }

  static openInMemory(options: StoreOptions = {}): RunStore {
    return new RunStore(new DatabaseSync(":memory:"), options);
  }

  static open(path: string, options: StoreOptions = {}): RunStore {
    return new RunStore(new DatabaseSync(path), options);
  }
```

  `DecisionRecorder` is a type-only import from `../decisions/types.js`. This is safe: `types.ts` imports only a type.

  `src/run/store-options.ts`:

```ts
import type { SecretBroker } from "../config/secret-broker.js";
import { storeRecorder } from "../decisions/record.js";
import type { RunStore, StoreOptions } from "./run-store.js";
export type { StoreOptions } from "./run-store.js";

/**
 * The one place the boot wiring builds a store's options (ADR 0015 + ADR 0030, Stage 4B spec §5): with the firewall armed
 * the redactor and the decision recorder travel together; cli.ts, the live gate and the rollback check all call this.
 */
export function storeOptionsFor(broker?: SecretBroker, env: NodeJS.ProcessEnv = process.env): StoreOptions {
  const decisionRecorder = (s: RunStore): ReturnType<typeof storeRecorder> => storeRecorder(s, { env });
  return broker ? { redact: broker.redact, decisionRecorder } : { decisionRecorder };
}
```

  `cli.ts`: replace `const storeOptions = broker ? { redact: broker.redact } : {};` with `const storeOptions = storeOptionsFor(broker);`, and add the import. Update the comment above it to say that the redactor and the decision recorder travel together.

  `self-write-guard.ts`: add `"src/run/store-options.ts", // ADR 0015 + 0030 boot wiring: the store's redactor and decision recorder travel together` next to `src/cli.ts`.

- [ ] **Step 4: Run.**
  - `npm run typecheck` → 0 errors.
  - `npx vitest run tests/run tests/decisions tests/core/core-worker-triage.test.ts tests/capabilities` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/run/store-options.ts src/run/run-store.ts src/cli.ts src/capabilities/self-write-guard.ts tests/run/store-options.test.ts <the edited callers and guard test>
git commit -m "feat(run): storeOptionsFor carries the redactor and an injected decision recorder together"
```

---

### Task 5: `secret.redact` call site — `redactReport` in the store

**Files:**
- Modify: `src/run/run-store.ts` — the three wrappers (`:7275`, `:7306`, `:7327`) and a new private `redactReport`
- Test: extend `tests/run/report-redaction-corpus.test.ts`; replace the private-recorder probe in `tests/run/store-options.test.ts` with a real masked report

**Interfaces:**
- Consumes: `SECRET_REDACT`, `RedactSeam` (Task 2); `decideSync`; `StoreOptions` / `storeOptionsFor` (Task 4).
- Produces: a private `redactReport(seam, run_id, text): string`.

- [ ] **Step 1: Add red assertions.** The Task 1 corpus fixture now opens its stores with `storeOptionsFor(fakeBroker())`, or with `{}` for firewall-off. Add the row assertions per class, read from `decisions` where `entry_id='secret.redact'`:
  - **maskable**: exactly one `masked` row per wrapper call, with `reason_code` = the seam (`final_report` / `failure_report` / `evolution_report`), `run_id` set, and `tool_call_id` null;
  - **cut boundary**: one row;
  - **short control, firewall-off, clean**: zero rows;
  - **duplicate re-enqueue**: a second row, and still one outbox row;
  - **conflict**: one row more, and the `conflict` result unchanged;
  - **insert failure**: one row, and the same throw;
  - **outer rollback**: no row and no outbox row.

  Every Task 1 byte pin stays unchanged.

  Recursion pin: a `BEFORE INSERT ON decisions WHEN NEW.entry_id='secret.redact'` trigger that raises. A masked final report is still enqueued with the masked text; exactly one open `decision_record_failed` incident exists, with subject `secret.redact`; the call returns.

  `store-options.test.ts`: a store from `storeOptionsFor(fakeBroker())` writes one `secret.redact masked` row for a masked final report. This pins the boot path's wiring.

- [ ] **Step 2: Run. Expected: FAIL on the new row assertions only.**

- [ ] **Step 3: Implement.**

```ts
  /**
   * E8 (Stage 4B spec §5): the three report wrappers' redact-then-cut, recorded. `masked` is decided on the text before
   * trim/cut; the stored bytes come from the same truncateForChat call as before, so payload_hash and the chat-turn copy
   * are unchanged. A row is a masking attempt (a duplicate or failed enqueue still counted), never text. Firewall off: no
   * decision, as before.
   */
  private redactReport(seam: RedactSeam, run_id: string, text: string): string {
    if (this.redactionEnabled) {
      decideSync(SECRET_REDACT, { masked: this.redact(text) !== text, seam }, { run_id, tool_call_id: null, recorder: this.decisionRecorder });
    }
    return truncateForChat(text, this.redact);
  }
```

  Make three replacements:
  - `:7275` `truncateForChat(input.text, this.redact)` → `this.redactReport("final_report", run_id, input.text)`
  - `:7306` → `this.redactReport("failure_report", run_id, text)`
  - `:7327` → `this.redactReport("evolution_report", run_id, input.text)`

  `SECRET_REDACT` and `decideSync` become runtime imports into `run-store.ts`. This is safe: `decide.ts` imports only `./types.js`, and the entry module imports only types.

- [ ] **Step 4: Run.** `npm run typecheck`, then the full `npm test`.

  Expected: PASS. `tests/decisions/jev-version-job.test.ts` has a known bimodal flake (pre-existing, recorded in `tasks/todo.md`). If it fails, rerun that file alone and report both runs.

- [ ] **Step 5: Commit.**

```bash
git add src/run/run-store.ts tests/run/report-redaction-corpus.test.ts tests/run/store-options.test.ts
git commit -m "feat(run): secret.redact records each masked report in the three report wrappers (bytes unchanged)"
```

---

### Task 6: The digest names `secret.redact`'s scope

**Files:**
- Modify: `src/decisions/digest.ts` `countLines` (`:91–103`)
- Test: `tests/decisions/digest.test.ts`

- [ ] **Step 1: Failing test.** `countLines` over one `secret.redact` rule row yields `` `· secret.redact 1 — ${RUNG_LABEL.rule} 1 (final, failure and evolution reports only)` ``. The same input with any other id yields no suffix.

- [ ] **Step 2: Run. Expected: FAIL.**

- [ ] **Step 3: Implement** (P-R3). In the `map` of `countLines`:

```ts
    return `· ${id} ${total} — ${[...known, ...other].join(" · ")}${id === "secret.redact" ? " (final, failure and evolution reports only)" : ""}`;
```

- [ ] **Step 4: Run.** `npx vitest run tests/decisions` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/decisions/digest.ts tests/decisions/digest.test.ts
git commit -m "feat(decisions): digest names secret.redact's scope (three report wrappers only)"
```

---

### Task 7: Differential harness — the shared API, comparator self-test, coverage-pin machinery

**Files:**
- Create: `scripts/stage4-diff-lib.mjs` (the API below)
- Create: `scripts/check-ladder-stage4-differential.mjs` (CLI + runner)
- Create: `scripts/stage4-corpora/stub.mjs` (one trivial registered corpus, which proves the machinery)

Read spec §6 in full. Read `scripts/old-dist-provenance.mjs`, and `scripts/check-decisions-rollback.mjs` for the arg, temp and cleanup pattern.

**Interfaces — produces (exact; Tasks 8–10 depend on them):**

```js
// scripts/stage4-diff-lib.mjs
export const DISTS = { new: <repo>/dist, s3: <--old-dist-3>, s4a: <--old-dist-4a> };   // filled by the CLI
export async function loadDist(dir) // → { RunStore, CapabilityRunner, decideCapability, classifyCommand, gateTargets, createToolApprovalSink,
                                     //     storeOptionsFor: fn | null, decideSync, storeRecorder, createSecretBroker, … } — every export the corpora need,
                                     //     each looked up by name and null when that dist lacks it (old dists have no storeOptionsFor)
export function mkTemp(name)         // → a dir under the run's temp root (deleted on every exit path unless --keep)
export function mkStore(d, kind, path) // kind: "bare" | "firewall"(fake broker) — new dist: storeOptionsFor(...); old dist: { redact } / {}
export function fakeBroker(d)        // the nine fake values of spec §6.5 via d.createSecretBroker; never real env
export function redactForPrint(s)    // fake-broker redaction + 200-char cap; transcript items print as `transcript#<n>` only
export function strip(projection, pair) // pair = ["s3"|"s4a","new"]: removes ids, timestamps, latency_ms, decisions rows of approval.bind / secret.redact;
                                     // maps tool_/op_ ids pairwise to tool#1, op#1 …; when pair[0] === "s3", also deletes every key listed in projection.__s3Omit
                                     // (from BOTH sides — the caller strips each side with the same pair)
export function compare(corpus, item, a, b, pair) // → null | { key, pair, diff } on JSON.stringify(strip(a, pair)) !== JSON.stringify(strip(b, pair))
export function requireNew(corpus, item, name, ok, detail) // a required new-side fact (spec "required, not excluded"); false → FAIL line
// A corpus module default-exports:
// { name, pairs: Array<["s3"|"s4a","new"]> | ((item) => pairs), min: { items: number, branches: string[] },
//   load(ctx): Promise<Item[]>  (Item = { key, tags: string[], ... }), project(d, item, ctx): Promise<object>, required?(d, item, proj, ctx): void }
export const CORPORA = []            // the CLI imports scripts/stage4-corpora/*.mjs and pushes each default export
```

- **CLI:** `node scripts/check-ladder-stage4-differential.mjs --old-dist-3 <dir> --old-dist-4a <dir> [--transcripts-dir <dir>] [--live-db <path>] [--only a,b] [--keep]`.
- **Exit codes:** 0 PASS · 1 FAIL · 2 setup error.
- **Provenance:**
  - `verifyOldDist(s3, new, "548cb87", "decisions/registry.js")`;
  - `verifyOldDist(s4a, new, "1451a66", "capabilities/capability-runner.js")`;
  - a provenance failure exits 2.
- **Per corpus, in order:**
  1. `load` runs.
  2. The coverage pin runs. `items.length < min.items`, or a `min.branches` tag with no item, is a FAIL with the counts printed. A short extraction never passes.
  3. Each item is projected on each pair, and `compare` runs. `required` runs on the new side.
  4. The **self-test** runs: the first item's new-side projection is mutated by one byte (append `"!"` to its first string field), and `compare` must report exactly that one key. Otherwise the result is `FAIL comparator self-test`.
- **Summary:** one line per corpus: items, per-tag counts, pairs, differences, required failures.

- [ ] **Step 1: Write the lib and the CLI.** `stub.mjs` is a corpus of three items over `classifyCommand("ls")`-style pure calls, with `min.items: 3` and one tag.

- [ ] **Step 2: Prove the machinery.**
  - `npm run build`, then `node scripts/check-ladder-stage4-differential.mjs --old-dist-3 … --old-dist-4a … --only stub` → exit 0.
  - Edit `stub.mjs` to `min.items: 4` → exit 1 with the coverage FAIL. Revert.
  - Run with a bad `--old-dist-3` path → exit 2.

  Paste all three outputs into the report.

- [ ] **Step 3: Commit.**

```bash
git add scripts/stage4-diff-lib.mjs scripts/check-ladder-stage4-differential.mjs scripts/stage4-corpora/stub.mjs
git commit -m "test(stage4): differential harness — shared API, comparator self-test, coverage pins"
```

---

### Task 8: Differential — command and path corpora (`548cb87` for the pure and card parts, `1451a66` for rows)

**Files:**
- Create: `scripts/stage4-corpora/command.mjs`, `scripts/stage4-corpora/path.mjs`

**Interfaces:** consumes the Task 7 API exactly as listed. Read spec §6 items 1–2.

- [ ] **Step 1: Command corpus.**

  `load`:
  - **(a) Test-table literals** from `tests/omp/command-matcher.test.ts`. Extract each string literal from the `it.each` tables and **evaluate** it to its runtime value: `JSON.parse` for double-quoted literals, and a restricted unescape (`\\n`, `\\t`, `\\\\`, `\\'`, `\\"`) for single-quoted and template literals without `${`. Take the command cell of each row, which for `[cmd, kind]` rows is the first element. Pins: ≥ 100 items, and ≥ 1 evaluated item contains a real `"\n"` (a heredoc). Assert both.
  - **(b) Transcripts.** Read `--transcripts-dir`'s `*.jsonl` line by line, take `toolCall` objects with `name === "bash"`, and dedupe `arguments.command`. Pin exactly **147** distinct items, failing with the found count otherwise. Keep the items in memory only.
  - **(c) ADR 0028 residuals** (`docs/decisions/0028-*.md:239–241`). Pin **9 items in 7 group tags**:

    | Group tag | Items |
    |---|---|
    | `dd` | `dd if=/dev/zero of=x` |
    | `unlink` | `unlink x` |
    | `interp_e` | `python3 -c 'print(1)'`, `node -e '1'`, `perl -e '1'` |
    | `ansi_c` | `echo $'a\x27b'` |
    | `spaced_arith` | as the ADR words it; read and transcribe |
    | `nested_apostrophe` | as the ADR words it; read and transcribe |
    | `bash_file` | `bash file.sh`, tagged with its expected class as well (plain by design, `command-matcher.ts:203`) |

  `min.branches`: the 7 group tags, plus one tag per classifier kind present in `src/omp/command-matcher.ts` that maps to spec's `external_write`, `destructive`, `plain` and `unseen shell script`. Read the file for the real kind and label names, and record the mapping in a comment.

  `project` returns two parts:
  - **Pure part:** `classifyCommand(cmd)` → `{kind, label}`.
  - **Bridge-seam part:** drive each dist's bridge handler for a `bash` call against a temp store with a running run, the way `scripts/live-gate-ladder-stage3-wired.mjs` and `scripts/live-gate-ladder-2b-hooks.mjs` do. Read them for the exact seam. Record:
    - `asked`: an approval prompt was created;
    - the card's `Action:` label, from the prompt text;
    - the `tool.shell_class` decision row's verdict and reason.

  `pairs`:
  - `[["s3","new"],["s4a","new"]]` for the pure part and for `asked`/label;
  - the row part on `["s4a","new"]` only, since `548cb87` has no `tool.shell_class`.

  Implement this as one projection with a `row` key and `__s3Omit: ["row"]`. `compare(…, pair)` strips both sides with the same pair, so on `["s3","new"]` the `row` key is removed from both sides, and on `["s4a","new"]` it is compared.

  **Every item gets the bridge-seam projection.** There is no subset fallback: the spec requires card, asked and row for the whole corpus. `required` asserts that each item's projection carries `asked`, `label` and `row`, so a missing bridge projection is a FAIL. If the full run is slow, reuse one store per dist and one run per item, or a pool of runs. Report the wall time.

- [ ] **Step 2: Path corpus.**

  `load`:
  - (a) literal paths from `tests/omp/gate-path.test.ts`, evaluated as above;
  - (b) one synthetic item per branch in spec §6 item 2(b), tagged with the branch name. Read `src/omp/gate-path.ts:25–66` and `src/omp/protected-paths.ts`. Each item is run for both `fs_read` and `fs_write`, and every protected path is included;
  - (c) the transcripts' `read`/`write`/`edit` inputs, pinned at exactly **13** (7 + 3 + 3).

  `project`:
  - the `gateTargets` output;
  - the gate's deny code at the bridge seam;
  - the `tool.path` row's verdict and reason, on `s4a` only, as above.

- [ ] **Step 3: Run.** `npm run build`, then `node scripts/check-ladder-stage4-differential.mjs --old-dist-3 … --old-dist-4a … --only command,path`.

  Expected:
  - self-test PASS;
  - every coverage pin PASS;
  - 0 differences;
  - exit 0.

  Paste the summary lines into the report.

- [ ] **Step 4: Commit.**

```bash
git add scripts/stage4-corpora/command.mjs scripts/stage4-corpora/path.mjs scripts/stage4-diff-lib.mjs
git commit -m "test(stage4): differential — command and path corpora, bridge-seam projection"
```

---

### Task 9: Differential — policy matrix and binding matrix

**Files:**
- Create: `scripts/stage4-corpora/policy.mjs`, `scripts/stage4-corpora/binding.mjs`

**Interfaces:** consumes the Task 7 API. Uses Task 1's binding matrix as the item list: rebuild its rows in plain JS, since the vitest file cannot be imported. Read spec §6 items 3–4.

- [ ] **Step 1: Policy matrix.** Run `decideCapability` over the cross product in spec §6 item 3.

  Capability shapes: `ToolRegistry`'s constructor registers nothing, so take the registry the runtime builds. Find it with `grep -rn "new ToolRegistry" src`, and use the module that registers the daemon's capabilities on that dist. If none is exportable, use the capability shapes in `tests/policy/*.test.ts`, transcribed. Name the source in a comment.

  `min.branches`: every key of `REASON_MAP` in `src/decisions/entries/tool-policy.ts`.

  `project` returns:
  - `{decision, reason}`;
  - a `CapabilityRunner.execute` run with a stub sink and a recorder over a temp store, giving the `tool.policy` row's verdict, its reason code, and the row count including the dedup.

  `pairs` is per item:
  - `standing: present` → `[["s4a","new"]]`;
  - `standing: absent` → `[["s3","new"],["s4a","new"]]`.

- [ ] **Step 2: Binding matrix.** Rebuild every Task 1 binding row in JS, on a fresh temp-file `RunStore` per item, through each dist's `CapabilityRunner` and real omp sink. Also include the run-level fixture path through `CoreWorker.executeRun` with `force_gated_capability`, as in Task 1.

  `pairs`: `[["s4a","new"]]`.

  Compared:
  - the result (status, `error_ref`);
  - every `tool_approvals` and `approvals` column, except ids and timestamps;
  - the `standing_*` rows;
  - ledger event types and payloads, stripped;
  - incident rows.

  `required`, on the new side:
  - exactly one `approval.bind` row per omp-sink consume;
  - the verdict is `bound` ⇔ before = `approved` ∧ after = `consumed` for **that attempt**, read before and after the call. A second consume of a `consumed` row is therefore `unbound` / `not_approved`;
  - `reason_code` is the sink code when unbound;
  - P3 → `unbound` / `no_sink`;
  - zero rows on P2, on first calls, on standing uses, and on the run-level path.

  Control: the old side has zero `approval.bind` rows.

- [ ] **Step 3: Run.** `npm run build`, then `--only policy,binding`. Expected: exit 0, and paste the summary.

- [ ] **Step 4: Mutation check (report only; never commit it).** Make `bindApproval` pass a fixed `tool_call_id: "tool_x"` to `decideSync`'s ctx, rebuild, and run `--only binding`. Expect FAIL. Revert with `git checkout -- src`, rebuild, and paste both outputs.

- [ ] **Step 5: Commit.**

```bash
git add scripts/stage4-corpora/policy.mjs scripts/stage4-corpora/binding.mjs
git commit -m "test(stage4): differential — policy matrix and binding matrix vs 1451a66 (+548cb87 for the no-standing half)"
```

---

### Task 10: Differential — seeded redaction corpus

**Files:**
- Create: `scripts/stage4-corpora/redaction.mjs`

**Interfaces:** consumes the Task 7 API (`mkStore`, `fakeBroker`). Read spec §6 item 5.

- [ ] **Step 1: Write the corpus.**

  `load`: run `VACUUM INTO` from `--live-db` to a temp path, then read every `notification_outbox` row with `intent_type='final_report'`, taking `json_extract(payload_json,'$.text')`. Pin ≥ **633**.

  Items:
  - each live text × each of the three wrappers;
  - the Task 1 classes, each tagged with its class name:
    - maskable, including the offset-2,000-of-3,000 case;
    - cut boundary, built as `"x".repeat(3895) + value + " tail"`, with the premise assertion from Task 1;
    - short control;
    - firewall off;
    - clean edges;
    - the four enqueue outcomes.

  **One fresh run per (text, wrapper).** The final-report and failure wrappers share the key `${run_id}:final_report`. Then pin: outbox rows per wrapper equal the item count for that wrapper.

  `pairs`: `[["s4a","new"]]`.

  Compared:
  - outbox `payload_json`, `payload_hash` and `state`;
  - the evolution report's `chat_turns` text;
  - the return values.

  `required`, on the new side, the per-class row counts of spec §6 item 5:
  - maskable: one `masked` row per call, `reason_code` = the seam;
  - cut boundary: one row;
  - short control, firewall off, clean: zero rows;
  - duplicate: a second row;
  - conflict: a row;
  - insert failure: a row;
  - outer rollback: no row.

  Also run the full-DB TEXT scan per store. It must find zero maskable values, and the exact expected counts for the short and firewall-off controls.

- [ ] **Step 2: Run.** `npm run build`, then `node scripts/check-ladder-stage4-differential.mjs --old-dist-3 … --old-dist-4a …` across **all** corpora (drop the stub with `--only command,path,policy,binding,redaction`). Expected: exit 0, and paste the full summary.

- [ ] **Step 3: Mutation check (report only).** Make `redactReport` skip `decideSync` for `failure_report`, rebuild, and run `--only redaction`. Expect FAIL on the required counts. Revert, rebuild, and paste both outputs.

- [ ] **Step 4: Commit.**

```bash
git add scripts/stage4-corpora/redaction.mjs
git commit -m "test(stage4): differential — seeded redaction corpus over 633 live report texts vs 1451a66"
```

---

### Task 11: Live gate — `scripts/live-gate-ladder-stage4b.mjs`

**Files:**
- Create: `scripts/live-gate-ladder-stage4b.mjs`

**Interfaces:**
- Consumes:
  - `../dist/`;
  - `--old-dist` at `1451a66`, verified with `verifyOldDist(…, "1451a66", "capabilities/capability-runner.js")`;
  - `storeOptionsFor` from `dist/run/store-options.js`;
  - `--live-db` (VACUUM INTO a temp copy).
- Produces: exit 0 only when all 8 lines PASS.

Read spec §7 (every line), and `scripts/live-gate-ladder-2b-hooks.mjs`, which drives the bridge and resolves through `resolveToolApprovalForTest` + the waiter at `:220`. Copy the refuse-outside-`.worktrees/` guard from `scripts/live-gate-standing-approval.mjs`.

- [ ] **Step 1: Write the gate.** Lines 1–8 follow spec §7, each printed as `PASS`/`FAIL <name> — <detail>`. All writes go to the temp copy. The broker is synthetic, built from fake strings.

  Exact numbers and evidence:
  - **Line 2:** a schedule-born run asks for `launchctl list` through the real bridge. Required, for the call's `tool_call_id`:
    - exactly one `approval.bind bound` row;
    - the approval row `consumed`;
    - **evidence that the adapter ran**, as distinct from a `tool_finished` that the bridge writes for a call that never reached the runner (`bridge-handler.ts:262–280`; the pre-run failure path is at `:275`). Read those lines, pick the field or event that only the adapter-execution path produces (for example the shell result's `exit_code` as a number, or an adapter-side ledger event), and name it in a comment;
    - the bridge result returned.

    Print the exit code, but do not assert it.
  - **Line 3:** the omp sink refuses `expired`, `action_mismatch` (one byte) and `lease_lost`. Each gives `unbound` with that code, and results byte-equal to the old dist on the same copy.
  - **Line 4:** cover each of these:
    - **Whole marker:** a seeded value at offset 2,000 of a 3,000-char text gives a whole `«redacted»`, byte-equal to the old dist, and one `masked final_report` row.
    - **Cut boundary:** `"x".repeat(3895) + value + " tail"` gives bytes equal to the old dist, with the premise asserted (the marker is split) and `… (truncated)` intact. One row.
    - **Other wrappers:** a failure notice and an evolution report, each likewise.
    - **Controls:** a clean report and the 5-char control each write no row.
  - **Line 5:** the store is built with `storeOptionsFor(broker)`. The count of `secret.redact masked` rows must equal the number of maskable report calls made, the full-copy scan must find 0 maskable seeded values, and the count of `approval.bind` rows must equal the omp-sink resumes made. Either count short → FAIL.
  - **Line 6:** `BEFORE INSERT ON decisions` triggers raise for both ids. Then:
    - the consume still succeeds, and the adapter still ran (the line-2 evidence);
    - the report is still enqueued masked;
    - exactly **one** open `decision_record_failed` incident exists with subject `approval.bind`, and exactly **one** with subject `secret.redact`;
    - the whole line completes within **5 s**, enforced by a timer that FAILs on expiry.
  - **Line 7:** a store opened without `redact` gives reports byte-equal to the old dist, and zero `secret.redact` rows.
  - **Line 8:** spawn `node scripts/live-gate-standing-approval.mjs` and `node scripts/live-gate-cleanroom-runtime.mjs` (read each header for args and env) and require exit 0 from both. Note in the gate's header that these child gates open stores without `storeOptionsFor`, so line 8 proves 4A behaviour on this build, not `secret.redact` wiring. Lines 4–5 prove that wiring.

- [ ] **Step 2: Run from the worktree.**
  - `npm run build`
  - `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-stage4b.mjs --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/base-1451a66/dist`

  Expected: 8/8 PASS, exit 0. Paste the full output.

- [ ] **Step 3: Silent-degradation proofs (report only; never commit).** Rebuild and rerun after each mutation, then revert and rebuild.
  - (a) `storeOptionsFor` returns `{ redact }` with no recorder (cast past the type) → line 5 must FAIL.
  - (b) `bindApproval` skips its post-consume `decideSync` → line 5 must FAIL.

  Paste both FAIL outputs.

- [ ] **Step 4: Commit.**

```bash
git add scripts/live-gate-ladder-stage4b.mjs
git commit -m "test(stage4b): live gate — bind through the bridge, redaction, silent degradation, recorder fault"
```

---

### Task 12: Rollback check — `scripts/check-ladder-stage4b-rollback.mjs`

**Files:**
- Create: `scripts/check-ladder-stage4b-rollback.mjs`

**Interfaces:**
- Consumes:
  - the pattern of `scripts/check-decisions-rollback.mjs`;
  - `scripts/check-standing-rollback.mjs` (its 4A seed, which includes the clean `tool_finished` for the standing use);
  - `storeOptionsFor` from the new dist;
  - `--old-dist` at `1451a66`;
  - `--live-db`.
- Produces: exit 0 PASS · 1 FAIL · 2 setup error.

Read spec §8.

- [ ] **Step 1: Write the check.** Use two VACUUM copies of the live DB: **A**, which the new build touches, and **F**, which only the old build ever opens.
  1. Open A with the new dist via `storeOptionsFor(fakeBroker)`. Seed:
     - one `approval.bind` row, through a real resume;
     - one `secret.redact` row, through a masked final report;
     - one standing row, using the 4A seed shape.
  2. On **both** A and F, have the `1451a66` dist:
     - open the copy and run its migrations;
     - render the digest and `/status` text (find the renderers with `grep -n "export function" src/decisions/digest.ts src/decisions/status-view.ts`);
     - resolve an approval;
     - run a resume, which on the old build writes no bind row;
     - enqueue a masked report, which writes no redact row;
     - try a `review_ok` outcome whose value is `approval.bind`, then one whose value is `secret.redact`. Both must be refused (`outcomes.ts:37–40`, old `ENTRY_IDS`).
  3. Reopen A with the new dist.

  PASS conditions:
  - nothing throws;
  - row counts of `decisions`, `tool_approvals`, `standing_approvals` and `notification_outbox` on A never drop between steps;
  - **expected difference, stated:** A's digest and `/status` output contains a `· approval.bind …` line and a `· secret.redact …` line, and F's has neither. Every other line, with ids and timestamps stripped, is equal between A and F, apart from the count lines of entries whose counts the seed itself changed. Compute the expected per-entry counts from the seed, and assert them rather than excluding them;
  - every step-2 result other than the digest and status text is equal between A and F, with ids and timestamps stripped.

- [ ] **Step 2: Run.** `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-ladder-stage4b-rollback.mjs --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/base-1451a66/dist`. Expected: all PASS, exit 0. Paste the output.

- [ ] **Step 3: Commit.**

```bash
git add scripts/check-ladder-stage4b-rollback.mjs
git commit -m "test(stage4b): rollback check — 1451a66 reads a 4B-written copy"
```

---

### After Task 12 (orchestrator, not a subagent task)

- Final whole-branch review: the most capable non-orchestrator model, plus a codex whole-diff pass, plus parallel reviewers (security / correctness / testing / adversarial).
- Docs sync, as AGENTS.md requires:
  - the ADR 0030 amendment draft (Stage 4B). It rewrites the Stage 4A line "`approval.bind` stays a locked id with no module" and has a README row. It must also name:
    - the `PROTECTED_FILES` addition;
    - that `review_ok` outcomes may now name the two ids;
    - the digest scope note;
  - ROADMAP Stage 4: the gate column is closed;
  - `tasks/todo.md` state block, with these follow-ups:
    - P7's missing expiry and `changes` checks;
    - R2 object keys;
    - R3 `action_summary`;
    - the Stage 3 spec's invariant-1 wording;
    - the standing CAS refusal code;
  - `tasks/lessons.md`;
  - a `sessions.md` entry.
- Merge to `main`, push, and rebuild `dist/`.
- Tell Paco the kickstart is owed. The 4A migration and the 4B code both land at the same kickstart.

## Plan review record (2026-10-29)

Senior (Sonnet, live code + tsc probe): 0 BLOCKER, 9 WARNING, 5 SUGGESTION. Codex (read-only): 3 BLOCKER, 3 WARNING. All applied in Rev 2 of this plan:
- **Codex:**
  - B1: the rollback check compares A against F, with the new-id lines as a stated difference (Task 12).
  - B2: the bind oracle uses per-attempt before/after state (Tasks 3, 9).
  - B3 (and senior W4): the run-level path goes through `CoreWorker.executeRun`, with no direct-store fallback (Task 1).
  - W1: line 2 requires adapter-only evidence (Task 11).
  - W2: per-item `pairs`, and the capability-shape source is named (Tasks 7, 9).
  - W3: the Stage 3 gate list is updated, against the senior's "leave it". Ruling: the spec names it, it is harmless, and it costs nothing if wrong.
- **Senior:**
  - W1: read-only external inputs as flags (Global Constraints).
  - W2: a scan hit stops the work (Task 1).
  - W3: the cut-boundary placement and premise (Tasks 1, 10, 11).
  - W5: Tasks 4–6 split into Tasks 4–12.
  - W6: an exact harness API (Task 7).
  - W7: evaluated literals (Task 8).
  - W8: one fresh run per (text, wrapper) (Task 10).
  - W9: the real caller list, with no-op recorders (Task 4).
  - Suggestions: 9 items in 7 groups (Task 8); the bind mutation in the gate (Task 11); restated numbers (Task 11); the dead `code` field dropped (Task 3); the line-8 scope note (Task 11).
