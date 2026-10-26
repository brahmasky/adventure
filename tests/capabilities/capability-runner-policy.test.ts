import { describe, expect, it, vi } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { CapabilityRunner } from "../../src/capabilities/capability-runner.js";
import type { CompiledTaskContract } from "../../src/domain/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const contract: CompiledTaskContract = {
  objective: "read local file",
  budget: { time_minutes: 15, max_tool_calls: 2, max_agent_delegations: 0 },
  allowed_actions: ["local_file_read"],
  forbidden_actions: [],
  output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" },
  approval_gates: [],
  stop_condition: "done",
  contract_hash: "h",
  eval_hooks: []
};

describe("CapabilityRunner policy recording", () => {
  it("records tool.policy via the decision recorder", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 1000,
      execute: () => ({ ok: true, output: { x: 1 } })
    });
    const record = vi.fn(() => "dec_test");
    const runner = new CapabilityRunner(registry);
    await runner.execute({
      contract,
      capability: "local_file_read",
      input: {},
      budget: new BudgetLedger(contract.budget),
      tool_call_id: "tc1",
      recorder: { record }
    });
    expect(record).toHaveBeenCalled();
    const first = (record.mock.calls[0] as unknown as [any])[0] as { id: string };
    expect(first.id).toBe("tool.policy");
  });
});