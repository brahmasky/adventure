import { describe, expect, it } from "vitest";
import { stableHash } from "../../src/domain/canonical.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import type {
  ApprovalState,
  BudgetSpec,
  CompiledTaskContract,
  Identity,
  NotifyTarget,
  PolicyDecision,
  RiskLevel,
  RunState,
  ScheduleState,
  SideEffectLevel,
  TaskEventType,
  ToolCallState,
  TriggerSource,
  TypedTaskEventInput
} from "../../src/domain/types.js";

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends
  (<Value>() => Value extends Expected ? 1 : 2) ? true : false;
type Expect<Condition extends true> = Condition;

type TriggerSourceMatchesPlan = Expect<Equal<
  TriggerSource,
  "telegram" | "schedule" | "cli" | "event"
>>;
type TaskEventTypeMatchesPlan = Expect<Equal<
  TaskEventType,
  "ask" | "run" | "turn" | "approve" | "deny" | "status" | "lessons" | "forget" | "skills"
>>;
type IdentityMatchesPlan = Expect<Equal<
  Identity,
  | { kind: "user"; id: string }
  | { kind: "schedule"; id: string }
  | { kind: "system"; id: string }
>>;
type NotifyTargetMatchesPlan = Expect<Equal<
  NotifyTarget,
  { kind: "local" } | { kind: "telegram"; chat_id: string }
>>;
type RunStateMatchesPlan = Expect<Equal<
  RunState,
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
  | "expired"
>>;
type ApprovalStateMatchesPlan = Expect<Equal<
  ApprovalState,
  "pending" | "approved" | "consumed" | "denied" | "expired"
>>;
type ToolCallStateMatchesPlan = Expect<Equal<
  ToolCallState,
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
  | "uncertain_outcome"
>>;
type ScheduleStateMatchesPlan = Expect<Equal<
  ScheduleState,
  "disabled" | "enabled" | "fired" | "enqueued" | "skipped_duplicate" | "failed"
>>;
type SideEffectLevelMatchesPlan = Expect<Equal<
  SideEffectLevel,
  "none" | "local_write" | "external_read" | "external_write" | "destructive" | "paid"
>>;
type RiskLevelMatchesPlan = Expect<Equal<RiskLevel, "low" | "medium" | "high">>;
type PolicyDecisionMatchesPlan = Expect<Equal<
  PolicyDecision,
  "allow" | "deny" | "requires_approval"
>>;
type BudgetSpecMatchesPlan = Expect<Equal<
  BudgetSpec,
  {
    time_minutes: number;
    max_tool_calls: number;
    max_agent_delegations: number;
  }
>>;
type CompiledTaskContractMatchesPlan = Expect<Equal<
  CompiledTaskContract,
  {
    objective: string;
    budget: BudgetSpec;
    allowed_actions: string[];
    forbidden_actions: string[];
    output: { path: string; format: "sourced_markdown_report" };
    approval_gates: SideEffectLevel[];
    stop_condition: string;
    contract_hash: string;
    eval_hooks: string[];
  }
>>;

const minimalTypedTaskEventInput: TypedTaskEventInput = {
  source: "cli",
  type: "run",
  requested_by: { kind: "user", id: "paco" },
  notify: { kind: "local" },
  idempotency_key: "cli:research-brief:1",
  source_reference: "argv"
};
void minimalTypedTaskEventInput;

// @ts-expect-error source_reference is required for trigger traceability.
const missingSourceReferenceInput: TypedTaskEventInput = {
  source: "cli",
  type: "run",
  program: "research-brief",
  goal: "compare gateway patterns",
  approval_id: "approval-1",
  requested_by: { kind: "user", id: "paco" },
  notify: { kind: "local" },
  idempotency_key: "cli:research-brief:1"
};
void missingSourceReferenceInput;

describe("buildTypedTaskEvent", () => {
  it("includes a payload hash derived from normalized task fields", () => {
    const event = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
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
      approval_id: "approval-1",
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
      approval_id: "approval-1",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      created_at: "2026-05-25T00:01:00.000Z"
    });

    expect(retry.payload_hash).toBe(first.payload_hash);
  });

  it("hashes the explicit task payload fields including approval", () => {
    const event = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      created_at: "2026-05-25T00:00:00.000Z",
      metadata: { source: "local" },
      payload: { topic: "local run smoke" }
    });

    expect(event.payload_hash).toBe(stableHash({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      metadata: { source: "local" },
      payload: { topic: "local run smoke" }
    }));
  });

  it("includes structured payload in the hash for idempotency conflict detection", () => {
    const first = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      payload: { topic: "alpha" }
    });
    const second = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      payload: { topic: "beta" }
    });

    expect(second.payload_hash).not.toBe(first.payload_hash);
  });

  it("excludes source_reference from the payload hash", () => {
    const first = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv"
    });
    const retry = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "stdin"
    });

    expect(retry.payload_hash).toBe(first.payload_hash);
  });

  it("does not hash fields outside the explicit task payload contract", () => {
    const baseline = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv"
    });
    const withExtraField = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      debug_note: "not part of the task payload contract"
    } as Parameters<typeof buildTypedTaskEvent>[0] & { debug_note: string });

    expect(withExtraField.payload_hash).toBe(baseline.payload_hash);
  });
});
