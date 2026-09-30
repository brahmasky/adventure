import { describe, expect, it } from "vitest";
import { CapabilityRunner } from "../../src/capabilities/capability-runner.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { CompiledTaskContract } from "../../src/domain/types.js";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";

const contract = { objective: "t", budget: { time_minutes: 1, max_tool_calls: 5, max_agent_delegations: 0 }, allowed_actions: ["slow"],
  forbidden_actions: [], approval_gates: [], output: { path: "x", format: "sourced_markdown_report" }, stop_condition: "", eval_hooks: [] } as unknown as CompiledTaskContract;

function slowRegistry(onAbort: () => void, settleMs: number) {
  const r = new ToolRegistry();
  r.register({ name: "slow", category: "tool", side_effect_level: "none", risk_level: "low", timeout_ms: 100, output_limit_bytes: 1000,
    execute: (_i, signal) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => { onAbort(); setTimeout(() => resolve({ ok: false, error: "aborted" }), settleMs); });
    }) });
  return r;
}

describe("runner cancellation — no adapter may outlive the runner (spec §5.6 R7)", () => {
  it("aborts the adapter on its own timeout and waits for it to settle before returning", async () => {
    let aborted = false; let settledBeforeReturn = false;
    const r = slowRegistry(() => { aborted = true; setTimeout(() => { settledBeforeReturn = true; }, 50); }, 50);
    const res = await new CapabilityRunner(r).execute({ contract, capability: "slow", input: {}, budget: new BudgetLedger(contract.budget) });
    expect(res.status).toBe("timed_out");
    expect(aborted).toBe(true);
    expect(settledBeforeReturn).toBe(true);
  });

  it("an external abort cancels the adapter and returns cancelled", async () => {
    const ac = new AbortController();
    const r = slowRegistry(() => {}, 10);
    const p = new CapabilityRunner(r).execute({ contract, capability: "slow", input: {}, budget: new BudgetLedger(contract.budget), signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    expect((await p).status).toBe("cancelled");
  });

  it("budget_reserved skips a second reservation — the approval re-entry must not double-charge", async () => {
    const r = new ToolRegistry();
    r.register({ name: "slow", category: "tool", side_effect_level: "none", risk_level: "low", timeout_ms: 100, output_limit_bytes: 1000, execute: () => ({ ok: true, output: {} }) });
    const budget = new BudgetLedger(contract.budget);
    await new CapabilityRunner(r).execute({ contract, capability: "slow", input: {}, budget, budget_reserved: true });
    expect(budget.usage().tool_calls).toBe(0);
  });
});
