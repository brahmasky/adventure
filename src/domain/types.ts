import { stableHash } from "./canonical.js";

export type TriggerSource = "telegram" | "schedule" | "cli" | "event";
export type TaskEventType = "ask" | "run" | "turn" | "approve" | "deny" | "status" | "usage" | "help" | "unknown_command" | "lessons" | "forget" | "skills" | "schedule_admin" | "kill" | "disarm" | "rearm";

export type Identity =
  | { kind: "user"; id: string }
  | { kind: "schedule"; id: string }
  | { kind: "system"; id: string };

export type NotifyTarget =
  | { kind: "local" }
  | { kind: "telegram"; chat_id: string };

export interface TelegramAllowlistedUser {
  telegram_user_id: number;
  identity_id: string;
}

export interface TelegramAllowlistedChat {
  telegram_chat_id: number;
  label: string;
  allowed_identity_ids: string[];
}

export interface TelegramAllowlist {
  users: TelegramAllowlistedUser[];
  chats: TelegramAllowlistedChat[];
}

export interface TypedTaskEventInput {
  source: TriggerSource;
  type: TaskEventType;
  program?: string;
  goal?: string;
  approval_id?: string;
  metadata?: Record<string, unknown>;
  payload?: unknown;
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
export type ScheduleState =
  | "disabled"
  | "enabled"
  | "fired"
  | "enqueued"
  | "skipped_duplicate"
  | "failed";
/**
 * P2 money-work (roadmap §P2): a pursued bounty's durable lifecycle. States record
 * what Paco reached externally (bookkeeping, never acting — ADR 0022); `paid` is a
 * status flag only, money accounting stays in the P3 earnings ledger.
 */
export type ProjectState =
  | "tracked"
  | "working"
  | "submitted"
  | "paid"
  | "dropped";
export type SideEffectLevel =
  | "none"
  | "local_write"
  | "external_read"
  | "external_write"
  | "destructive"
  | "paid";
export type RiskLevel = "low" | "medium" | "high";
export type PolicyDecision = "allow" | "deny" | "requires_approval";
export type ApprovalDecision = "approved" | "denied";

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
  approval_gates: SideEffectLevel[];
  stop_condition: string;
  contract_hash: string;
  eval_hooks: string[];
}

export function buildTypedTaskEvent(input: TypedTaskEventInput): TypedTaskEvent {
  const {
    source,
    type,
    program,
    goal,
    approval_id,
    metadata,
    payload,
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
      metadata,
      payload,
      requested_by,
      notify,
      idempotency_key
    })
  };
}
