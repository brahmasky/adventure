import { decide } from "../decisions/decide.js";
import { SETTLE_JEV_MS, SETTLE_QUESTION_BARS, TURN_SETTLE, TURN_SETTLE_ID, type SettleDetail, type SettleReason, type SettleState, type SettleVerdict } from "../decisions/entries/turn-settle.js";
import { claimsCheck, pendingCount, todoCheck } from "../decisions/settle-checks.js";
import { storeRecorder } from "../decisions/record.js";
import type { RungResult } from "../decisions/types.js";
import { enqueueUrgentCard } from "../decisions/urgent.js";
import { settleJevState } from "../decisions/settle-state.js";
import { askSettle, SETTLE_QUESTION_REASON, SETTLE_QUESTIONS } from "../jev/settle-ask.js";
import type { JevRequest, JevResult } from "../jev/jev-client.js";
import { JEV_PROVIDER } from "../llm/metered-pricing.js";
import type { SendBackKind } from "./bridge-handler.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";

/** 2b-i §3.3: Houge answers `settle` within this from the request's arrival; the Jev call needs at least SETTLE_JEV_MIN_MS of it. */
export const SETTLE_BUDGET_MS = 4_000;
export const SETTLE_JEV_MIN_MS = 300;
export const SETTLE_HEALTH_LIMIT = 3;
export const SETTLE_HEALTH_WINDOW_MS = 60 * 60 * 1000;
const HEALTH_REASONS: readonly string[] = ["budget", "todo_unavailable"];
const HEALTH_KIND: ReadonlySet<string> = new Set(["decision_health"]);
export const NOTE_TAIL = "Your reply will replace the previous one: restate your complete final answer. Do not start a step that needs Paco's approval; say what is pending.";
export const REASON_LINES: Readonly<Record<"claim_scheduled" | "claim_saved" | "claim_attached" | "claim_sent", string>> = {
  claim_scheduled: "You said you scheduled it, but no schedule_task succeeded this turn. If you meant to do it, do it now with the tool; if it was done in an earlier turn, say so instead.",
  claim_saved: "You said you saved it, but no lesson_write succeeded this turn. If you meant to do it, do it now with the tool; if it was done in an earlier turn, say so instead.",
  claim_attached: "You said you attached a file, but no [[attach: <path>]] line in your reply points at a file in the workspace. If you meant to attach it, add the line; if it was sent in an earlier turn, say so instead.",
  claim_sent: "You said you sent it, but nothing was published or sent this turn. If you meant to do it, do it now with the tool; if it was done in an earlier turn, say so instead."
};
export interface SettleDeps { store: RunStore; env: NodeJS.ProcessEnv; client: (r: JevRequest) => Promise<JevResult>; chatId: string; now?: () => string; clock?: () => number }
export type SettleDecision =
  | { sendBack: false; decisionId: string | null; reason: SettleReason | null }
  | { sendBack: true; kind: SendBackKind; reason: SettleReason; note: string; decisionId: string | null };

/** Code-owned sentences per Jev reason (senior plan S: the question instructions talk about fields, not to the planner). */
export const JEV_LINES: Readonly<Record<"jev_claims_done" | "jev_unverified" | "jev_promise" | "jev_asks_permission", string>> = {
  jev_claims_done: "Your reply reads as unfinished: it claims the task is done, but nothing this turn shows it.",
  jev_unverified: "Your reply reads as unfinished: you acted or edited something but did not verify the result.",
  jev_promise: "Your reply reads as unfinished: it ends on a promise of further work instead of the work.",
  jev_asks_permission: "Your reply reads as unfinished: it asks permission for work Paco's message already asked for."
};

/** The reason line (spec §3.4): a claim's fixed sentence, a todo COUNT, or the Jev reason's sentence; never item names or model text. */
export function settleNote(reason: SettleReason, s: SettleState): string {
  const line = reason in REASON_LINES ? REASON_LINES[reason as keyof typeof REASON_LINES]
    : reason in JEV_LINES ? JEV_LINES[reason as keyof typeof JEV_LINES]
    : reason === "todo_pending" ? `Your todo list still has ${s.todoNow ? pendingCount(s.todoNow) : 0} open items.`
    : `Your reply reads as unfinished (${reason}).`;
  return `${line}\n${NOTE_TAIL}`;
}

/** The bar of a settle question id; the ids come from SETTLE_QUESTIONS, keyed the same in SETTLE_QUESTION_BARS. */
const barOfQuestion = (id: string): number => SETTLE_QUESTION_BARS[id as keyof typeof SETTLE_QUESTION_BARS];
/** Question ids over THEIR bar with their p, furthest over its bar (p − bar) first: the one rule for the rung and the re-ask. */
function overBar(answers: Record<string, number>): Array<[string, number]> {
  return SETTLE_QUESTIONS.map((q) => [q.id, answers[q.id] ?? 0] as [string, number]).filter(([id, p]) => p > barOfQuestion(id))
    .sort((a, b) => (b[1] - barOfQuestion(b[0])) - (a[1] - barOfQuestion(a[0])));
}
/** The ids come from SETTLE_QUESTIONS, and SETTLE_QUESTION_REASON is keyed by the same ids: the lookup cannot miss. */
const reasonOf = (id: string): SettleReason => SETTLE_QUESTION_REASON[id]!;

