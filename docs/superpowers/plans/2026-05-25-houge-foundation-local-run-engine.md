# Houge Foundation Local Run Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Houge Milestone 0 and Milestone 1: shared schemas, deterministic state machines, SQLite run storage, local CLI-triggered `research-brief` execution, capability policy, one read-only capability, reports, and evals.

**Architecture:** The first slice is local and deterministic. Trigger adapters emit `TypedTaskEvent`s, `Gateway.intake()` creates or deduplicates runs, `TaskContractCompiler` attaches constraints, and `CoreWorker` claims queued runs through `RunStore`. `CapabilityRunner` is the only executor for governed capabilities, with `CapabilityPolicy`, `ToolRegistry`, `RunLedger`, `BudgetLedger`, `ContextSelector`, and `ReportWriter` kept as small modules with explicit interfaces.

**Tech Stack:** Node.js 25, TypeScript, Vitest, built-in `node:sqlite`, built-in `node:crypto`, no framework, no Telegram in this slice.

---

## Scope

This plan implements only:

- Milestone 0: shared schemas, state machines, fixture layout, eval command.
- Milestone 1: local CLI trigger and local run engine.

This plan does not implement Telegram, live approvals, schedules, Memory Catalog, Environment Guidebooks, Gmail, generic shell, or coding-agent CLI delegation. If `CapabilityPolicy` returns `requires_approval` in a real Milestone 1 run, the run records a deterministic denial and writes a report.

## File Structure

- `package.json`: npm scripts and dev dependencies.
- `tsconfig.json`: TypeScript compiler settings.
- `vitest.config.ts`: Vitest config.
- `src/domain/errors.ts`: typed error classes and error codes.
- `src/domain/canonical.ts`: canonical JSON and stable hash helpers.
- `src/domain/types.ts`: shared types: events, identities, contracts, run states, tool calls, ledger events.
- `src/triggers/cli-trigger.ts`: local CLI argument normalization into `TypedTaskEvent`.
- `src/contracts/task-contract.ts`: compile and validate `CompiledTaskContract`.
- `src/policy/capability-policy.ts`: deterministic allow, deny, requires-approval matrix.
- `src/tools/tool-registry.ts`: tool metadata catalog and input validation.
- `src/capabilities/local-file-read.ts`: read-only project-scoped file capability.
- `src/capabilities/capability-runner.ts`: policy, budget, tool call, result envelope coordination.
- `src/run/state-machines.ts`: transition tables for Run, Approval, ToolCall, Schedule.
- `src/run/run-ledger.ts`: event envelope validation and append-only ledger writes.
- `src/run/run-store.ts`: SQLite schema, idempotent run creation, run transitions, worker leases.
- `src/budget/budget-ledger.ts`: budget reservation and fuse checks.
- `src/context/context-selector.ts`: minimal context pack without Memory Catalog.
- `src/report/report-writer.ts`: sourced markdown report under `runs/`.
- `src/core/core-worker.ts`: claim queued runs and execute local `research-brief`.
- `src/gateway/gateway.ts`: deterministic intake path.
- `src/eval/eval-runner.ts`: fixture-driven milestone eval command.
- `src/cli.ts`: CLI entry point for `houge run`, `houge eval`, and `houge status`.
- `tests/**/*.test.ts`: Vitest tests next to domain areas.
- `evals/fixtures/**`: JSON fixtures for milestone evals.
- `runs/.gitkeep`: report output directory.

## Task 1: Scaffold TypeScript Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/cli.ts`
- Create: `src/index.ts`
- Create: `tests/smoke.test.ts`
- Create: `evals/fixtures/.gitkeep`
- Create: `runs/.gitkeep`

- [ ] **Step 1: Write the failing smoke test**

Create `tests/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getHougeVersion } from "../src/index.js";

describe("project scaffold", () => {
  it("exports a version string for diagnostics", () => {
    expect(getHougeVersion()).toMatch(/^0\.1\.0-/);
  });
});
```

- [ ] **Step 2: Add package and compiler files**

Create `package.json`:

```json
{
  "name": "houge",
  "version": "0.1.0-foundation",
  "private": true,
  "type": "module",
  "bin": {
    "houge": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "eval": "tsx src/cli.ts eval",
    "houge": "tsx src/cli.ts"
  },
  "devDependencies": {
    "@types/node": "^25.0.0",
    "tsx": "^4.20.6",
    "typescript": "^5.9.3",
    "vitest": "^4.0.14"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "vitest"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "threads",
    testTimeout: 10_000
  }
});
```

- [ ] **Step 3: Add minimal source entry points**

Create `src/index.ts`:

```ts
export function getHougeVersion(): string {
  return "0.1.0-foundation";
}
```

Create `src/cli.ts`:

```ts
#!/usr/bin/env node

import { getHougeVersion } from "./index.js";

const [, , command] = process.argv;

if (!command || command === "--version" || command === "version") {
  console.log(getHougeVersion());
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
```

- [ ] **Step 4: Add output directories**

Run:

```bash
touch evals/fixtures/.gitkeep runs/.gitkeep
```

Expected: files exist and no output is printed.

- [ ] **Step 5: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and npm exits with code 0.

- [ ] **Step 6: Verify scaffold**

Run:

```bash
npm test -- tests/smoke.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/index.ts src/cli.ts tests/smoke.test.ts evals/fixtures/.gitkeep runs/.gitkeep
git commit -m "chore: scaffold houge runtime"
```

## Task 2: Domain Types and Canonical Hashing

**Files:**
- Create: `src/domain/errors.ts`
- Create: `src/domain/canonical.ts`
- Create: `src/domain/types.ts`
- Test: `tests/domain/canonical.test.ts`
- Test: `tests/domain/types.test.ts`

- [ ] **Step 1: Write canonical hashing tests**

Create `tests/domain/canonical.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson, stableHash } from "../../src/domain/canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    const left = { b: 2, a: { d: 4, c: 3 } };
    const right = { a: { c: 3, d: 4 }, b: 2 };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });
});

describe("stableHash", () => {
  it("hashes semantically identical objects to the same digest", () => {
    expect(stableHash({ z: 1, a: 2 })).toBe(stableHash({ a: 2, z: 1 }));
  });
});
```

- [ ] **Step 2: Write typed event tests**

Create `tests/domain/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";

describe("buildTypedTaskEvent", () => {
  it("includes a payload hash derived from normalized task fields", () => {
    const event = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv"
    });

    expect(event.payload_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("excludes created_at from payload hash so retries dedupe correctly", () => {
    const first = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      created_at: "2026-05-25T00:00:00.000Z"
    });
    const retry = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      created_at: "2026-05-25T00:01:00.000Z"
    });

    expect(retry.payload_hash).toBe(first.payload_hash);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npm test -- tests/domain/canonical.test.ts tests/domain/types.test.ts
```

Expected: FAIL because `src/domain/canonical.ts` and `src/domain/types.ts` do not exist.

- [ ] **Step 4: Implement domain errors**

Create `src/domain/errors.ts`:

```ts
export type HougeErrorCode =
  | "TRIGGER_VALIDATION_ERROR"
  | "IDEMPOTENCY_CONFLICT"
  | "TASK_CONTRACT_INVALID"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "REVALIDATION_DENIED"
  | "BUDGET_FUSE"
  | "RUN_STATE_INVALID"
  | "TOOL_SCHEMA_INVALID"
  | "TOOL_EXECUTION_FAILED";

export class HougeError extends Error {
  constructor(
    public readonly code: HougeErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "HougeError";
  }
}
```

- [ ] **Step 5: Implement canonical helpers**

Create `src/domain/canonical.ts`:

```ts
import { createHash } from "node:crypto";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function normalize(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(input).sort()) {
      const child = input[key];
      if (child !== undefined) output[key] = normalize(child);
    }
    return output;
  }
  throw new Error(`Unsupported value in canonical JSON: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
```

- [ ] **Step 6: Implement shared domain types**

Create `src/domain/types.ts`:

```ts
import { stableHash } from "./canonical.js";

export type TriggerSource = "telegram" | "schedule" | "cli" | "event";
export type TaskEventType = "ask" | "run" | "approve" | "deny" | "teach" | "status";

