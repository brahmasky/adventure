# Remainder slice R2 — `intake.sender` + `turn.contract` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `intake.sender` (locked) and `turn.contract` as rule-only, record-never-steer ladder entries at today's Telegram sender check and task-contract compile, and prove zero behaviour change with the stamped merge-base differential, a live gate and a rollback check.

**Architecture:** Two entry modules under `src/decisions/entries/` (protected). The sender check and the contract compile keep deciding exactly as today; each gains a `reason` **beside** its existing `error` so the entry can name why. `intake.sender` records once, in `pollOnce`'s denial branch, through a `decisionRecorder` passed in the adapter's options by both production constructors. `turn.contract` records at the refusal return (`run_id` null) and as the first statement of `handleTaskIntake`'s `if (queued.ok)` block (`run_id` = the new run), through `Gateway`'s recorder, which gains an injectable `options.decisionRecorder`. The differential gains an `r2` stamped pair and two corpora (`sender`, `contract`).

**Tech Stack:** Node 25, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest. Zero runtime deps.

**Plan status:** Rev 1.1 — after the plan review: senior (Sonnet 5.5; applied and ran Tasks 1–6 in a worktree: Tasks 1–4 green as written, Task 5 broke 7 existing tests, Task 6 broke 4 corpora: 2 B / 4 W / 2 S) and codex (3 B / 2 W / 1 S); every finding verified first-hand and applied (rulings P10–P12, Tasks 3, 5, 6, 9, 10). Codex scoped re-review: every finding closed; one new warning (redaction exception vs all-PASS) → ruled: no exception. Ready to build.

**Spec:** `docs/superpowers/specs/2026-11-01-ladder-remainder-r2-sender-contract-design.md` (Rev 1.2, APPROVED by Paco 2026-11-01: 1-B, 2-A, 3-A; 2-A shipped as `8478b42`). Read it before any task. Pattern slice: R1 (`docs/superpowers/plans/2026-10-30-remainder-r1-gateway-intake.md`, spec `…-r1-gateway-intake-design.md`).

## Rulings (orchestrator, from the probe; plan review adds to this list)
- **P1 — merge base.** The branch is cut from `main@ef4d0d1` (R2 spec + the 2-A hotfix `8478b42`). The `r2` pair's old build is that commit, stamped: `.worktrees/base-ef4d0d1`. Every older pair keeps its own old build and invocation (lesson 2026-10-30): 4B `--old-dist-4a .worktrees/base-1451a66/dist`, 4C `--old-dist-4b .worktrees/base-c558413/dist --old-base c558413c3e248122256c3355b8852d3879aed3f6`, R1 `--old-dist-r1 .worktrees/base-aec1d4f/dist --old-base-r1 aec1d4f9377f8fcebf883eaed8a81538b2cf8aef`, s3 `--old-dist-3 .worktrees/base-548cb87/dist`.
- **P2 — the hotfix on older pairs.** The s3/s4a/s4b/r1 old builds predate `8478b42`, so a Telegram-source `TASK_CONTRACT_INVALID` on those pairs now differs by one outbox row keyed `:contract_invalid`. No existing corpus is expected to produce one. If any pair shows that difference, stop and report it (name the item); do **not** add a filter.
- **P3 — `/kill`.** Any test, corpus or gate that could intake `kill` pins `HOUGE_TOMBSTONE_PATH` and `HOUGE_DISARM_PATH` to a temp dir first and restores them (`tests/gateway/kill-switch.test.ts` `PINNED_ENV`), and asserts no `houge.kill` in the cwd afterwards (lesson 2026-10-30). The sender corpus's `emit` is a recording stub that never intakes.
- **P4 — `HOUGE_TELEGRAM_CHAT_ID`** is cleared (tests, differential) or pinned to a stub chat (live gate) wherever a recorder fault is provoked: both recorders have no `env`, so `decision_record_failed` would otherwise page the real chat.
- **P5 — deterministic dumps.** Reuse R1's `withCountingClock`, `dumpDb(store, { dropDecisionIds })`, `relabelClocks`, `scrubIds` exactly as `scripts/stage4-corpora/intake.mjs` does: new rows dropped **before** relabelling; coverage and determinism self-tests, each shown failing once.
- **P6 — counting by entry id.** The counting recorder wrapper counts `record` calls per `entry.id`; assertions name `turn.contract` / `intake.sender` only (the same recorder also sees `intake.budget_fuse` and the rating entry).
- **P7 — the gate's schedule fire.** Line 5 drives `maybeFireScheduledTasks({ store, gateway, worker: stub, now, env: { …, HOUGE_SCHEDULER_ENABLED: "true" } })` with a stub worker `{ submitTurn: () => true, executeRun: async () => ({ status: "queued" }) }` on the copy; before it, every pre-existing schedule on the **copy** is disabled through the store's own method (name it in a comment) so only the gate's schedule is due. Assertions are scoped to the gate's `schedule_id` / run.
- **P8 — exact PASS values.** Every gate and rollback line names its exact expected value; no `every()` or `>= 1` over a set that can be empty (lesson 2026-10-30).
- **P9 — commit trailer.** Every commit recipe carries `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
- **P10 (plan review: senior B1+B2, codex B1+B2) — every admitted scheduled turn now writes one `turn.contract` `restrict` row.** That is Decision 1-B working, and it reaches every test and corpus that intakes a schedule-born turn through `Gateway` and asserts exact `decisions` rows. Measured by the senior run: 7 unit tests (`tests/capabilities/approval-bind-matrix.test.ts` ×6, `tests/capabilities/memory-correct-preflight.test.ts` ×1) and 4 corpora (`intake`, `binding`, `memadmit`, `memcorrect`). **Rule:** each one is updated to expect the row **exactly** — one `turn.contract|restrict|schedule_born` row whose `run_id` is that scheduled run — never a blanket filter that would also hide a missing or extra row. In a corpus that relabels clocks, the R2 rows are dropped **before** `relabelClocks` (lesson 2026-10-30) and asserted separately. P2's "stop, don't filter" applies only to a `:contract_invalid` hotfix difference, not to this row.
- **P11 (senior W1) — environment pins in daemon-driving tests.** Any new test that runs `runTelegramDaemon` or `runTelegramPollOnce` pins `HOUGE_TELEGRAM_CHAT_ID`, `HOUGE_SCHEDULER_ENABLED`, `HOUGE_RADAR_ENABLED`, `HOUGE_RADAR_PANEL_ENABLED`, `HOUGE_MEDIA_INGEST_ENABLED`, `HOUGE_LLM_MEDIA_PROVIDERS` (deleted in `beforeEach`, restored in `afterEach`), and asserts silence **to the sender's chat** (`222`), not an empty `sent` list: an armed ambient flag sends unrelated operator alerts (the senior saw a `jev_no_key` alert).
- **P12 (senior W3) — module names.** `scrubIds` is exported from `scripts/stage4-bind-fixture.mjs` (not the lib); `withPinnedEnv`, `withCountingClock`, `seedAsk`, `intakeEvent` from `scripts/stage4-intake-fixture.mjs`; `mkStore`, `mkTemp`, `dumpDb`, `relabelClocks`, `requireNew`, `canon`, `DISTS` from `scripts/stage4-diff-lib.mjs`. `intakeEvent`'s `extra` overrides `type`, `program` and `requested_by` (Task 8 needs all three).

## Global Constraints

- `dependencies: {}` stays empty; Node stdlib plus devDeps only.
- **Behaviour identical** to `ef4d0d1`: every `skipped_telegram_updates` row, offset advance, emitted event, acknowledgement, `GatewayIntakeResult`, compiled contract and `contract_hash`, run row, ledger event, outbox row and their order stay byte-identical. The only new rows are `decisions` rows with `entry_id` `intake.sender` or `turn.contract` — plus, only when a decision insert fails, the existing `decision_record_failed` incident and its one alert row to the operator chat (spec §4.3). Nothing is ever sent to a denied sender.
- **In-memory shapes that do change (spec §5):** the denied `TelegramAuthResult` / `TelegramNormalizeResult` and the refused `TaskContractResult` gain a sibling `reason`. `error` (code, message) is unchanged.
- **Raw answer drives (Stage 4B R1):** `decideSync`'s result is never used for a branch.
- `intake.sender`: `stage "intake"`, `input "tool"`, `locked: true`, verdicts `allow | deny`, default `allow`, `fail: "deny"`, no `alwaysRecord`, reasons in check order `channel_post`, `forwarded`, `anonymous`, `no_chat`, `user_not_allowlisted`, `chat_not_allowlisted`, `identity_not_for_chat`. Rule: a reason → `deny`; `null` → throws (→ `deny` at rung `fail`, `fallback_reason "threw"`).
- `turn.contract`: `stage "pre_model"`, `input "tool"`, unlocked, verdicts `compile | restrict | refuse`, default `compile`, `fail: "refuse"`, no `alwaysRecord`, reasons `schedule_born`, `goal_missing`, `unknown_program`, `unsupported_type`.
- Both: `version: 1`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`. Rows: `tool_call_id: null`; `intake.sender` and `turn.contract` refusals `run_id: null`; `restrict` rows carry the new run's id.
- `eval-runner.ts` and `normalizeTelegramUpdate`'s signature stay untouched.
- No message text, goal text, program name, sender id or chat id in any decision row, test print or script print. Tests use synthetic text and ids only (the repo is public).
- Never write the live DB (`houge.sqlite`); live checks use a `VACUUM INTO` copy deleted on every exit path.
- New functions under 50 lines; match surrounding style; tests in `tests/<area>/` mirroring `src/`.
- Commits: Conventional Commits, one concern each, stage files by name.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/decisions/entries/intake-sender.ts` (new) | 1 | locked entry, `SENDER_DENIAL_REASONS`, `SenderDenialReason` |
| `src/decisions/entries/turn-contract.ts` (new) | 1 | entry, `CONTRACT_REFUSAL_REASONS`, `ContractRefusal`, `TurnContractInput` |
| `src/decisions/entry-ids.ts`, `src/decisions/registry.ts` | 1 | 26 → 28 ids |
| `tests/decisions/intake-sender.test.ts`, `turn-contract.test.ts` (new), `tests/decisions/registry.test.ts`, `scripts/live-gate-ladder-stage4b.mjs:172` | 1 | pins, counts |
| `src/triggers/telegram-auth.ts`, `src/triggers/telegram-trigger-adapter.ts` (`:84–86`, `:105`) | 2 | sibling `reason` |
| `src/capabilities/self-write-guard.ts`, `tests/capabilities/self-write-guard.test.ts` | 2 | 3-A |
| `tests/triggers/telegram-auth.test.ts`, `telegram-trigger-adapter.test.ts`, `telegram-sender-evidence.test.ts` (new) | 2 | shapes + evidence pin |
| `src/triggers/telegram-trigger-adapter.ts` (`TelegramLongPollingAdapterOptions`, `pollOnce`), `src/telegram/telegram-poll-runner.ts:162`, `src/telegram/telegram-daemon.ts:231` | 3 | recorder seam + call site |
| `tests/triggers/sender-decisions.test.ts` (new), `tests/telegram/sender-decision-wiring.test.ts` (new) | 3 | rows, wiring |
| `src/contracts/task-contract.ts` | 4 | sibling `reason` at all 7 `invalid(` sites |
| `tests/contracts/task-contract.test.ts` | 4 | shapes + totality |
| `src/gateway/gateway.ts` (options, recorder getter, `handleTaskIntake`) | 5 | two call sites |
| `tests/gateway/contract-decisions.test.ts` (new) | 5 | rows, counts, placement |
| `scripts/stage4-diff-lib.mjs`, `scripts/check-ladder-stage4-differential.mjs` | 6 | `r2` pair, ids, exports |
| `scripts/stage4-sender-fixture.mjs`, `scripts/stage4-corpora/sender.mjs` (new) | 7 | corpus `sender` |
| `scripts/stage4-corpora/contract.mjs` (new) | 8 | corpus `contract` |
| `scripts/live-gate-ladder-remainder-r2.mjs` (new) | 9 | live gate |
| `scripts/check-ladder-remainder-r2-rollback.mjs` (new) | 10 | rollback |

---

### Task 1: The two entries on the registry

**Files:**
- Create: `src/decisions/entries/intake-sender.ts`, `src/decisions/entries/turn-contract.ts`
- Modify: `src/decisions/entry-ids.ts:5`, `src/decisions/registry.ts` (imports `:8–10` area, `REGISTRY` tail `:38`), `tests/decisions/registry.test.ts` (every `toHaveLength(26)`), `scripts/live-gate-ladder-stage4b.mjs:172`
- Test: `tests/decisions/intake-sender.test.ts`, `tests/decisions/turn-contract.test.ts`

**Interfaces:**
- Produces:
  - `SENDER_DENIAL_REASONS = ["channel_post", "forwarded", "anonymous", "no_chat", "user_not_allowlisted", "chat_not_allowlisted", "identity_not_for_chat"] as const`; `type SenderDenialReason`; `type SenderVerdict = "allow" | "deny"`; `interface SenderInput { denied: SenderDenialReason | null }`; `INTAKE_SENDER: Entry<SenderInput, SenderVerdict>`.
  - `CONTRACT_REFUSAL_REASONS = ["goal_missing", "unknown_program", "unsupported_type"] as const`; `type ContractRefusal`; `type TurnContractVerdict = "compile" | "restrict" | "refuse"`; `interface TurnContractInput { refused: ContractRefusal | null; restricted: boolean }`; `TURN_CONTRACT: Entry<TurnContractInput, TurnContractVerdict>`.

- [ ] **Step 1: Write the failing entry tests**

`tests/decisions/intake-sender.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_SENDER, SENDER_DENIAL_REASONS } from "../../src/decisions/entries/intake-sender.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; rung: string; reason: string | null; fallback: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_SENDER as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, rung: r.rung, reason: r.reason, fallback: r.fallbackReason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: null, tool_call_id: null, recorder, log: () => undefined };

