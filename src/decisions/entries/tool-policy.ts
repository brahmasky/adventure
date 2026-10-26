import type { Entry, RungAnswer } from "../types.js";
import type { CapabilityDecision } from "../../policy/capability-policy.js";

export type ToolPolicyVerdict = "allowed" | "requires_approval" | "denied";

const REASON_MAP: Readonly<Record<string, string>> = {
  "Capability forbidden by task contract": "forbidden",
  "Coding-agent CLI delegation is not allowed by this task contract": "coding_agent_cli_not_allowed",
  "Capability not allowed by task contract": "capability_not_allowed",
  "Capability has gated side effects": "gated_side_effect",
  "Turn trust asks for a tap": "trust_ask",
  "Capability allowed by task contract": "allowed",
};
function rule(s: { decision: CapabilityDecision["decision"]; reason?: string }): RungAnswer<ToolPolicyVerdict> {
  const verdict =
    s.decision === "allow" ? "allowed" :
    s.decision === "requires_approval" ? "requires_approval" :
    "denied";
  const code = s.reason !== undefined ? REASON_MAP[s.reason] : undefined;
  return code === undefined ? { verdict } : { verdict, reason: code };
}

export const TOOL_POLICY: Entry<{ decision: CapabilityDecision["decision"]; reason?: string }, ToolPolicyVerdict> = {
  id: "tool.policy", version: 2, stage: "pre_tool", input: "tool",
  question: "Is this tool call permitted by policy?",
  verdicts: ["allowed", "requires_approval", "denied"],
  ladder: [{ kind: "rule", name: "policy", decide: rule }],
  fail: "denied", defaultVerdict: "allowed", outcomes: [], alwaysRecord: true, armed: { rule: "on" },
  effects: { allowed: { kind: "none", reversible: true, announced: "none" }, requires_approval: { kind: "tighten", reversible: true, announced: "none" }, denied: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [
    "forbidden",
    "coding_agent_cli_not_allowed",
    "capability_not_allowed",
    "gated_side_effect",
    "trust_ask",
    "allowed",
  ],
};
