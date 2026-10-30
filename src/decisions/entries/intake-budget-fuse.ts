import type { GlobalBudgetKind } from "../../budget/global-budget-ledger.js";
import type { Entry, RungAnswer } from "../types.js";

export type BudgetFuseVerdict = "admit" | "refuse";
/** computeBreaches' kinds, in GLOBAL_BUDGET_KINDS order; empty = under every cap. */
export interface BudgetFuseInput { breached: readonly GlobalBudgetKind[] }

function rule(s: BudgetFuseInput): RungAnswer<BudgetFuseVerdict> {
  const first = s.breached[0];
  return first === undefined ? { verdict: "admit" } : { verdict: "refuse", reason: first };
}

export const INTAKE_BUDGET_FUSE: Entry<BudgetFuseInput, BudgetFuseVerdict> = {
  id: "intake.budget_fuse", version: 1, stage: "intake", input: "tool", locked: true,
  question: "Is every rolling-24h global cap under its limit, so a new run may be admitted (ADR 0003)?",
  verdicts: ["admit", "refuse"],
  ladder: [{ kind: "rule", name: "checkGlobalBudget", decide: rule }],
  fail: "refuse", defaultVerdict: "admit", outcomes: [], armed: { rule: "on" },
  effects: { admit: { kind: "none", reversible: true, announced: "none" }, refuse: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["runs", "tool_calls", "gated_attempts"],
};
