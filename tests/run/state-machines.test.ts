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
