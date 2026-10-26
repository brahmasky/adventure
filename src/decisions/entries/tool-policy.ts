import type { Entry, RungAnswer } from "../types.js";
import type { CapabilityDecision } from "../../policy/capability-policy.js";

export type ToolPolicyVerdict = "allowed" | "requires_approval" | "denied";

function rule(s: { decision: CapabilityDecision["decision"]; reason?: string }): RungAnswer<ToolPolicyVerdict> {
  const verdict =
    s.decision === "allow" ? "allowed" :
    s.decision === "requires_approval" ? "requires_approval" :
    "denied";
  return s.reason === undefined ? { verdict } : { verdict, reason: s.reason };
}

export const TOOL_POLICY: Entry<{ decision: CapabilityDecision["decision"]; reason?: string }, ToolPolicyVerdict> = {
  id: "tool.policy", version: 2, stage: "pre_tool", input: "tool",
  question: "Is this tool call permitted by policy?",
  verdicts: ["allowed", "requires_approval", "denied"],
  ladder: [{ kind: "rule", name: "policy", decide: rule }],
  fail: "denied", defaultVerdict: "allowed", outcomes: [], alwaysRecord: true, armed: { rule: "on" },
  effects: { allowed: { kind: "none", reversible: true, announced: "none" }, requires_approval: { kind: "tighten", reversible: true, announced: "none" }, denied: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [
    "Capability forbidden by task contract",
    "Coding-agent CLI delegation is not allowed by this task contract",
    "Capability not allowed by task contract",
    "Capability has gated side effects",
    "Turn trust asks for a tap",
    "Capability allowed by task contract",
  ],
};
