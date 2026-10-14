import { describe, expect, it } from "vitest";
import { decideCapability, TRUST_ASK_REASON, type CapabilityDecisionInput } from "../../src/policy/capability-policy.js";

// ADR 0029 decision 2 / spec §7.2: a raised trust level only ADDS a tap. It must never turn a deny into an ask, never lift a
// code ask, and never deny on its own: the gate stays code's.
const base: CapabilityDecisionInput = { capability: "lesson_write", category: "tool", side_effect_level: "none", risk_level: "low",
  allowed_actions: ["lesson_write", "shell_external"], forbidden_actions: ["paid_action"], approval_gates: ["external_write", "destructive", "paid"] };

describe("decideCapability with trust_ask", () => {
  it("allow + trust_ask → requires_approval, with the trust reason", () => {
    expect(decideCapability({ ...base, trust_ask: true })).toEqual({ decision: "requires_approval", reason: TRUST_ASK_REASON });
  });
  it("no trust_ask (or false) keeps today's answer exactly", () => {
    expect(decideCapability(base).decision).toBe("allow");
    expect(decideCapability({ ...base, trust_ask: false }).decision).toBe("allow");
  });
  it("a deny stays a deny", () => {
    expect(decideCapability({ ...base, capability: "paid_action", allowed_actions: ["paid_action"], trust_ask: true }).decision).toBe("deny");
    expect(decideCapability({ ...base, capability: "not_allowed", trust_ask: true }).decision).toBe("deny");
  });
  it("a code ask keeps its own reason (the code ask's full pause wins, spec §7.2)", () => {
    expect(decideCapability({ ...base, capability: "shell_external", side_effect_level: "external_write", trust_ask: true }))
      .toEqual({ decision: "requires_approval", reason: "Capability has gated side effects" });
  });
});

// Monotonicity table: ask := code_ask OR trust_ask. Code's own decision is reached by varying the input; trust only adds.
describe("trust_ask monotonicity", () => {
  const codeCases: Array<[string, CapabilityDecisionInput, "allow" | "requires_approval" | "deny"]> = [
    ["allow", base, "allow"],
    ["ask", { ...base, capability: "shell_external", side_effect_level: "external_write" }, "requires_approval"],
    ["deny (forbidden)", { ...base, capability: "paid_action", allowed_actions: ["paid_action"] }, "deny"],
    ["deny (not allowed)", { ...base, capability: "not_allowed" }, "deny"]
  ];
  for (const [name, input, codeDecision] of codeCases) {
    for (const trustAsk of [false, true]) {
      it(`code ${name} x trust_ask=${trustAsk}`, () => {
        expect(decideCapability(input).decision).toBe(codeDecision);
        const out = decideCapability({ ...input, trust_ask: trustAsk }).decision;
        if (codeDecision === "deny") expect(out).toBe("deny");
        else expect(out === "requires_approval").toBe(codeDecision === "requires_approval" || trustAsk);
      });
    }
  }
});
