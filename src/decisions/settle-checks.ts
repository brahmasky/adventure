import type { LedgerEvent } from "../run/run-ledger.js";
import type { SettleDetail, SettleReason, SettleState, SettleVerdict, TodoSnapshot } from "./entries/turn-settle.js";
import type { RungAbstain, RungAnswer } from "./types.js";

/**
 * Rules 2–3 of turn.settle (2b-i §3.3): a first-person past-tense claim of work this run's ledger does not show, and a
 * todo list the planner changed this turn and left open. Code-owned verb lists, tested per verb (zh and en) with and
 * without evidence and with negations. A sentence holding a negation never claims.
 */
export type ClaimReason = "claim_scheduled" | "claim_saved" | "claim_attached" | "claim_sent";
/** N3: `nothing` negates only as the object of the claim verb ("sent nothing"), never "…, nothing else changed". */
const NEGATED = /\b(?:not|never|cannot|can't|couldn't|didn't|haven't|hasn't|won't|wasn't|unable|yet to)\b|\b(?:sent|saved|scheduled|recorded|remembered|attached)\s+nothing\b|没有|没|未|无法|不能|不会|还没|尚未/i;
/**
 * 2b-i final review A7: a sentence about an earlier turn or time reports, it does not claim. 已经 ("already") is no marker.
 * N3: `before` only as `before this|that|now|the last|previous turn` ("30 minutes before your meeting" still claims), and
 * `last week` etc. only as the time, never possessive ("as last week's report").
 */
const EARLIER = /\b(?:earlier|yesterday|previous(?:ly)?|before\s+(?:this|that|now|the\s+(?:last|previous)\s+turn)|last\s+(?:week|month|time|turn)(?!['’]s))\b|之前|昨天|上次|上一轮|早些时候/i;
/** Each sentence WITH its terminator, so a question (`?`, `？`) can be told apart (A7: a question never claims). */
const SENTENCE = /[^.!?。！？\n]+[.!?。！？]*/g;
const SUBJ_CORE = String.raw`(?:it|that|this|they|them|everything)(?:'s|’s| is| has been| was| are| were)\s+(?:now\s+)?`;
const SUBJ = String.raw`\b${SUBJ_CORE}`;
/**
 * A7 ruling: the pronoun passive of sent/recorded claims only as the whole sentence ("It was sent.", "That's recorded now."):
 * in context it is reported or located prose ("the invoice says it was sent on March 3", "everything's recorded in the table").
 */
const PASSIVE_ONLY = (verb: string): string => String.raw`^${SUBJ_CORE}${verb}(?:\s+(?:already|now|successfully))?[.!。！]*$`;
const FIRST = String.raw`\bi(?:'ve|’ve| have| just)?\s+(?:just\s+|already\s+|now\s+)?`;
const CLAIM_PATTERNS: ReadonlyArray<[ClaimReason, RegExp]> = [
  ["claim_scheduled", new RegExp(`${FIRST}scheduled|${SUBJ}scheduled|\\breminder\\s+(?:is|has been)\\s+set\\b|已安排|已设置提醒|安排好了|已经安排|已设好提醒`, "i")],
  ["claim_saved", new RegExp(`${FIRST}(?:saved|remembered|recorded|noted (?:it|that) down)|${SUBJ}(?:saved|remembered)|${PASSIVE_ONLY("recorded")}|已保存|记住了|记下来了|已经记下|已记录|保存好了`, "i")],
  // A7: zh 附上 claims only past (已附上, 附上了) or as the sentence's opening ("附上报告。" = "Attached: the report"), never as an offer
  ["claim_attached", /\b(?:i(?:'ve| have|’ve)?\s+(?:just\s+|now\s+)?attached|attached\s+(?:below|above|here|is|are)|see\s+(?:the\s+)?attached)\b|^附上|附上了|已附|见附件|附件如下/i],
  ["claim_sent", new RegExp(`${FIRST}sent\\b|\\bi['’]ve\\b[^.]*\\band\\s+sent\\b|${PASSIVE_ONLY("sent")}|已发送|发出去了|已经发出|发送成功|已发出`, "i")]
];
/** A bare one-word confirmation ("Saved." / "Sent.") claims only as a short sentence: "Saved searches are listed below" is prose. */
const BARE: ReadonlyArray<[ClaimReason, RegExp]> = [["claim_saved", /^\s*saved\b/i], ["claim_sent", /^\s*sent\b/i]];
const BARE_MAX_WORDS = 3;
const claims = (sentence: string, reason: ClaimReason, re: RegExp): boolean =>
  re.test(sentence) || BARE.some(([r, b]) => r === reason && b.test(sentence) && sentence.split(/\s+/).length <= BARE_MAX_WORDS);

const finished = (e: LedgerEvent, tool: string): boolean => e.event_type === "tool_finished" && e.payload.tool === tool && e.payload.status === "succeeded";
/** Ruling 3: the capability of a shell call is on its loop_step row. */
const externalStep = (e: LedgerEvent): boolean => e.event_type === "loop_step" && e.payload.capability === "shell_external" && e.payload.ok === true;
const EVIDENCE: Readonly<Record<ClaimReason, (evidence: readonly LedgerEvent[], attachmentsAccepted: number) => boolean>> = {
  claim_scheduled: (ev) => ev.some((e) => finished(e, "schedule_task")),
  claim_saved: (ev) => ev.some((e) => e.event_type === "lesson_saved" || e.event_type === "fact_saved" || finished(e, "lesson_write")),
  claim_attached: (_ev, n) => n > 0,
  claim_sent: (ev) => ev.some((e) => e.event_type === "external_work_published" || externalStep(e))
};

/** A sentence that can claim: not negated, not a question, not about an earlier turn or time (A7). */
const mayClaim = (s: string): boolean => s.length > 0 && !NEGATED.test(s) && !/[?？]$/.test(s) && !EARLIER.test(s);

/** The claims the reply makes (table order, each once) that the run's ledger does not support. */
export function claimsCheck(text: string, evidence: readonly LedgerEvent[], attachmentsAccepted: number): ClaimReason[] {
  const sentences = (text.match(SENTENCE) ?? []).map((s) => s.trim()).filter(mayClaim);
  const out: ClaimReason[] = [];
  for (const [reason, re] of CLAIM_PATTERNS) if (sentences.some((s) => claims(s, reason, re)) && !EVIDENCE[reason](evidence, attachmentsAccepted)) out.push(reason);
  return out;
}

/** The todo tool's row (bridge-handler handleReport): bookkeeping, not a tool call, for turn.settle (2b-i final review A5). */
export const isBookkeeping = (e: LedgerEvent): boolean => e.event_type === "tool_finished" && e.payload.tool === "builtin:todo";

/** Guard 3 (spec §3.2): the newest tool event of the run (bookkeeping aside) is a denied tool_finished or a gate deny. */
export function lastCallDenied(evidence: readonly LedgerEvent[]): boolean {
  const last = [...evidence].reverse().find((e) => (e.event_type === "tool_finished" || e.event_type === "policy_decision") && !isBookkeeping(e));
  if (!last) return false;
  return last.event_type === "tool_finished" ? last.payload.status === "denied" : last.payload.decision === "deny";
}

const OPEN = new Set(["pending", "in_progress"]);
const shape = (t: TodoSnapshot): string => JSON.stringify(t.phases.map((p) => p.tasks.map((x) => [x.content, x.status])));
export const pendingCount = (t: TodoSnapshot): number => t.phases.reduce((n, p) => n + p.tasks.filter((x) => OPEN.has(x.status)).length, 0);

/** 2b-R6: only a list that changed this turn can send back; either snapshot missing turns the check off for the turn. */
export function todoCheck(before: TodoSnapshot | null, now: TodoSnapshot | null): "todo_pending" | "todo_unavailable" | null {
  if (before === null || now === null) return "todo_unavailable";
  return shape(before) !== shape(now) && pendingCount(now) > 0 ? "todo_pending" : null;
}

type Rule = RungAnswer<SettleVerdict, SettleDetail> | RungAbstain<SettleVerdict, SettleDetail>;
/** Rules 2–3 for settleRule: a claim or an open changed todo sends back; else abstain (reason todo_unavailable when the check was off). */
export function settleChecks(s: SettleState): Rule {
  const claims = claimsCheck(s.text, s.evidence, s.attachmentsAccepted);
  if (claims.length > 0) return { verdict: "send_back", reason: claims[0] as SettleReason, detail: { claims } };
  const todo = todoCheck(s.todoBefore, s.todoNow);
  if (todo === "todo_pending") return { verdict: "send_back", reason: todo };
  return todo === "todo_unavailable" ? { abstain: true, reason: todo } : { abstain: true };
}
