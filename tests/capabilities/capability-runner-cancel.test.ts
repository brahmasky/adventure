import { afterEach, describe, expect, it, vi } from "vitest";
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
    const sink = { requestApproval: () => ({ approval_id: "a" }), consumeApprovedApproval: (i: { approval_id: string }) => ({ ok: true as const, approval_id: i.approval_id, state: "consumed" as const }) };
    await new CapabilityRunner(r, sink).execute({ contract, capability: "slow", input: {}, budget, budget_reserved: true, approved_approval_id: "a" });
    expect(budget.usage().tool_calls).toBe(0);
  });

  afterEach(() => { vi.useRealTimers(); });

  it("an adapter that throws leaves no live timers behind", async () => {
    vi.useFakeTimers();
    const r = new ToolRegistry();
    r.register({ name: "slow", category: "tool", side_effect_level: "none", risk_level: "low", timeout_ms: 3000, output_limit_bytes: 1000,
      execute: () => { throw new Error("boom"); } });
    const res = await new CapabilityRunner(r).execute({ contract, capability: "slow", input: {}, budget: new BudgetLedger(contract.budget) });
    expect(res.status).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an adapter that settles fast after a timeout leaves no cleanup timer", async () => {
    vi.useFakeTimers();
    const r = new ToolRegistry();
    r.register({ name: "slow", category: "tool", side_effect_level: "none", risk_level: "low", timeout_ms: 100, output_limit_bytes: 1000,
      execute: (_i, signal) => new Promise((resolve) => { signal?.addEventListener("abort", () => resolve({ ok: false, error: "x" })); }) });
    const p = new CapabilityRunner(r).execute({ contract, capability: "slow", input: {}, budget: new BudgetLedger(contract.budget) });
    await vi.advanceTimersByTimeAsync(100);
    expect((await p).status).toBe("timed_out");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the external abort listener on every exit path", async () => {
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    const r = new ToolRegistry();
    r.register({ name: "slow", category: "tool", side_effect_level: "none", risk_level: "low", timeout_ms: 100, output_limit_bytes: 1000, execute: () => ({ ok: true, output: {} }) });
    await new CapabilityRunner(r).execute({ contract, capability: "slow", input: {}, budget: new BudgetLedger(contract.budget), signal: ac.signal });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("an already-aborted signal cancels without ever starting the adapter", async () => {
    const ac = new AbortController(); ac.abort();
    let started = false;
    const r = new ToolRegistry();
    r.register({ name: "slow", category: "tool", side_effect_level: "none", risk_level: "low", timeout_ms: 100, output_limit_bytes: 1000, execute: () => { started = true; return { ok: true, output: {} }; } });
    const res = await new CapabilityRunner(r).execute({ contract, capability: "slow", input: {}, budget: new BudgetLedger(contract.budget), signal: ac.signal });
    expect(res.status).toBe("cancelled");
    expect(started).toBe(false);
  });

  it("budget_reserved without an approved approval still reserves", async () => {
    const r = new ToolRegistry();
    r.register({ name: "slow", category: "tool", side_effect_level: "none", risk_level: "low", timeout_ms: 100, output_limit_bytes: 1000, execute: () => ({ ok: true, output: {} }) });
    const budget = new BudgetLedger(contract.budget);
    await new CapabilityRunner(r).execute({ contract, capability: "slow", input: {}, budget, budget_reserved: true });
    expect(budget.usage().tool_calls).toBe(1);
  });

  it("action_summary overrides the default approval summary; default unchanged", async () => {
    const gated = { ...(contract as object), approval_gates: ["external_write"], allowed_actions: ["ext"] } as unknown as CompiledTaskContract;
    const r = new ToolRegistry();
    r.register({ name: "ext", category: "tool", side_effect_level: "external_write", risk_level: "medium", timeout_ms: 100, output_limit_bytes: 1000, execute: () => ({ ok: true, output: {} }) });
    const seen: string[] = [];
    const sink = { requestApproval: (i: { action_summary: string }) => { seen.push(i.action_summary); return { approval_id: "a" }; }, consumeApprovedApproval: () => ({ ok: false as const, error: { code: "x", message: "x" } }) };
    const run = (extra: object) => new CapabilityRunner(r, sink as never).execute({ contract: gated, capability: "ext", input: {}, budget: new BudgetLedger(contract.budget), run_id: "r", ...extra });
    await run({ action_summary: "label" });
    await run({});
    expect(seen).toEqual(["label", "Execute ext"]);
  });
});
