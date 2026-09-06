import type { LlmUsage } from "../run/llm-usage.js";

/**
 * The audit chokepoint contract (spec 2026-09-04 §"Slice 2"; review 2026-09-06 B1).
 *
 * Every LLM leg attempt in Houge — `answerWithChain` legs and the spawn seats outside the chain —
 * is reported through ONE of these. It is a REQUIRED constructor parameter wherever an adapter or
 * seat is built: the opt-in `onUsage` hook it replaces is what produced defect D4 (whole call
 * paths recording nothing because nobody passed the hook). A required parameter cannot be
 * forgotten; the compiler enforces coverage.
 *
 * NON-NEGOTIABLE: an attempt carries counts and metadata ONLY — never prompt or response bodies.
 */

export type LlmAttemptOutcome = "ok" | "error" | "unavailable";

/**
 * Bounded classifier for a failed attempt. Never raw provider text — the ledger must not carry
 * bytes that could be untrusted. Derived from OUR OWN provider error strings, which are fixed.
 */
export type LlmErrorKind = "auth" | "model_missing" | "timeout" | "spawn" | "transport" | "parse" | "other";

/**
 * `unavailable` (review S1, codex #11) means the provider was NOT constructively callable: binary
 * absent, not authenticated, model retired, API key unset. Timeout, non-zero exit, over-cap and
 * parse failures are `error` — the provider was reachable and the request itself failed. Both
 * fall through the chain identically; the distinction is diagnostic, and it feeds the sweep.
 */
export interface LlmAttempt {
  provider: string;
  /** The call's purpose (`LlmCallRole`). The chain passes ""; the scoped sink fills it. */
  role: string;
  outcome: LlmAttemptOutcome;
  /** Required by convention when `outcome === "ok"` (review S2); the store sink warns if absent. */
  model?: string;
  latency_ms?: number;
  /** Present only on `ok`. `thinking_tokens` is informational — ALREADY inside `output_tokens`. */
  usage?: LlmUsage;
  error_kind?: LlmErrorKind;
  /** One id per chain invocation (review W3) so "agy failed, pi served" is reconstructable. */
  attempt_group?: string;
  /** 0-based position of this leg within the invocation. */
  leg_index?: number;
}

export interface LlmAuditSink {
  /** Best-effort by contract: implementations swallow their own failures and log a warning. */
  record(attempt: LlmAttempt): void;
}

/**
 * Map one of our provider error strings to a bounded kind. Classify at the LEG boundary, never
 * on the chain's joined aggregate (codex #10) — the aggregate destroys provider-specific cause.
 * Order matters: the earlier match wins.
 */
export function classifyLlmError(message: string): LlmErrorKind {
  const m = message.toLowerCase();
  if (m.includes("enoent") || m.includes("spawn error") || m.includes("spawn failed")) return "spawn";
  if (m.includes("timed out") || m.includes("timeout")) return "timeout";
  if (m.includes("invalid model selection")) return "model_missing";
  if (
    m.includes("not authenticated") ||
    m.includes("not logged in") ||
    m.includes("log in") ||
    m.includes("api key") ||
    m.includes("unauthenticated") ||
    m.includes("sign in")
  ) {
    return "auth";
  }
  if (
    m.includes("no json envelope") ||
    m.includes("produced no answer") ||
    m.includes("exceeded") ||
    m.includes("missing message content")
  ) {
    return "parse";
  }
  if (m.includes("http ") || m.includes("fetch failed") || m.includes("request failed") || m.includes("network")) {
    return "transport";
  }
  return "other";
}
