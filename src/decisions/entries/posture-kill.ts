import type { Entry, RungAnswer } from "../types.js";

export type PostureKillVerdict = "armed" | "killed";

function rule(s: { armed: boolean }): RungAnswer<PostureKillVerdict> {
  return s.armed ? { verdict: "armed" } : { verdict: "killed" };
}

export const POSTURE_KILL: Entry<{ armed: boolean }, PostureKillVerdict> = {
  id: "posture.kill", version: 1, stage: "pre_tool", input: "tool", locked: true,
  question: "Is the posture kill switch armed?",
  verdicts: ["armed", "killed"],
  ladder: [{ kind: "rule", name: "posture", decide: rule }],
  // kill switch: killed is the fail state; lock holds until rearmed by Paco
  fail: "killed", defaultVerdict: "armed", outcomes: [], armed: { rule: "on" },
  effects: { armed: { kind: "none", reversible: true, announced: "none" }, killed: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [],
};
