import type { Entry, RungAnswer } from "../types.js";

/** authorizeTelegramUpdate's denials in check order, plus normalizeTelegramUpdate's channel-post pre-check (spec 2026-11-01 R2 §3.1). */
export const SENDER_DENIAL_REASONS = ["channel_post", "forwarded", "anonymous", "no_chat", "user_not_allowlisted", "chat_not_allowlisted", "identity_not_for_chat"] as const;
export type SenderDenialReason = (typeof SENDER_DENIAL_REASONS)[number];
export type SenderVerdict = "allow" | "deny";
/** Consulted only after a denial (pollOnce), so `null` is a bug: the rule throws and the row is `deny` at rung `fail` (§4.1). */
export interface SenderInput { denied: SenderDenialReason | null }

function rule(s: SenderInput): RungAnswer<SenderVerdict> {
  if (s.denied === null) throw new Error("intake.sender consulted for a denial with no reason");
  return { verdict: "deny", reason: s.denied };
}

export const INTAKE_SENDER: Entry<SenderInput, SenderVerdict> = {
  id: "intake.sender", version: 1, stage: "intake", input: "tool", locked: true,
  question: "Is this Telegram update from an allowlisted sender in an allowlisted chat, not forwarded and not a channel post?",
  verdicts: ["allow", "deny"],
  ladder: [{ kind: "rule", name: "authorizeTelegramUpdate", decide: rule }],
  fail: "deny", defaultVerdict: "allow", outcomes: [], armed: { rule: "on" },
  effects: { allow: { kind: "none", reversible: true, announced: "none" }, deny: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [...SENDER_DENIAL_REASONS],
};
