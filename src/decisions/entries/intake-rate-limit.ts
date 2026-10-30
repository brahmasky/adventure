import type { Entry, RungAnswer } from "../types.js";

export type IntakeRateLimitVerdict = "allow" | "limit";
/** RunStore.checkTelegramRateLimit's reasons verbatim, in its check order (spec 2026-10-30 R1 §3.1). */
export const INTAKE_RATE_LIMIT_REASONS = ["command_window", "active_runs", "pending_approvals"] as const;
export type IntakeRateLimitReason = (typeof INTAKE_RATE_LIMIT_REASONS)[number];
/** The exempt commands never reach this entry (Decision 3-A): RATE_LIMIT_EXEMPT is checked in Gateway.intake first. */
export interface IntakeRateLimitInput { limited: IntakeRateLimitReason | null }

function rule(s: IntakeRateLimitInput): RungAnswer<IntakeRateLimitVerdict> {
  return s.limited === null ? { verdict: "allow" } : { verdict: "limit", reason: s.limited };
}

export const INTAKE_RATE_LIMIT: Entry<IntakeRateLimitInput, IntakeRateLimitVerdict> = {
  id: "intake.rate_limit", version: 1, stage: "intake", input: "tool",
  question: "Does this Telegram command pass the per-chat rate limit?",
  verdicts: ["allow", "limit"],
  ladder: [{ kind: "rule", name: "checkTelegramRateLimit", decide: rule }],
  fail: "limit", defaultVerdict: "allow", outcomes: [], armed: { rule: "on" },
  effects: { allow: { kind: "none", reversible: true, announced: "none" }, limit: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [...INTAKE_RATE_LIMIT_REASONS],
};
