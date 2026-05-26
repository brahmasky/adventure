import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";

describe("BudgetLedger", () => {
  it("denies reservations that exceed the tool-call cap", () => {
    const budget = new BudgetLedger({ max_tool_calls: 1, max_agent_delegations: 0, time_minutes: 15 });

    expect(budget.reserveToolCall()).toEqual({ ok: true, zone: "green" });
    expect(budget.reserveToolCall()).toEqual({
      ok: false,
      reason: "Tool-call budget exhausted",
      zone: "fuse"
    });
  });
});