describe("intake.sender — a refused Telegram sender leaves a row naming why (locked, the allowlist floor)", () => {
  it("is locked, rule-only, refusal-only, reads tool input, sound", () => {
    expect(INTAKE_SENDER.locked).toBe(true);
    expect(LOCKED_ENTRY_IDS).toContain("intake.sender");
    expect(INTAKE_SENDER.alwaysRecord).toBeUndefined();
    expect(INTAKE_SENDER.input).toBe("tool");
    expect(INTAKE_SENDER.stage).toBe("intake");
    expect(INTAKE_SENDER.fail).toBe("deny");
    expect(INTAKE_SENDER.reasonCodes).toEqual(["channel_post", "forwarded", "anonymous", "no_chat", "user_not_allowlisted", "chat_not_allowlisted", "identity_not_for_chat"]);
    expect(entryProblems(INTAKE_SENDER as unknown as AnyEntry)).toEqual([]);
  });
  it.each([...SENDER_DENIAL_REASONS])("denied for %s → deny with that reason, recorded", (reason) => {
    expect(decideSync(INTAKE_SENDER, { denied: reason }, ctx)).toMatchObject({ verdict: "deny", reason });
    expect(rows).toEqual([{ verdict: "deny", rung: "rule", reason, fallback: null }]);
  });
  it("a denial with no reason never records allow: the rule throws and the row is deny at rung fail, fallback threw", () => {
    expect(decideSync(INTAKE_SENDER, { denied: null }, ctx).verdict).toBe("deny");
    expect(rows).toEqual([{ verdict: "deny", rung: "fail", reason: null, fallback: "threw" }]);
  });
});
```

`tests/decisions/turn-contract.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { CONTRACT_REFUSAL_REASONS, TURN_CONTRACT } from "../../src/decisions/entries/turn-contract.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(TURN_CONTRACT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: null, tool_call_id: null, recorder };

describe("turn.contract — a refused contract, or a schedule-born turn's narrowed envelope, leaves a row (spec R2 §4.2, Decision 1-B)", () => {
  it("is unlocked, rule-only, pre_model, tool input, sound", () => {
    expect(TURN_CONTRACT.locked).toBeUndefined();
    expect(LOCKED_ENTRY_IDS).not.toContain("turn.contract");
    expect(TURN_CONTRACT.alwaysRecord).toBeUndefined();
    expect(TURN_CONTRACT.stage).toBe("pre_model");
    expect(TURN_CONTRACT.input).toBe("tool");
    expect(TURN_CONTRACT.fail).toBe("refuse");
    expect(TURN_CONTRACT.reasonCodes).toEqual(["schedule_born", "goal_missing", "unknown_program", "unsupported_type"]);
    expect(entryProblems(TURN_CONTRACT as unknown as AnyEntry)).toEqual([]);
  });
  it("a full contract → compile, not recorded (the contract is already on the run)", () => {
    expect(decideSync(TURN_CONTRACT, { refused: null, restricted: false }, ctx).verdict).toBe("compile");
    expect(rows).toEqual([]);
  });
  it("a schedule-born turn's narrowed envelope → restrict/schedule_born, recorded", () => {
    expect(decideSync(TURN_CONTRACT, { refused: null, restricted: true }, ctx)).toMatchObject({ verdict: "restrict", reason: "schedule_born" });
    expect(rows).toEqual([{ verdict: "restrict", reason: "schedule_born" }]);
  });
  it.each([...CONTRACT_REFUSAL_REASONS])("refused for %s → refuse with that reason, recorded (a refusal wins over restricted)", (reason) => {
    expect(decideSync(TURN_CONTRACT, { refused: reason, restricted: true }, ctx)).toMatchObject({ verdict: "refuse", reason });
    expect(rows).toEqual([{ verdict: "refuse", reason }]);
  });
});
```

In `tests/decisions/registry.test.ts`: change every `toHaveLength(26)` to `toHaveLength(28)`, and after the R1 block add:
```ts
  it("intake.sender (locked, intake) and turn.contract (unlocked, pre_model) are registered rule-only entries (remainder R2)", () => {
    for (const [id, locked, stage] of [["intake.sender", true, "intake"], ["turn.contract", false, "pre_model"]] as const) {
      const e = entryById(id) as AnyEntry;
      expect(e).toBeDefined();
      expect(e.stage).toBe(stage);
      expect(e.locked === true).toBe(locked);
      expect(e.ladder.map((r) => r.kind)).toEqual(["rule"]);
      expect((LOCKED_ENTRY_IDS as readonly string[]).includes(id)).toBe(locked);
    }
    expect(ENTRY_IDS).toHaveLength(28);
  });
```
Then `grep -rn "26" scripts/live-gate-ladder-*.mjs scripts/check-ladder-*.mjs | grep -v 2026` and update every registry-count literal (at least `scripts/live-gate-ladder-stage4b.mjs:172`, `=== 26` → `=== 28`); name each in the commit body.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/decisions/intake-sender.test.ts tests/decisions/turn-contract.test.ts tests/decisions/registry.test.ts`
Expected: FAIL — cannot resolve the two entry modules; length 26.

- [ ] **Step 3: Write the entries**

`src/decisions/entries/intake-sender.ts`:
```ts
import type { Entry, RungAnswer } from "../types.js";

/** authorizeTelegramUpdate's denials in check order, plus normalizeTelegramUpdate's channel-post pre-check (spec 2026-11-01 R2 §3.1). */
export const SENDER_DENIAL_REASONS = ["channel_post", "forwarded", "anonymous", "no_chat", "user_not_allowlisted", "chat_not_allowlisted", "identity_not_for_chat"] as const;
export type SenderDenialReason = (typeof SENDER_DENIAL_REASONS)[number];
export type SenderVerdict = "allow" | "deny";
/** Consulted only after a denial (pollOnce), so `null` is a bug: the rule throws and the row is `deny` at rung `fail` (§4.1). */
export interface SenderInput { denied: SenderDenialReason | null }

function rule(s: SenderInput): RungAnswer<SenderVerdict> {
  if (s.denied === null) throw new Error("intake.sender consulted for a denial with no reason");
  return { verdict: "deny", reason: s.denied };
}

export const INTAKE_SENDER: Entry<SenderInput, SenderVerdict> = {
  id: "intake.sender", version: 1, stage: "intake", input: "tool", locked: true,
  question: "Is this Telegram update from an allowlisted sender in an allowlisted chat, not forwarded and not a channel post?",
  verdicts: ["allow", "deny"],
  ladder: [{ kind: "rule", name: "authorizeTelegramUpdate", decide: rule }],
  fail: "deny", defaultVerdict: "allow", outcomes: [], armed: { rule: "on" },
  effects: { allow: { kind: "none", reversible: true, announced: "none" }, deny: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [...SENDER_DENIAL_REASONS],
};
```

