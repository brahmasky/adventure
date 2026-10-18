import { createHash } from "node:crypto";
import { meanAnswers } from "../decisions/noise-band.js";
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
export type DecisionPoint = "triage" | "injection" | "memory_kind";
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
  /**
   * The noise band's one re-ask (Addition B): when `near` says a banded answer sits within its band of a bar, the identical
   * request is sent once more and every answer becomes the mean. `allowed` (a remaining time budget) may veto it.
   */
  reask?: { near: (answers: Record<string, JevAnswer>, model: string) => boolean; allowed?: () => boolean; boundMs?: () => number };
  /** A budget for the first call (tool.injection's 3 s per tool call): an overrun is a `timeout` skip, as a client timeout is. */
  boundMs?: number;
  /** The key each raw row is stored under (default: the question's own id and criteria hash). */
  rowKey?: (q: Question) => { question_id: string; criteria_hash: string };
}
export type Decision =
  | { status: "answered"; answers: Record<string, JevAnswer>; model: string; latency_ms: number; input_tokens: number; stateHash: string; rows: JevDecisionInsert[];
      /** The one re-ask: `mean` decided on the mean of `first` and `second`; `failed` kept the first answer. A tool-input caller decides on the more cautious of the two. */
      reask?: "mean" | "failed"; first?: Record<string, JevAnswer>; second?: Record<string, JevAnswer> }
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
export function recordSkip(store: RunStore, point: DecisionPoint, run_id: string | null, lang: Lang, reason: SkipReason, now?: string,
  ladder_decision_id: string | null = null): void {
  store.insertJevDecision({ run_id, point, question_id: null, criteria_hash: null, model_reported: null, state_hash: null, lang, answers_json: null,
    confidence: null, top_prob: null, margin: null, threshold_version: null, threshold_used: null, decision: null, latency_ms: null, input_tokens: null,
    status: "skipped", skip_reason: reason, ladder_decision_id, ...(now ? { created_at: now } : {}) });
}

/** Inside the caller's transaction: the rows land with their final decision (and the ladder decision they answered), next to the lane's own writes. */
export function persistDecisionRows(store: RunStore, rows: JevDecisionInsert[], decision: "act" | "fallback" | "shadow", threshold_used: string | null,
  ladder_decision_id: string | null = null): string[] {
  return rows.map((r) => store.insertJevDecision({ ...r, decision, threshold_used, ladder_decision_id }));
}

type Answered = Extract<Decision, { status: "answered" }>;
type WireQuestions = Record<string, ReturnType<typeof toJevQuestion>>;
const wireOf = (qs: readonly Question[]): WireQuestions => Object.fromEntries(qs.map((q) => [q.id, toJevQuestion(q)]));
const mismatched = (qs: readonly Question[], answers: Record<string, JevAnswer>): boolean => qs.some((q) => answers[q.id]?.type !== q.type);

const BOUND_EXPIRED: JevResult = { ok: false, reason: "error", detail: "decide bound", error_kind: "timeout" };
/**
 * The late path runs in a promise nothing awaits: a throw there (store closed at shutdown, SQLITE_BUSY, disk) would be an
 * unhandled rejection that ends the daemon. It logs a fixed code with enums only and never rethrows: the turn already
 * decided, and losing one late incident is cheaper than losing the process.
 */
function reportLate(onLate: (r: Extract<JevResult, { ok: false }>) => void, r: Extract<JevResult, { ok: false }>): void {
  try {
    onLate(r);
  } catch (e) {
    console.error(`jev: late_incident_failed reason=${r.reason} error_kind=${r.error_kind ?? "none"} cause=${e instanceof Error ? e.name : typeof e}`);
  }
}

/**
 * Races a call against a budget; with no budget, the call alone (the client's own timeout still applies). A call that loses
 * the race still reports an outage when it settles: `onLate` gets its failure, so a bound shorter than the client's own
 * timeout (or retries) never hides a 429 / 529 / auth from Paco. Its answer, if any, is discarded.
 */
