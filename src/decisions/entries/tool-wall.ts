import type { Entry, RungAnswer } from "../types.js";

export type ToolWallVerdict = "crosses" | "stays";

function rule(s: { crosses: boolean }): RungAnswer<ToolWallVerdict> {
  return s.crosses ? { verdict: "crosses" } : { verdict: "stays" };
}

export const TOOL_WALL: Entry<{ crosses: boolean }, ToolWallVerdict> = {
  id: "tool.wall", version: 1, stage: "post_tool", input: "tool", locked: true,
  question: "Does this tool cross the read wall?",
  verdicts: ["crosses", "stays"],
  ladder: [{ kind: "rule", name: "wall", decide: rule }],
  fail: "crosses", defaultVerdict: "stays", outcomes: [], armed: { rule: "on" },
  effects: { crosses: { kind: "tighten", reversible: true, announced: "none" }, stays: { kind: "none", reversible: true, announced: "none" } },
  reasonCodes: [],
};
