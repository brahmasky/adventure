import type {
  ApprovalState,
  ProjectState,
  RunState,
  ScheduleState,
  ToolCallState
} from "../domain/types.js";

const runTransitions: Record<RunState, readonly RunState[]> = {
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
  failed: [],
  timed_out: [],
  cancelled: [],
  uncertain_outcome: [],
  denied: [],
  denied_on_revalidation: []
};

const scheduleTransitions: Record<ScheduleState, readonly ScheduleState[]> = {
  disabled: ["enabled"],
  enabled: ["disabled", "fired"],
  fired: ["enqueued", "skipped_duplicate", "failed"],
  enqueued: [],
  skipped_duplicate: [],
  failed: []
};

// P2 (spec §4): forward chain + drop-anywhere + un-drop (with reason). Skipping ahead
// (e.g. tracked→paid) is illegal — each externally-reached state gets its own ledgered move.
const projectTransitions: Record<ProjectState, readonly ProjectState[]> = {
  tracked: ["working", "dropped"],
  working: ["submitted", "dropped"],
  submitted: ["paid", "dropped"],
  paid: ["dropped"],
  dropped: ["tracked"]
};

export function canTransitionProject(from: ProjectState, to: ProjectState): boolean {
  return projectTransitions[from].includes(to);
}

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
