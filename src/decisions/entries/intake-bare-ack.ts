import type { Entry, RungAnswer } from "../types.js";

/** Consulted only while an approval card waits on a live Telegram turn (spec 2026-11-01 R3 §4.1); `acked` is isBareAck's raw answer. */
export interface BareAckInput { acked: boolean }
export type BareAckVerdict = "nudge" | "pass";

function rule(s: BareAckInput): RungAnswer<BareAckVerdict> {
  return s.acked ? { verdict: "nudge", reason: "ack_while_card_waits" } : { verdict: "pass" };
}

export const INTAKE_BARE_ACK: Entry<BareAckInput, BareAckVerdict> = {
  id: "intake.bare_ack", version: 1, stage: "intake", input: "paco", locked: true,
  question: "While an approval card waits, is this message a bare acknowledgement — nudged, never taken as consent (ADR 0029 §5.1)?",
  verdicts: ["nudge", "pass"],
  ladder: [{ kind: "rule", name: "isBareAck", decide: rule }],
  fail: "nudge", defaultVerdict: "pass", outcomes: [], armed: { rule: "on" },
  effects: {
    nudge: { kind: "reply", reversible: true, announced: "none", what: "the code-owned nudge points at the card; nothing is approved" },
    pass: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: ["ack_while_card_waits"],
};