/** The Jev rung: any question's p over its own bar sends back with that question's reason; all below settles (ruling 6 for the reason). */
function jevRung(d: SettleDeps, s: SettleState, deadline: number): () => Promise<RungResult<SettleVerdict, SettleDetail>> {
  return async () => {
    const left = deadline - (d.clock ?? Date.now)();
    if (left < SETTLE_JEV_MIN_MS) return { failed: "budget", reason: "budget" };
    const bound = Math.min(SETTLE_JEV_MS, left);
    const r = await askSettle({ run_id: s.run_id, state: settleJevState(s), client: d.client, store: d.store, boundMs: bound });
    // a timeout the DEADLINE cut (the bound was shorter than the client's own 1.5 s) is a budget miss, not a Jev timeout
    if ("failed" in r) return r.failed === "timeout" && bound < SETTLE_JEV_MS ? { failed: "budget", reason: "budget" } : { failed: r.failed };
    const over = overBar(r.answers);
    const top = Math.max(...Object.values(r.answers));
    if (over.length > 0) return { verdict: "send_back", reason: reasonOf(over[0]![0]), p: over[0]![1], detail: { jev: r.answers } };
    // codex plan W2: either snapshot missing is the todo check's own verdict, not only todoNow
    return { verdict: "settle", reason: todoCheck(s.todoBefore, s.todoNow) === "todo_unavailable" ? "todo_unavailable" : "settled", p: top, detail: { jev: r.answers } };
  };
}

export async function decideSettle(d: SettleDeps, s: SettleState, deadline: number): Promise<SettleDecision> {
  const now = d.now ?? (() => new Date().toISOString());
  const r = await decide(TURN_SETTLE, s, { run_id: s.run_id, recorder: storeRecorder(d.store, { env: d.env, now }), exec: { system_one: jevRung(d, s, deadline) }, ...(d.clock ? { clock: d.clock } : {}) });
  const reason = r.reason as SettleReason | null;
  settleHealthAfter(d, now(), reason);
  if (r.verdict !== "send_back" || reason === null) return { sendBack: false, decisionId: r.decisionId, reason };
  return { sendBack: true, kind: r.rung === "system_one" ? JEV_PROVIDER : "rule", reason, note: settleNote(reason, s), decisionId: r.decisionId };
}

/** Rows with reason budget or todo_unavailable in the last hour (spec §3.3; decision_fallback excludes both). */
export function settleHealth(store: RunStore, _env: NodeJS.ProcessEnv, now: string): number {
  return store.countDecisionsWithReasons(TURN_SETTLE_ID, HEALTH_REASONS, new Date(Date.parse(now) - SETTLE_HEALTH_WINDOW_MS).toISOString());
}

/** After each settle row (spec §3.3): a row with neither reason resolves the incident; the third counted row in an hour pages once. */
function settleHealthAfter(d: SettleDeps, now: string, reason: SettleReason | null): void {
  try {
    if (reason === null || !HEALTH_REASONS.includes(reason)) { resolveOpenIncidents(d.store, HEALTH_KIND, TURN_SETTLE_ID, now); return; }
    const n = settleHealth(d.store, d.env, now);
    if (n < SETTLE_HEALTH_LIMIT) return;
    const opened = openAlertedIncident(d.store, { kind: "decision_health", subject: TURN_SETTLE_ID, detail: { entry: TURN_SETTLE_ID, count: n, limit: SETTLE_HEALTH_LIMIT, window_min: 60 }, env: {}, now });
    const incident = d.store.findOpenIncident(d.store.incidentFingerprint("decision_health", TURN_SETTLE_ID));
    if (opened && incident) enqueueUrgentCard(d.store, { chat_id: d.chatId, key: `decision_health:${incident.incident_id}`, text: `⚠️ *turn.settle* could not finish ${n} settles in the last hour (budget or todo state unavailable). Replies are delivered unsettled; the next complete settle clears this.` });
  } catch (e) { console.error(`settle: health bookkeeping failed: ${e instanceof Error ? e.message : String(e)}`); }
}

/** The final-pass audit's code checks (spec §3.5): the claims and todo reasons that persist on pass 1's final text. */
export function finalAuditReasons(s: SettleState): SettleReason[] {
  const out: SettleReason[] = [...claimsCheck(s.text, s.evidence, s.attachmentsAccepted)];
  if (todoCheck(s.todoBefore, s.todoNow) === "todo_pending") out.push("todo_pending");
  return out;
}

/** Spec §3.5: the Jev questions re-asked AFTER delivery, bounded; the reason furthest over its bar (the rung's rule), or null (a failure is null: no card on an outage). */
export async function reaskAfterDelivery(d: SettleDeps, s: SettleState, boundMs: number): Promise<SettleReason | null> {
  const r = await askSettle({ run_id: s.run_id, state: settleJevState(s), client: d.client, store: d.store, boundMs });
  if ("failed" in r) return null;
  const over = overBar(r.answers);
  return over.length > 0 ? reasonOf(over[0]![0]) : null;
}
