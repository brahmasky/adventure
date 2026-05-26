import type {
  ApprovalState,
  RunState,
  ScheduleState,
  ToolCallState
} from "../domain/types.js";

type State = string;
type TransitionTable = Record<State, readonly State[]>;

const runTransitions: TransitionTable = {
  created: ["contracted", "failed", "cancelled", "expired"],
  contracted: ["queued", "failed", "cancelled", "expired"],
  queued: ["running", "failed", "cancelled", "expired"],
  running: [
    "waiting_for_approval",
    "reconciliation_required",
    "reporting",
    "failed",
    "cancelled",
    "expired"
  ],
  waiting_for_approval: ["queued", "failed", "cancelled", "expired"],
  reconciliation_required: ["queued", "failed", "cancelled", "expired"],
  reporting: ["completed", "failed", "cancelled", "expired"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: []
};

const approvalTransitions: TransitionTable = {
  pending: ["approved", "denied", "expired"],
  approved: ["consumed"],
  consumed: [],
  denied: [],
  expired: []
};

const toolCallTransitions: TransitionTable = {
  requested: ["policy_checked"],
  policy_checked: ["running", "denied", "waiting_for_approval"],
  waiting_for_approval: ["running", "denied_on_revalidation"],
  running: ["succeeded", "failed", "timed_out", "cancelled", "uncertain_outcome"],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  uncertain_outcome: [],
  denied: [],
  denied_on_revalidation: []
};

const scheduleTransitions: TransitionTable = {
  disabled: ["enabled"],
  enabled: ["disabled", "fired"],
  fired: ["enqueued", "skipped_duplicate", "failed"],
  enqueued: [],
  skipped_duplicate: [],
  failed: []
};

export function canTransitionRun(from: RunState | State, to: RunState | State): boolean {
  return (runTransitions[from] ?? []).includes(to);
}

export function canTransitionApproval(
  from: ApprovalState | State,
  to: ApprovalState | State
): boolean {
  return (approvalTransitions[from] ?? []).includes(to);
}

export function canTransitionToolCall(
  from: ToolCallState | State,
  to: ToolCallState | State
): boolean {
  return (toolCallTransitions[from] ?? []).includes(to);
}

export function canTransitionSchedule(
  from: ScheduleState | State,
  to: ScheduleState | State
): boolean {
  return (scheduleTransitions[from] ?? []).includes(to);
}
