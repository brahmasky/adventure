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
| `tests/run/report-redaction-corpus.test.ts` | new: redaction characterisation classes | 1, 4 |
| `src/decisions/entries/approval-bind.ts`, `src/decisions/entries/secret-redact.ts` | new entries | 2 |
| `src/decisions/entry-ids.ts`, `src/decisions/registry.ts` | 18 → 20 | 2 |
| `tests/decisions/approval-bind.test.ts`, `tests/decisions/secret-redact.test.ts`, `tests/decisions/registry.test.ts` | entry + registry tests | 2 |
| `scripts/live-gate-ladder-stage3-wired.mjs` | id list now includes the two new ids | 2 |
| `src/capabilities/capability-runner.ts` | `bindApproval` helper | 3 |
| `src/run/store-options.ts` | new `storeOptionsFor` | 4 |
| `src/run/run-store.ts` | options type, injected recorder, `redactReport` | 4 |
| `src/cli.ts` | uses `storeOptionsFor` | 4 |
| `src/decisions/digest.ts` | scope note on the `secret.redact` line | 4 |
| `src/capabilities/self-write-guard.ts` | `PROTECTED_FILES` += `src/run/store-options.ts` | 4 |
| the 7 TS test files passing `{ redact }` | add `decisionRecorder` or use `storeOptionsFor` | 4 |
| `scripts/check-ladder-stage4-differential.mjs` (+ `scripts/stage4-corpora.mjs`) | new differential | 5, 6 |
| `scripts/live-gate-ladder-stage4b.mjs` | new live gate | 7 |
| `scripts/check-ladder-stage4b-rollback.mjs` | new rollback check | 8 |

---

### Task 1: Characterisation pins (today's behaviour, before any change)

**Files:**
- Create: `tests/capabilities/approval-bind-matrix.test.ts`
- Create: `tests/run/report-redaction-corpus.test.ts`

