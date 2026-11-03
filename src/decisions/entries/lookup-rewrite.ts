import type { Entry, RungAnswer } from "../types.js";

/** Where lookupQuery decided (spec R6 §4.1): code before the call, the call's outage, the model's answer, code over it. */
export const REWRITE_STEPS = ["rewritten", "no_recent_line", "long_message", "no_time", "late", "failed", "same", "invalid"] as const;
export type RewriteStep = (typeof REWRITE_STEPS)[number];
export type RewriteVerdict = "rewrite" | "bare";
export interface RewriteInput { step: RewriteStep }

function rule(s: RewriteInput): RungAnswer<RewriteVerdict> {
  return s.step === "rewritten" ? { verdict: "rewrite", reason: "rewritten" } : { verdict: "bare", reason: s.step };
}

export const LOOKUP_REWRITE: Entry<RewriteInput, RewriteVerdict> = {
  id: "lookup.rewrite", version: 1, stage: "pre_model", input: "mixed",
  question: "Does the lookup lane search a rewritten query or Paco's bare message?",
  verdicts: ["rewrite", "bare"],
  ladder: [{ kind: "rule", name: "rewrite_step", decide: rule }],
  fail: "bare", defaultVerdict: "bare", outcomes: [], armed: { rule: "on" }, alwaysRecord: true,
  effects: {
    rewrite: { kind: "effect", reversible: true, announced: "none", what: "the validated rewrite is the query selected for the search and the reader's objective" },
    bare: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: [...REWRITE_STEPS],
};
