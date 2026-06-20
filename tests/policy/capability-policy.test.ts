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

  it("denies coding-agent CLI delegation when the contract does not allow it (ADR 0011)", () => {
    // A normal contract keeps coding_agent_cli out of allowed_actions → denied.
    expect(
      decideCapability({
        capability: "coding_agent_cli",
        category: "coding_agent_cli",
        side_effect_level: "external_read",
        risk_level: "medium",
        allowed_actions: ["llm_answer"],
        forbidden_actions: [],
        approval_gates: ["external_write", "destructive", "paid"]
      })
    ).toEqual({
      decision: "deny",
      reason: "Coding-agent CLI delegation is not allowed by this task contract"
    });
  });

  it("denies coding-agent CLI delegation when the contract forbids it (normal turn)", () => {
    expect(
      decideCapability({
        capability: "coding_agent_cli",
        category: "coding_agent_cli",
        side_effect_level: "external_read",
        risk_level: "medium",
        allowed_actions: ["llm_answer"],
        forbidden_actions: ["coding_agent_cli"],
        approval_gates: ["external_write", "destructive", "paid"]
      })
    ).toEqual({ decision: "deny", reason: "Capability forbidden by task contract" });
  });

  it("allows coding-agent CLI delegation in the self-diagnose contract (ADR 0011, Phase 1)", () => {
    // The self-diagnose route lists coding_agent_cli; external_read is not gated → allow.
    expect(
      decideCapability({
        capability: "coding_agent_cli",
        category: "coding_agent_cli",
        side_effect_level: "external_read",
        risk_level: "medium",
        allowed_actions: ["coding_agent_cli", "llm_answer", "write_report"],
        forbidden_actions: ["generic_shell", "external_write", "paid_action"],
        approval_gates: ["local_write", "external_write", "destructive", "paid"]
      })
    ).toEqual({ decision: "allow", reason: "Capability allowed by task contract" });
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
