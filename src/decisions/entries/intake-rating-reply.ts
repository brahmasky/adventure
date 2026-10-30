import type { Entry, RungAnswer } from "../types.js";

/** What an open, in-window rating ask did with the next message (spec 2026-10-30 R1 §4.2). */
export type RatingReplyOutcome = "consume" | "forward" | "lapse";
export interface RatingReplyInput { outcome: RatingReplyOutcome }
const REASON = { consume: "bare_digit", forward: "digit_comment", lapse: "not_rating" } as const satisfies Record<RatingReplyOutcome, string>;

function rule(s: RatingReplyInput): RungAnswer<RatingReplyOutcome> {
  return { verdict: s.outcome, reason: REASON[s.outcome] };
}

export const INTAKE_RATING_REPLY: Entry<RatingReplyInput, RatingReplyOutcome> = {
  id: "intake.rating_reply", version: 1, stage: "intake", input: "paco",
  question: "Does this message answer the open rating ask (consume a bare digit, forward a comment) or let it lapse?",
  verdicts: ["consume", "forward", "lapse"],
  ladder: [{ kind: "rule", name: "parseBareRating", decide: rule }],
  fail: "lapse", defaultVerdict: "lapse", alwaysRecord: true, outcomes: [], armed: { rule: "on" },
  effects: {
    consume: { kind: "reply", reversible: false, announced: "none", what: "the rating is banked; the code-owned ack is the reply" },
    forward: { kind: "effect", reversible: false, announced: "none", what: "the rating is banked; the comment runs as the turn" },
    lapse: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: [REASON.consume, REASON.forward, REASON.lapse],
};
