import type { PolicyDecision, RiskLevel, SideEffectLevel } from "../domain/types.js";

export interface CapabilityDecisionInput {
  capability: string;
  category: "tool" | "coding_agent_cli";
  side_effect_level: SideEffectLevel;
  risk_level: RiskLevel;
  allowed_actions: string[];
  forbidden_actions: string[];
}

export interface CapabilityDecision {
  decision: PolicyDecision;
  reason: string;
}

const gatedSideEffectLevels: SideEffectLevel[] = ["external_write", "destructive", "paid"];

export function decideCapability(input: CapabilityDecisionInput): CapabilityDecision {
  if (input.category === "coding_agent_cli") {
    return {
      decision: "deny",
      reason: "Coding-agent CLI delegation is reserved for V2 containment"
    };
  }

  if (input.forbidden_actions.includes(input.capability)) {
    return { decision: "deny", reason: "Capability forbidden by task contract" };
  }

  if (!input.allowed_actions.includes(input.capability)) {
    return { decision: "deny", reason: "Capability not allowed by task contract" };
  }

  if (gatedSideEffectLevels.includes(input.side_effect_level)) {
    return { decision: "requires_approval", reason: "Capability has gated side effects" };
  }

  return { decision: "allow", reason: "Capability allowed by task contract" };
}
