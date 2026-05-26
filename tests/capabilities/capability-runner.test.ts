import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { CapabilityRunner } from "../../src/capabilities/capability-runner.js";
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
  it("returns a structured denial for forbidden capabilities", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "codex_cli",
      category: "coding_agent_cli",
      side_effect_level: "local_write",
      risk_level: "high",
      timeout_ms: 1000,
      output_limit_bytes: 1000
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
  });
});
