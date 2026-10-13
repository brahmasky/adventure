import { TREE_ACTIONS, TREE_BREADTH, TREE_REASONING } from "../../jev/questions/tree.js";
import type { RouteReason, TurnRole } from "../../jev/tree-policy.js";
import type { Entry, RungAbstain, RungAnswer, VerdictEffect } from "../types.js";
import { ROUTE_REASONS } from "./turn-handler.js";

/**
 * `turn.gear` (spec §4.4): the planner role this turn runs on, from the same Jev call as `turn.handler`. Stage 1 records it;
 * the planner still pins the route's role, and the two are equal by construction (tests/core/turn-handler-ladder.test.ts).
 * `applied` is true only when the gear questions were armed and the tree (or the cascade) decided the handler. A role
 * causes nothing beyond which model answers (R12 kind `none`).
 */
export const TURN_GEAR_ID = "turn.gear";
export type TurnGearVerdict = TurnRole;
export interface TurnGearState { role: TurnRole; reason: RouteReason; applied: boolean }
const NONE: VerdictEffect = { kind: "none", reversible: true, announced: "none", what: "which planner role answers" };

export function turnGearRule(s: TurnGearState): RungAnswer<TurnGearVerdict> | RungAbstain<TurnGearVerdict> {
  return s.applied ? { abstain: true } : { verdict: s.role, reason: "gear_not_applied" };
}

export const TURN_GEAR: Entry<TurnGearState, TurnGearVerdict> = {
  // 2: the Jev rung re-asks once inside a reviewed noise band (stage 2a, Addition B)
  id: TURN_GEAR_ID, version: 2, stage: "pre_model", input: "paco",
  question: "Which planner role (Fast, Default, Thinking) does this turn run on?",
  verdicts: ["fast", "default", "thinking"],
  ladder: [
    { kind: "rule", name: "route_role", decide: turnGearRule },
    { kind: "system_one", name: "tree_gear", questions: [TREE_BREADTH, TREE_REASONING, TREE_ACTIONS], bars: { kind: "calibrated", questionIds: ["breadth", "reasoning", "actions"] },
      timeoutMs: 1_000 }
  ],
  fail: "default", defaultVerdict: "default",
  outcomes: ["correction", "rating", "review_ok", "review_bad", "review_unsure", "think_harder"],
  armed: { rule: "on", system_one: "on" },
  effects: { fast: NONE, default: NONE, thinking: NONE },
  reasonCodes: [...ROUTE_REASONS, "gear_not_applied"]
};
