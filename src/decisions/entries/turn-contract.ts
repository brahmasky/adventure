import type { Entry, RungAnswer } from "../types.js";

/** compileTaskContract's refusals (spec 2026-11-01 R2 §4.2): empty goal/message/question/topic, unknown program, unsupported type. */
export const CONTRACT_REFUSAL_REASONS = ["goal_missing", "unknown_program", "unsupported_type"] as const;
export type ContractRefusal = (typeof CONTRACT_REFUSAL_REASONS)[number];
export type TurnContractVerdict = "compile" | "restrict" | "refuse";
/** `restricted` is read off the compiled contract (a turn whose allowed_actions lack schedule_task), never re-derived from the event. */
export interface TurnContractInput { refused: ContractRefusal | null; restricted: boolean }

function rule(s: TurnContractInput): RungAnswer<TurnContractVerdict> {
  if (s.refused !== null) return { verdict: "refuse", reason: s.refused };
  return s.restricted ? { verdict: "restrict", reason: "schedule_born" } : { verdict: "compile" };
}

export const TURN_CONTRACT: Entry<TurnContractInput, TurnContractVerdict> = {
  id: "turn.contract", version: 1, stage: "pre_model", input: "tool",
  question: "Does this event compile to a contract, and is a schedule-born turn's envelope narrowed (no schedule_task)?",
  verdicts: ["compile", "restrict", "refuse"],
  ladder: [{ kind: "rule", name: "compileTaskContract", decide: rule }],
  fail: "refuse", defaultVerdict: "compile", outcomes: [], armed: { rule: "on" },
  effects: {
    compile: { kind: "none", reversible: true, announced: "none" },
    restrict: { kind: "tighten", reversible: true, announced: "none" },
    refuse: { kind: "tighten", reversible: true, announced: "none" }
  },
  reasonCodes: ["schedule_born", ...CONTRACT_REFUSAL_REASONS],
};