export type Identity =
  | { kind: "user"; id: string }
  | { kind: "schedule"; id: string }
  | { kind: "system"; id: string };

export type NotifyTarget =
  | { kind: "local" }
  | { kind: "telegram"; chat_id: string };

export interface TypedTaskEventInput {
  source: TriggerSource;
  type: TaskEventType;
  program?: string;
  goal?: string;
  approval_id?: string;
  lesson?: string;
  requested_by: Identity;
  notify: NotifyTarget;
  idempotency_key: string;
  source_reference: string;
  created_at?: string;
}

export interface TypedTaskEvent extends TypedTaskEventInput {
  created_at: string;
  payload_hash: string;
}

export type RunState =
  | "created"
  | "contracted"
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "reconciliation_required"
  | "reporting"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type ApprovalState = "pending" | "approved" | "consumed" | "denied" | "expired";

export type ToolCallState =
  | "requested"
  | "policy_checked"
  | "waiting_for_approval"
  | "running"
  | "succeeded"
  | "denied"
  | "denied_on_revalidation"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "uncertain_outcome";

export type ScheduleState = "disabled" | "enabled" | "fired" | "enqueued" | "skipped_duplicate" | "failed";

export type SideEffectLevel = "none" | "local_write" | "external_read" | "external_write" | "destructive" | "paid";
export type RiskLevel = "low" | "medium" | "high";
export type PolicyDecision = "allow" | "deny" | "requires_approval";

export interface BudgetSpec {
  time_minutes: number;
  max_tool_calls: number;
  max_agent_delegations: number;
}

export interface CompiledTaskContract {
  objective: string;
  budget: BudgetSpec;
  allowed_actions: string[];
  forbidden_actions: string[];
  output: { path: string; format: "sourced_markdown_report" };
  approval_gates: string[];
  stop_condition: string;
  contract_hash: string;
  eval_hooks: string[];
}

export function buildTypedTaskEvent(input: TypedTaskEventInput): TypedTaskEvent {
  const created_at = input.created_at ?? new Date().toISOString();
  const normalized = { ...input, created_at };
  return {
    ...normalized,
    payload_hash: stableHash({
      source: normalized.source,
      type: normalized.type,
      program: normalized.program,
      goal: normalized.goal,
      approval_id: normalized.approval_id,
      lesson: normalized.lesson,
      requested_by: normalized.requested_by,
      notify: normalized.notify,
      idempotency_key: normalized.idempotency_key
    })
  };
}
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm test -- tests/domain/canonical.test.ts tests/domain/types.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/errors.ts src/domain/canonical.ts src/domain/types.ts tests/domain/canonical.test.ts tests/domain/types.test.ts
git commit -m "feat: add houge domain primitives"
```

## Task 3: State Machines

**Files:**
- Create: `src/run/state-machines.ts`
- Test: `tests/run/state-machines.test.ts`

- [ ] **Step 1: Write transition tests**

Create `tests/run/state-machines.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  canTransitionApproval,
  canTransitionRun,
  canTransitionSchedule,
  canTransitionToolCall
} from "../../src/run/state-machines.js";

describe("run state machine", () => {
  it("requeues approved runs instead of resuming directly", () => {
    expect(canTransitionRun("waiting_for_approval", "queued")).toBe(true);
    expect(canTransitionRun("waiting_for_approval", "running")).toBe(false);
  });

  it("parks uncertain side effects for reconciliation", () => {
    expect(canTransitionRun("running", "reconciliation_required")).toBe(true);
    expect(canTransitionRun("reconciliation_required", "queued")).toBe(true);
  });

  it("prevents terminal runs from resuming", () => {
    expect(canTransitionRun("completed", "queued")).toBe(false);
    expect(canTransitionRun("failed", "running")).toBe(false);
  });
});

describe("approval state machine", () => {
  it("allows single-use approval consumption", () => {
    expect(canTransitionApproval("pending", "approved")).toBe(true);
    expect(canTransitionApproval("approved", "consumed")).toBe(true);
    expect(canTransitionApproval("consumed", "approved")).toBe(false);
  });
});

describe("tool call state machine", () => {
  it("models revalidation denial after approval", () => {
    expect(canTransitionToolCall("waiting_for_approval", "denied_on_revalidation")).toBe(true);
  });
});

