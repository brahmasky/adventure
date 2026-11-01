import type { Entry, RungAnswer } from "../types.js";

/** PlannerSupervisor.submit's steer/queue branch, first match in this order (spec 2026-11-01 R3 §4.2); listed steer first. */
export const STEER_REASONS = ["live_turn", "turn_schedule_born", "message_scheduled", "needs_ingest", "not_running", "turn_not_live", "queued_behind", "idle"] as const;
export type SteerReason = (typeof STEER_REASONS)[number];
export type SteerVerdict = "steer" | "wait" | "queue";
/** Captured in submit from the values the branch reads; recorded at the incoming run's claim (spec §4.0). */
export interface SteerOrQueueInput { outcome: SteerVerdict; reason: SteerReason }

function rule(s: SteerOrQueueInput): RungAnswer<SteerVerdict> {
  return { verdict: s.outcome, reason: s.reason };
}

export const INTAKE_STEER_OR_QUEUE: Entry<SteerOrQueueInput, SteerVerdict> = {
  id: "intake.steer_or_queue", version: 1, stage: "intake", input: "tool",
  question: "Does this message steer into the live Telegram turn, wait behind a turn it may not join, or queue on an idle planner?",
  verdicts: ["steer", "wait", "queue"],
  ladder: [{ kind: "rule", name: "submit", decide: rule }],
  fail: "wait", defaultVerdict: "queue", outcomes: [], armed: { rule: "on" },
  effects: {
    steer: { kind: "effect", reversible: false, announced: "none", what: "the message joins the running turn; one reply" },
    wait: { kind: "none", reversible: true, announced: "none" },
    queue: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: [...STEER_REASONS],
};
