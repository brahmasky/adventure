import type { Entry, RungAnswer } from "../types.js";
export type PathVerdict = "allowed" | "blocked";
function rule(s: { allowed: boolean; reason?: string }): RungAnswer<PathVerdict> {
  if (s.allowed) return { verdict: "allowed" };
  return s.reason === undefined ? { verdict: "blocked" } : { verdict: "blocked", reason: s.reason };
}
export const TOOL_PATH: Entry<{ allowed: boolean; reason?: string }, PathVerdict> = {
  id: "tool.path", version: 2, stage: "pre_tool", input: "tool", locked: true,
  question: "Is this path permitted by the gate?",
  verdicts: ["allowed", "blocked"],
  ladder: [{ kind: "rule", name: "gateTargets", decide: rule }],
  fail: "blocked", defaultVerdict: "allowed", outcomes: [], armed: { rule: "on" },
  effects: { allowed: { kind: "none", reversible: true, announced: "none" }, blocked: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["missing_path", "bad_path", "url_read", "protected_path"],
};
