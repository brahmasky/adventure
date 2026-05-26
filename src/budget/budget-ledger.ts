import type { BudgetSpec } from "../domain/types.js";

export type BudgetZone = "green" | "yellow" | "red" | "fuse";

export type BudgetReservation =
  | { ok: true; zone: BudgetZone }
  | { ok: false; reason: string; zone: BudgetZone };

export interface BudgetUsage {
  tool_calls: number;
  max_tool_calls: number;
  zone: BudgetZone;
}

export class BudgetLedger {
  private toolCalls = 0;

  constructor(private readonly budget: BudgetSpec) {}

  reserveToolCall(): BudgetReservation {
    if (this.toolCalls >= this.budget.max_tool_calls) {
      return { ok: false, reason: "Tool-call budget exhausted", zone: "fuse" };
    }

    this.toolCalls += 1;
    return { ok: true, zone: this.zone() };
  }

  usage(): BudgetUsage {
    return {
      tool_calls: this.toolCalls,
      max_tool_calls: this.budget.max_tool_calls,
      zone: this.zone()
    };
  }

  private zone(): BudgetZone {
    const remaining = this.budget.max_tool_calls - this.toolCalls;
    const ratio = remaining / Math.max(this.budget.max_tool_calls, 1);

    if (ratio < 0.05) return "fuse";
    if (ratio < 0.2) return "red";
    if (ratio < 0.5) return "yellow";
    return "green";
  }
}
