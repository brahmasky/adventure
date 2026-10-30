import type { Entry, RungAnswer } from "../types.js";

export type ScheduleAdmitVerdict = "admit" | "exists" | "refuse";
/** `none` only for no_chat: the notify-target check runs before the verb dispatch (spec 2026-10-30 §4.2). */
export type ScheduleAdmitVerb = "create" | "update" | "cancel" | "none";
export type ScheduleAdmitReason = "no_chat" | "not_found" | "cap";
export interface ScheduleAdmitInput { verb: ScheduleAdmitVerb; outcome: ScheduleAdmitVerdict; code?: ScheduleAdmitReason }

function rule(s: ScheduleAdmitInput): RungAnswer<ScheduleAdmitVerdict> {
  if (s.outcome === "refuse") return s.code !== undefined ? { verdict: "refuse", reason: s.code } : { verdict: "refuse" };
  return s.verb === "none" ? { verdict: s.outcome } : { verdict: s.outcome, reason: s.verb };
}

export const SCHEDULE_ADMIT: Entry<ScheduleAdmitInput, ScheduleAdmitVerdict> = {
  id: "schedule.admit", version: 1, stage: "pre_tool", input: "tool",
  question: "Does this schedule_task create, update or cancel pass the code-owned admission checks?",
  verdicts: ["admit", "exists", "refuse"],
  ladder: [{ kind: "rule", name: "scheduleAdmits", decide: rule }],
  fail: "refuse", defaultVerdict: "admit", alwaysRecord: true, outcomes: [], armed: { rule: "on" },
  effects: { admit: { kind: "none", reversible: true, announced: "none" }, exists: { kind: "none", reversible: true, announced: "none" },
    refuse: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["create", "update", "cancel", "no_chat", "not_found", "cap"],
};