**Interfaces:**
- Consumes: the existing code only.
- Produces: two test files that later tasks extend with new-row assertions. Each file exports nothing. Put each fixture builder in its own top-level function, named below, so Tasks 3 and 4 can add `it` blocks that reuse them.

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

  Add one `it` for the run-level fixture path. Drive `CoreWorker.runGatedCapability`, or the narrowest seam that reaches `consumeApprovedApproval` (`run-store.ts:7738`) with `force_gated_capability` as `eval-runner.ts:256` sets it. Cover the happy path and the eight `APPROVAL_*` / `RUN_NOT_RUNNING` codes, and pin the results. If no seam reaches it without a full eval, pin `store.consumeApprovedApproval` directly. Name the choice in the test's comment.

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
  - **cut boundary**: a value planted so its `«redacted»` straddles char 3,900. Pin the exact bytes the current code produces, with no expectation written by hand. Compute them once with the current `truncateForChat` semantics (redact → trim → slice 3900 + `"\n\n… (truncated)"`) and assert the stored bytes equal that string;
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

  A FAIL here means a pin is wrong, not the code. Fix the pin to today's behaviour and note it in the report.

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
- Modify: `scripts/live-gate-ladder-stage3-wired.mjs:35` (only if it asserts equality with the full list. It currently asserts "includes", so it stays correct. Check and leave alone when it does.)
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
  - `verdict` is `bound` iff the `tool_approvals` row moved `approved → consumed`. Derive it from the state read back (step (b) of Task 1), not from the result;
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
    recorder: DecisionRecorder): { ok: true } | { ok: false; result: CapabilityResult; code: string } {
    const ctx = { run_id: input.run_id ?? null, tool_call_id: input.tool_call_id ?? null, recorder };
    if (!this.approvals) {
      decideSync(APPROVAL_BIND, { ok: false, code: "no_sink" }, ctx);
      return { ok: false, code: "no_sink", result: { status: "failed", error_ref: "Approval sink is not available for resume" } };
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
    return { ok: false, code: consumption.error.code, result: { status: "failed", error_ref: `${consumption.error.code}: ${consumption.error.message}` } };
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

### Task 4: `storeOptionsFor`, the injected recorder, and `secret.redact`

**Files:**
- Create: `src/run/store-options.ts`; test `tests/run/store-options.test.ts`
- Modify: `src/run/run-store.ts`:
  - the options type and constructor (`:1405–1421`);
  - the three wrappers (`:7275`, `:7306`, `:7327`);
  - a new private `redactReport`.
- Modify: `src/cli.ts:33–34` (`storeOptions` becomes `storeOptionsFor(broker)`)
- Modify: `src/decisions/digest.ts` `countLines` (P-R3)
- Modify: `src/capabilities/self-write-guard.ts` `PROTECTED_FILES` (+ `"src/run/store-options.ts"`, with a comment beside `src/cli.ts`'s line)
- Modify: the TS callers that pass `{ redact }` to `RunStore.open*` (find them with `grep -rn "RunStore.open[A-Za-z]*([^)]*redact" tests src`): the triage harness, the 2a ladder tests, injection-judge, jev-anchor-import, improve groups/proposals, run-store-redaction. Each gains `decisionRecorder: (s) => storeRecorder(s)`, or uses `storeOptionsFor`.
- Test: extend `tests/run/report-redaction-corpus.test.ts`; `tests/decisions/digest.test.ts` (one line); `tests/capabilities/self-write-guard*.test.ts`, if one pins the list.

**Interfaces:**
- Consumes: `SECRET_REDACT`, `RedactSeam` (Task 2); `storeRecorder` (`src/decisions/record.ts`); `SecretBroker` (`src/config/secret-broker.ts`).
- Produces:

```ts
// src/run/store-options.ts
export type StoreOptions =
  | { redact: (s: string) => string; decisionRecorder: (store: RunStore) => DecisionRecorder }
  | { redact?: never; decisionRecorder?: (store: RunStore) => DecisionRecorder };
export function storeOptionsFor(broker?: SecretBroker, env?: NodeJS.ProcessEnv): StoreOptions;
```

  `RunStore.open(path, options?: StoreOptions)` and `RunStore.openInMemory(options?: StoreOptions)`. Define `StoreOptions` in `run-store.ts`, because the store owns its option type, and re-export it from `store-options.ts`. `store-options.ts` imports `RunStore` as a type only.

- [ ] **Step 1: Write failing tests.**

  `tests/run/store-options.test.ts`:
  - With a broker, `storeOptionsFor(broker)` has `redact === broker.redact` and a `decisionRecorder` function. Without one, it has no `redact` and still has a `decisionRecorder`.
  - A store opened with `storeOptionsFor(fakeBroker())` writes a `secret.redact masked` row for a masked final report. This is the boot path's wiring, pinned.
  - Type pin:

```ts
// @ts-expect-error — redact without a recorder must not compile (spec §5, senior B1)
RunStore.openInMemory({ redact: (s: string) => s });
```

  Typecheck covers the `// @ts-expect-error` line. Wrap it in `if (false as boolean) { … }` so it does not run.

  Extend `report-redaction-corpus.test.ts`. The fixture now opens its stores with `storeOptionsFor(fakeBroker())`, or with `{}` for firewall-off. Add the row assertions of spec §6 item 5 per class:
  - **maskable**: exactly one `masked` row per wrapper call, `reason_code` = the seam (`final_report` / `failure_report` / `evolution_report`), `run_id` set, `tool_call_id` null;
  - **cut boundary**: one row;
  - **short, firewall-off, clean**: zero rows;
  - **duplicate**: a second row;
  - **conflict**: a row;
  - **insert failure**: a row, plus the same throw;
  - **outer rollback**: no row and no outbox row.

  Every Task 1 byte pin stays unchanged.

  Add the recursion pin. Install a `BEFORE INSERT ON decisions` trigger that raises for `entry_id='secret.redact'`. A masked final report is then still enqueued with masked text, exactly one open `decision_record_failed` incident exists with subject `secret.redact`, and the call returns.

  `tests/decisions/digest.test.ts`: `countLines` over one `secret.redact` row yields `· secret.redact 1 — <rule label> 1 (final, failure and evolution reports only)`. Read `RUNG_LABEL` for the label text.

- [ ] **Step 2: Run them. Expected: FAIL (the module is missing, there are no rows, and the type pin is unused).**

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

  static openInMemory(options: StoreOptions = {}): RunStore { return new RunStore(new DatabaseSync(":memory:"), options); }
  static open(path: string, options: StoreOptions = {}): RunStore { return new RunStore(new DatabaseSync(path), options); }
```

  Keep the existing multi-line formatting style of those two static methods if it differs. `DecisionRecorder` is a type-only import from `../decisions/types.js`; `types.ts` imports no runtime code. Confirm with `grep -n "^import" src/decisions/types.ts`. `SECRET_REDACT` and `decideSync` are runtime imports. Confirm that `src/decisions/entries/secret-redact.ts` and `src/decisions/decide.ts` do not import `run-store` at run time, transitively: `grep -n "^import" src/decisions/decide.ts`. If `decide.ts` pulls in a module that reaches `run-store.js`, stop and report NEEDS_CONTEXT, with the import chain.

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

  Replace `:7275` `truncateForChat(input.text, this.redact)` → `this.redactReport("final_report", run_id, input.text)`. Replace `:7306` → `this.redactReport("failure_report", run_id, text)`. Replace `:7327` → `this.redactReport("evolution_report", run_id, input.text)`.

  `store-options.ts`:

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
  const decisionRecorder = (s: RunStore) => storeRecorder(s, { env });
  return broker ? { redact: broker.redact, decisionRecorder } : { decisionRecorder };
}
```

  Check the broker type's exported name: `grep -n "^export" src/config/secret-broker.ts`.

  `cli.ts`: replace `const storeOptions = broker ? { redact: broker.redact } : {};` with `const storeOptions = storeOptionsFor(broker);`, and add the import. Keep the comment above it, updated to mention the recorder.

  Note: the no-broker branch now carries a recorder, so the CLI's store writes `approval.bind`-style rows. The store itself writes only `secret.redact`, and only when armed, so nothing new is written with the firewall off.

  `digest.ts` `countLines`: append the note only for `secret.redact`:

```ts
    return `· ${id} ${total} — ${[...known, ...other].join(" · ")}${id === "secret.redact" ? " (final, failure and evolution reports only)" : ""}`;
```

  `self-write-guard.ts`: add `"src/run/store-options.ts", // ADR 0015 + 0030 boot wiring: the store's redactor and decision recorder travel together` next to `src/cli.ts`.

- [ ] **Step 4: Run.**
  - `npm run typecheck`, with zero errors and the `@ts-expect-error` used;
  - `npx vitest run tests/run tests/decisions tests/capabilities tests/core/core-worker-triage.test.ts tests/improve`;
  - then the full `npm test`.

  Expected: PASS. `tests/decisions/jev-version-job.test.ts` has a known bimodal flake (pre-existing, recorded in `tasks/todo.md`). If it fails, rerun that file alone and report both runs.

- [ ] **Step 5: Commit.** Split into two commits:

```bash
git add src/run/store-options.ts src/run/run-store.ts src/cli.ts src/capabilities/self-write-guard.ts tests/run/store-options.test.ts tests/run/report-redaction-corpus.test.ts <the updated test callers>
git commit -m "feat(run): secret.redact records masked reports; storeOptionsFor carries redactor + recorder together"
git add src/decisions/digest.ts tests/decisions/digest.test.ts
git commit -m "feat(decisions): digest names secret.redact's scope (three report wrappers only)"
```

---

### Task 5: Differential harness — skeleton, comparator self-test, command and path corpora (base `548cb87`)

**Files:**
- Create: `scripts/check-ladder-stage4-differential.mjs`
- Create: `scripts/stage4-corpora.mjs`, the corpus loaders, so Task 6 adds to them without growing the harness past readability

**Interfaces:**
- Produces:
  - **CLI:** `node scripts/check-ladder-stage4-differential.mjs --old-dist-3 <dir@548cb87> --old-dist-4a <dir@1451a66> [--only command,path,policy,binding,redaction] [--keep]`.
  - **Exit codes:** 0 PASS · 1 FAIL · 2 setup error.
  - **Corpus interface:** each corpus is `{ name, base: "3"|"4a", min: { items, branches: string[] }, load(): Promise<Item[]>, project(dist, item, tmp): Promise<Projection> }`.
  - **Comparison:** the harness compares `JSON.stringify(project(old)) === JSON.stringify(project(new))` per item, after stripping the excluded fields (ids, timestamps, `latency_ms`, the pairwise-mapped `tool_`/`op_` ids, and `decisions` rows whose `entry_id ∈ {approval.bind, secret.redact}`).

Read spec §6 (all of it), and `scripts/old-dist-provenance.mjs`, `scripts/check-decisions-rollback.mjs` for the arg, temp and cleanup pattern. For the bridge-seam drive, read `scripts/live-gate-ladder-stage3-wired.mjs` and `scripts/live-gate-ladder-2b-hooks.mjs`.

- [ ] **Step 1: Old dists (orchestrator does this before dispatch; the implementer verifies).** Two worktrees:
  - `.worktrees/base-548cb87`, built;
  - `.worktrees/base-1451a66`, built.

  Provenance: call `verifyOldDist(old, NEW_DIST, "548cb87", "decisions/registry.js")` and `verifyOldDist(old, NEW_DIST, "1451a66", "capabilities/capability-runner.js")`. A provenance failure exits 2.

- [ ] **Step 2: Comparator + self-test first.**

  Write `compare(name, items, oldP, newP)`, which returns a list of differing item keys. The self-test feeds a fixed item whose new-side projection is mutated by one byte. The comparator must report exactly that key, else exit 1 with `FAIL comparator self-test`. Every corpus run calls it once.

  Printing: an item prints only through the fake-broker redactor plus a length cap (200 chars), and transcript items print as `transcript#<n>` only.

- [ ] **Step 3: Coverage pins.**

  After `load()`, FAIL when `items.length < min.items` or when any `min.branches` entry has no item tagged with it. A short or empty extraction is a FAIL, never a pass.

  Command corpus `min`:
  - test-table literals ≥ 100;
  - transcript distinct = **147** (exactly: FAIL with the found count otherwise);
  - the 7 ADR 0028 misses (each one is a separate branch tag);
  - branches `external_write`, `destructive`, `plain`, `unseen shell script`. Confirm these label strings against `src/omp/command-matcher.ts` and adjust the tag names to the real kind/label names. Record the mapping in a comment.

  Path corpus `min`: one tag per branch in spec §6 item 2(b), plus **13** transcript inputs.

- [ ] **Step 4: Command corpus loader.**
  - (a) Parse `tests/omp/command-matcher.test.ts` for string literals inside the `it.each` tables. Use a small regex over the file text that takes the first string of each table row, and assert ≥ 100.
  - (b) Read `omp/sessions/chat-8744196214/*.jsonl` line by line, take `toolCall` objects with `name === "bash"`, and dedupe `arguments.command`. Keep them in memory only. Never write them to the repo, never print them raw. Where a debug copy is needed, write it under the temp dir, which is deleted on exit.
  - (c) Seven literal items for ADR 0028 `docs/decisions/0028-*.md:239–241`: `dd if=/dev/zero of=x`, `unlink x`, `python3 -c 'print(1)'`, `node -e '1'`, `perl -e '1'`, `echo $'a\x27b'`, `bash file.sh`. Add the spaced-arithmetic and nested-apostrophe items as the ADR text words them. Read the lines and transcribe.

  `project`: `classifyCommand(cmd)` → `{kind, label}` from each dist's `omp/command-matcher.js`. Confirm the export name.

  Bridge-seam projection: drive the dist's bridge handler for a `bash` tool call the way `live-gate-ladder-stage3-wired.mjs` does, against a temp `RunStore` with a running run. Record:
  - whether it asked: an approval prompt was created;
  - the card's `Action:` label, from the approval prompt text;
  - the `tool.shell_class` decision row verdict and reason.

  `548cb87` has no `tool.shell_class` rows, so the row part of the projection is compared head vs `1451a66` only. Run the bridge-seam projection three-way:
  - card and asked: old-3 vs new;
  - row: old-4a vs new.

  If driving the bridge per item is too slow for 147 + ≥100 items (more than 5 minutes total), drive it for the transcript items and the 7 misses, and keep the pure `classifyCommand` comparison for the test-table literals. Record the ruling in the report.

- [ ] **Step 5: Path corpus loader.**
  - (a) Literal paths from `tests/omp/gate-path.test.ts`.
  - (b) One synthetic item per branch of spec §6 item 2(b). Read `src/omp/gate-path.ts:25–66` and `src/omp/protected-paths.ts`, and tag each item with its branch name. Each item is run for both `fs_read` and `fs_write`.
  - (c) The 13 `read`/`write`/`edit` inputs from the transcripts (7 + 3 + 3). Assert the count.

  `project`: the `gateTargets` output; at the bridge seam, the gate's deny code; the `tool.path` row's verdict and reason (head vs `1451a66` only, as above).

- [ ] **Step 6: Run against the built branch.**
  - `npm run build`
  - `node scripts/check-ladder-stage4-differential.mjs --old-dist-3 … --old-dist-4a … --only command,path`

  Expected: the comparator self-test passes, the coverage pins pass, 0 differences, exit 0. Paste the summary lines (counts per corpus, per branch) into the report.

- [ ] **Step 7: Commit.**

```bash
git add scripts/check-ladder-stage4-differential.mjs scripts/stage4-corpora.mjs
git commit -m "test(stage4): differential harness — comparator self-test, command and path corpora vs 548cb87"
```

---

### Task 6: Differential — policy, binding and redaction corpora (base `1451a66`)

**Files:**
- Modify: `scripts/stage4-corpora.mjs`, `scripts/check-ladder-stage4-differential.mjs` (register the three corpora)

**Interfaces:**
- Consumes: the corpus interface and comparator from Task 5; the fixtures' *behaviour* from Task 1. The harness reimplements those fixtures in plain JS against each dist; vitest files cannot be imported into `.mjs`.
- Produces: corpora `policy`, `binding`, `redaction`.

Read spec §6 items 3–5.

- [ ] **Step 1: Policy matrix.**

  Use `decideCapability` from each dist's `policy/capability-policy.js` over the cross product in spec §6 item 3. Take the capabilities from the dist's `ToolRegistry` default registration; confirm with `grep -rn "register(" src/tools | head`, or seed from `tests/policy/*.test.ts` capability shapes.

  `min.branches`: every `CapabilityDecision.reason` string listed in `src/decisions/entries/tool-policy.ts` `REASON_MAP` keys.

  Project `{decision, reason}`, plus a `CapabilityRunner.execute` run with a stub sink: the `tool.policy` row verdict, the reason code and the row count, including the dedup. The `standing: present` half is compared old-4a vs new only. The `standing: absent` half is compared against both old dists.

- [ ] **Step 2: Binding matrix.** The Task 1 matrix rows, rebuilt in JS on a temp-file `RunStore` per item, through each dist's `CapabilityRunner` and real omp sink.

  Compared: the result (status, `error_ref`), every `tool_approvals`/`approvals` column except ids and timestamps, the `standing_*` rows, ledger event types and payloads (stripped of ids and timestamps), and incident rows.

  Required on the new side, asserted separately from the comparison:
  - one `approval.bind` row per omp-sink consume;
  - its verdict derived from the read-back `tool_approvals.state` (`consumed` ⇒ `bound`);
  - `reason_code` = the sink code when unbound;
  - P3 → `unbound`/`no_sink`;
  - zero rows on P2, first calls and the run-level path.

  The old side must have zero `approval.bind` rows; that is a control.

- [ ] **Step 3: Redaction corpus.**

  Make a VACUUM copy of the live DB (`VACUUM INTO` a temp path, opened read-only for the copy) and read every `notification_outbox` row with `intent_type='final_report'`, taking `json_extract(payload_json,'$.text')`. Expect **≥ 633** rows; FAIL if fewer.

  Run each text through each of the three wrappers on both dists. The new dist's store is opened with `storeOptionsFor(fakeBroker)` imported from the new dist's `run/store-options.js`; the old one with `{ redact: fakeBroker.redact }`. Then run the Task 1 classes: maskable, cut boundary, short control, firewall off, clean, and the enqueue outcomes.

  Compared: outbox `payload_json`, `payload_hash`, `state`; the evolution `chat_turns` text; return values.

  Required on the new side, per class, the row counts of spec §6 item 5. Also run the full-DB TEXT scan per store: zero maskable values, and the exact expected counts for the short and firewall-off controls.

  The fake broker is built in the harness from fake strings. No real env value is read.

- [ ] **Step 4: Run.**
  - `npm run build`
  - `node scripts/check-ladder-stage4-differential.mjs --old-dist-3 … --old-dist-4a …`, with all five corpora

  Expected: exit 0, self-test PASS, every coverage pin PASS, 0 differences, every required count PASS. Paste the summary into the report.

- [ ] **Step 5: Mutation check (report only, do not commit).**
  - Temporarily change `redactReport` to skip `decideSync` for `failure_report`, rebuild, and rerun `--only redaction`. Expect FAIL on the required counts.
  - Temporarily make `bindApproval` pass `tool_call_id: "tool_x"` (a fixed id), rebuild, and rerun `--only binding`. Expect FAIL.

  Revert both with `git checkout -- src`, rebuild, and report the two FAIL outputs.

- [ ] **Step 6: Commit.**

```bash
git add scripts/stage4-corpora.mjs scripts/check-ladder-stage4-differential.mjs
git commit -m "test(stage4): differential — policy matrix, binding matrix, seeded redaction corpus vs 1451a66"
```

---

### Task 7: Live gate — `scripts/live-gate-ladder-stage4b.mjs`

**Files:**
- Create: `scripts/live-gate-ladder-stage4b.mjs`

**Interfaces:**
- Consumes: the new dist (`../dist/`); old dist at `1451a66` (`--old-dist`), verified by `verifyOldDist(…, "1451a66", "capabilities/capability-runner.js")`; `storeOptionsFor` from `dist/run/store-options.js`.
- Produces: exit 0 only when all 8 lines PASS.

Read spec §7 (every line) and `scripts/live-gate-ladder-2b-hooks.mjs` (the bridge drive, `resolveToolApprovalForTest` + waiter at `:220`). Read `scripts/live-gate-standing-approval.mjs` for the 4A refuse-outside-worktree guard, and copy that guard.

- [ ] **Step 1: Write the gate.**
  - Lines 1–8 exactly as spec §7, each printed `PASS`/`FAIL <name> — <detail>`.
  - All writes go to a VACUUM copy in a temp dir, deleted on every exit path unless `--keep`.
  - Use a synthetic broker from fake strings; never read real secret values.

  Specifics:
  - **Line 2** drives a schedule-born run asking for `launchctl list` through the real bridge. It requires, for the call's `tool_call_id`:
    - one `approval.bind bound` row;
    - the approval `consumed`;
    - a `tool_finished` ledger event with `status` set;
    - the bridge result returned.

    It prints the exit code without asserting it.
  - **Line 6** installs `BEFORE INSERT ON decisions` triggers raising for both ids. It wraps the work in a 5 s timer that FAILs on expiry.
  - **Line 8** spawns `node scripts/live-gate-standing-approval.mjs` and `node scripts/live-gate-cleanroom-runtime.mjs` as children and requires exit 0 from both. Read each script's header for its required args and env.

- [ ] **Step 2: Run from the worktree.**
  - `npm run build`
  - `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-stage4b.mjs --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/base-1451a66/dist`

  Expected: 8/8 PASS, exit 0. Paste the full output into the report.

- [ ] **Step 3: Silent-degradation proof (report only).** Temporarily make `storeOptionsFor` return `{ redact }` with no recorder, cast to bypass the type. Rebuild and rerun; line 5 must FAIL. Revert, rebuild, and report the output.

- [ ] **Step 4: Commit.**

```bash
git add scripts/live-gate-ladder-stage4b.mjs
git commit -m "test(stage4b): live gate — bind through the bridge, redaction, silent degradation, recorder fault"
```

---

### Task 8: Rollback check — `scripts/check-ladder-stage4b-rollback.mjs`

**Files:**
- Create: `scripts/check-ladder-stage4b-rollback.mjs`

**Interfaces:**
- Consumes: the pattern of `scripts/check-decisions-rollback.mjs` and `scripts/check-standing-rollback.mjs` (its 4A seed); `storeOptionsFor` from the new dist.
- Produces: exit 0 PASS · 1 FAIL · 2 setup error.

Read spec §8.

- [ ] **Step 1: Write the check.**
  1. Make a VACUUM copy of the live DB.
  2. Open it with the new dist via `storeOptionsFor(fakeBroker)`. Seed one `approval.bind` row through a real resume, one `secret.redact` row through a masked final report, and one standing row (reuse the 4A seed shape).
  3. Have the `1451a66` dist open the copy, run its migrations, and render the digest and `/status` text. Find the render functions with `grep -n "export function" src/decisions/digest.ts src/decisions/status-view.ts`. The output must include the new ids' count lines without a throw.
  4. Still on `1451a66`: resolve an approval, run a resume (no bind row written by the old build), enqueue a masked report (no redact row written), and try a `review_ok` outcome whose value is `approval.bind` and then `secret.redact`. Both must be refused, per `outcomes.ts:37–40` against the old `ENTRY_IDS`.
  5. Reopen with the new dist.

  PASS means:
  - no throw;
  - the row counts of `decisions`, `tool_approvals`, `standing_approvals` and `notification_outbox` never drop;
  - each old-build output equals what the old build gives on a copy that has never seen the new build. Run the same steps on a second fresh copy for this comparison, and exclude ids and timestamps.

- [ ] **Step 2: Run.** `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-ladder-stage4b-rollback.mjs --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/base-1451a66/dist`. Expected: all PASS, exit 0. Paste the output.

- [ ] **Step 3: Commit.**

```bash
git add scripts/check-ladder-stage4b-rollback.mjs
git commit -m "test(stage4b): rollback check — 1451a66 reads a 4B-written copy"
```

---

### After Task 8 (orchestrator, not a subagent task)

- Final whole-branch review: the most capable non-orchestrator model, plus a codex whole-diff pass, plus parallel reviewers (security / correctness / testing / adversarial).
- Docs sync, as AGENTS.md requires:
  - the ADR 0030 amendment draft (Stage 4B), which rewrites the Stage 4A line "`approval.bind` stays a locked id with no module", plus its README row;
  - the `PROTECTED_FILES` addition, named in the amendment;
  - `docs/reference/configuration.md`, only if it documents the digest lines;
  - ROADMAP Stage 4: the gate column closed;
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
