import type { Entry, RungAnswer } from "../types.js";

/** The catch-up block shows at most this many of the newest lane turns (moved here from turn-context.ts, which re-exports it). */
export const CATCH_UP_MAX_ENTRIES = 6;
export const CATCH_UP_REASONS = ["all", "entry_capped", "trimmed", "all_trimmed", "read_failed"] as const;
export type CatchUpVerdict = "inject" | "none";
/** Captured in buildTurnPrompt from the one laneTurnsSince read and renderCatchUp's result (spec R5 §4.2). */
export interface CatchUpInput { read_failed: boolean; available: number; shown: number }

function rule(s: CatchUpInput): RungAnswer<CatchUpVerdict> {
  if (s.read_failed) return { verdict: "none", reason: "read_failed" };
  if (s.shown === 0) return { verdict: "none", reason: "all_trimmed" };
  if (s.shown === s.available) return { verdict: "inject", reason: "all" };
  return { verdict: "inject", reason: s.shown === CATCH_UP_MAX_ENTRIES ? "entry_capped" : "trimmed" };
}

export const CONTEXT_CATCH_UP: Entry<CatchUpInput, CatchUpVerdict> = {
  id: "context.catch_up", version: 1, stage: "pre_model", input: "mixed",
  question: "Does the planner prompt carry the quick replies Paco got from the lanes since the planner last answered, and how many fit?",
  verdicts: ["inject", "none"],
  ladder: [{ kind: "rule", name: "catch_up_fit", decide: rule }],
  fail: "none", defaultVerdict: "none", outcomes: [], armed: { rule: "on" }, alwaysRecord: true,
  effects: {
    inject: { kind: "effect", reversible: true, announced: "none", what: "the fenced quick-replies block is in the planner prompt" },
    none: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: [...CATCH_UP_REASONS],
};
