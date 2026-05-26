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
});
