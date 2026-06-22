import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { compileSelfDiagnoseContract, compileSkillAuthorContract, compileTaskContract } from "../../src/contracts/task-contract.js";

const runEvent = buildTypedTaskEvent({
  source: "cli",
  type: "run",
  program: "research-brief",
  goal: "compare Pi, OpenClaw, and Hermes",
  requested_by: { kind: "user", id: "paco" },
  notify: { kind: "local" },
  idempotency_key: "cli:research-brief",
  source_reference: "argv"
});

describe("compileTaskContract", () => {
  it("compiles research-brief into a bounded contract", () => {
    const result = compileTaskContract(runEvent);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.allowed_actions).toContain("local_file_read");
      expect(result.contract.forbidden_actions).toContain("coding_agent_cli");
      expect(result.contract.contract_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects unknown programs", () => {
    const badEvent = { ...runEvent, program: "unknown-program" };
    const result = compileTaskContract(badEvent);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "TASK_CONTRACT_INVALID",
        message: "Unknown program: unknown-program"
      }
    });
  });

  it("compiles a turn into the intent-router front-door contract (ADR 0010)", () => {
    const turnEvent = buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "what's new with SpaceX?",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:turn-contract",
      source_reference: "telegram:update:1:message:1"
    });

    const result = compileTaskContract(turnEvent);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.objective).toBe("what's new with SpaceX?");
      expect(result.contract.allowed_actions).toEqual([
        "intent_router",
        "web_search",
        "llm_answer",
        "write_report"
      ]);
      expect(result.contract.budget.max_tool_calls).toBe(6);
      expect(result.contract.forbidden_actions).toContain("external_write");
      expect(result.contract.approval_gates).toContain("external_write");
      expect(result.contract.contract_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects a turn with an empty message", () => {
    const empty = buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "   ",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:turn-empty",
      source_reference: "telegram:update:2:message:2"
    });
    expect(compileTaskContract(empty)).toEqual({
      ok: false,
      error: { code: "TASK_CONTRACT_INVALID", message: "Message is required" }
    });
  });

  it("the self-diagnose contract allows coding_agent_cli; the turn contract forbids it (ADR 0011)", () => {
    const self = compileSelfDiagnoseContract("why did you ask which 猴哥?");
    expect(self.allowed_actions).toContain("coding_agent_cli");
    expect(self.allowed_actions).toEqual(["coding_agent_cli", "llm_answer", "write_report"]);
    // Writes/destructive/paid stay forbidden; no new approval gate (external_read consult).
    expect(self.forbidden_actions).toContain("external_write");
    expect(self.forbidden_actions).toContain("destructive");
    expect(self.forbidden_actions).not.toContain("coding_agent_cli");
    expect(self.budget.max_tool_calls).toBe(3);
    expect(self.contract_hash).toMatch(/^[a-f0-9]{64}$/);

    // The normal turn contract keeps coding_agent_cli forbidden — unreachable from a turn.
    const turnEvent = buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "anything",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:turn-forbids-codex",
      source_reference: "telegram:update:9:message:9"
    });
    const turn = compileTaskContract(turnEvent);
    expect(turn.ok).toBe(true);
    if (turn.ok) {
      expect(turn.contract.allowed_actions).not.toContain("coding_agent_cli");
      expect(turn.contract.forbidden_actions).toContain("coding_agent_cli");
    }
  });

  it("the skill-author contract forbids coding_agent_cli — skills are prose (ADR 0011 Phase 2b)", () => {
    const skill = compileSkillAuthorContract("write a skill for cross-checking figures");
    expect(skill.allowed_actions).toEqual(["llm_answer", "write_report"]);
    expect(skill.allowed_actions).not.toContain("coding_agent_cli");
    expect(skill.forbidden_actions).toContain("coding_agent_cli");
    expect(skill.forbidden_actions).toContain("external_write");
    expect(skill.forbidden_actions).toContain("destructive");
    expect(skill.budget.max_tool_calls).toBe(3);
    expect(skill.contract_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("compiles /ask into the built-in ask program contract", () => {
    const askEvent = buildTypedTaskEvent({
      source: "telegram",
      type: "ask",
      program: "ask",
      goal: "what should Houge do next?",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:ask-contract",
      source_reference: "telegram:update:1:message:1"
    });

    const result = compileTaskContract(askEvent);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.objective).toBe("what should Houge do next?");
      expect(result.contract.allowed_actions).toEqual(["llm_answer", "write_report"]);
      expect(result.contract.eval_hooks).toContain("milestone-2-ask-path");
    }
  });
});
