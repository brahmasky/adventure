import type { Entry, RungAnswer } from "../types.js";

export type ToolBudgetVerdict = "ok" | "exceeded";

function rule(s: { ok: boolean }): RungAnswer<ToolBudgetVerdict> {
  return s.ok ? { verdict: "ok" } : { verdict: "exceeded" };
}

export const TOOL_BUDGET: Entry<{ ok: boolean }, ToolBudgetVerdict> = {
  id: "tool.budget", version: 1, stage: "pre_tool", input: "tool",
  question: "Is the tool budget still healthy?",
  verdicts: ["ok", "exceeded"],
  ladder: [{ kind: "rule", name: "budget", decide: rule }],
  fail: "exceeded", defaultVerdict: "ok", outcomes: [], armed: { rule: "on" },
  effects: { ok: { kind: "none", reversible: true, announced: "none" }, exceeded: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [],
};
