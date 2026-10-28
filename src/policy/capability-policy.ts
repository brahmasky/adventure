import type { PolicyDecision, RiskLevel, SideEffectLevel } from "../domain/types.js";

export interface CapabilityDecisionInput {
  capability: string;
  category: "tool" | "coding_agent_cli";
  side_effect_level: SideEffectLevel;
  risk_level: RiskLevel;
  allowed_actions: string[];
  forbidden_actions: string[];
  approval_gates: SideEffectLevel[];
  /**
   * turn.trust's added tap (decision ladder spec §7.2; ADR 0029 decision 2: ask := code_ask ∨ trust_ask). Turns an allow
   * into an ask, nothing else: never a deny into an ask, never an ask into an allow, never a deny on its own.
   */
  trust_ask?: boolean;
  /** Stage 4A: the bridge's standing selector. It can satisfy a GATE only, and only when trust does not ask; the runner must still win the store CAS. */
  standing?: { standing_id: string };
}

export const TRUST_ASK_REASON = "Turn trust asks for a tap";
export const STANDING_REASON = "Standing approval authorised this call";
export const STANDING_MISMATCH_REASON = "Standing approval did not match";

export interface CapabilityDecision {
  decision: PolicyDecision;
  reason: string;
  /** echoed from the input on a gated ask with no trust ask: the runner's cue to try the CAS */
  standing?: { standing_id: string };
}

export function decideCapability(input: CapabilityDecisionInput): CapabilityDecision {
  if (input.forbidden_actions.includes(input.capability)) {
    return { decision: "deny", reason: "Capability forbidden by task contract" };
  }

  // Coding-agent CLI delegation (ADR 0011, Phase 1) is gated to contracts that
  // explicitly allow it — the `self-diagnose` route. Every other contract keeps
  // `coding_agent_cli` in its forbidden_actions, so this category is unreachable
  // from a normal turn/ask/research run; only the self-diagnose contract opens it.
  if (input.category === "coding_agent_cli" && !input.allowed_actions.includes(input.capability)) {
    return {
      decision: "deny",
      reason: "Coding-agent CLI delegation is not allowed by this task contract"
    };
  }

  if (!input.allowed_actions.includes(input.capability)) {
    return { decision: "deny", reason: "Capability not allowed by task contract" };
  }

  if (input.approval_gates.includes(input.side_effect_level)) {
    // a trust ask beats standing: Paco approved these bytes on clean turns, not on one that read text aimed at the assistant
    const standing = input.standing !== undefined && input.trust_ask !== true ? { standing: input.standing } : {};
    return { decision: "requires_approval", reason: "Capability has gated side effects", ...standing };
  }

  if (input.trust_ask === true) {
    return { decision: "requires_approval", reason: TRUST_ASK_REASON };
  }

  return { decision: "allow", reason: "Capability allowed by task contract" };
}