function bounded(p: Promise<JevResult>, ms: number | undefined, onLate: (r: Extract<JevResult, { ok: false }>) => void): Promise<JevResult> {
  if (ms === undefined) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  // A rejection before expiry reaches the caller through the race; after it, it is classified like any other late failure
  // (a thrown client is transport noise to jevIncidentKind) instead of escaping as an unhandled rejection.
  void p.then((late) => { if (expired && !late.ok) reportLate(onLate, late); },
    (e: unknown) => { if (expired) reportLate(onLate, { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e), error_kind: "transport" }); });
  const budget = new Promise<JevResult>((r) => { timer = setTimeout(() => { expired = true; r(BOUND_EXPIRED); }, Math.max(0, ms)); });
  return Promise.race([p, budget]).finally(() => clearTimeout(timer));
}

/** Opens the outage incident a failure implies (none for per-call noise such as a timeout). */
const incidentFor = (i: DecideInput) => (r: Extract<JevResult, { ok: false }>): void => openJevIncident(i.store, r, { point: i.point, run_id: i.run_id });

export async function decide(i: DecideInput): Promise<Decision> {
  const questions = wireOf(i.questions);
  const r = await bounded(i.client({ state: i.state, questions }), i.boundMs, incidentFor(i));
  if (!r.ok) {
    // No row here (the caller records the skip after its cancellation check). The incident is not a row and may open
    // regardless: an outage is an outage even if this turn ended.
    openJevIncident(i.store, r, { point: i.point, run_id: i.run_id });
    return { status: "skipped", reason: skipReasonOf(r) };
  }
  // Fail loud, never partial: a missing answer, or one whose type is not its question's (a client that skipped validation).
  if (mismatched(i.questions, r.answers)) return { status: "skipped", reason: "parse" };
  resolveJevIncidentsOnAnswer(i.store); // like the open, independent of whether this turn is still live
  const first = answeredOf(i, r);
  const wantsReask = i.reask !== undefined && i.reask.near(r.answers, r.model) && (i.reask.allowed?.() ?? true);
  return wantsReask ? reaskOnce(i, questions, first) : first;
}

/** The first call's rows (raw, what calibration reads), whatever the re-ask then decides (plan Ruling 5). */
function answeredOf(i: DecideInput, r: Extract<JevResult, { ok: true }>): Answered {
  const now = i.now?.().toISOString();
  const sh = stateHash(i.state);
  const rows: JevDecisionInsert[] = i.questions.map((q) => {
    const a = r.answers[q.id]!; // checked: every requested id is present, with its question's type
    const key = i.rowKey ? i.rowKey(q) : { question_id: q.id, criteria_hash: criteriaHash(q) };
    return {
      run_id: i.run_id, point: i.point, ...key, model_reported: r.model, state_hash: sh, lang: i.lang,
      answers_json: JSON.stringify(distributionOf(a)), confidence: a.type === "noul" ? null : a.confidence, top_prob: topProbOf(a), margin: marginOf(a),
      threshold_version: i.thresholdVersion, threshold_used: null, decision: null, latency_ms: r.latency_ms, input_tokens: r.input_tokens,
      status: "answered", skip_reason: null, ...(now ? { created_at: now } : {}), ...(i.instants ?? {}),
    };
  });
  return { status: "answered", answers: r.answers, model: r.model, latency_ms: r.latency_ms, input_tokens: r.input_tokens, stateHash: sh, rows };
}

/** Exactly one more identical request. Answered on the same model with the same shapes → the mean; anything else → the first answer. */
async function reaskOnce(i: DecideInput, questions: WireQuestions, first: Answered): Promise<Answered> {
  const r = await bounded(i.client({ state: i.state, questions }), i.reask?.boundMs?.(), incidentFor(i)); // an overrun keeps the first answer (Addition B)
  if (!r.ok) { openJevIncident(i.store, r, { point: i.point, run_id: i.run_id }); return { ...first, reask: "failed" }; }
  const mean = r.model === first.model && !mismatched(i.questions, r.answers) ? meanAnswers(first.answers, r.answers) : null;
  if (!mean) return { ...first, reask: "failed" };
  return { ...first, answers: mean, first: first.answers, second: r.answers, reask: "mean", latency_ms: first.latency_ms + r.latency_ms };
}
