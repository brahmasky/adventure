import type { Entry, RungAnswer } from "../types.js";

export const RECALL_REASONS = ["embedded", "fts_only", "embed_failed", "dropped_after_gate", "below_gate", "unscored"] as const;
export type RecallVerdict = "include" | "none";
/** Captured in buildTurnPrompt from the returned TurnRetrieval (spec R5 §4.1): counts and the two sides' best scores, never ids or text. */
export interface RecallInput { embedding: boolean; facts: number; pages: number; best_admitted: number | null; best_rejected: number | null }

function rule(s: RecallInput): RungAnswer<RecallVerdict> {
  if (s.facts + s.pages > 0) return { verdict: "include", reason: s.embedding ? "embedded" : "fts_only" };
  if (!s.embedding) return { verdict: "none", reason: "embed_failed" };
  if (s.best_admitted !== null) return { verdict: "none", reason: "dropped_after_gate" };
  if (s.best_rejected !== null) return { verdict: "none", reason: "below_gate" };
  return { verdict: "none", reason: "unscored" };
}

export const CONTEXT_RECALL: Entry<RecallInput, RecallVerdict> = {
  id: "context.recall", version: 1, stage: "pre_model", input: "mixed",
  question: "Which retrieved episodic facts and wiki pages enter the turn's [context] block?",
  verdicts: ["include", "none"],
  ladder: [{ kind: "rule", name: "relevance_gate", decide: rule }],
  fail: "none", defaultVerdict: "none", outcomes: [], armed: { rule: "on" }, alwaysRecord: true,
  effects: {
    include: { kind: "effect", reversible: true, announced: "none", what: "the admitted facts and pages are in the planner prompt's [context] block; the next turn retrieves afresh" },
    none: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: [...RECALL_REASONS],
};