`src/decisions/entries/turn-contract.ts`:
```ts
import type { Entry, RungAnswer } from "../types.js";

/** compileTaskContract's refusals (spec 2026-11-01 R2 §4.2): empty goal/message/question/topic, unknown program, unsupported type. */
export const CONTRACT_REFUSAL_REASONS = ["goal_missing", "unknown_program", "unsupported_type"] as const;
export type ContractRefusal = (typeof CONTRACT_REFUSAL_REASONS)[number];
export type TurnContractVerdict = "compile" | "restrict" | "refuse";
/** `restricted` is read off the compiled contract (a turn whose allowed_actions lack schedule_task), never re-derived from the event. */
export interface TurnContractInput { refused: ContractRefusal | null; restricted: boolean }

function rule(s: TurnContractInput): RungAnswer<TurnContractVerdict> {
  if (s.refused !== null) return { verdict: "refuse", reason: s.refused };
  return s.restricted ? { verdict: "restrict", reason: "schedule_born" } : { verdict: "compile" };
}

export const TURN_CONTRACT: Entry<TurnContractInput, TurnContractVerdict> = {
  id: "turn.contract", version: 1, stage: "pre_model", input: "tool",
  question: "Does this event compile to a contract, and is a schedule-born turn's envelope narrowed (no schedule_task)?",
  verdicts: ["compile", "restrict", "refuse"],
  ladder: [{ kind: "rule", name: "compileTaskContract", decide: rule }],
  fail: "refuse", defaultVerdict: "compile", outcomes: [], armed: { rule: "on" },
  effects: {
    compile: { kind: "none", reversible: true, announced: "none" },
    restrict: { kind: "tighten", reversible: true, announced: "none" },
    refuse: { kind: "tighten", reversible: true, announced: "none" }
  },
  reasonCodes: ["schedule_born", ...CONTRACT_REFUSAL_REASONS],
};
```

In `src/decisions/entry-ids.ts:5` append `"intake.sender", "turn.contract"` to `ENTRY_IDS` after `"intake.budget_fuse"`. In `src/decisions/registry.ts` import `INTAKE_SENDER` and `TURN_CONTRACT` beside the R1 imports and append `INTAKE_SENDER as unknown as AnyEntry, TURN_CONTRACT as unknown as AnyEntry` to `REGISTRY` after `INTAKE_BUDGET_FUSE`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/decisions/ && npm run typecheck`
Expected: PASS; typecheck 0. If `entryProblems` objects to `restrict`/`refuse` being `tighten` with an unlocked entry, read `registry.ts:84–100` and report — do not change the effect kinds without a ruling.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/entries/intake-sender.ts src/decisions/entries/turn-contract.ts src/decisions/entry-ids.ts src/decisions/registry.ts tests/decisions/intake-sender.test.ts tests/decisions/turn-contract.test.ts tests/decisions/registry.test.ts scripts/live-gate-ladder-stage4b.mjs
git commit -m "feat(decisions): register intake.sender (locked) and turn.contract (rule-only, record never steer)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The sender check names its reason; `telegram-auth.ts` joins the protected surface (3-A)

**Files:**
- Modify: `src/triggers/telegram-auth.ts` (whole file, 37 lines), `src/triggers/telegram-trigger-adapter.ts:84–86` (the type) and `:105` (the pre-check), `src/capabilities/self-write-guard.ts` (`PROTECTED_FILES`), `tests/capabilities/self-write-guard.test.ts` (the protected-paths table near `:115`), `tests/triggers/telegram-auth.test.ts:31–34`, `tests/triggers/telegram-trigger-adapter.test.ts:445–448`
- Test: `tests/triggers/telegram-sender-evidence.test.ts` (new)

**Interfaces:**
- Consumes: `SenderDenialReason` (Task 1).
- Produces: `TelegramAuthResult` failure variant `{ ok: false; error: { code: "TELEGRAM_AUTH_DENIED"; message: string }; reason: SenderDenialReason }`; `TelegramNormalizeResult` failure variant gains `reason?: SenderDenialReason` (present on every `TELEGRAM_AUTH_DENIED`, absent otherwise).

- [ ] **Step 1: Write the failing tests**

`tests/triggers/telegram-sender-evidence.test.ts` — pins every denial origin to its reason (the evidence derivation 3-A cannot protect, spec Decision 3) and the message strings (byte-identical skip rows):
```ts
import { describe, expect, it } from "vitest";
import { authorizeTelegramUpdate } from "../../src/triggers/telegram-auth.js";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import type { TelegramAllowlist } from "../../src/domain/types.js";

// Spec 2026-11-01 R2 §3.1 / Decision 3-A: telegram-auth.ts is protected, but the evidence it reads is built in the
// self-writable adapter. These pins fail if a self-write loosens how a forward, a channel post or a tap is derived.
const ALLOW: TelegramAllowlist = { users: [{ telegram_user_id: 111, identity_id: "paco" }, { telegram_user_id: 444, identity_id: "other" }],
  chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] };
