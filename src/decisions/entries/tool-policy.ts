import type { Entry, RungAnswer } from "../types.js";

export type ToolPolicyVerdict = "allowed" | "denied";

function rule(s: { allowed: boolean }): RungAnswer<ToolPolicyVerdict> {
  return s.allowed ? { verdict: "allowed" } : { verdict: "denied" };
}

export const TOOL_POLICY: Entry<{ allowed: boolean }, ToolPolicyVerdict> = {
  id: "tool.policy", version: 1, stage: "pre_tool", input: "tool",
  question: "Is this tool call permitted by policy?",
  verdicts: ["allowed", "denied"],
  ladder: [{ kind: "rule", name: "policy", decide: rule }],
  fail: "denied", defaultVerdict: "allowed", outcomes: [], armed: { rule: "on" },
  effects: { allowed: { kind: "none", reversible: true, announced: "none" }, denied: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [],
};
