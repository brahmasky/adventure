import { describe, expect, it, vi } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { CapabilityRunner } from "../../src/capabilities/capability-runner.js";
import { stableHash } from "../../src/domain/canonical.js";
import type { CompiledTaskContract } from "../../src/domain/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const contract: CompiledTaskContract = {
  objective: "read local file",
  budget: { time_minutes: 15, max_tool_calls: 2, max_agent_delegations: 0 },
  allowed_actions: ["local_file_read"],
  forbidden_actions: ["coding_agent_cli"],
  output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" },
  approval_gates: ["external_write"],
  stop_condition: "report written",
  contract_hash: "contract_hash",
  eval_hooks: []
};

describe("CapabilityRunner", () => {
  it("returns a structured denial for forbidden capabilities without calling the adapter", async () => {
    const registry = new ToolRegistry();
    const adapter = vi.fn(() => ({ ok: true as const, output: { ignored: true } }));
    registry.register({
      name: "codex_cli",
      category: "coding_agent_cli",
      side_effect_level: "local_write",
      risk_level: "high",
      timeout_ms: 1000,
      output_limit_bytes: 1000,
      execute: adapter
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract,
      capability: "codex_cli",
      input: {},
      budget: new BudgetLedger(contract.budget)
    });

    expect(result).toEqual({
      status: "denied",
      reason: "Coding-agent CLI delegation is reserved for V2 containment",
      recovery_hint: "Report the blocked action to the user"
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it("denies budget exhaustion without calling the adapter", async () => {
    const registry = new ToolRegistry();
    const adapter = vi.fn(() => ({ ok: true as const, output: { ignored: true } }));
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 1000,
      execute: adapter
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract,
      capability: "local_file_read",
      input: {},
      budget: new BudgetLedger({ ...contract.budget, max_tool_calls: 0 })
    });

    expect(result).toEqual({
      status: "denied",
      reason: "Tool-call budget exhausted",
      recovery_hint: "Write a partial report"
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it("denies approval-required capabilities when no approval sink is wired", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "external_publish",
      category: "tool",
      side_effect_level: "external_write",
      risk_level: "high",
      timeout_ms: 1000,
      output_limit_bytes: 1000,
      execute: () => ({ ok: true, output: { ignored: true } })
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract: { ...contract, allowed_actions: ["external_publish"] },
      capability: "external_publish",
      input: {},
      budget: new BudgetLedger(contract.budget)
    });

    expect(result).toEqual({
      status: "denied",
      reason: "Live approval channel is not available",
      recovery_hint: "Report the blocked action to the user"
    });
  });

  it("returns succeeded output and stable output hash after adapter execution", async () => {
    const output = { path: "notes/report.md", bytes: 42 };
    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 1000,
      execute: () => ({ ok: true, output })
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract,
      capability: "local_file_read",
      input: { path: "notes/report.md" },
      budget: new BudgetLedger(contract.budget)
    });

    expect(result).toEqual({
      status: "succeeded",
      output_ref: "inline:local_file_read",
      output_hash: stableHash(output),
      output
    });
  });

  it("allows llm_answer (external_read) without approval and returns succeeded", async () => {
    const output = { question: "hi", answer: "hello", model: "claude-haiku-4-5" };
    const registry = new ToolRegistry();
    const adapter = vi.fn(() => ({ ok: true as const, output }));
    registry.register({
      name: "llm_answer",
      category: "tool",
      side_effect_level: "external_read",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 100_000,
      execute: adapter
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract: { ...contract, allowed_actions: ["llm_answer"] },
      capability: "llm_answer",
      input: { question: "hi" },
      budget: new BudgetLedger(contract.budget)
    });

    expect(result).toEqual({
      status: "succeeded",
      output_ref: "inline:llm_answer",
      output_hash: stableHash(output),
      output
    });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("returns timed_out when adapter execution exceeds metadata timeout", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1,
      output_limit_bytes: 1000,
      execute: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, output: { late: true } }), 20);
        })
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract,
      capability: "local_file_read",
      input: {},
      budget: new BudgetLedger(contract.budget)
    });

    expect(result).toEqual({
      status: "timed_out",
      error_ref: "Tool execution timed out"
    });
  });

  it("returns failed when successful adapter output exceeds metadata limit", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 10,
      execute: () => ({ ok: true, output: { content: "this output is too large" } })
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract,
      capability: "local_file_read",
      input: {},
      budget: new BudgetLedger(contract.budget)
    });

    expect(result).toEqual({
      status: "failed",
      error_ref: "Tool output exceeded limit"
    });
  });

  it("returns a failed envelope when the adapter throws", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 1000,
      execute: () => {
        throw new Error("adapter exploded");
      }
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract,
      capability: "local_file_read",
      input: {},
      budget: new BudgetLedger(contract.budget)
    });

    expect(result).toEqual({ status: "failed", error_ref: "adapter exploded" });
  });

  it("returns a failed envelope when adapter output cannot be hashed", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 1000,
      execute: () => ({ ok: true, output: { unsupported: new Date("2026-05-26T00:00:00.000Z") } })
    });

    const runner = new CapabilityRunner(registry);
    const result = await runner.execute({
      contract,
      capability: "local_file_read",
      input: {},
      budget: new BudgetLedger(contract.budget)
    });

    expect(result).toEqual({ status: "failed", error_ref: "unsupported object instance in canonical JSON" });
  });
});
