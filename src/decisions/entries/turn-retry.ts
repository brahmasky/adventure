import type { LlmErrorKind } from "../../llm/audit.js";
import { mayRetryOf } from "../../omp/omp-frames.js";
import type { Entry, RungAnswer } from "../types.js";

/** Retry reasons first (the five retryable kinds, then `other_once`), then the final ones (spec 2026-11-01 R4 §4.2). */
export const RETRY_REASONS = ["quota", "auth", "transport", "timeout", "model_missing", "other_once", "other_unrouted", "other_retried", "other_after_tool", "model_refusal", "aborted", "spawn"] as const;
export type RetryReason = (typeof RETRY_REASONS)[number];
export type RetryVerdict = "retry" | "final";
/** Captured in mayRetry from the values it reads (retriedOther is set after the decision, so this is the pre-decision value). */
export interface RetryInput { kind: LlmErrorKind; routed: boolean; usedTool: boolean; retriedOther: boolean }

function reasonOf(s: RetryInput): string {
  if (s.kind !== "other") return s.kind; // a kind outside RETRY_REASONS (unreachable from classifyOmpError) is nulled by rowOf
  if (!s.routed) return "other_unrouted";
  if (s.retriedOther) return "other_retried";
  if (s.usedTool) return "other_after_tool";
  return "other_once";
}

function rule(s: RetryInput): RungAnswer<RetryVerdict> {
  return { verdict: mayRetryOf(s) ? "retry" : "final", reason: reasonOf(s) };
}

export const TURN_RETRY: Entry<RetryInput, RetryVerdict> = {
  id: "turn.retry", version: 1, stage: "supervision", input: "tool",
  question: "A model error ended the turn's current leg: move to the next model, or fail the turn?",
  verdicts: ["retry", "final"],
  ladder: [{ kind: "rule", name: "may_retry", decide: rule }],
  fail: "final", defaultVerdict: "final", outcomes: [], armed: { rule: "on" }, alwaysRecord: true,
  effects: {
    retry: { kind: "effect", reversible: false, announced: "none", what: "another model continues the turn with RETRY_NOTE; a step-up is ledgered" },
    final: { kind: "tighten", reversible: true, announced: "none", what: "the turn fails with today's error text" }
  },
  reasonCodes: [...RETRY_REASONS],
};
