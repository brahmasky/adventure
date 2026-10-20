import type { LedgerEvent } from "../../run/run-ledger.js";
import { SETTLE_QUESTIONS } from "../../jev/questions/settle.js";
import { criteriaHash } from "../../jev/questions/types.js";
import type { TrustLevel } from "./turn-trust.js";
import { settleChecks } from "../settle-checks.js";
import type { Entry, ProvisionalBar, RungAbstain, RungAnswer, VerdictEffect } from "../types.js";

/**
 * `turn.settle` (2b-i spec §3; parent §7.3): does this reply settle, or does it go back for ONE more pass? Rule 1 is the
 * never-send-back guards (2b-R13), rules 2–3 the claims and todo checks (src/omp/settle-judge.ts), then Jev's four noul
 * questions at a provisional 0.5. Monotone settle < send_back: a judge may only tighten (R12 over mixed input). The
 * effect of send_back is one bounded continuation (omp's session_stop `continue`); after a Jev-rung send-back every side
 * effect asks (settleAsk, ADR 0030 named exception as extended by 2b-R7). Always recorded, keyed by Houge's run id.
 */
export const TURN_SETTLE_ID = "turn.settle";
export type SettleVerdict = "settle" | "send_back";
export const SETTLE_REASONS = ["hostile", "already_sent_back", "last_call_denied", "steer_queued", "deadline_short", "aborting", "empty", "claim_scheduled", "claim_saved",
  "claim_attached", "claim_sent", "todo_pending", "todo_unavailable", "jev_claims_done", "jev_unverified", "jev_promise", "jev_asks_permission", "budget", "settled"] as const;
export type SettleReason = (typeof SETTLE_REASONS)[number];
export const SETTLE_DISCARDED_VALUES = ["extension_timeout", "signal", "continuation_failed"] as const;
export const SETTLE_BAR_P = 0.5;
export const SETTLE_JEV_MS = 1_500;
export const DEADLINE_SHORT_MS = 60_000;
/** The bar's hash covers all four questions (senior plan S): a change to any of them marks the bar stale. */
export const SETTLE_QUESTIONS_HASH = criteriaHash({ id: "settle", type: "noul", instructions: SETTLE_QUESTIONS.map((q) => `${q.id}: ${q.instructions}`).join("\n") });
export const SETTLE_BAR: ProvisionalBar = { kind: "provisional", question: "settle", criteriaHash: SETTLE_QUESTIONS_HASH, model: "jev-1.13.0", p: SETTLE_BAR_P,
  source: "2b-i spec §3.3: provisional 0.5 on four noul questions, armed at ship; the sanity run on 30 days of replies bounds the send-back rate at 10%" };

/** omp's todo list as get_state reports it (content kept only until the comparison; never recorded or sent). */
export interface TodoSnapshot { phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> }
/** Built by the supervisor (src/decisions/settle-state.ts); `redacted` is what the Jev rung may read (senior B4). */
export interface SettleState {
  run_id: string; text: string; pass: number; sentBack: boolean; trust: TrustLevel; lastCallDenied: boolean; steerQueued: boolean; msLeft: number; aborting: boolean;
  evidence: readonly LedgerEvent[]; todoBefore: TodoSnapshot | null; todoNow: TodoSnapshot | null; pacoMessage: string;
  /** `[[attach:]]` lines parseAttachments accepted from this pass's final text (senior S5). */
  attachmentsAccepted: number;
  redacted: { text: string; pacoMessage: string }; toolSummary: string;
}
export interface SettleDetail { jev?: Record<string, number>; guard?: SettleReason; claims?: SettleReason[] }
type Rule = RungAnswer<SettleVerdict, SettleDetail> | RungAbstain<SettleVerdict, SettleDetail>;
const settle = (reason: SettleReason): Rule => ({ verdict: "settle", reason, detail: { guard: reason } });

/** Rule 1 (spec §3.2), in this order; null when no guard fires. */
export function settleGuard(s: SettleState): SettleReason | null {
  if (s.trust === "hostile") return "hostile";
  if (s.sentBack) return "already_sent_back";
  if (s.lastCallDenied) return "last_call_denied";
  if (s.steerQueued) return "steer_queued";
  if (s.msLeft < DEADLINE_SHORT_MS) return "deadline_short";
  if (s.aborting) return "aborting";
  if (s.text.trim().length === 0) return "empty";
  return null;
}

/** The entry's rule rung: the guards (rule 1), then the claims and todo checks (rules 2–3, settle-checks.ts). */
export function settleRule(s: SettleState): Rule {
  const guard = settleGuard(s);
  if (guard) return settle(guard);
  return settleChecks(s);
}

const NONE: VerdictEffect = { kind: "none", reversible: true, announced: "none", what: "the reply is delivered as it is" };
export const TURN_SETTLE: Entry<SettleState, SettleVerdict, SettleDetail> = {
  id: TURN_SETTLE_ID, version: 1, stage: "settle", input: "mixed",
  question: "Does this reply settle the turn, or does it go back for one more pass?",
  verdicts: ["settle", "send_back"],
  ladder: [
    { kind: "rule", name: "settle_rule", decide: settleRule },
    // the client's own 1.5 s bound fires first; this outer bound only stops a hung executor
    { kind: "system_one", name: "settle", questions: SETTLE_QUESTIONS, bars: SETTLE_BAR, timeoutMs: SETTLE_JEV_MS + 500, recordedP: "settle" }
  ],
  fail: "settle", monotone: { order: ["settle", "send_back"] }, defaultVerdict: "settle", alwaysRecord: true,
  outcomes: ["settle_sent_back", "settle_unverified", "settle_discarded", "review_ok", "review_bad", "review_unsure"],
  armed: { rule: "on", system_one: "on" },
  effects: { settle: NONE, send_back: { kind: "tighten", reversible: true, announced: "none", what: "one bounded continuation with the code-owned note; after a Jev-rung send-back every side effect asks (settleAsk)" } },
  reasonCodes: SETTLE_REASONS
};
