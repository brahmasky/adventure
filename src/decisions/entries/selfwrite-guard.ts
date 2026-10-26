import type { Entry, RungAnswer } from "../types.js";

export type SelfWriteVerdict = "allowed" | "blocked";

function rule(s: { allowed: boolean }): RungAnswer<SelfWriteVerdict> {
  return s.allowed ? { verdict: "allowed" } : { verdict: "blocked" };
}

export const SELF_WRITE_GUARD: Entry<{ allowed: boolean }, SelfWriteVerdict> = {
  id: "selfwrite.guard", version: 1, stage: "pre_tool", input: "tool", locked: true,
  question: "May this self-write land?",
  verdicts: ["allowed", "blocked"],
  ladder: [{ kind: "rule", name: "guard", decide: rule }],
  fail: "blocked", defaultVerdict: "allowed", outcomes: [], armed: { rule: "on" },
  effects: { allowed: { kind: "none", reversible: true, announced: "none" }, blocked: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [],
};