const msg = (over: Record<string, unknown>) => ({ update_id: 1, message: { message_id: 1, text: "hi", from: { id: 111 }, chat: { id: 222 }, ...over } });
const tap = (from: number | undefined, chat = 222) => ({ update_id: 2, callback_query: { id: "c", data: "x", ...(from === undefined ? {} : { from: { id: from } }), message: { message_id: 3, chat: { id: chat } } } });
const denied = (reason: string, message: string) => ({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED", message }, reason });

describe("every sender denial carries its reason; messages unchanged", () => {
  it.each([
    ["channel post", { update_id: 5, channel_post: { message_id: 1, chat: { id: 222 } } }, denied("channel_post", "Channel posts are not accepted")],
    ["forward (forward_date)", msg({ forward_date: 1 }), denied("forwarded", "Forwarded commands are not accepted")],
    ["forward (forward_origin)", msg({ forward_origin: { type: "user" } }), denied("forwarded", "Forwarded commands are not accepted")],
    ["a stranger's forward (precedence: forwarded)", msg({ from: { id: 999 }, forward_date: 1 }), denied("forwarded", "Forwarded commands are not accepted")],
    ["anonymous sender", msg({ from: undefined }), denied("anonymous", "Anonymous Telegram senders are not accepted")],
    ["stranger", msg({ from: { id: 999 } }), denied("user_not_allowlisted", "Telegram user is not allowlisted")],
    ["foreign chat", msg({ chat: { id: 333 } }), denied("chat_not_allowlisted", "Telegram chat is not allowlisted")],
    ["allowlisted user, wrong chat identity", msg({ from: { id: 444 } }), denied("identity_not_for_chat", "Telegram identity is not allowlisted for this chat")],
    ["stranger's tap", tap(999), denied("user_not_allowlisted", "Telegram user is not allowlisted")],
    ["anonymous tap", tap(undefined), denied("anonymous", "Anonymous Telegram senders are not accepted")],
    ["tap from a foreign chat", tap(111, 333), denied("chat_not_allowlisted", "Telegram chat is not allowlisted")],
    ["tap, wrong chat identity", tap(444), denied("identity_not_for_chat", "Telegram identity is not allowlisted for this chat")]
  ])("%s", (_label, update, expected) => {
    expect(normalizeTelegramUpdate(update as never, ALLOW)).toEqual(expected);
  });
  it("no_chat is reachable only at the auth seam (a real update always has message.chat)", () => {
    expect(authorizeTelegramUpdate({ from_id: 111 }, ALLOW)).toEqual(denied("no_chat", "Telegram chat id is required"));
  });
  it("an allowed sender carries no reason; a non-auth failure carries none", () => {
    expect(normalizeTelegramUpdate(msg({}) as never, ALLOW)).toMatchObject({ ok: true });
    const noMessage = normalizeTelegramUpdate({ update_id: 9, callback_query: { id: "c", data: "x", from: { id: 111 } } } as never, ALLOW);
    expect(noMessage).toEqual({ ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message: "Callback query is missing its message" } });
  });
});
```
(If a fixture field name differs from `TelegramUpdate`'s real shape, read `src/domain/types.ts` / the adapter's types and fix the fixture, never the expectation.)

In `tests/capabilities/self-write-guard.test.ts`, add to the protected-paths table beside `["task-contract", …]`:
```ts
    ["telegram-auth (the sender allowlist predicate, locked intake.sender, R2 Decision 3-A)", entry({ status: "M", path: "src/triggers/telegram-auth.ts" })],
```
Update the two exact-shape tests to include the reason: `tests/triggers/telegram-auth.test.ts:31–34` gains `reason: "identity_not_for_chat"`; `tests/triggers/telegram-trigger-adapter.test.ts:445–448` gains `reason: "forwarded"` (read each first; match the denial they build).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/triggers/ tests/capabilities/self-write-guard.test.ts`
Expected: FAIL — no `reason` on any denial; `telegram-auth.ts` not protected.

- [ ] **Step 3: Implement**

`src/triggers/telegram-auth.ts` — same checks, same order, same messages; each denial names its reason:
```ts
import type { SenderDenialReason } from "../decisions/entries/intake-sender.js";
import type { Identity, TelegramAllowlist } from "../domain/types.js";

export interface TelegramAuthEvidence {
  from_id?: number | undefined;
  chat_id?: number | undefined;
  is_forwarded?: boolean;
  is_channel_post?: boolean;
}

export type TelegramAuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; error: { code: "TELEGRAM_AUTH_DENIED"; message: string }; reason: SenderDenialReason };

export function authorizeTelegramUpdate(evidence: TelegramAuthEvidence, allowlist: TelegramAllowlist): TelegramAuthResult {
  if (evidence.is_channel_post) return denied("channel_post", "Channel posts are not accepted");
  if (evidence.is_forwarded) return denied("forwarded", "Forwarded commands are not accepted");
  if (typeof evidence.from_id !== "number") return denied("anonymous", "Anonymous Telegram senders are not accepted");
  if (typeof evidence.chat_id !== "number") return denied("no_chat", "Telegram chat id is required");

  const user = allowlist.users.find((entry) => entry.telegram_user_id === evidence.from_id);
  if (!user) return denied("user_not_allowlisted", "Telegram user is not allowlisted");

  const chat = allowlist.chats.find((entry) => entry.telegram_chat_id === evidence.chat_id);
  if (!chat) return denied("chat_not_allowlisted", "Telegram chat is not allowlisted");

  if (!chat.allowed_identity_ids.includes(user.identity_id)) {
    return denied("identity_not_for_chat", "Telegram identity is not allowlisted for this chat");
  }

  return { ok: true, identity: { kind: "user", id: user.identity_id } };
}

/** The reason rides beside `error` (spec 2026-11-01 R2 §4.1): `error` and the skip row it becomes are unchanged. */
function denied(reason: SenderDenialReason, message: string): TelegramAuthResult {
  return { ok: false, error: { code: "TELEGRAM_AUTH_DENIED", message }, reason };
}
```
(`src/decisions/entries/intake-sender.ts` imports only types, so the type-only import adds no runtime edge. Confirm `npm run build` emits no `import` of it in `dist/triggers/telegram-auth.js`.)

`src/triggers/telegram-trigger-adapter.ts:84–86`:
```ts
export type TelegramNormalizeResult =
  | { ok: true; event: TelegramNormalizedEvent }
  | { ok: false; error: { code: string; message: string }; acknowledgement?: TelegramAcknowledgement; reason?: SenderDenialReason };
```
(add `import type { SenderDenialReason } from "../decisions/entries/intake-sender.js";`), and `:105`:
```ts
    return { ok: false, error: { code: "TELEGRAM_AUTH_DENIED", message: "Channel posts are not accepted" }, reason: "channel_post" };
```
The two `if (!auth.ok) return auth;` lines stay as they are (the reason passes through).

`src/capabilities/self-write-guard.ts` `PROTECTED_FILES`, after `"src/contracts/task-contract.ts",`:
```ts
  "src/triggers/telegram-auth.ts", // the sender allowlist predicate — locked intake.sender's raw answer (R2 Decision 3-A); the evidence derivation stays in the adapter, pinned by tests/triggers/telegram-sender-evidence.test.ts
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/triggers/ tests/capabilities/ tests/eval/ && npm run typecheck`
Expected: PASS; typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add src/triggers/telegram-auth.ts src/triggers/telegram-trigger-adapter.ts src/capabilities/self-write-guard.ts tests/triggers/telegram-sender-evidence.test.ts tests/triggers/telegram-auth.test.ts tests/triggers/telegram-trigger-adapter.test.ts tests/capabilities/self-write-guard.test.ts
git commit -m "refactor(telegram): every sender denial names its reason beside the unchanged error; protect telegram-auth.ts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `intake.sender` recorded in `pollOnce`, wired by both constructors

**Files:**
- Modify: `src/triggers/telegram-trigger-adapter.ts` (`TelegramLongPollingAdapterOptions` `:556–565`, `pollOnce`'s `!normalized.ok` branch `:612–631`), `src/telegram/telegram-poll-runner.ts:162–183`, `src/telegram/telegram-daemon.ts:231–253`
- Test: `tests/triggers/sender-decisions.test.ts` (new), `tests/telegram/sender-decision-wiring.test.ts` (new)

**Interfaces:**
- Consumes: `INTAKE_SENDER` (Task 1); `normalized.reason` (Task 2); `decideSync` (`src/decisions/decide.js`), `storeRecorder` (`src/decisions/record.js`), `DecisionRecorder` (`src/decisions/types.js`).
- Produces: `TelegramLongPollingAdapterOptions.decisionRecorder?: DecisionRecorder`.

- [ ] **Step 1: Write the failing tests**

`tests/triggers/sender-decisions.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import type { TelegramAllowlist } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { createTelegramLongPollingAdapter } from "../../src/triggers/telegram-trigger-adapter.js";

// Spec 2026-11-01 R2 §4.1: a refused sender leaves one row naming why; it still gets nothing back, and the skip row and
// offset are written first (the durable truth that keeps the loop moving).
const ALLOW: TelegramAllowlist = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] };
const msg = (update_id: number, from: number, extra: Record<string, unknown> = {}) => ({ update_id, message: { message_id: update_id, text: "hi", from: { id: from }, chat: { id: 222 }, ...extra } });
let saved: string | undefined;
beforeEach(() => { saved = process.env.HOUGE_TELEGRAM_CHAT_ID; delete process.env.HOUGE_TELEGRAM_CHAT_ID; });
afterEach(() => { if (saved === undefined) delete process.env.HOUGE_TELEGRAM_CHAT_ID; else process.env.HOUGE_TELEGRAM_CHAT_ID = saved; });

function rig(store: RunStore, updates: unknown[], recorder: DecisionRecorder = storeRecorder(store)) {
  const order: string[] = []; const emitted: unknown[] = []; const acks: unknown[] = [];
  const counted: DecisionRecorder = { record: (e, r, c) => { order.push(`decision:${e.id}`); return recorder.record(e, r, c); } };
  const adapter = createTelegramLongPollingAdapter({
    allowlist: ALLOW, client: { getUpdates: async () => updates as never },
    offsetStore: { getOffset: (s) => store.getOffset(s), setOffset: (s, o) => { order.push(`offset:${o}`); store.setOffset(s, o); } },
    skippedUpdateStore: { recordSkippedTelegramUpdate: (i) => { order.push(`skip:${i.update_id}`); store.recordSkippedTelegramUpdate(i); } },
    acknowledgeSink: (a) => { acks.push(a); }, decisionRecorder: counted
  });
  return { order, emitted, acks, poll: () => adapter.pollOnce(async (e) => { emitted.push(e); }) };
}
const senderRows = (store: RunStore) => (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db
  .prepare("SELECT verdict, reason_code, rung, run_id, tool_call_id, stage FROM decisions WHERE entry_id = 'intake.sender' ORDER BY rowid").all();

describe("intake.sender in pollOnce", () => {
  it("a stranger → skip row, offset, then one deny row with no run; nothing emitted, no acknowledgement", async () => {
    const store = RunStore.openInMemory();
    const r = rig(store, [msg(10, 999)]);
    expect(await r.poll()).toEqual({ processed_updates: 0, skipped_updates: 1 });
    expect(r.order).toEqual(["skip:10", "offset:11", "decision:intake.sender"]);
    expect(senderRows(store)).toEqual([{ verdict: "deny", reason_code: "user_not_allowlisted", rung: "rule", run_id: null, tool_call_id: null, stage: "intake" }]);
    expect(r.emitted).toEqual([]); expect(r.acks).toEqual([]);
  });
  it("Paco's own message is emitted and never consults the entry", async () => {
    const store = RunStore.openInMemory();
    const r = rig(store, [msg(10, 111)]);
    await r.poll();
    expect(r.emitted).toHaveLength(1);
    expect(r.order.filter((o) => o.startsWith("decision:"))).toEqual([]);
    expect(senderRows(store)).toEqual([]);
  });
  it("a malformed command from Paco (invalid-command ack) is not a sender decision", async () => {
    const store = RunStore.openInMemory();
    const r = rig(store, [{ update_id: 12, message: { message_id: 12, text: "/deny", from: { id: 111 }, chat: { id: 222 } } }]);
    await r.poll();
    expect(r.acks).toHaveLength(1);
    expect(senderRows(store)).toEqual([]);
  });
  it("a denial between two allowed updates: order and offsets unchanged, one row", async () => {
    const store = RunStore.openInMemory();
    const r = rig(store, [msg(20, 111), msg(21, 999, { forward_date: 1 }), msg(22, 111)]);
    await r.poll();
    expect(r.emitted).toHaveLength(2);
    expect(store.getOffset("telegram")).toBe(23);
    expect(senderRows(store).map((x) => x.reason_code)).toEqual(["forwarded"]);
  });
  it("a failed decision insert opens decision_record_failed; the skip row, offset and silence to the sender are unchanged", async () => {
    const store = RunStore.openInMemory();
    (store as unknown as { insertDecision: () => never }).insertDecision = () => { throw new Error("planted"); };
    const r = rig(store, [msg(10, 999)]);
    await r.poll();
    expect(store.getOffset("telegram")).toBe(11);
    expect(r.emitted).toEqual([]); expect(r.acks).toEqual([]);
    const incidents = (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db
      .prepare("SELECT kind, subject FROM incidents WHERE kind = 'decision_record_failed'").all();
    expect(incidents).toEqual([{ kind: "decision_record_failed", subject: "intake.sender" }]);
  });
  it("a recorder that throws past itself changes nothing and opens no incident", async () => {
    const store = RunStore.openInMemory();
    const r = rig(store, [msg(10, 999)], { record: () => { throw new Error("planted"); } });
    await r.poll();
    expect(store.getOffset("telegram")).toBe(11);
    const n = (store as unknown as { db: { prepare(s: string): { get(): { n: number } } } }).db.prepare("SELECT count(*) AS n FROM incidents").get().n;
    expect(n).toBe(0);
  });
  it("no recorder (eval and older callers) → the denial is handled exactly as before, no row", async () => {
    const store = RunStore.openInMemory();
    const adapter = createTelegramLongPollingAdapter({ allowlist: ALLOW, client: { getUpdates: async () => [msg(10, 999)] as never },
      offsetStore: { getOffset: (s) => store.getOffset(s), setOffset: (s, o) => store.setOffset(s, o) } });
    expect(await adapter.pollOnce(async () => undefined)).toEqual({ processed_updates: 0, skipped_updates: 1 });
    expect(senderRows(store)).toEqual([]);
  });
});
```
(Read `incidents`' real column names in `run-store.ts` and the `insertDecision` method name before running; fix the fixture, never the expectation. If the store's offset getter returns something other than a number for an unset source, read `getOffset` and adapt.)

`tests/telegram/sender-decision-wiring.test.ts` — the production constructors (codex B1: corpora inject recorders and cannot see a constructor that forgets one):
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramPollOnce } from "../../src/telegram/telegram-poll-runner.js";
import { runTelegramDaemon as runDaemon } from "../../src/telegram/telegram-daemon.js";
import { NO_OMP_PROBE, pinOmpEnv, tmpOmpDist, useFakeOmp } from "../helpers/omp-env.js";

pinOmpEnv();
const ALLOW = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] };
const stranger = (update_id: number) => ({ update_id, message: { message_id: update_id, text: "hi", from: { id: 999 }, chat: { id: 222 } } });
const rows = (store: RunStore) => (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
  .prepare("SELECT verdict, reason_code FROM decisions WHERE entry_id = 'intake.sender'").all();

describe("both production poll constructors record intake.sender", () => {
  it("runTelegramPollOnce", async () => {
    const store = RunStore.openInMemory(); const root = mkdtempSync(join(tmpdir(), "hg-sw-")); const sent: string[] = [];
    try {
      useFakeOmp({ "*": { rpcText: "x" } }, root);
      await runTelegramPollOnce({ store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) }, allowlist: ALLOW,
        telegramClient: { getUpdates: async () => [stranger(30)], sendMessage: async ({ text }) => { sent.push(text); return { message_id: 1 }; } } });
      expect(rows(store)).toEqual([{ verdict: "deny", reason_code: "user_not_allowlisted" }]);
      expect(sent).toEqual([]);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("runTelegramDaemon", async () => {
    const store = RunStore.openInMemory(); const root = mkdtempSync(join(tmpdir(), "hg-sw-")); const sent: string[] = [];
    const controller = new AbortController(); let calls = 0;
    try {
      useFakeOmp({ "*": { rpcText: "x" } }, root);
      await runDaemon({ ...NO_OMP_PROBE, store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) }, allowlist: ALLOW,
        stopSignal: controller.signal, longPollTimeoutSeconds: 0,
        telegramClient: { getUpdates: async () => { calls += 1; if (calls === 1) return [stranger(31)]; controller.abort(); return []; },
          sendMessage: async ({ text }) => { sent.push(text); return { message_id: 1 }; } } });
      expect(rows(store)).toEqual([{ verdict: "deny", reason_code: "user_not_allowlisted" }]);
      expect(sent).toEqual([]);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
```
(Copy any missing required option of `runTelegramDaemon` from `tests/telegram/telegram-daemon.test.ts:127–168` — e.g. `llmAdapter`, the `fakeOmp` helper.) **P11:** add the `beforeEach`/`afterEach` env pin for the six variables, record `sendMessage` as `{ chat_id, text }`, and replace both `expect(sent).toEqual([])` with `expect(sent.filter((m) => m.chat_id === "222")).toEqual([])`. Show the daemon case passing with `HOUGE_SCHEDULER_ENABLED=true HOUGE_RADAR_ENABLED=true HOUGE_TELEGRAM_CHAT_ID=999` exported in the shell (the senior's failing environment).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/triggers/sender-decisions.test.ts tests/telegram/sender-decision-wiring.test.ts`
Expected: FAIL — no `decisionRecorder` option; no rows.

- [ ] **Step 3: Implement**

`TelegramLongPollingAdapterOptions` gains, after `skippedUpdateStore?`:
```ts
  /** Records intake.sender on a denied update (spec 2026-11-01 R2 §4.1); absent (eval, tests) → no row, the denial unchanged. */
  decisionRecorder?: DecisionRecorder;
```
In `pollOnce`, the `!normalized.ok` branch, immediately after `options.offsetStore.setOffset(TELEGRAM_OFFSET_SOURCE, update.update_id + 1);` and `skipped += 1;`:
```ts
          // After the skip row and the offset (the durable truth); never throws (decideSync catches), never replies.
          if (normalized.error.code === "TELEGRAM_AUTH_DENIED" && options.decisionRecorder) {
            decideSync(INTAKE_SENDER, { denied: normalized.reason ?? null }, { run_id: null, tool_call_id: null, recorder: options.decisionRecorder });
          }
```
Imports: `import { decideSync } from "../decisions/decide.js"; import { INTAKE_SENDER } from "../decisions/entries/intake-sender.js"; import type { DecisionRecorder } from "../decisions/types.js";`. Check for an import cycle (`src/decisions/*` must not import `src/triggers/*`): `grep -rn "triggers/" src/decisions/` returns nothing; if it does, stop and report.

Both constructors (`telegram-poll-runner.ts:162`, `telegram-daemon.ts:231`) add, after `skippedUpdateStore: {…},`:
```ts
    decisionRecorder: storeRecorder(options.store), // intake.sender (spec 2026-11-01 R2 §4.1); no env: a record failure pages HOUGE_TELEGRAM_CHAT_ID
```
with `import { storeRecorder } from "../decisions/record.js";` (if already imported, reuse).

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/triggers/ tests/telegram/ && npm run typecheck`
Expected: PASS; typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add src/triggers/telegram-trigger-adapter.ts src/telegram/telegram-poll-runner.ts src/telegram/telegram-daemon.ts tests/triggers/sender-decisions.test.ts tests/telegram/sender-decision-wiring.test.ts
git commit -m "feat(telegram): record intake.sender after a denied update's skip row; both poll constructors wire the recorder" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The contract compile names its refusal

**Files:**
- Modify: `src/contracts/task-contract.ts` (`TaskContractResult` `:4–9`, `invalid` `:11–16`, the seven `invalid(` calls `:28`, `:37`, `:42`, `:61`, `:157`, `:186`, `:188`), `tests/contracts/task-contract.test.ts:32–36`, `:83–85`
- Test: `tests/contracts/task-contract.test.ts` (extended)

**Interfaces:**
- Consumes: `ContractRefusal` (Task 1).
- Produces: `TaskContractResult` failure variant `{ ok: false; error: { code: "TASK_CONTRACT_INVALID"; message: string }; reason: ContractRefusal }`.

- [ ] **Step 1: Write the failing tests** — append to `tests/contracts/task-contract.test.ts`:
```ts
describe("every contract refusal names its reason beside the unchanged error (spec 2026-11-01 R2 §4.2)", () => {
  const base = { source: "telegram", requested_by: { kind: "user", id: "paco" }, notify: { kind: "local" }, idempotency_key: "k", source_reference: "r" } as const;
  const ev = (o: Record<string, unknown>) => buildTypedTaskEvent({ ...base, ...o } as never);
  it.each([
    ["unsupported type", { type: "bogus" }, "unsupported_type", "Unsupported event type: bogus"],
    ["unknown /run program", { type: "run", program: "nosuch", goal: "g" }, "unknown_program", "Unknown program: nosuch"],
    ["/run without a program", { type: "run", goal: "g" }, "unknown_program", "Unknown program: (missing)"],
    ["research-brief, empty goal", { type: "run", program: "research-brief", goal: " " }, "goal_missing", "Goal is required"],
    ["web-research, empty topic", { type: "run", program: "web-research", goal: " " }, "goal_missing", "Topic is required"],
    ["turn, empty message", { type: "turn", program: "turn", goal: " " }, "goal_missing", "Message is required"],
    ["ask, foreign program", { type: "ask", program: "nosuch", goal: "g" }, "unknown_program", "Unknown program: nosuch"],
    ["ask, empty question", { type: "ask", goal: " " }, "goal_missing", "Question is required"]
  ])("%s", (_l, o, reason, message) => {
    expect(compileTaskContract(ev(o))).toEqual({ ok: false, error: { code: "TASK_CONTRACT_INVALID", message }, reason });
  });
  it("totality: seven invalid( call sites besides the definition, each naming a reason first", () => {
    const src = readFileSync(new URL("../../src/contracts/task-contract.ts", import.meta.url), "utf8");
    expect([...src.matchAll(/\binvalid\(/g)]).toHaveLength(8); // the definition + seven calls
    expect([...src.matchAll(/\binvalid\("(goal_missing|unknown_program|unsupported_type)", /g)]).toHaveLength(7);
  });
});
```
(Add `import { readFileSync } from "node:fs";` and `buildTypedTaskEvent` from `../../src/domain/types.js` if not imported.) If `buildTypedTaskEvent` rejects an empty goal or an unknown type before the compiler sees it, build the event object literally instead, and say so in the commit body.

Update the two existing exact-shape assertions (`:32–36`, `:83–85`) to add the reason they produce (read each: an unknown program → `"unknown_program"`; "Message is required" → `"goal_missing"`).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/contracts/task-contract.test.ts`
Expected: FAIL — no `reason`.

- [ ] **Step 3: Implement**
```ts
import type { ContractRefusal } from "../decisions/entries/turn-contract.js";

export type TaskContractResult =
  | { ok: true; contract: CompiledTaskContract }
  | {
      ok: false;
      error: { code: "TASK_CONTRACT_INVALID"; message: string };
      /** Beside `error` (spec 2026-11-01 R2 §4.2): the gateway returns `error` alone, so no intake result changes. */
      reason: ContractRefusal;
    };

function invalid(reason: ContractRefusal, message: string): TaskContractResult {
  return {
    ok: false,
    error: { code: "TASK_CONTRACT_INVALID", message },
    reason
  };
}
```
and each call site: `:28` `invalid("unsupported_type", …)`; `:37` `invalid("unknown_program", …)`; `:42` `invalid("goal_missing", "Goal is required")`; `:61` `invalid("goal_missing", "Topic is required")`; `:157` `invalid("goal_missing", "Message is required")`; `:186` `invalid("unknown_program", …)`; `:188` `invalid("goal_missing", "Question is required")`. Messages unchanged.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run tests/contracts/ tests/gateway/ && npm run typecheck`
Expected: PASS (the gateway still returns `{ ok: false, error: contract.error }`, so gateway tests are unchanged); typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/task-contract.ts tests/contracts/task-contract.test.ts
git commit -m "refactor(contracts): every task-contract refusal names its reason beside the unchanged error" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `turn.contract` call sites in `Gateway`; injectable recorder

**Files:**
- Modify: `src/gateway/gateway.ts` (constructor `options` type; the `decisionRecorder` getter `:155–156`; `handleTaskIntake`'s refusal line and its `if (queued.ok)` block)
- Test: `tests/gateway/contract-decisions.test.ts` (new)

**Interfaces:**
- Consumes: `TURN_CONTRACT`, `TurnContractInput` (Task 1); `contract.reason` (Task 4); `TURN_ACTIONS` is not used (the strip is read off the contract).
- Produces: `Gateway` constructor `options.decisionRecorder?: DecisionRecorder` (the corpus and gate inject a counting wrapper).

- [ ] **Step 1: Write the failing test** — `tests/gateway/contract-decisions.test.ts`:
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_BUDGET_CAPS } from "../../src/budget/global-budget-ledger.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import { buildTypedTaskEvent, type TypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-11-01 R2 §4.2 (Decision 1-B): a refusal and a schedule-born turn's narrowed envelope leave a row; a plain
// compile is consulted and writes none; fuse cycles, duplicates and failed attaches write nothing.
const NOW = "2026-07-03T12:00:00.000Z";
const PINNED = ["HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH"] as const;
const saved: Partial<Record<(typeof PINNED)[number], string>> = {};
let dir = ""; let seq = 0;
beforeEach(() => {
  for (const k of PINNED) { if (process.env[k] !== undefined) saved[k] = process.env[k]; else delete saved[k]; }
  dir = mkdtempSync(join(tmpdir(), "hg-contract-"));
  delete process.env.HOUGE_TELEGRAM_CHAT_ID;
  process.env.HOUGE_TOMBSTONE_PATH = join(dir, "t.kill"); process.env.HOUGE_DISARM_PATH = join(dir, "t.disarm");
});
afterEach(() => { for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } rmSync(dir, { recursive: true, force: true }); });

function ev(o: { source?: "telegram" | "schedule"; type?: string; program?: string; goal?: string; key?: string } = {}): TypedTaskEvent {
  seq += 1;
  const source = o.source ?? "telegram";
  return buildTypedTaskEvent({ source, type: o.type ?? "turn", program: o.program ?? "turn", goal: o.goal ?? "synthetic",
    requested_by: source === "schedule" ? { kind: "schedule", id: "sch_1" } : { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" }, idempotency_key: o.key ?? `k:${seq}`, source_reference: `ref:${seq}` } as never);
}
function rig(caps = DEFAULT_GLOBAL_BUDGET_CAPS) {
  const store = RunStore.openInMemory(); const calls: string[] = [];
  const inner = storeRecorder(store);
  const recorder: DecisionRecorder = { record: (e, r, c) => { calls.push(e.id); return inner.record(e, r, c); } };
  return { store, calls, g: new Gateway(store, caps, undefined, undefined, undefined, { decisionRecorder: recorder }),
    contractCalls: () => calls.filter((id) => id === "turn.contract").length };
}
const rows = (store: RunStore) => (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db
  .prepare("SELECT verdict, reason_code, run_id, stage FROM decisions WHERE entry_id = 'turn.contract' ORDER BY rowid").all();

describe("turn.contract at handleTaskIntake", () => {
  it("a Telegram turn → consulted once, no row (compile is the default)", () => {
    const r = rig(); const out = r.g.intake(ev(), NOW);
    expect(out.ok).toBe(true);
    expect(r.contractCalls()).toBe(1);
    expect(rows(r.store)).toEqual([]);
  });
  it("a scheduled turn → one restrict/schedule_born row carrying the new run's id; the contract still lacks schedule_task", () => {
    const r = rig(); const out = r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:1" }), NOW);
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(rows(r.store)).toEqual([{ verdict: "restrict", reason_code: "schedule_born", run_id: out.run_id, stage: "pre_model" }]);
    const contract = (r.store as unknown as { db: { prepare(s: string): { get(id: string): { contract_json: string } } } }).db
      .prepare("SELECT contract_json FROM runs WHERE run_id = ?").get(out.run_id).contract_json;
    expect(JSON.parse(contract).allowed_actions).not.toContain("schedule_task");
  });
  it("the same scheduled occurrence replayed (duplicate) → still one row, one call", () => {
    const r = rig();
    r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:2" }), NOW);
    r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:2" }), NOW);
    expect(rows(r.store)).toHaveLength(1);
    expect(r.contractCalls()).toBe(1);
  });
  it("a scheduled turn under a tripped fuse, two cycles → zero turn.contract calls and rows (only the fuse records)", () => {
    const r = rig({ ...DEFAULT_GLOBAL_BUDGET_CAPS, runs: 0 });
    for (let i = 0; i < 2; i += 1) expect(r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:3" }), NOW)).toMatchObject({ ok: false, error: { code: "GLOBAL_BUDGET_FUSE" } });
    expect(r.contractCalls()).toBe(0);
    expect(rows(r.store)).toEqual([]);
    expect(r.calls.filter((id) => id === "intake.budget_fuse")).toHaveLength(2);
  });
  it.each([
    ["/run nosuch", { type: "run", program: "nosuch" }, "unknown_program"],
    ["an empty Telegram turn", { goal: " " }, "goal_missing"],
    ["an empty scheduled turn", { source: "schedule" as const, goal: " " }, "goal_missing"],
    ["an unsupported type", { type: "bogus" }, "unsupported_type"]
  ])("%s → refuse with no run; the intake result is the unchanged error", (_l, o, reason) => {
    const r = rig(); const out = r.g.intake(ev(o), NOW);
    expect(out).toMatchObject({ ok: false, error: { code: "TASK_CONTRACT_INVALID" } });
    expect(Object.keys((out as { error: object }).error).sort()).toEqual(["code", "message"]);
    expect(out).not.toHaveProperty("reason");
    expect(rows(r.store)).toEqual([{ verdict: "refuse", reason_code: reason, run_id: null, stage: "pre_model" }]);
  });
  it("the row is the first write of the queued block: a later throw there cannot cost it", () => {
    const r = rig();
    (r.store as unknown as { recordGlobalBudgetRun: () => never }).recordGlobalBudgetRun = () => { throw new Error("planted"); };
    expect(() => r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:4" }), NOW)).toThrow("planted");
    expect(rows(r.store)).toHaveLength(1);
  });
  it("order (codex W): the decision row precedes recordGlobalBudgetRun, disarmGlobalFuse and recordTelegramAccepted", () => {
    const r = rig(); const order: string[] = [];
    const s = r.store as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ["insertDecision", "recordGlobalBudgetRun", "disarmGlobalFuse", "recordTelegramCommandAudit"]) {
      const orig = s[m]!.bind(r.store); s[m] = (...a: unknown[]) => { order.push(m); return orig(...a); };
    }
    r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:6" }), NOW);
    expect(order.slice(0, 3)).toEqual(["insertDecision", "recordGlobalBudgetRun", "disarmGlobalFuse"]);
  });
  it("no injected recorder → the lazy store recorder as before (rows still written)", () => {
    const store = RunStore.openInMemory();
    new Gateway(store).intake(ev({ source: "schedule", key: "schedule:sch_1:5" }), NOW);
    expect(rows(store).map((x) => x.verdict)).toEqual(["restrict"]);
  });
});
```
Add the two other entry paths into `handleTaskIntake` (senior W2), inside the same `describe`:
```ts
  it("a rating forward (digit + comment) re-enters handleTaskIntake → consulted once, no row", () => {
    const r = rig();
    const ago = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
    r.store.writePendingRating({ chat_id: "222", asked_at: ago(40), window_start: ago(120) }); // as tests/gateway/rating-reply-decisions.test.ts:36
    const out = r.g.intake(ev({ goal: "2 synthetic comment" }), NOW);
    expect(out).toMatchObject({ ok: true, status: "created" });
    expect(r.contractCalls()).toBe(1);
    expect(rows(r.store)).toEqual([]);
  });
  it("a memory-lane Ask runs handleTaskIntake inside admitMemLaneAsk's transaction → consulted once, no row", () => {
    const r = rig();
    const original = createQueuedTurnRun(r.store, "synthetic rule"); // setup as tests/gateway/intake-decisions.test.ts:136–143
    r.store.recordChatTurn({ chat_id: "555", run_id: original, role: "user", text: "synthetic rule" });
    r.store.insertJevVerdict({ run_id: original, category: "memory", breadth: 1, reasoning: 1, actions: 0, sets_rule: 0.95, rule_scope: "ask",
      lane: "memory", role: "default", effort: null, cascade: null, save_outcome: "saved", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });
    let n = 0;
    const g = new Gateway(r.store, DEFAULT_GLOBAL_BUDGET_CAPS, undefined, undefined, undefined, { dataDir: dir, decisionRecorder: { record: (e, x, c) => { if (e.id === "turn.contract") n += 1; return storeRecorder(r.store).record(e, x, c); } } });
    const out = g.intake(buildTypedTaskEvent({ source: "telegram", type: "memlane_ask", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "mla:1", source_reference: "mla:1",
      metadata: { telegram_update_id: 1, telegram_callback_id: "mla:1", run_id: original } } as never), NOW);
    expect(out.ok).toBe(true);
    expect(n).toBe(1);
    expect(rows(r.store)).toEqual([]);
  });
```
(Import `createQueuedTurnRun` from `../helpers/runs.js`.)

**P10 — existing tests this changes.** Update, in this task, every existing test that intakes a schedule-born turn through `Gateway` and asserts exact `decisions` rows, adding the one expected row (`turn.contract`, `restrict`, `schedule_born`, the run's id) to its expectation: `tests/capabilities/approval-bind-matrix.test.ts` (6 cases: P5 swap, P5 control, 4× standing_trial — through `makeRun` and `assertWholeTable`) and `tests/capabilities/memory-correct-preflight.test.ts` ("a refusal through a real storeRecorder stores one refuse row"). Then grep for any other: `grep -rln 'source: "schedule"' tests | xargs grep -ln "listDecisionsForRun\|FROM decisions\|assertWholeTable"` (at `ef4d0d1`: also `tests/core/memory-write-admit.test.ts`, `tests/core/memory-write-service.test.ts`, `tests/omp/bridge-handler-standing.test.ts`, `tests/gateway/rating-reply-decisions.test.ts` — the senior ran `tests/core`, `tests/omp`, `tests/gateway` green, so these filter by entry id; confirm each and name it in the commit body).

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/gateway/contract-decisions.test.ts`
Expected: FAIL — `decisionRecorder` not an option; no rows.

- [ ] **Step 3: Implement** in `src/gateway/gateway.ts`:
  - The constructor's last parameter type becomes `{ dataDir?: string; roles?: ModelsRoles; decisionRecorder?: DecisionRecorder } = {}`.
  - The getter: `private get decisionRecorder(): DecisionRecorder { return (this.recorderCache ??= this.options.decisionRecorder ?? storeRecorder(this.runStore)); }` (update its doc comment: injectable for the differential and the gate, spec R2 §4.2).
  - The refusal line (Task 2-A hotfix shape) becomes:
```ts
    if (!contract.ok) {
      decideSync(TURN_CONTRACT, { refused: contract.reason, restricted: false }, { run_id: null, tool_call_id: null, recorder: this.decisionRecorder });
      return this.refuseContract(event, contract.error);
    }
```
  - The first statement inside `if (queued.ok) {`:
```ts
      // turn.contract (spec 2026-11-01 R2 §4.2): first, so no later write in this block can cost the row; one per admitted run.
      const restricted = event.type === "turn" && !contract.contract.allowed_actions.includes("schedule_task");
      decideSync(TURN_CONTRACT, { refused: null, restricted }, { run_id: created.run_id, tool_call_id: null, recorder: this.decisionRecorder });
```
  - Import `TURN_CONTRACT` from `../decisions/entries/turn-contract.js`.
  - `handleTaskIntake` already exceeds 50 lines (pre-existing); this adds 5. Say so in the commit body; the split stays a follow-up.

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run tests/gateway/ tests/telegram/ tests/run/ tests/capabilities/ tests/core/ tests/omp/ tests/decisions/ && npm run typecheck`
Expected: PASS (the 7 P10 tests green with the row added, not filtered); typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/gateway.ts tests/gateway/contract-decisions.test.ts tests/capabilities/approval-bind-matrix.test.ts tests/capabilities/memory-correct-preflight.test.ts
git commit -m "feat(gateway): record turn.contract at a refusal and for each admitted run; the recorder is injectable" -m "handleTaskIntake was already over 50 lines; +5 here, split left as a follow-up." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Harness — the `r2` pair, row filters, exports

**Files:**
- Modify: `scripts/stage4-diff-lib.mjs` (`DISTS` `:7`, `EXPORTS` `:17`, `INTAKE_IDS`/`NEW_ROW_IDS` `:144–151`), `scripts/check-ladder-stage4-differential.mjs` (usage comment `:1–15`, args `:31–32`, provenance `:40–52`, `ctx.dists`)

**Interfaces:**
- Produces: `DISTS.r2`, `ctx.dists.r2`; corpora use `pairs: [["r2", "new"]]`; `export const R2_IDS = ["intake.sender", "turn.contract"]`; `NEW_ROW_IDS.r2`.

- [ ] **Step 1: lib**
  - `DISTS = { new: null, s3: null, s4a: null, s4b: null, r1: null, r2: null }`.
  - After `INTAKE_IDS`: `export const R2_IDS = ["intake.sender", "turn.contract"];` and every set in `NEW_ROW_IDS` gains `...R2_IDS`; add `r2: new Set(R2_IDS)`. Doc comment: the branch build is the new side of every pair; the corpora that intake scheduled turns through `Gateway` (R1 `intake.mjs` `source: "schedule"` items, 4B `memadmit.mjs:135`) would otherwise show a spurious `restrict` row; 4C's `schedule.mjs` never touches `Gateway`.
  - `EXPORTS` gains `createTelegramLongPollingAdapter: "triggers/telegram-trigger-adapter.js"` and `runTelegramPollOnce: "telegram/telegram-poll-runner.js"` (Task 9).
- [ ] **Step 1b: the existing corpora (P10; senior B2, codex B1+B2).** The senior applied Step 1 alone and measured: `intake` FAIL (`schedule:saturated`, `no_ask:schedule`: `db.decisions` + `required`), `binding` FAIL (7 `omp:*` items, "unexpected decision entries: turn.contract", `binding.mjs:138`), `memadmit` FAIL (`w:scheduled:loop`, `w:scheduled:lane`, `memadmit.mjs:181`), `memcorrect` FAIL (`not_operator_turn:pre`, `:write`); `schedule`, `stub` PASS; `redaction` a load error, not diagnosed. These corpora read raw `decisions` rows, which `NEW_ROW_IDS` never reaches. Edit each so the expected `turn.contract` row is **asserted exactly** (P10), on the new side only (the old side must hold none — keep or add that control):
  - `scripts/stage4-corpora/intake.mjs`: `dumpDb(store, { dropDecisionIds: [...INTAKE_IDS, ...R2_IDS] })`; `tableCounts` (`:75`) excludes the same ids; the `intake` select keeps `INTAKE_IDS` rows, a second select `r2` (`__strip`) reads `R2_IDS` rows; `required` checks `r2` against the item's `expectR2` (default `[]`; the admitted scheduled items set `[["turn.contract", "restrict", "schedule_born"]]` and the row's `run_id` equals the item's created run).
  - `scripts/stage4-corpora/binding.mjs:138`, `memadmit.mjs:181`, `memcorrect.mjs` (its "other entries" check): accept exactly one `turn.contract|restrict|schedule_born` row whose `run_id` is the item's scheduled run when the item's run is schedule-born, and none otherwise; any other id still fails. Drop `R2_IDS` before any `relabelClocks` over a projection that holds `decisions` rows.
  - `redaction`: diagnose the load error on the **unmodified** branch first (`git stash` the lib edit, run `--only redaction`). It passed at R1's ship (10 corpora, 2026-10-30), so suspect the environment first (machine load, the transcript-count pin, a stale temp root). The final differential must PASS every corpus — no exception: if it fails on `ef4d0d1` too, fix it as its own `fix(gate):` commit in this task with the diagnosis in the body; if it appears only with this slice, fix the slice.

- [ ] **Step 2: CLI** — `--old-dist-r2 <dir>` (required; must contain `gateway/gateway.js`) and `--old-base-r2 <full sha>` (required once merged); `p7 = verifyStampedDist(a.oldR2, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBaseR2 ?? undefined), "gateway/gateway.js")`; printed like `r1`; `ctx.dists.r2 = await loadDist(args.oldR2)`; usage comment names both flags and the full post-merge command.

- [ ] **Step 3: Verify** — `git worktree add .worktrees/base-ef4d0d1 ef4d0d1`; `ln -s ../../node_modules .worktrees/base-ef4d0d1/node_modules`; `(cd .worktrees/base-ef4d0d1 && npm run build)`; `node scripts/stamp-dist.mjs .worktrees/base-ef4d0d1`. On the branch: `npm run build && node scripts/check-ladder-stage4-differential.mjs --old-dist-3 .worktrees/base-548cb87/dist --old-dist-4a .worktrees/base-1451a66/dist --old-dist-4b .worktrees/base-c558413/dist --old-base c558413c3e248122256c3355b8852d3879aed3f6 --old-dist-r1 .worktrees/base-aec1d4f/dist --old-base-r1 aec1d4f9377f8fcebf883eaed8a81538b2cf8aef --old-dist-r2 .worktrees/base-ef4d0d1/dist`
Expected: the ten existing corpora PASS (their only change the exact `turn.contract` assertions of Step 1b; P2: stop and report any `:contract_invalid` difference); exit 0. Then `--old-dist-r2 dist` → exit 2 `same_build` on `gateway/gateway.js`. Then a planted miss: in a scratch copy of `dist/gateway/gateway.js` delete the `queued.ok` `decideSync` line and run `--only intake` → FAIL on the scheduled items (shows the Step 1b assertions are exact, not filters); restore.

- [ ] **Step 4: Commit**

```bash
git add scripts/stage4-diff-lib.mjs scripts/check-ladder-stage4-differential.mjs scripts/stage4-corpora/intake.mjs scripts/stage4-corpora/binding.mjs scripts/stage4-corpora/memadmit.mjs scripts/stage4-corpora/memcorrect.mjs
git commit -m "test(gate): differential gains the r2 stamped pair and filters intake.sender / turn.contract rows on every pair" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Corpus `sender`

**Files:**
- Create: `scripts/stage4-sender-fixture.mjs`, `scripts/stage4-corpora/sender.mjs`

**Interfaces:**
- Consumes: `DISTS`, `mkStore`, `mkTemp`, `dumpDb`, `relabelClocks`, `scrubIds`, `R2_IDS` (Task 6); R1's `withCountingClock`, `withPinnedEnv` (`scripts/stage4-intake-fixture.mjs`); each dist's `createTelegramLongPollingAdapter`, `storeRecorder`.
- Produces: `senderUpdate(kind, opts)` (message, forward, channel post, tap, photo, malformed command; synthetic ids `111` Paco / `999` stranger / `444` other identity, chat `222` / `333`), `pollItem(d, store, updates, { recorder })` → `{ result, emitted, acks, offset, calls }` (Task 9 reuses both).

Corpus shape: copy `scripts/stage4-corpora/intake.mjs` (`export default { name: "sender", pairs: [["r2", "new"]], min, load, project, required }`).

- [ ] **Step 1: Fixture.** `pollItem` builds the dist's adapter with `allowlist` (Paco `111` in chat `222`; `444` allowlisted as identity `other`, not for chat `222`), a stub `getUpdates` returning the item's updates once, a store-backed `offsetStore` and `skippedUpdateStore`, an `acknowledgeSink` that collects, and on the **new** side `decisionRecorder` = a counting wrapper over `d.storeRecorder(store)` (calls per entry id); the old side passes no recorder. `emit` collects the event and never intakes (P3). Each item runs under `withPinnedEnv(tmp, () => withCountingClock(NOW, …))` on its own fresh store (`mkStore(d, "bare", …)`), media ingest on for the photo items (`mediaIngestEnabled: () => true`), off otherwise.
- [ ] **Step 2: Items** (tags in brackets): a message for each adapter-reachable reason [`channel_post`, `forwarded` ×2 (`forward_date`, `forward_origin`), `anonymous`, `user_not_allowlisted`, `chat_not_allowlisted`, `identity_not_for_chat`]; a stranger's forward [`precedence`]; taps: stranger, anonymous, foreign chat, wrong identity [`tap`]; a callback with no `message` [`not_sender`]; a stranger's bare photo with ingest on [`photo_denied`]; Paco's text, Paco's photo with ingest on, Paco's tap, Paco's `/deny` (invalid-command ack) [`allowed`, `not_sender`]; a batch `[Paco, stranger, Paco]` [`batch`].
- [ ] **Step 3: project / required.** `project`: `seedMax` as R1; run; read new-side `decisions` rows after `seedMax` into `view.newRows` (`__strip`, checked by `required`); the compared view is `{ result, emitted (events with their idempotency keys), acks, offset, db: dumpDb(store, { dropDecisionIds: R2_IDS }) }` → `relabelClocks` → `scrubIds`. Old side: throw if any `R2_IDS` row exists (control). Coverage + determinism self-tests as R1 (each shown failing once by a mutated copy, as R1's Task 5 did). `required`: per item, `view.newRows` equals the item's expected `[entry_id, verdict, reason_code, run_id null, tool_call_id null]` list exactly (empty for allowed / not-sender items) **and** `calls["intake.sender"]` equals that list's length — for allowed items the positive evidence is `emitted.length` equal to the item's expected count. A planted early return in a scratch copy of the built adapter (skip the `decideSync`) must fail `required` once; record the output in the commit body.
- [ ] **Step 4: Run** `npm run build && node scripts/check-ladder-stage4-differential.mjs <the Task 6 flags> --only sender`, then without `--only`.
Expected: `PASS sender`; all corpora PASS; exit 0; no `hg-s4d-*` temp roots left.
- [ ] **Step 5: Commit**

```bash
git add scripts/stage4-sender-fixture.mjs scripts/stage4-corpora/sender.mjs
git commit -m "test(gate): sender corpus — every denial origin and the allowed paths through pollOnce over a whole-DB dump" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Corpus `contract`

**Files:**
- Create: `scripts/stage4-corpora/contract.mjs`

**Interfaces:**
- Consumes: Task 6 lib; R1's `intakeEvent`, `seedAsk`, `withPinnedEnv`, `withCountingClock` (`scripts/stage4-intake-fixture.mjs`); each dist's `Gateway`, `buildTypedTaskEvent`, `DEFAULT_GLOBAL_BUDGET_CAPS`.

- [ ] **Step 1: Items** (each on its own fresh store; new side `new d.Gateway(store, caps, undefined, undefined, undefined, { decisionRecorder: counting })`, old side without the option; every `intake(event, NOW)`; `who = { chat: "222", actor: "paco" }`): a Telegram turn [`compile`]; a scheduled turn [`restrict`]; the same scheduled occurrence twice [`duplicate`]; a scheduled turn under `caps: { runs: 0 }` twice [`fuse`]; an `ask`; `/run research-brief`; `/run web-research` [`compile_other`]; an empty Telegram turn and an empty scheduled turn [`goal_missing`]; `/run nosuch` [`unknown_program`]; an unsupported type [`unsupported_type`]; a rating `forward` (`seedAsk` active + `2，synthetic`) [`via_rating`]; a memory-lane Ask (setup as `tests/gateway/intake-decisions.test.ts` P12, fuse open) [`via_memlane`].
- [ ] **Step 2: project / required** as Task 7, with `R2_IDS` dropped from the dump and `view.newRows` checked: `restrict` rows carry `run_id` equal to the item's created run (compare against `results[i].run_id`, before `scrubIds`), refusals `run_id` null; `calls["turn.contract"]` per item: 1 per fresh run or refusal, 0 for `fuse` and for the second `duplicate` intake. A planted early return (no `decideSync` in the `queued.ok` block) in a scratch copy fails `required` once; record it.
- [ ] **Step 3: Run** `--only contract`, then the whole differential.
Expected: `PASS contract`; all twelve corpora PASS; `STAGE 4 DIFFERENTIAL: PASS`; exit 0.
- [ ] **Step 4: Commit**

```bash
git add scripts/stage4-corpora/contract.mjs
git commit -m "test(gate): contract corpus — refusals, the schedule strip, duplicates and fuse cycles over a whole-DB dump" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Live gate `scripts/live-gate-ladder-remainder-r2.mjs`

**Files:**
- Create: `scripts/live-gate-ladder-remainder-r2.mjs`

Pattern: `scripts/live-gate-ladder-remainder-r1.mjs` (read whole first): refuses outside `.worktrees/`, imports `../dist/`, `HOUGE_ENV_FILE`, a `VACUUM INTO` copy removed in `finally` and on SIGINT/SIGTERM/SIGHUP, stale-root sweep at start, numbered `check(n, label, ok, detail)` lines, counts and codes only. Before any store opens: `HOUGE_TELEGRAM_CHAT_ID = "gate-stub-chat"`, `HOUGE_TOMBSTONE_PATH` / `HOUGE_DISARM_PATH` under the temp root (P3, P4); restored on exit; after the last line assert no `houge.kill` in the cwd or the main checkout. Header: the exact invocation.

- [ ] **Step 1: Lines** (spec §7; P7, P8):
1. A stranger's message through `runTelegramPollOnce` (dist, the copy, a stub client, synthetic allowlist) → skip row `TELEGRAM_AUTH_DENIED` for that update id; offset = id + 1; exactly one new `intake.sender` row `deny/user_not_allowlisted`, `run_id` null; `sendMessage` calls = 0; outbox rows added = 0; runs added = 0.
2. Paco's forward → one new row `deny/forwarded`; a channel post → one new row `deny/channel_post`; `sendMessage` calls = 0 for both.
3. A stranger taps an approval button for an approval seeded on the copy → one new row `deny/user_not_allowlisted`; that approval's state unchanged (`pending`).
4. Paco's own text through the Task 7 `pollItem` with a counting recorder → emitted = 1; `intake.sender` calls = 0; rows added = 0.
5. P7: a gate schedule due at `now`, `maybeFireScheduledTasks` once → one run for the gate's `schedule_id`; its `contract_json.allowed_actions` lacks `schedule_task`; exactly one `turn.contract` row `restrict/schedule_born` whose `run_id` is that run. **Duplicate (codex B3: a second tick finds the schedule already advanced and does nothing):** replay the same occurrence explicitly — `gateway.intake` of the event built exactly as `schedule-tick.ts:118–126` builds it, with the fired occurrence's idempotency key `schedule:<schedule_id>:<scheduled_time>` — → result `status: "duplicate"` with the same `run_id`, and still exactly one row.
6. Caps `{ runs: 0 }`, a second gate schedule due, two ticks → `turn.contract` rows for it = 0; a Telegram turn through `new Gateway(store, caps, …, { decisionRecorder: counting })` → `turn.contract` calls = 1, rows = 0; `/run nosuch x` → `TASK_CONTRACT_INVALID`, exactly one new row `refuse/unknown_program`, `run_id` null, exactly one outbox row keyed `<key>:contract_invalid`.
7. Faults: `insertDecision` faulted, then a stranger's update and a scheduled fire → exactly **two** open `decision_record_failed` incidents, subjects `intake.sender` and `turn.contract` (one per entry, `record.ts:72–75`); outbox rows added = exactly **two**, both incident alerts targeting `gate-stub-chat` (confirm against `openAlertedIncident`'s per-subject dedupe and write the number it gives; never `>= 1`); rows to chat `222` = 0; skip row, offset, run and contract as in lines 1 and 5. A recorder that throws (injected) → incidents added = 0, outbox rows added = 0, results as above, the error logged (capture `console.error`).
8. `decisionStatusLines(store, new Date().toISOString())` contains one count line for each of the two ids; `store.insertLadderMove(…)` naming `intake.sender` → refused (locked; copy the minimal move from the R1 gate's line 8).
- [ ] **Step 2: Run** `npm run build && HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-remainder-r2.mjs`
Expected: `8/8 PASS`, exit 0, temp root gone. Then rerun the R1, 4C and 4B live gates with their recorded invocations: each exit 0 (4B's count now 28).
- [ ] **Step 3: Commit**

```bash
git add scripts/live-gate-ladder-remainder-r2.mjs
git commit -m "test(gate): remainder R2 live gate — sender denials stay silent, the schedule strip row, refusals, faults, the lock" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Rollback check `scripts/check-ladder-remainder-r2-rollback.mjs`

**Files:**
- Create: `scripts/check-ladder-remainder-r2-rollback.mjs`

Pattern: `scripts/check-ladder-remainder-r1-rollback.mjs` (read whole). Flags: `--old-dist <dir>` (required, the `ef4d0d1` stamped build), `--old-base-r2 <full sha>` (required after merge); provenance file `gateway/gateway.js`.

- [ ] **Step 1: Lines** — on a VACUUM copy the new build writes, through the real paths: one `intake.sender` row (intake, `run_id` null), one `turn.contract` `restrict` row (pre_model, with its run), one `turn.contract` `refuse` row (pre_model, `run_id` null, the first such row). The old build then opens the copy (no migration, no error), renders `/status` and the digest (no throw) and compares each with the same render of an untouched copy (senior W4; R1's rollback does this): the digest is identical (the Unsure section lists only `system_one` rows with a `p`, `digest.ts:62–68`, so a `restrict` row with a `run_id` never appears; if the old build's chat-bound review does surface it, the line FAILs and the delta is reported); `/status` differs only in count lines naming the two new ids, asserted line by line, lists `decisions`: the exact count before = after, and the three seeded rows present with their exact `entry_id`, `verdict`, `reason_code`, `stage`, `run_id` (P8); its `ENTRY_IDS`-validated writer (`review_ok`) naming each new id refuses with its normal error, not a crash; the new build reopens the copy and reads all rows.
- [ ] **Step 2: Run** (before merge) `npm run build && node scripts/check-ladder-remainder-r2-rollback.mjs --old-dist .worktrees/base-ef4d0d1/dist`; after merge on `main` add `--old-base-r2 <full ef4d0d1 sha>`.
Expected: every line PASS, exit 0.
- [ ] **Step 3: Commit**

```bash
git add scripts/check-ladder-remainder-r2-rollback.mjs
git commit -m "test(gate): remainder R2 rollback — the merge-base build reads the new intake and pre_model rows and refuses writes naming the new ids" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks (orchestrator, not a task)
Full suite + typecheck + build on a quiet machine; the differential (twelve corpora), the R2, R1, 4C, 4B live gates and the R2 rollback on the final head; whole-branch reviews (most capable non-orchestrator model + codex whole-diff + security/correctness/testing/adversarial); docs sync — ADR 0030 amendment row drafted "awaiting Paco's signature" (two entries; Decision 1-B: `turn.contract` records refusals and the schedule strip; Decision 3-A: `telegram-auth.ts` protected, its limit stated) + index row, ladder design §6.1 note, ROADMAP delta, `tasks/todo.md` state block, `tasks/lessons.md`, `sessions.md` (incl. the 2-A hotfix); follow-ups noted: `handleTaskIntake` split; merge, push, rebuild, kickstart (Tier A).
