import type { Entry, RungAnswer } from "../types.js";
import { gateTargets } from "../../omp/gate-path.js";
export type PathVerdict = "allowed" | "blocked";
function rule(s: { raw: string; home: string; cwd: string }): RungAnswer<PathVerdict> {
  const r = gateTargets(s.raw, s.home, s.cwd);
  if (r.ok) return { verdict: "allowed" };
  return { verdict: "blocked", reason: r.reason };
}
export const TOOL_PATH: Entry<{ raw: string; home: string; cwd: string }, PathVerdict> = {
  id: "tool.path", version: 1, stage: "pre_tool", input: "tool", locked: true,
  question: "Is this path permitted by the gate?",
  verdicts: ["allowed", "blocked"],
  ladder: [{ kind: "rule", name: "gateTargets", decide: rule }],
  fail: "blocked", defaultVerdict: "allowed", outcomes: [], armed: { rule: "on" },
  effects: { allowed: { kind: "none", reversible: true, announced: "none" }, blocked: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["missing_path", "bad_path", "url_read"],
};
