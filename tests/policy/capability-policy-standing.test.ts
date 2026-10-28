import { describe, expect, it } from "vitest";
import { decideCapability, type CapabilityDecisionInput } from "../../src/policy/capability-policy.js";

// Stage 4A §7: standing may satisfy a GATE only. It never lifts a deny, never touches an allow, and a trust ask beats it:
// the row says Paco approved these bytes on a clean turn, not on one that read text aimed at the assistant.
const gated: CapabilityDecisionInput = { capability: "shell_external", category: "tool", side_effect_level: "external_write", risk_level: "medium",
  allowed_actions: ["shell_external", "lesson_write"], forbidden_actions: ["paid_action"], approval_gates: ["external_write", "destructive", "paid"] };
const SA = { standing_id: "sa_1" };

describe("decideCapability with standing", () => {
  it("a gated ask echoes the standing row for the runner to authorise — the decision itself stays requires_approval", () => {
    expect(decideCapability({ ...gated, standing: SA })).toEqual({ decision: "requires_approval", reason: "Capability has gated side effects", standing: SA });
  });
  it("a trust ask suppresses standing (hostile scheduled call asks as today)", () => {
    expect(decideCapability({ ...gated, standing: SA, trust_ask: true })).toEqual({ decision: "requires_approval", reason: "Capability has gated side effects" });
  });
  it("standing never lifts a deny and never changes an allow", () => {
    expect(decideCapability({ ...gated, capability: "paid_action", allowed_actions: ["paid_action"], standing: SA })).toEqual({ decision: "deny", reason: "Capability forbidden by task contract" });
    expect(decideCapability({ ...gated, capability: "not_allowed", standing: SA }).decision).toBe("deny");
    expect(decideCapability({ ...gated, capability: "lesson_write", side_effect_level: "none", standing: SA })).toEqual({ decision: "allow", reason: "Capability allowed by task contract" });
  });
  it("without standing the answer is byte-identical to today (no standing key at all)", () => {
    expect(decideCapability(gated)).toEqual({ decision: "requires_approval", reason: "Capability has gated side effects" });
  });
});
