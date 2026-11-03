import type { Entry, RungAnswer } from "../types.js";

export const MODEL_REASONS = ["stepped_up", "refused", "next_leg", "pin_failed", "no_leg"] as const;
export type ModelVerdict = "head" | "fallback" | "held" | "none";
/** Captured around one pin walk (spec R6 §4.3, plan P11): refused counts only this walk's refusals. */
export interface ModelInput { leg: "first" | "retry"; outcome: "ok" | "pin_failed" | "exhausted"; stepped: boolean; refused: number }

function rule(s: ModelInput): RungAnswer<ModelVerdict> | ModelVerdict {
  if (s.outcome === "exhausted") return { verdict: "none", reason: "no_leg" };
  if (s.outcome === "pin_failed") return { verdict: s.leg === "first" ? "held" : "none", reason: "pin_failed" };
  if (s.stepped) return { verdict: "fallback", reason: "stepped_up" };
  if (s.refused > 0) return { verdict: "fallback", reason: "refused" };
  return s.leg === "retry" ? { verdict: "fallback", reason: "next_leg" } : "head";
}

export const TURN_MODEL: Entry<ModelInput, ModelVerdict> = {
  id: "turn.model", version: 1, stage: "pre_model", input: "tool",
  question: "Which leg of the turn's role is the planner child pinned to: its first eligible candidate, a later leg or the next role up, the model it already holds, or none?",
  verdicts: ["head", "fallback", "held", "none"],
  ladder: [{ kind: "rule", name: "pin_walk", decide: rule }],
  fail: "head", defaultVerdict: "head", outcomes: [], armed: { rule: "on" },
  effects: {
    head: { kind: "none", reversible: true, announced: "none" },
    fallback: { kind: "effect", reversible: true, announced: "none", what: "a later leg of the role, or the next role up, answers; a step-up is ledgered routed_escalation as today; a refusal lasts for the child's life" },
    held: { kind: "effect", reversible: true, announced: "none", what: "the turn answers on the model the child already holds; planner_model_reset_failed as today" },
    none: { kind: "none", reversible: true, announced: "none", what: "the turn fails no_planner_leg or retry_failed with today's text and incident" }
  },
  reasonCodes: [...MODEL_REASONS],
};
