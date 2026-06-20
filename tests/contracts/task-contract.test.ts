import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { compileTaskContract } from "../../src/contracts/task-contract.js";

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
