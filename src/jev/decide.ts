import { createHash } from "node:crypto";
import type { RunStore } from "../run/run-store.js";
import type { Lang } from "./intent-question.js";
import type { JevAnswer, JevRequest, JevResult } from "./jev-client.js";
import { openJevIncident, resolveJevIncidentsOnAnswer } from "./jev-incidents.js";
import { criteriaHash, toJevQuestion, type Question } from "./questions/types.js";

/**
 * The one way Houge asks Jev (ADR 0029 §3.2). Builds the request, calls, validates, and returns the answers plus the
 * decision rows AS DATA. It NEVER applies a threshold and NEVER writes a row: the caller applies its gate, then persists
 * the rows inside its own transaction after its cancellation check (a lost turn writes nothing late). Every failure is a
 * `skipped` result with an enum reason; the caller treats it as "no answer" = today's path.
 */
export type SkipReason =
  | "no_key" | "fused" | "auth" | "rate_limited" | "overloaded" | "malformed_question" | "timeout" | "parse" | "transport"
  | "state_too_large" | "disabled" | "posture" | "modality" | "override" | "error"
  // the §2.1 ack rule settled the turn in code: no Jev call, but the turn still has its one triage row
  | "ack_rule";
export type DecisionPoint = "triage";
export type JevDecisionInsert = Parameters<RunStore["insertJevDecision"]>[0];

export interface DecideInput {
  point: DecisionPoint;
  run_id: string | null;
  state: Record<string, unknown>;
  questions: readonly Question[];
  lang: Lang;
  client: (req: JevRequest) => Promise<JevResult>;
  store: RunStore;
  thresholdVersion: string;
  now?: () => Date;
  /** When the caller cut the thread and built `state`: stamped on every answered row so the replay can rebuild it exactly. */
  instants?: { thread_cut_at: string; state_built_at: string };
}
export type Decision =
  | { status: "answered"; answers: Record<string, JevAnswer>; model: string; latency_ms: number; input_tokens: number; stateHash: string; rows: JevDecisionInsert[] }
  | { status: "skipped"; reason: SkipReason };

export function stateHash(state: unknown): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

/** The probability vector a row stores: a choice's options, a score's levels "0".."n-1", a noul's {true: p, false: 1 − p}. */
function distributionOf(a: JevAnswer): Record<string, number> {
  return a.type === "noul" ? { true: a.noul, false: 1 - a.noul } : a.probabilities;
}

/** p1 − p2: the gap between the top two entries, a steadier signal than confidence when n > 2. A noul's is |2p − 1|. */
export function marginOf(a: JevAnswer): number {
  if (a.type === "noul") return Math.abs(2 * a.noul - 1);
  const sorted = Object.values(a.probabilities).sort((x, y) => y - x);
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}

/** The largest entry of the stored vector: a noul's is max(p, 1 − p). */
export function topProbOf(a: JevAnswer): number {
  return Math.max(...Object.values(distributionOf(a)));
}

function skipReasonOf(r: Extract<JevResult, { ok: false }>): SkipReason {
  if (r.reason === "no_key" || r.reason === "fused" || r.reason === "auth") return r.reason;
  switch (r.error_kind) {
    case "rate_limited": case "overloaded": case "malformed_question": case "timeout": case "parse": case "transport": return r.error_kind;
    default: return "error";
  }
}

/** Writes one skipped row (no question, no numbers). Called by the caller after its cancellation check. */
export function recordSkip(store: RunStore, point: DecisionPoint, run_id: string | null, lang: Lang, reason: SkipReason, now?: string): void {
  store.insertJevDecision({ run_id, point, question_id: null, criteria_hash: null, model_reported: null, state_hash: null, lang, answers_json: null,
    confidence: null, top_prob: null, margin: null, threshold_version: null, threshold_used: null, decision: null, latency_ms: null, input_tokens: null,
    status: "skipped", skip_reason: reason, ...(now ? { created_at: now } : {}) });
}

/** Inside the caller's transaction: the rows land with their final decision, next to the lane's own writes. */
export function persistDecisionRows(store: RunStore, rows: JevDecisionInsert[], decision: "act" | "fallback" | "shadow", threshold_used: string | null): string[] {
  return rows.map((r) => store.insertJevDecision({ ...r, decision, threshold_used }));
}

export async function decide(i: DecideInput): Promise<Decision> {
  const questions: Record<string, ReturnType<typeof toJevQuestion>> = {};
  for (const q of i.questions) questions[q.id] = toJevQuestion(q);
  const r = await i.client({ state: i.state, questions });
  if (!r.ok) {
    // No row here (the caller records the skip after its cancellation check). The incident is not a row and may open
    // regardless: an outage is an outage even if this turn ended.
    openJevIncident(i.store, r, { point: i.point, run_id: i.run_id });
    return { status: "skipped", reason: skipReasonOf(r) };
  }
  // Fail loud, never partial: a missing answer, or one whose type is not its question's (a client that skipped validation).
  if (i.questions.some((q) => r.answers[q.id]?.type !== q.type)) return { status: "skipped", reason: "parse" };
  resolveJevIncidentsOnAnswer(i.store); // like the open, independent of whether this turn is still live
  const now = i.now?.().toISOString();
  const sh = stateHash(i.state);
  const rows: JevDecisionInsert[] = [];
  for (const q of i.questions) {
    const a = r.answers[q.id]!; // checked above: every requested id is present, with its question's type
    rows.push({
      run_id: i.run_id, point: i.point, question_id: q.id, criteria_hash: criteriaHash(q), model_reported: r.model, state_hash: sh, lang: i.lang,
      answers_json: JSON.stringify(distributionOf(a)), confidence: a.type === "noul" ? null : a.confidence, top_prob: topProbOf(a), margin: marginOf(a),
      threshold_version: i.thresholdVersion, threshold_used: null, decision: null, latency_ms: r.latency_ms, input_tokens: r.input_tokens,
      status: "answered", skip_reason: null, ...(now ? { created_at: now } : {}), ...(i.instants ?? {}),
    });
  }
  return { status: "answered", answers: r.answers, model: r.model, latency_ms: r.latency_ms, input_tokens: r.input_tokens, stateHash: sh, rows };
}
