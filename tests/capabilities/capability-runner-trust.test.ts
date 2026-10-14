import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { CapabilityRunner, type ApprovalRequestSink } from "../../src/capabilities/capability-runner.js";
import type { CompiledTaskContract } from "../../src/domain/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

// The runner must pass trust_ask to the policy, and the approved re-execution must consume the SAME fingerprint (trust_ask
// lives outside the adapter input, so the fingerprint is unchanged — spec §8.3 continuity, F11).
const contract = { allowed_actions: ["lesson_write"], forbidden_actions: [], approval_gates: ["external_write"], budget: { time_minutes: 10, max_tool_calls: 10, max_agent_delegations: 0 } } as unknown as CompiledTaskContract;
function rig() {
  const registry = new ToolRegistry(); let ran = 0;
  registry.register({ name: "lesson_write", category: "tool", side_effect_level: "none", risk_level: "low", timeout_ms: 1_000, output_limit_bytes: 1_000,
    execute: async () => { ran++; return { ok: true, output: { saved: true } }; } });
  const requested: Array<{ action_fingerprint: string }> = []; const consumed: string[] = [];
  const sink: ApprovalRequestSink = {
    requestApproval: (i) => { requested.push(i); return { approval_id: "appr_1" }; },
    consumeApprovedApproval: (i) => { consumed.push(i.action_fingerprint); return { ok: true, approval_id: i.approval_id, state: "consumed" }; }
  };
  return { runner: new CapabilityRunner(registry, sink), requested, consumed, ran: () => ran };
}

describe("CapabilityRunner trust_ask", () => {
  it("asks for an otherwise tap-free tool, then runs once on the approved id with the same fingerprint", async () => {
    const r = rig(); const budget = new BudgetLedger(contract.budget);
    const input = { contract, capability: "lesson_write", input: { scope: "ask" }, budget, trust_ask: true };
    const first = await r.runner.execute(input);
    expect(first).toEqual({ status: "requires_approval", approval_id: "appr_1" });
    expect(r.ran()).toBe(0);
    const second = await r.runner.execute({ ...input, approved_approval_id: "appr_1", budget_reserved: true });
    expect(second.status).toBe("succeeded");
    expect(r.consumed).toEqual([r.requested[0]!.action_fingerprint]);
    expect(r.ran()).toBe(1);
  });
  it("without trust_ask the tool runs at once (today)", async () => {
    const r = rig();
    expect((await r.runner.execute({ contract, capability: "lesson_write", input: { scope: "ask" }, budget: new BudgetLedger(contract.budget) })).status).toBe("succeeded");
  });
});
