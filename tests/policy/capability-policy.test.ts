import { describe, expect, it } from "vitest";
import { decideCapability } from "../../src/policy/capability-policy.js";

describe("decideCapability", () => {
  it("allows read-only capabilities listed in the contract", () => {
    expect(
      decideCapability({
        capability: "local_file_read",
        category: "tool",
        side_effect_level: "none",
        risk_level: "low",
        allowed_actions: ["local_file_read"],
        forbidden_actions: [],
        approval_gates: ["external_write", "destructive", "paid"]
      })
    ).toEqual({ decision: "allow", reason: "Capability allowed by task contract" });
  });

  it("denies coding-agent CLI delegation in V1", () => {
    expect(
      decideCapability({
        capability: "codex_cli",
        category: "coding_agent_cli",
        side_effect_level: "local_write",
        risk_level: "high",
        allowed_actions: ["codex_cli"],
        forbidden_actions: [],
        approval_gates: ["external_write", "destructive", "paid"]
      })
    ).toEqual({ decision: "deny", reason: "Coding-agent CLI delegation is reserved for V2 containment" });
  });

  it("requires approval for external writes", () => {
    expect(
      decideCapability({
        capability: "gmail_send",
        category: "tool",
        side_effect_level: "external_write",
        risk_level: "high",
        allowed_actions: ["gmail_send"],
        forbidden_actions: [],
        approval_gates: ["external_write", "destructive", "paid"]
      })
    ).toEqual({ decision: "requires_approval", reason: "Capability has gated side effects" });
  });

  it("requires approval when side effect level matches a contract approval gate", () => {
    expect(
      decideCapability({
        capability: "local_project_write",
        category: "tool",
        side_effect_level: "local_write",
        risk_level: "medium",
        allowed_actions: ["local_project_write"],
        forbidden_actions: [],
        approval_gates: ["local_write"]
      })
    ).toEqual({ decision: "requires_approval", reason: "Capability has gated side effects" });
  });
});
