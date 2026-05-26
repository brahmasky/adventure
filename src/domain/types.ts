import { stableHash } from "./canonical.js";

export type TriggerSource = "cli" | "api" | "schedule" | "webhook";
export type TaskEventType = "run" | "cancel" | "resume";

export type Identity =
  | { kind: "user"; id: string }
  | { kind: "service"; id: string }
  | { kind: "system" };

export type NotifyTarget =
  | { kind: "local" }
  | { kind: "email"; address: string }
  | { kind: "webhook"; url: string };

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

export type RunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type ApprovalState = "not_required" | "required" | "approved" | "denied";
export type ToolCallState = "pending" | "running" | "succeeded" | "failed";
export type ScheduleState = "scheduled" | "paused" | "completed" | "cancelled";
export type SideEffectLevel = "none" | "local" | "external";
export type RiskLevel = "low" | "medium" | "high";
export type PolicyDecision = "allow" | "deny" | "require_approval";

export interface BudgetSpec {
  max_steps?: number;
  max_tool_calls?: number;
  max_tokens?: number;
  timeout_ms?: number;
}

export interface CompiledTaskContract {
  program: string;
  goal: string;
  side_effect_level: SideEffectLevel;
  risk_level: RiskLevel;
  budget: BudgetSpec;
  policy_decision: PolicyDecision;
}

export function buildTypedTaskEvent(input: TypedTaskEventInput): TypedTaskEvent {
  const {
    source,
    type,
    program,
    goal,
    approval_id,
    lesson,
    requested_by,
    notify,
    idempotency_key
  } = input;

  return {
    ...input,
    created_at: input.created_at ?? new Date().toISOString(),
    payload_hash: stableHash({
      source,
      type,
      program,
      goal,
      approval_id,
      lesson,
      requested_by,
      notify,
      idempotency_key
    })
  };
}
