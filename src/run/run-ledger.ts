import { randomUUID } from "node:crypto";

export type LedgerActor =
  | "gateway"
  | "core"
  | "capability_runner"
  | "trigger_adapter"
  | "notification_outbox"
  | "system";

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

const requiredPayloadFields = {
  trigger_received: ["source", "source_reference", "requester", "idempotency_key", "payload_hash"],
  idempotency_conflict: [
    "source",
    "idempotency_key",
    "existing_run_id",
    "stored_payload_hash",
    "incoming_payload_hash",
    "resolution"
  ],
  schedule_fired: ["schedule_id", "scheduled_time", "command_hash"],
  schedule_skipped_duplicate: [
    "schedule_id",
    "scheduled_time",
    "idempotency_key",
    "existing_run_id"
  ],
  run_created: ["source", "idempotency_key", "program", "goal_hash", "requester"],
  contract_attached: ["contract_hash", "program", "budget", "allowed_actions", "approval_gates"],
  worker_lease_acquired: ["worker_id", "lease_expires_at", "attempt_count"],
  worker_lease_released: ["worker_id", "reason"],
  worker_lease_expired: [
    "worker_id",
    "lease_expires_at",
    "active_tool_call_id",
    "recovery_action"
  ],
  context_selected: [
    "context_pack_id",
    "included_artifact_ids",
    "excluded_relevant_artifact_ids",
    "token_estimate"
  ],
  budget_zone_changed: ["previous_zone", "next_zone", "remaining_budget", "reason"],
  capability_requested: [
    "tool_call_id",
    "capability",
    "input_hash",
    "side_effect_level",
    "risk_level"
  ],
  policy_decision: ["tool_call_id", "decision", "reason", "policy_version"],
  tool_started: ["tool_call_id", "operation_id", "adapter_name", "input_hash", "timeout_ms"],
  tool_finished: ["tool_call_id", "status", "output_hash", "duration_ms", "bytes_out"],
  approval_requested: [
    "approval_id",
    "action_fingerprint",
    "action_summary",
    "side_effect_level",
    "expires_at"
  ],
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
} as const satisfies Record<LedgerEventType, readonly string[]>;

export function createLedgerEvent(
  input: Omit<LedgerEvent, "event_id" | "occurred_at">
): LedgerEvent {
  return {
    ...input,
    event_id: `evt_${randomUUID()}`,
    occurred_at: new Date().toISOString()
  };
}

export function validateLedgerEvent(
  event: LedgerEvent
): { ok: true } | { ok: false; error: string } {
  for (const field of requiredPayloadFields[event.event_type]) {
    if (event.payload[field] === undefined) {
      return {
        ok: false,
        error: `${event.event_type} missing required payload field: ${field}`
      };
    }
  }

  return { ok: true };
}
