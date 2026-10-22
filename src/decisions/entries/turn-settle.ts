import type { LedgerEvent } from "../../run/run-ledger.js";
import { SETTLE_QUESTIONS, type SettleQuestionId } from "../../jev/questions/settle.js";
import { criteriaHash, type NoulQuestion } from "../../jev/questions/types.js";
import type { TrustLevel } from "./turn-trust.js";
import { settleChecks } from "../settle-checks.js";
import type { Entry, ProvisionalBar, RungAbstain, RungAnswer, VerdictEffect } from "../types.js";

/**
 * `turn.settle` (2b-i spec §3; parent §7.3): does this reply settle, or does it go back for ONE more pass? Rule 1 is the
 * never-send-back guards (2b-R13), rules 2–3 the claims and todo checks (src/omp/settle-judge.ts), then Jev's four noul
 * questions, each against its own bar (SETTLE_QUESTION_BARS, calibration 2026-10-20). Monotone settle < send_back: a judge may only tighten (R12 over mixed input). The
 * effect of send_back is one bounded continuation (omp's session_stop `continue`); after a Jev-rung send-back every side
 * effect asks (settleAsk, ADR 0030 named exception as extended by 2b-R7). Always recorded, keyed by Houge's run id.
 */
export const TURN_SETTLE_ID = "turn.settle";
export type SettleVerdict = "settle" | "send_back";
export const SETTLE_REASONS = ["hostile", "already_sent_back", "last_call_denied", "steer_queued", "deadline_short", "aborting", "pass_errored", "empty", "claim_scheduled", "claim_saved",
  "claim_attached", "claim_sent", "todo_pending", "todo_unavailable", "jev_claims_done", "jev_unverified", "jev_promise", "jev_asks_permission", "budget", "settled"] as const;
export type SettleReason = (typeof SETTLE_REASONS)[number];
/**
 * The settle reasons that mean "could not finish a settle": three in an hour page through decision_health, and the digest
 * counts each (R0': a run of pass_errored rows is a planner-side outage window, made visible, never silent).
 */
export const SETTLE_HEALTH_REASONS = ["budget", "todo_unavailable", "pass_errored"] as const satisfies readonly SettleReason[];
export const SETTLE_DISCARDED_VALUES = ["extension_timeout", "signal", "continuation_failed"] as const;
/** Calibration 2026-10-20 (spec §3.3): a question sends back when its p exceeds ITS bar; unverified's 0.8 sits just above a 0.7–0.8 cluster of honest reports. */
export const SETTLE_QUESTION_BARS: Readonly<Record<SettleQuestionId, number>> = { settle_claims_done: 0.6, settle_unverified: 0.8, settle_promise: 0.7, settle_asks_permission: 0.7 };
/** The entry's single bar (what the digest's unsure band reads): the lowest per-question bar. */
export const SETTLE_BAR_P = 0.6;
export const SETTLE_JEV_MS = 1_500;
export const DEADLINE_SHORT_MS = 60_000;
/** The bar's hash covers all four questions, instructions AND criteria (senior plan S): a change to any of them marks the bar stale. */
export const settleQuestionsHash = (qs: readonly NoulQuestion[]): string =>
  criteriaHash({ id: "settle", type: "noul", instructions: qs.map((q) => `${q.id}: ${q.instructions}${q.criteria ? `\n  true: ${q.criteria.true}\n  false: ${q.criteria.false}` : ""}`).join("\n") });
export const SETTLE_QUESTIONS_HASH = settleQuestionsHash(SETTLE_QUESTIONS);
export const SETTLE_BAR: ProvisionalBar = { kind: "provisional", question: "settle", criteriaHash: SETTLE_QUESTIONS_HASH, p: SETTLE_BAR_P,
  source: "calibration 2026-10-20 on 133 planner replies (30 days): set B at per-question bars 0.6/0.8/0.7/0.7 → probe 7/133 = 5.3%, 7/7 planted; sanity rerun 6/133 = 4.5%, 9/9 planted; see spec §3.3" };

/** omp's todo list as get_state reports it (content kept only until the comparison; never recorded or sent). */
export interface TodoSnapshot { phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> }
/** Built by the supervisor (src/decisions/settle-state.ts); `redacted` is what the Jev rung may read (senior B4). */
export interface SettleState {
  run_id: string; text: string; pass: number; sentBack: boolean; trust: TrustLevel; lastCallDenied: boolean; steerQueued: boolean; msLeft: number; aborting: boolean;
  /** 2b-i final review A8: the pass ended on a model error; a continuation would run on the same failing model. */
  passErrored: boolean;
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
  if (s.passErrored) return "pass_errored";
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
