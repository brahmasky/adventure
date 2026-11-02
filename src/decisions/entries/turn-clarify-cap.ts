import { clarifyCapOf, type ClarifyCapInput } from "../../capabilities/intent.js";
import type { Entry, RungAnswer } from "../types.js";

export type ClarifyCapVerdict = "allow" | "cap";

function rule(s: ClarifyCapInput): RungAnswer<ClarifyCapVerdict> | ClarifyCapVerdict {
  return clarifyCapOf(s) ? { verdict: "cap", reason: "cap_reached" } : "allow";
}

export const TURN_CLARIFY_CAP: Entry<ClarifyCapInput, ClarifyCapVerdict> = {
  id: "turn.clarify_cap", version: 1, stage: "pre_model", input: "tool",
  question: "Houge has asked its limit of clarifying questions in a row: does this prompt carry the do-not-ask-another line?",
  verdicts: ["allow", "cap"],
  ladder: [{ kind: "rule", name: "clarify_cap", decide: rule }],
  fail: "allow", defaultVerdict: "allow", outcomes: [], armed: { rule: "on" },
  effects: {
    allow: { kind: "none", reversible: true, announced: "none" },
    cap: { kind: "tighten", reversible: true, announced: "none", what: "CLARIFY_CAP_NOTICE is in the planner prompt; the next non-clarify reply resets the streak" }
  },
  reasonCodes: ["cap_reached"],
};
