import type { Entry, RungAnswer } from "../types.js";

export type ReaderFamilyVerdict = "primary" | "fallback";

function rule(s: { primary: boolean }): RungAnswer<ReaderFamilyVerdict> {
  return s.primary ? { verdict: "primary" } : { verdict: "fallback" };
}

export const READER_FAMILY: Entry<{ primary: boolean }, ReaderFamilyVerdict> = {
  id: "reader.family", version: 1, stage: "post_tool", input: "tool",
  question: "Is the primary reader suitable, or should the fallback be used?",
  verdicts: ["primary", "fallback"],
  ladder: [{ kind: "rule", name: "family", decide: rule }],
  fail: "fallback", defaultVerdict: "primary", outcomes: [], armed: { rule: "on" },
  effects: { primary: { kind: "none", reversible: true, announced: "none" }, fallback: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [],
};