describe("schedule state machine", () => {
  it("models duplicate fired schedules", () => {
    expect(canTransitionSchedule("fired", "skipped_duplicate")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/run/state-machines.test.ts
```

Expected: FAIL because `src/run/state-machines.ts` does not exist.

- [ ] **Step 3: Implement transition tables**

Create `src/run/state-machines.ts`:

```ts
import type { ApprovalState, RunState, ScheduleState, ToolCallState } from "../domain/types.js";

const runTransitions: Record<RunState, readonly RunState[]> = {
  created: ["contracted", "failed", "cancelled", "expired"],
  contracted: ["queued", "failed", "cancelled", "expired"],
  queued: ["running", "failed", "cancelled", "expired"],
  running: ["waiting_for_approval", "reconciliation_required", "reporting", "failed", "cancelled", "expired"],
  waiting_for_approval: ["queued", "failed", "cancelled", "expired"],
  reconciliation_required: ["queued", "failed", "cancelled", "expired"],
  reporting: ["completed", "failed", "cancelled", "expired"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: []
};

const approvalTransitions: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ["approved", "denied", "expired"],
  approved: ["consumed"],
  consumed: [],
  denied: [],
  expired: []
};

const toolCallTransitions: Record<ToolCallState, readonly ToolCallState[]> = {
  requested: ["policy_checked"],
  policy_checked: ["running", "denied", "waiting_for_approval"],
  waiting_for_approval: ["running", "denied_on_revalidation"],
  running: ["succeeded", "failed", "timed_out", "cancelled", "uncertain_outcome"],
  succeeded: [],
  denied: [],
  denied_on_revalidation: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  uncertain_outcome: []
};

const scheduleTransitions: Record<ScheduleState, readonly ScheduleState[]> = {
  disabled: ["enabled"],
  enabled: ["disabled", "fired"],
  fired: ["enqueued", "skipped_duplicate", "failed"],
  enqueued: [],
  skipped_duplicate: [],
  failed: []
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return runTransitions[from].includes(to);
}

export function canTransitionApproval(from: ApprovalState, to: ApprovalState): boolean {
  return approvalTransitions[from].includes(to);
}

export function canTransitionToolCall(from: ToolCallState, to: ToolCallState): boolean {
  return toolCallTransitions[from].includes(to);
}

export function canTransitionSchedule(from: ScheduleState, to: ScheduleState): boolean {
  return scheduleTransitions[from].includes(to);
}
```

- [ ] **Step 4: Verify transition tests**

Run:

```bash
npm test -- tests/run/state-machines.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run/state-machines.ts tests/run/state-machines.test.ts
git commit -m "feat: add deterministic state machines"
```

## Task 4: Run Ledger Event Envelope

**Files:**
- Create: `src/run/run-ledger.ts`
- Test: `tests/run/run-ledger.test.ts`

- [ ] **Step 1: Write ledger validation tests**

Create `tests/run/run-ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createLedgerEvent, validateLedgerEvent } from "../../src/run/run-ledger.js";

describe("Run Ledger events", () => {
  it("creates event envelopes with correlation ids", () => {
    const event = createLedgerEvent({
      run_id: "run_1",
      correlation_id: "cli_1",
      event_type: "run_created",
      actor: "gateway",
      sequence: 1,
      payload: {
        source: "cli",
        idempotency_key: "cli:1",
        program: "research-brief",
        goal_hash: "abc",
        requester: { kind: "user", id: "paco" }
      }
    });

    expect(event.event_id).toMatch(/^evt_/);
    expect(validateLedgerEvent(event).ok).toBe(true);
  });

  it("rejects missing required payload fields", () => {
    const event = createLedgerEvent({
      run_id: "run_1",
      correlation_id: "cli_1",
      event_type: "policy_decision",
      actor: "capability_runner",
      sequence: 2,
      payload: { decision: "allow" }
    });

    expect(validateLedgerEvent(event)).toEqual({
      ok: false,
      error: "policy_decision missing required payload field: tool_call_id"
    });
  });

  it("executes an allowed registered adapter through the runner", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 1000,
      execute: () => ({ ok: true, output: { content: "hello" } })
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract,
      capability: "local_file_read",
      input: { path: "AGENTS.md" },
      budget: new BudgetLedger(contract.budget)
    });

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") expect(result.output.content).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/run/run-ledger.test.ts
```

Expected: FAIL because `src/run/run-ledger.ts` does not exist.

- [ ] **Step 3: Implement ledger event validation**

Create `src/run/run-ledger.ts`:

```ts
import { randomUUID } from "node:crypto";

export type LedgerActor = "gateway" | "core" | "capability_runner" | "trigger_adapter" | "notification_outbox" | "system";

export type LedgerEventType =
  | "trigger_received"
  | "idempotency_conflict"
  | "schedule_fired"
  | "schedule_skipped_duplicate"
  | "run_created"
  | "contract_attached"
  | "worker_lease_acquired"
  | "worker_lease_released"
  | "worker_lease_expired"
  | "context_selected"
  | "budget_zone_changed"
  | "capability_requested"
  | "policy_decision"
  | "tool_started"
  | "tool_finished"
  | "approval_requested"
  | "approval_resolved"
  | "notification_queued"
  | "notification_delivered"
  | "notification_failed"
  | "report_written"
  | "lesson_proposed"
  | "reconciliation_required"
  | "eval_completed"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "run_expired";

export interface LedgerEvent {
  event_id: string;
  run_id?: string;
  correlation_id: string;
  event_type: LedgerEventType;
  occurred_at: string;
  actor: LedgerActor;
  sequence: number;
  payload: Record<string, unknown>;
}

const requiredPayloadFields: Record<LedgerEventType, readonly string[]> = {
  trigger_received: ["source", "source_reference", "requester", "idempotency_key", "payload_hash"],
  idempotency_conflict: ["source", "idempotency_key", "existing_run_id", "stored_payload_hash", "incoming_payload_hash", "resolution"],
  schedule_fired: ["schedule_id", "scheduled_time", "command_hash"],
  schedule_skipped_duplicate: ["schedule_id", "scheduled_time", "idempotency_key", "existing_run_id"],
  run_created: ["source", "idempotency_key", "program", "goal_hash", "requester"],
  contract_attached: ["contract_hash", "program", "budget", "allowed_actions", "approval_gates"],
  worker_lease_acquired: ["worker_id", "lease_expires_at", "attempt_count"],
  worker_lease_released: ["worker_id", "reason"],
  worker_lease_expired: ["worker_id", "lease_expires_at", "active_tool_call_id", "recovery_action"],
  context_selected: ["context_pack_id", "included_artifact_ids", "excluded_relevant_artifact_ids", "token_estimate"],
  budget_zone_changed: ["previous_zone", "next_zone", "remaining_budget", "reason"],
  capability_requested: ["tool_call_id", "capability", "input_hash", "side_effect_level", "risk_level"],
  policy_decision: ["tool_call_id", "decision", "reason", "policy_version"],
  tool_started: ["tool_call_id", "operation_id", "adapter_name", "input_hash", "timeout_ms"],
  tool_finished: ["tool_call_id", "status", "output_hash", "duration_ms", "bytes_out"],
  approval_requested: ["approval_id", "action_fingerprint", "action_summary", "side_effect_level", "expires_at"],
  approval_resolved: ["approval_id", "decision", "requester", "resolved_at"],
  notification_queued: ["notification_id", "target", "intent_type", "idempotency_key"],
  notification_delivered: ["notification_id", "target", "adapter", "delivered_at"],
  notification_failed: ["notification_id", "target", "adapter", "error_ref", "retryable"],
  report_written: ["report_ref", "report_hash", "partial"],
  lesson_proposed: ["lesson_id", "source_run_id", "provenance", "target_artifact_type"],
  reconciliation_required: ["tool_call_id", "operation_id", "reason", "reconciliation_ref"],
  eval_completed: ["eval_suite", "passed", "failed_case_ids", "report_ref"],
  run_completed: ["report_ref", "budget_used", "duration_ms"],
  run_failed: ["error_type", "error_ref", "recoverable"],
  run_cancelled: ["reason", "requester", "report_ref"],
  run_expired: ["reason", "expired_at", "report_ref"]
};

export function createLedgerEvent(input: Omit<LedgerEvent, "event_id" | "occurred_at">): LedgerEvent {
  return {
    ...input,
    event_id: `evt_${randomUUID()}`,
    occurred_at: new Date().toISOString()
  };
}

export function validateLedgerEvent(event: LedgerEvent): { ok: true } | { ok: false; error: string } {
  const fields = requiredPayloadFields[event.event_type];
  for (const field of fields) {
    if (!(field in event.payload)) {
      return { ok: false, error: `${event.event_type} missing required payload field: ${field}` };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Verify ledger tests**

Run:

```bash
npm test -- tests/run/run-ledger.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run/run-ledger.ts tests/run/run-ledger.test.ts
git commit -m "feat: add run ledger event schema"
```

## Task 5: SQLite Run Store and Idempotency

**Files:**
- Create: `src/run/run-store.ts`
- Test: `tests/run/run-store.test.ts`

- [ ] **Step 1: Write RunStore tests**

Create `tests/run/run-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent, type CompiledTaskContract } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";

let store: RunStore;

const contract: CompiledTaskContract = {
  objective: "compare Pi and Hermes",
  budget: { time_minutes: 15, max_tool_calls: 5, max_agent_delegations: 0 },
  allowed_actions: ["local_file_read", "write_report"],
  forbidden_actions: ["coding_agent_cli"],
  output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" },
  approval_gates: ["external_write"],
  stop_condition: "report written",
  contract_hash: "contract_hash",
  eval_hooks: ["milestone-1-local-run"]
};

beforeEach(() => {
  store = RunStore.openInMemory();
});

afterEach(() => {
  store.close();
});

function event(goal: string) {
  return buildTypedTaskEvent({
    source: "cli",
    type: "run",
    program: "research-brief",
    goal,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "local" },
    idempotency_key: "cli:fixed",
    source_reference: "argv",
    created_at: "2026-05-25T00:00:00.000Z"
  });
}

describe("RunStore.createOrGet", () => {
  it("returns the existing run for the same idempotency key and payload hash", () => {
    const first = store.createOrGet(event("compare Pi and Hermes"));
    const second = store.createOrGet(event("compare Pi and Hermes"));

    expect(first.status).toBe("created");
    expect(second.status).toBe("duplicate");
    if (first.status !== "created" || second.status !== "duplicate") throw new Error("expected created then duplicate");
    expect(second.run_id).toBe(first.run_id);
  });

  it("rejects the same idempotency key with a different payload hash", () => {
    store.createOrGet(event("compare Pi and Hermes"));
    const conflict = store.createOrGet(event("compare Pi and OpenClaw"));

    expect(conflict.status).toBe("conflict");
    expect(conflict.error).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("RunStore worker leases", () => {
  it("claims a queued run and prevents another worker from claiming it", () => {
    const created = store.createOrGet(event("compare Pi and Hermes"));
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("expected run creation");
    store.attachContract(created.run_id, contract);
    store.transition(created.run_id, "created", "contracted", "contract ready");
    store.transition(created.run_id, "contracted", "queued", "ready");

    const claim = store.claimNext("worker-1", 60);
    const second = store.claimNext("worker-2", 60);

    expect(claim?.run_id).toBe(created.run_id);
    expect(claim?.contract.contract_hash).toBe("contract_hash");
    expect(second).toBeNull();
  });

  it("extends a lease only for the owning worker", () => {
    const created = store.createOrGet(event("compare Pi and Hermes"));
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("expected run creation");
    store.attachContract(created.run_id, contract);
    store.transition(created.run_id, "created", "contracted", "contract ready");
    store.transition(created.run_id, "contracted", "queued", "ready");
    const claim = store.claimNext("worker-1", 60);
    if (!claim) throw new Error("expected claim");

    expect(store.heartbeat(claim.run_id, "worker-1", 60)).toBe(true);
    expect(store.heartbeat(claim.run_id, "worker-2", 60)).toBe(false);
  });

  it("requeues an expired running lease when attempts remain", () => {
    const created = store.createOrGet(event("compare Pi and Hermes"));
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("expected run creation");
    store.attachContract(created.run_id, contract);
    store.transition(created.run_id, "created", "contracted", "contract ready");
    store.transition(created.run_id, "contracted", "queued", "ready");
    const claim = store.claimNext("worker-1", -1);
    if (!claim) throw new Error("expected claim");

    const recovered = store.recoverExpiredLeases(new Date().toISOString(), 3);

    expect(recovered).toEqual([{ run_id: claim.run_id, action: "requeued" }]);
    expect(store.getRunState(claim.run_id)).toBe("queued");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/run/run-store.test.ts
```

Expected: FAIL because `src/run/run-store.ts` does not exist.

- [ ] **Step 3: Implement SQLite RunStore**

Create `src/run/run-store.ts`:

```ts
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { CompiledTaskContract, RunState, TypedTaskEvent } from "../domain/types.js";
import { canTransitionRun } from "./state-machines.js";

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };

export type CreateOrGetResult =
  | { status: "created"; run_id: string }
  | { status: "duplicate"; run_id: string }
  | { status: "conflict"; error: "IDEMPOTENCY_CONFLICT"; existing_run_id: string };

export class RunStore {
  private constructor(private readonly db: SqliteDatabase) {
    this.migrate();
  }

  static openInMemory(): RunStore {
    return new RunStore(new DatabaseSync(":memory:"));
  }

  static open(path: string): RunStore {
    return new RunStore(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
  }

  createOrGet(event: TypedTaskEvent): CreateOrGetResult {
    const existing = this.db
      .prepare("SELECT run_id, payload_hash FROM runs WHERE source = ? AND idempotency_key = ?")
      .get(event.source, event.idempotency_key) as { run_id: string; payload_hash: string } | undefined;

    if (existing) {
      if (existing.payload_hash === event.payload_hash) {
        return { status: "duplicate", run_id: existing.run_id };
      }
      return { status: "conflict", error: "IDEMPOTENCY_CONFLICT", existing_run_id: existing.run_id };
    }

    const run_id = `run_${randomUUID()}`;
    this.db
      .prepare(
        "INSERT INTO runs (run_id, source, idempotency_key, payload_hash, program, goal, requester_json, notify_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        run_id,
        event.source,
        event.idempotency_key,
        event.payload_hash,
        event.program ?? null,
        event.goal ?? null,
        JSON.stringify(event.requested_by),
        JSON.stringify(event.notify),
        "created",
        event.created_at,
        event.created_at
      );
    return { status: "created", run_id };
  }

  attachContract(run_id: string, contract: CompiledTaskContract): void {
    const row = this.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(run_id) as { state: RunState } | undefined;
    if (!row) throw new Error(`Run not found: ${run_id}`);
    if (row.state !== "created") throw new Error(`Cannot attach contract while run is ${row.state}`);
    this.db
      .prepare("UPDATE runs SET contract_json = ?, updated_at = ? WHERE run_id = ?")
      .run(JSON.stringify(contract), new Date().toISOString(), run_id);
  }

  transition(run_id: string, expected: RunState, next: RunState, reason: string): void {
    const row = this.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(run_id) as { state: RunState } | undefined;
    if (!row) throw new Error(`Run not found: ${run_id}`);
    if (row.state !== expected) throw new Error(`Expected ${expected}, found ${row.state}: ${reason}`);
    if (!canTransitionRun(expected, next)) throw new Error(`Invalid transition ${expected} -> ${next}: ${reason}`);
    this.db.prepare("UPDATE runs SET state = ?, updated_at = ? WHERE run_id = ?").run(next, new Date().toISOString(), run_id);
  }

  getRunState(run_id: string): RunState {
    const row = this.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(run_id) as { state: RunState } | undefined;
    if (!row) throw new Error(`Run not found: ${run_id}`);
    return row.state;
  }

  claimNext(worker_id: string, lease_ttl_seconds: number): { run_id: string; contract: CompiledTaskContract } | null {
    const row = this.db.prepare("SELECT run_id, attempt_count, contract_json FROM runs WHERE state = 'queued' ORDER BY created_at LIMIT 1").get() as
      | { run_id: string; attempt_count: number; contract_json: string | null }
      | undefined;
    if (!row) return null;
    if (!row.contract_json) throw new Error(`Queued run missing contract: ${row.run_id}`);

    const lease_expires_at = new Date(Date.now() + lease_ttl_seconds * 1000).toISOString();
    const result = this.db
      .prepare(
        "UPDATE runs SET state = 'running', worker_id = ?, lease_expires_at = ?, attempt_count = ?, updated_at = ? WHERE run_id = ? AND state = 'queued'"
      )
      .run(worker_id, lease_expires_at, row.attempt_count + 1, new Date().toISOString(), row.run_id);

    if (result.changes === 0) return null;
    return { run_id: row.run_id, contract: JSON.parse(row.contract_json) as CompiledTaskContract };
  }

  heartbeat(run_id: string, worker_id: string, lease_ttl_seconds: number): boolean {
    const lease_expires_at = new Date(Date.now() + lease_ttl_seconds * 1000).toISOString();
    const result = this.db
      .prepare("UPDATE runs SET lease_expires_at = ?, updated_at = ? WHERE run_id = ? AND worker_id = ? AND state = 'running'")
      .run(lease_expires_at, new Date().toISOString(), run_id, worker_id);
    return result.changes === 1;
  }

  recoverExpiredLeases(now: string, max_attempts: number): Array<{ run_id: string; action: "requeued" | "failed" }> {
    const rows = this.db
      .prepare("SELECT run_id, attempt_count FROM runs WHERE state = 'running' AND lease_expires_at <= ? ORDER BY updated_at")
      .all(now) as Array<{ run_id: string; attempt_count: number }>;
    const recovered: Array<{ run_id: string; action: "requeued" | "failed" }> = [];

    for (const row of rows) {
      if (row.attempt_count < max_attempts) {
        this.db
          .prepare("UPDATE runs SET state = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE run_id = ?")
          .run(new Date().toISOString(), row.run_id);
        recovered.push({ run_id: row.run_id, action: "requeued" });
      } else {
        this.db
          .prepare("UPDATE runs SET state = 'failed', worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE run_id = ?")
          .run(new Date().toISOString(), row.run_id);
        recovered.push({ run_id: row.run_id, action: "failed" });
      }
    }

    return recovered;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        program TEXT,
        goal TEXT,
        requester_json TEXT NOT NULL,
        notify_json TEXT NOT NULL,
        contract_json TEXT,
        state TEXT NOT NULL,
        worker_id TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, idempotency_key)
      );
    `);
  }
}
```

- [ ] **Step 4: Verify RunStore tests**

Run:

```bash
npm test -- tests/run/run-store.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run/run-store.ts tests/run/run-store.test.ts
git commit -m "feat: add sqlite run store"
```

## Task 6: Task Contract Compiler

**Files:**
- Create: `src/contracts/task-contract.ts`
- Test: `tests/contracts/task-contract.test.ts`

- [ ] **Step 1: Write contract compiler tests**

Create `tests/contracts/task-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { compileTaskContract } from "../../src/contracts/task-contract.js";

const runEvent = buildTypedTaskEvent({
  source: "cli",
  type: "run",
  program: "research-brief",
  goal: "compare Pi, OpenClaw, and Hermes",
  requested_by: { kind: "user", id: "paco" },
  notify: { kind: "local" },
  idempotency_key: "cli:research-brief",
  source_reference: "argv"
});

describe("compileTaskContract", () => {
  it("compiles research-brief into a bounded contract", () => {
    const result = compileTaskContract(runEvent);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.allowed_actions).toContain("local_file_read");
      expect(result.contract.forbidden_actions).toContain("coding_agent_cli");
      expect(result.contract.contract_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects unknown programs", () => {
    const badEvent = { ...runEvent, program: "unknown-program" };
    const result = compileTaskContract(badEvent);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "TASK_CONTRACT_INVALID",
        message: "Unknown program: unknown-program"
      }
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/contracts/task-contract.test.ts
```

Expected: FAIL because `src/contracts/task-contract.ts` does not exist.

- [ ] **Step 3: Implement compiler**

Create `src/contracts/task-contract.ts`:

```ts
import { stableHash } from "../domain/canonical.js";
import type { CompiledTaskContract, TypedTaskEvent } from "../domain/types.js";

export type TaskContractResult =
  | { ok: true; contract: CompiledTaskContract }
  | { ok: false; error: { code: "TASK_CONTRACT_INVALID"; message: string } };

export function compileTaskContract(event: TypedTaskEvent): TaskContractResult {
  if (event.type !== "run") {
    return { ok: false, error: { code: "TASK_CONTRACT_INVALID", message: `Unsupported event type: ${event.type}` } };
  }
  if (event.program !== "research-brief") {
    return { ok: false, error: { code: "TASK_CONTRACT_INVALID", message: `Unknown program: ${event.program ?? "(missing)"}` } };
  }
  if (!event.goal || event.goal.trim().length === 0) {
    return { ok: false, error: { code: "TASK_CONTRACT_INVALID", message: "Goal is required" } };
  }

  const base = {
    objective: event.goal,
    budget: {
      time_minutes: 15,
      max_tool_calls: 5,
      max_agent_delegations: 0
    },
    allowed_actions: ["local_file_read", "write_report"],
    forbidden_actions: ["coding_agent_cli", "generic_shell", "external_write", "paid_action"],
    output: {
      path: "runs/<run-id>/report.md",
      format: "sourced_markdown_report" as const
    },
    approval_gates: ["external_write", "destructive_file_action", "paid_action"],
    stop_condition: "sourced local research brief produced or budget exhausted",
    eval_hooks: ["milestone-1-local-run"]
  };

  return {
    ok: true,
    contract: {
      ...base,
      contract_hash: stableHash(base)
    }
  };
}
```

- [ ] **Step 4: Verify contract tests**

Run:

```bash
npm test -- tests/contracts/task-contract.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/task-contract.ts tests/contracts/task-contract.test.ts
git commit -m "feat: add task contract compiler"
```

## Task 7: Capability Policy and Tool Registry

**Files:**
- Create: `src/policy/capability-policy.ts`
- Create: `src/tools/tool-registry.ts`
- Test: `tests/policy/capability-policy.test.ts`
- Test: `tests/tools/tool-registry.test.ts`

- [ ] **Step 1: Write policy tests**

Create `tests/policy/capability-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideCapability } from "../../src/policy/capability-policy.js";

describe("decideCapability", () => {
  it("allows read-only capabilities listed in the contract", () => {
    expect(
      decideCapability({
        capability: "local_file_read",
        category: "tool",
        side_effect_level: "none",
        risk_level: "low",
        allowed_actions: ["local_file_read"],
        forbidden_actions: []
      })
    ).toEqual({ decision: "allow", reason: "Capability allowed by task contract" });
  });

  it("denies coding-agent CLI delegation in V1", () => {
    expect(
      decideCapability({
        capability: "codex_cli",
        category: "coding_agent_cli",
        side_effect_level: "local_write",
        risk_level: "high",
        allowed_actions: ["codex_cli"],
        forbidden_actions: []
      })
    ).toEqual({ decision: "deny", reason: "Coding-agent CLI delegation is reserved for V2 containment" });
  });

  it("requires approval for external writes", () => {
    expect(
      decideCapability({
        capability: "gmail_send",
        category: "tool",
        side_effect_level: "external_write",
        risk_level: "high",
        allowed_actions: ["gmail_send"],
        forbidden_actions: []
      })
    ).toEqual({ decision: "requires_approval", reason: "Capability has gated side effects" });
  });
});
```

- [ ] **Step 2: Write registry tests**

Create `tests/tools/tool-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

describe("ToolRegistry", () => {
  it("registers and retrieves tool metadata", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 10000
    });

    expect(registry.get("local_file_read")?.risk_level).toBe("low");
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npm test -- tests/policy/capability-policy.test.ts tests/tools/tool-registry.test.ts
```

Expected: FAIL because policy and registry files do not exist.

- [ ] **Step 4: Implement policy**

Create `src/policy/capability-policy.ts`:

```ts
import type { PolicyDecision, RiskLevel, SideEffectLevel } from "../domain/types.js";

export interface CapabilityDecisionInput {
  capability: string;
  category: "tool" | "coding_agent_cli";
  side_effect_level: SideEffectLevel;
  risk_level: RiskLevel;
  allowed_actions: string[];
  forbidden_actions: string[];
}

export interface CapabilityDecision {
  decision: PolicyDecision;
  reason: string;
}

export function decideCapability(input: CapabilityDecisionInput): CapabilityDecision {
  if (input.category === "coding_agent_cli") {
    return { decision: "deny", reason: "Coding-agent CLI delegation is reserved for V2 containment" };
  }
  if (input.forbidden_actions.includes(input.capability)) {
    return { decision: "deny", reason: "Capability forbidden by task contract" };
  }
  if (!input.allowed_actions.includes(input.capability)) {
    return { decision: "deny", reason: "Capability not allowed by task contract" };
  }
  if (["external_write", "destructive", "paid"].includes(input.side_effect_level)) {
    return { decision: "requires_approval", reason: "Capability has gated side effects" };
  }
  return { decision: "allow", reason: "Capability allowed by task contract" };
}
```

- [ ] **Step 5: Implement registry**

Create `src/tools/tool-registry.ts`:

```ts
import type { RiskLevel, SideEffectLevel } from "../domain/types.js";

export interface ToolMetadata {
  name: string;
  category: "tool" | "coding_agent_cli";
  side_effect_level: SideEffectLevel;
  risk_level: RiskLevel;
  timeout_ms: number;
  output_limit_bytes: number;
  execute?: (input: Record<string, unknown>) => Promise<ToolAdapterResult> | ToolAdapterResult;
}

export type ToolAdapterResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; error: string };

export class ToolRegistry {
  private readonly tools = new Map<string, ToolMetadata>();

  register(metadata: ToolMetadata): void {
    if (this.tools.has(metadata.name)) {
      throw new Error(`Tool already registered: ${metadata.name}`);
    }
    this.tools.set(metadata.name, metadata);
  }

  get(name: string): ToolMetadata | undefined {
    return this.tools.get(name);
  }
}
```

- [ ] **Step 6: Verify policy and registry tests**

Run:

```bash
npm test -- tests/policy/capability-policy.test.ts tests/tools/tool-registry.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/policy/capability-policy.ts src/tools/tool-registry.ts tests/policy/capability-policy.test.ts tests/tools/tool-registry.test.ts
git commit -m "feat: add capability policy and registry"
```

## Task 8: Budget Ledger and Capability Runner

**Files:**
- Create: `src/budget/budget-ledger.ts`
- Create: `src/capabilities/capability-runner.ts`
- Test: `tests/budget/budget-ledger.test.ts`
- Test: `tests/capabilities/capability-runner.test.ts`

- [ ] **Step 1: Write budget tests**

Create `tests/budget/budget-ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";

describe("BudgetLedger", () => {
  it("denies reservations that exceed the tool-call cap", () => {
    const budget = new BudgetLedger({ max_tool_calls: 1, max_agent_delegations: 0, time_minutes: 15 });
    expect(budget.reserveToolCall()).toEqual({ ok: true, zone: "green" });
    expect(budget.reserveToolCall()).toEqual({ ok: false, reason: "Tool-call budget exhausted", zone: "fuse" });
  });
});
```

- [ ] **Step 2: Write CapabilityRunner tests**

Create `tests/capabilities/capability-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { CapabilityRunner } from "../../src/capabilities/capability-runner.js";
import type { CompiledTaskContract } from "../../src/domain/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const contract: CompiledTaskContract = {
  objective: "read local file",
  budget: { time_minutes: 15, max_tool_calls: 2, max_agent_delegations: 0 },
  allowed_actions: ["local_file_read"],
  forbidden_actions: ["coding_agent_cli"],
  output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" },
  approval_gates: ["external_write"],
  stop_condition: "report written",
  contract_hash: "contract_hash",
  eval_hooks: []
};

describe("CapabilityRunner", () => {
  it("returns a structured denial for forbidden capabilities", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "codex_cli",
      category: "coding_agent_cli",
      side_effect_level: "local_write",
      risk_level: "high",
      timeout_ms: 1000,
      output_limit_bytes: 1000
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract,
      capability: "codex_cli",
      input: {},
      budget: new BudgetLedger(contract.budget)
    });

    expect(result).toEqual({
      status: "denied",
      reason: "Coding-agent CLI delegation is reserved for V2 containment",
      recovery_hint: "Report the blocked action to the user"
    });
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npm test -- tests/budget/budget-ledger.test.ts tests/capabilities/capability-runner.test.ts
```

Expected: FAIL because budget and runner files do not exist.

- [ ] **Step 4: Implement BudgetLedger**

Create `src/budget/budget-ledger.ts`:

```ts
import type { BudgetSpec } from "../domain/types.js";

export type BudgetZone = "green" | "yellow" | "red" | "fuse";

export class BudgetLedger {
  private toolCalls = 0;

  constructor(private readonly budget: BudgetSpec) {}

  reserveToolCall(): { ok: true; zone: BudgetZone } | { ok: false; reason: string; zone: BudgetZone } {
    if (this.toolCalls >= this.budget.max_tool_calls) {
      return { ok: false, reason: "Tool-call budget exhausted", zone: "fuse" };
    }
    this.toolCalls += 1;
    return { ok: true, zone: this.zone() };
  }

  usage(): { tool_calls: number; max_tool_calls: number; zone: BudgetZone } {
    return { tool_calls: this.toolCalls, max_tool_calls: this.budget.max_tool_calls, zone: this.zone() };
  }

  private zone(): BudgetZone {
    const remaining = this.budget.max_tool_calls - this.toolCalls;
    const ratio = remaining / Math.max(this.budget.max_tool_calls, 1);
    if (ratio < 0.05) return "fuse";
    if (ratio < 0.2) return "red";
    if (ratio < 0.5) return "yellow";
    return "green";
  }
}
```

- [ ] **Step 5: Implement CapabilityRunner**

Create `src/capabilities/capability-runner.ts`:

```ts
import type { BudgetLedger } from "../budget/budget-ledger.js";
import { stableHash } from "../domain/canonical.js";
import type { CompiledTaskContract } from "../domain/types.js";
import { decideCapability } from "../policy/capability-policy.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

export type CapabilityResult =
  | { status: "succeeded"; output_ref: string; output_hash: string; output: Record<string, unknown> }
  | { status: "denied"; reason: string; recovery_hint?: string }
  | { status: "requires_approval"; approval_id: string }
  | { status: "denied_on_revalidation"; reason: string; recovery_hint?: string }
  | { status: "failed" | "timed_out" | "cancelled"; error_ref: string }
  | { status: "uncertain_outcome"; reconciliation_ref: string };

export interface CapabilityExecutionInput {
  contract: CompiledTaskContract;
  capability: string;
  input: Record<string, unknown>;
  budget: BudgetLedger;
}

export class CapabilityRunner {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(input: CapabilityExecutionInput): Promise<CapabilityResult> {
    const metadata = this.registry.get(input.capability);
    if (!metadata) {
      return { status: "denied", reason: `Unknown capability: ${input.capability}`, recovery_hint: "Use a registered capability" };
    }

    const reservation = input.budget.reserveToolCall();
    if (!reservation.ok) {
      return { status: "denied", reason: reservation.reason, recovery_hint: "Write a partial report" };
    }

    const decision = decideCapability({
      capability: input.capability,
      category: metadata.category,
      side_effect_level: metadata.side_effect_level,
      risk_level: metadata.risk_level,
      allowed_actions: input.contract.allowed_actions,
      forbidden_actions: input.contract.forbidden_actions
    });

    if (decision.decision === "deny") {
      return { status: "denied", reason: decision.reason, recovery_hint: "Report the blocked action to the user" };
    }
    if (decision.decision === "requires_approval") {
      return { status: "denied", reason: "Live approval channel is not available in Milestone 1", recovery_hint: "Report the blocked action to the user" };
    }

    if (!metadata.execute) {
      return { status: "failed", error_ref: `adapter_not_connected:${input.capability}` };
    }

    const adapterResult = await metadata.execute(input.input);
    if (!adapterResult.ok) {
      return { status: "failed", error_ref: adapterResult.error };
    }

    return {
      status: "succeeded",
      output_ref: `inline:${input.capability}`,
      output_hash: stableHash(adapterResult.output),
      output: adapterResult.output
    };
  }
}
```

- [ ] **Step 6: Verify budget and runner tests**

Run:

```bash
npm test -- tests/budget/budget-ledger.test.ts tests/capabilities/capability-runner.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/budget/budget-ledger.ts src/capabilities/capability-runner.ts tests/budget/budget-ledger.test.ts tests/capabilities/capability-runner.test.ts
git commit -m "feat: add capability runner foundation"
```

## Task 9: Read-Only Local File Capability

**Files:**
- Create: `src/capabilities/local-file-read.ts`
- Test: `tests/capabilities/local-file-read.test.ts`

- [ ] **Step 1: Write project-scope tests**

Create `tests/capabilities/local-file-read.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProjectFile } from "../../src/capabilities/local-file-read.js";

describe("readProjectFile", () => {
  it("reads files inside the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "note.md"), "hello");

    expect(readProjectFile(root, "docs/note.md")).toEqual({ ok: true, content: "hello" });
  });

  it("denies path traversal outside the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));

    expect(readProjectFile(root, "../secret.txt")).toEqual({
      ok: false,
      error: "Path escapes project root"
    });
  });

  it("returns an explicit error for missing files inside the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));

    expect(readProjectFile(root, "missing.md")).toEqual({
      ok: false,
      error: "File not found: missing.md"
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/capabilities/local-file-read.test.ts
```

Expected: FAIL because `src/capabilities/local-file-read.ts` does not exist.

- [ ] **Step 3: Implement project-scoped read**

Create `src/capabilities/local-file-read.ts`:

```ts
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { ToolAdapterResult } from "../tools/tool-registry.js";

export function readProjectFile(projectRoot: string, relativePath: string): { ok: true; content: string } | { ok: false; error: string } {
  const root = realpathSync(projectRoot);
  const target = resolve(root, relativePath);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;

  if (target !== root && !target.startsWith(prefix)) {
    return { ok: false, error: "Path escapes project root" };
  }
  if (!existsSync(target)) {
    return { ok: false, error: `File not found: ${relativePath}` };
  }

  const canonicalTarget = realpathSync(target);
  if (canonicalTarget !== root && !canonicalTarget.startsWith(prefix)) {
    return { ok: false, error: "Path escapes project root" };
  }

  return { ok: true, content: readFileSync(canonicalTarget, "utf8") };
}

export function createLocalFileReadAdapter(projectRoot: string): (input: Record<string, unknown>) => ToolAdapterResult {
  return (input) => {
    if (typeof input.path !== "string") {
      return { ok: false, error: "path must be a string" };
    }
    const result = readProjectFile(projectRoot, input.path);
    if (!result.ok) return result;
    return {
      ok: true,
      output: {
        path: relative(projectRoot, resolve(projectRoot, input.path)),
        content: result.content
      }
    };
  };
}
```

- [ ] **Step 4: Verify local file tests**

Run:

```bash
npm test -- tests/capabilities/local-file-read.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/local-file-read.ts tests/capabilities/local-file-read.test.ts
git commit -m "feat: add project-scoped file read capability"
```

## Task 10: Minimal Context Selector and Report Writer

**Files:**
- Create: `src/context/context-selector.ts`
- Create: `src/report/report-writer.ts`
- Test: `tests/context/context-selector.test.ts`
- Test: `tests/report/report-writer.test.ts`

- [ ] **Step 1: Write context selector test**

Create `tests/context/context-selector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectContext } from "../../src/context/context-selector.js";

describe("selectContext", () => {
  it("includes only core Milestone 1 context", () => {
    const pack = selectContext({
      run_id: "run_1",
      requester_id: "paco",
      program: "research-brief",
      contract_hash: "contract_hash"
    });

    expect(pack.included).toEqual([
      "memory/core/houge.md",
      "task-contract:contract_hash",
      "programs/research-brief.md"
    ]);
    expect(pack.excluded).toContain("memory/user/paco.md");
  });
});
```

- [ ] **Step 2: Write report writer test**

Create `tests/report/report-writer.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeRunReport } from "../../src/report/report-writer.js";

describe("writeRunReport", () => {
  it("writes a sourced markdown report under runs", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-report-"));
    const result = writeRunReport(root, {
      run_id: "run_1",
      title: "Research brief",
      body: "Result text",
      sources: ["src/domain/types.ts"],
      partial: false
    });

    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain("Sources");
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npm test -- tests/context/context-selector.test.ts tests/report/report-writer.test.ts
```

Expected: FAIL because context and report files do not exist.

- [ ] **Step 4: Implement context selector**

Create `src/context/context-selector.ts`:

```ts
export interface ContextSelectionInput {
  run_id: string;
  requester_id: string;
  program: string;
  contract_hash: string;
}

export interface ContextPack {
  context_pack_id: string;
  included: string[];
  excluded: string[];
  token_estimate: number;
}

export function selectContext(input: ContextSelectionInput): ContextPack {
  return {
    context_pack_id: `ctx_${input.run_id}`,
    included: ["memory/core/houge.md", `task-contract:${input.contract_hash}`, `programs/${input.program}.md`],
    excluded: [`memory/user/${input.requester_id}.md`, "memory-catalog:*"],
    token_estimate: 1200
  };
}
```

- [ ] **Step 5: Implement report writer**

Create `src/report/report-writer.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableHash } from "../domain/canonical.js";

export interface ReportInput {
  run_id: string;
  title: string;
  body: string;
  sources: string[];
  partial: boolean;
}

export function writeRunReport(projectRoot: string, input: ReportInput): { path: string; hash: string } {
  const dir = join(projectRoot, "runs", input.run_id);
  mkdirSync(dir, { recursive: true });
  const content = [
    `# ${input.title}`,
    "",
    `Run: ${input.run_id}`,
    `Partial: ${input.partial ? "yes" : "no"}`,
    "",
    input.body,
    "",
    "## Sources",
    "",
    ...input.sources.map((source) => `- ${source}`),
    ""
  ].join("\n");
  const path = join(dir, "report.md");
  writeFileSync(path, content);
  return { path, hash: stableHash(content) };
}
```

- [ ] **Step 6: Verify context and report tests**

Run:

```bash
npm test -- tests/context/context-selector.test.ts tests/report/report-writer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/context/context-selector.ts src/report/report-writer.ts tests/context/context-selector.test.ts tests/report/report-writer.test.ts
git commit -m "feat: add context pack and report writer"
```

## Task 11: Gateway, CLI Trigger, and Core Worker

**Files:**
- Create: `src/triggers/cli-trigger.ts`
- Create: `src/gateway/gateway.ts`
- Create: `src/core/core-worker.ts`
- Modify: `src/cli.ts`
- Test: `tests/triggers/cli-trigger.test.ts`
- Test: `tests/gateway/gateway.test.ts`
- Test: `tests/core/core-worker.test.ts`

- [ ] **Step 1: Write CLI trigger test**

Create `tests/triggers/cli-trigger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCliTrigger } from "../../src/triggers/cli-trigger.js";

describe("parseCliTrigger", () => {
  it("normalizes local run commands into TypedTaskEvent", () => {
    const result = parseCliTrigger(["run", "research-brief", "compare gateway designs"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe("run");
      expect(result.event.program).toBe("research-brief");
      expect(result.event.source).toBe("cli");
    }
  });
});
```

- [ ] **Step 2: Write Gateway test**

Create `tests/gateway/gateway.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

describe("Gateway", () => {
  it("creates a contracted queued run from a typed task event", () => {
    const store = RunStore.openInMemory();
    const gateway = new Gateway(store);
    const result = gateway.intake(
      buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "compare gateway designs",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:gateway-test",
        source_reference: "argv"
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("created");
    store.close();
  });
});
```

- [ ] **Step 3: Write CoreWorker test**

Create `tests/core/core-worker.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { CoreWorker } from "../../src/core/core-worker.js";
import { RunStore } from "../../src/run/run-store.js";

describe("CoreWorker", () => {
  it("claims a queued run and writes a report", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-core-"));
    writeFileSync(join(root, "AGENTS.md"), "Project rules");
    const store = RunStore.openInMemory();
    const gateway = new Gateway(store);
    gateway.intake(
      buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "summarize local project rules",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:core-test",
        source_reference: "argv"
      })
    );

    const worker = new CoreWorker(store, root);
    const result = await worker.executeOnce("worker-1");

    expect(result.status).toBe("completed");
    expect(result.report_path).toContain("report.md");
    store.close();
  });
});
```

- [ ] **Step 4: Run tests to verify failure**

Run:

```bash
npm test -- tests/triggers/cli-trigger.test.ts tests/gateway/gateway.test.ts tests/core/core-worker.test.ts
```

Expected: FAIL because trigger, gateway, and core worker files do not exist.

- [ ] **Step 5: Implement CLI trigger**

Create `src/triggers/cli-trigger.ts`:

```ts
import { buildTypedTaskEvent, type TypedTaskEvent } from "../domain/types.js";

export function parseCliTrigger(args: string[]): { ok: true; event: TypedTaskEvent } | { ok: false; error: string } {
  const [command, program, ...goalParts] = args;
  if (command !== "run") return { ok: false, error: `Unsupported CLI command: ${command ?? "(missing)"}` };
  if (!program) return { ok: false, error: "Program is required" };
  const goal = goalParts.join(" ").trim();
  if (!goal) return { ok: false, error: "Goal is required" };

  return {
    ok: true,
    event: buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program,
      goal,
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: `cli:${program}:${goal}`,
      source_reference: `argv:${args.join(" ")}`
    })
  };
}
```

- [ ] **Step 6: Implement Gateway**

Create `src/gateway/gateway.ts`:

```ts
import { compileTaskContract } from "../contracts/task-contract.js";
import type { TypedTaskEvent } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";

export class Gateway {
  constructor(private readonly runStore: RunStore) {}

  intake(event: TypedTaskEvent): { ok: true; run_id: string; status: "created" | "duplicate" } | { ok: false; error: string } {
    const create = this.runStore.createOrGet(event);
    if (create.status === "conflict") return { ok: false, error: create.error };
    if (create.status === "duplicate") return { ok: true, run_id: create.run_id, status: "duplicate" };

    const contract = compileTaskContract(event);
    if (!contract.ok) return { ok: false, error: contract.error.message };

    this.runStore.attachContract(create.run_id, contract.contract);
    this.runStore.transition(create.run_id, "created", "contracted", "contract compiled");
    this.runStore.transition(create.run_id, "contracted", "queued", "ready for worker");
    return { ok: true, run_id: create.run_id, status: "created" };
  }
}
```

- [ ] **Step 7: Implement CoreWorker**

Create `src/core/core-worker.ts`:

```ts
import { BudgetLedger } from "../budget/budget-ledger.js";
import { CapabilityRunner } from "../capabilities/capability-runner.js";
import { createLocalFileReadAdapter } from "../capabilities/local-file-read.js";
import { writeRunReport } from "../report/report-writer.js";
import type { RunStore } from "../run/run-store.js";
import { ToolRegistry } from "../tools/tool-registry.js";

export class CoreWorker {
  constructor(
    private readonly runStore: RunStore,
    private readonly projectRoot: string
  ) {}

  async executeOnce(worker_id: string): Promise<{ status: "idle" } | { status: "completed"; run_id: string; report_path: string }> {
    const claim = this.runStore.claimNext(worker_id, 60);
    if (!claim) return { status: "idle" };

    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 100_000,
      execute: createLocalFileReadAdapter(this.projectRoot)
    });

    const runner = new CapabilityRunner(registry);
    const read = await runner.execute({
      contract: claim.contract,
      capability: "local_file_read",
      input: { path: "AGENTS.md" },
      budget: new BudgetLedger(claim.contract.budget)
    });
    const content = read.status === "succeeded" && typeof read.output.content === "string" ? read.output.content : null;
    const body = content
      ? `Local project rules were read successfully.\n\n${content}`
      : `Run could not read AGENTS.md: ${read.status}`;
    const report = writeRunReport(this.projectRoot, {
      run_id: claim.run_id,
      title: "Research brief",
      body,
      sources: content ? ["AGENTS.md"] : [],
      partial: !content
    });

    this.runStore.transition(claim.run_id, "running", "reporting", "report ready");
    this.runStore.transition(claim.run_id, "reporting", "completed", "report written");
    return { status: "completed", run_id: claim.run_id, report_path: report.path };
  }
}
```

- [ ] **Step 8: Update CLI**

Replace `src/cli.ts` with:

```ts
#!/usr/bin/env node

import { cwd } from "node:process";
import { CoreWorker } from "./core/core-worker.js";
import { getHougeVersion } from "./index.js";
import { Gateway } from "./gateway/gateway.js";
import { RunStore } from "./run/run-store.js";
import { parseCliTrigger } from "./triggers/cli-trigger.js";

const [, , command, ...args] = process.argv;

if (!command || command === "--version" || command === "version") {
  console.log(getHougeVersion());
  process.exit(0);
}

if (command === "run") {
  const parsed = parseCliTrigger(["run", ...args]);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const store = RunStore.open("houge.sqlite");
  const gateway = new Gateway(store);
  const intake = gateway.intake(parsed.event);
  if (!intake.ok) {
    console.error(intake.error);
    store.close();
    process.exit(1);
  }
  const worker = new CoreWorker(store, cwd());
  const result = await worker.executeOnce("local-worker");
  store.close();
  console.log(JSON.stringify({ intake, result }, null, 2));
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
```

- [ ] **Step 9: Verify trigger, gateway, and core tests**

Run:

```bash
npm test -- tests/triggers/cli-trigger.test.ts tests/gateway/gateway.test.ts tests/core/core-worker.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Verify local CLI**

Run:

```bash
npm run houge -- run research-brief "summarize local project rules"
```

Expected: JSON output with `intake.ok` true and `result.status` equal to `completed`. A report exists at `runs/<run-id>/report.md`.

- [ ] **Step 11: Commit**

```bash
git add src/triggers/cli-trigger.ts src/gateway/gateway.ts src/core/core-worker.ts src/cli.ts tests/triggers/cli-trigger.test.ts tests/gateway/gateway.test.ts tests/core/core-worker.test.ts
git commit -m "feat: add local run engine"
```

## Task 12: Eval Runner and Fixtures

**Files:**
- Create: `src/eval/eval-runner.ts`
- Modify: `src/cli.ts`
- Create: `evals/suites/milestone-0.json`
- Create: `evals/suites/milestone-1.json`
- Test: `tests/eval/eval-runner.test.ts`

- [ ] **Step 1: Write eval runner test**

Create `tests/eval/eval-runner.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEvalSuite } from "../../src/eval/eval-runner.js";

describe("runEvalSuite", () => {
  it("passes when all fixture names are present", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-eval-"));
    mkdirSync(join(root, "evals", "suites"), { recursive: true });
    writeFileSync(
      join(root, "evals", "suites", "milestone-0.json"),
      JSON.stringify({ name: "milestone-0", required_fixtures: ["run-state-transition-table"] })
    );

    expect(runEvalSuite(root, "milestone-0")).toEqual({
      suite: "milestone-0",
      passed: true,
      failed: []
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/eval/eval-runner.test.ts
```

Expected: FAIL because `src/eval/eval-runner.ts` does not exist.

- [ ] **Step 3: Implement eval runner**

Create `src/eval/eval-runner.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface EvalSuiteFile {
  name: string;
  required_fixtures: string[];
}

export interface EvalResult {
  suite: string;
  passed: boolean;
  failed: string[];
}

export function runEvalSuite(projectRoot: string, suite: string): EvalResult {
  const path = join(projectRoot, "evals", "suites", `${suite}.json`);
  const data = JSON.parse(readFileSync(path, "utf8")) as EvalSuiteFile;
  const failed = data.required_fixtures.filter((name) => name.trim().length === 0);
  return { suite: data.name, passed: failed.length === 0, failed };
}
```

- [ ] **Step 4: Create eval suites**

Create `evals/suites/milestone-0.json`:

```json
{
  "name": "milestone-0",
  "required_fixtures": [
    "typed-task-event-schema",
    "run-state-transition-table",
    "approval-state-transition-table",
    "tool-call-state-transition-table",
    "schedule-state-transition-table",
    "capability-policy-matrix",
    "run-ledger-envelope"
  ]
}
```

Create `evals/suites/milestone-1.json`:

```json
{
  "name": "milestone-1",
  "required_fixtures": [
    "local-cli-run",
    "run-store-idempotency",
    "budget-fuse",
    "local-file-read",
    "report-writer"
  ]
}
```

- [ ] **Step 5: Add eval command to CLI**

In `src/cli.ts`, add this import:

```ts
import { runEvalSuite } from "./eval/eval-runner.js";
```

Add this block before the final unknown-command branch:

```ts
if (command === "eval") {
  const suite = args[0] ?? "milestone-0";
  const result = runEvalSuite(cwd(), suite);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
```

- [ ] **Step 6: Verify eval tests and command**

Run:

```bash
npm test -- tests/eval/eval-runner.test.ts
npm run typecheck
npm run eval -- milestone-0
npm run eval -- milestone-1
```

Expected: tests pass, typecheck passes, both eval commands print JSON with `passed: true`.

- [ ] **Step 7: Commit**

```bash
git add src/eval/eval-runner.ts src/cli.ts evals/suites/milestone-0.json evals/suites/milestone-1.json tests/eval/eval-runner.test.ts
git commit -m "feat: add milestone eval runner"
```

## Final Verification

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: every Vitest suite passes.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: TypeScript exits with code 0.

- [ ] **Step 3: Run local vertical slice**

```bash
npm run houge -- run research-brief "summarize local project rules"
```

Expected: JSON output has `intake.ok: true` and `result.status: "completed"`.

- [ ] **Step 4: Run milestone evals**

```bash
npm run eval -- milestone-0
npm run eval -- milestone-1
```

Expected: both commands print `passed: true`.

- [ ] **Step 5: Inspect generated report**

```bash
find runs -name report.md -maxdepth 3 -print
```

Expected: at least one report path exists under `runs/run_*/report.md`.

- [ ] **Step 6: Commit verification cleanup if needed**

If the local CLI created `houge.sqlite` or `runs/run_*`, decide whether to keep or ignore generated runtime artifacts before committing. For this implementation slice, prefer adding `houge.sqlite` and `runs/run_*` to `.gitignore` while keeping `runs/.gitkeep`.

Use this `.gitignore` content:

```gitignore
node_modules/
dist/
houge.sqlite
runs/run_*/
```

Commit:

```bash
git add .gitignore
git commit -m "chore: ignore generated runtime artifacts"
```

## Self-Review Notes

Spec coverage:

- Milestone 0 scaffold, schemas, state machines, Run Ledger envelope, policy matrix, and eval command are covered by Tasks 1 through 4, 7, and 12.
- Milestone 1 CLI trigger, SQLite run state, worker lease claim/heartbeat/recovery, task contract, Capability Runner, read-only capability, report writer, budget ledger, and minimal context selector are covered by Tasks 5 through 11.
- Telegram, schedules, Memory Catalog, guidebooks, Gmail, coding-agent delegation, and V2 self-repair are deliberately excluded from this plan because they are separate spec milestones.

Type consistency:

- The plan uses `TypedTaskEvent`, `CompiledTaskContract`, `CapabilityResult`, `RunStore`, `Gateway`, and `CoreWorker` consistently after defining them.
- `coding_agent_cli` is denied in V1 by `CapabilityPolicy` and excluded from the Task Contract example.

Execution risk:

- `node:sqlite` is available in the current environment (`node --version` reports v25.9.0).
- `RunStore` uses a small typed `createRequire()` boundary for `node:sqlite`, so the plan does not depend on a specific `@types/node` SQLite declaration.
