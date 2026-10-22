import { createHash } from "node:crypto";
import { errorCode } from "../domain/error-code.js";
import { JEV_INCIDENT_SUBJECT, openJevIncident } from "../jev/jev-incidents.js";
import type { JevAnswer, JevRequest, JevResult } from "../jev/jev-client.js";
import { toJevQuestion } from "../jev/questions/types.js";
import { treeQuestions } from "../jev/triage-replay.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";
import { askCandidate, CHECK_GOLDEN_ENTRIES, runGoldenForModel, type CandidateAsk, type CheckGoldenEntry } from "./golden.js";
import {
  agreementByCheck, CHECK_IDS, checkOutcome, JEV_ANCHOR_MIN_ZH, judge, laneCountsOf, type CheckMargin, type CheckRun, type CheckVerdict, type RecallDrop, type RouteState
} from "./jev-version-check.js";

/**
 * The Jev version check's running part (spec 2026-10-22 §2.4-2.6): discovery of the models Jev reported, and the background
 * job that checks one model against Paco's approved anchor. The job runs on its own promise, started by the signal-path
 * tick and never awaited by it (the tick runs inside the Telegram poll loop); one model at a time; every recorded answer is
 * a `jev_check_runs` row of the model's current generation, so a stop or an outage resumes without asking twice. Only
 * answers reporting the candidate count. Logs carry model ids, enums and error codes only, never state or turn text.
 */
export interface JevJobDeps {
  store: RunStore; client: (r: JevRequest) => Promise<JevResult>; signal: AbortSignal;
  /** The operator chat the notice and the Accept card go to; null → the incident pages through the default operator chat. */
  chatId: string | null;
  now: () => string;
  /** The golden entries run on the candidate (default all four). */
  golden?: readonly CheckGoldenEntry[];
  log?: (line: string) => void;
}
export type JevCheckResult = "trusted" | "drifted" | "insufficient" | "deferred" | "stopped" | "outage" | "skipped";

/** After an outage the next start waits this long: the tick runs every poll cycle and must not hammer a down Jev. */
export const JEV_JOB_OUTAGE_BACKOFF_MS = 10 * 60_000;
/** A deferred model (the alias served another id) is retried on a later day. */
export const JEV_DEFER_RETRY_MS = 24 * 3_600_000;
export const JEV_MODEL_INCIDENT_KINDS: ReadonlySet<string> = new Set(["jev_model_drifted", "jev_model_insufficient"]);
export const jevModelSubject = (model: string): string => `${JEV_INCIDENT_SUBJECT}:model:${model}`;
/** The Accept button's model key: 8 hex of sha256, so callback data stays short and carries no model text. */
export const modelHash = (model: string): string => createHash("sha256").update(model).digest("hex").slice(0, 8);
export const jevAcceptData = (model: string): string => `dec:jv:${modelHash(model)}:acc`;
const ANCHOR_COMMAND = "houge jev anchor import";
const TREE_RUNS = [["A", false], ["A2", false], ["B", true]] as const;
const PROGRESS_EVERY = 25;
const GOLDEN_DRIFT: ReadonlySet<string> = new Set(["decision_golden_drift"]);

const logOf = (d: Pick<JevJobDeps, "log">) => d.log ?? ((l: string) => console.error(l));

/** Spec §2.4: every model an `llm_attempt` row from Jev reported after the cursor is noted (`checking` when unseen); the cursor advances. Returns the models first seen now. */
export function discoverJevModels(store: RunStore, now: string): string[] {
  const rows = store.jevAttemptModelsSince(store.getJevModelCursor());
  const noted: string[] = [];
  for (const r of rows) {
    if (!store.getJevModel(r.model)) noted.push(r.model);
    store.noteJevModel(r.model, now);
  }
  if (rows.length > 0) store.setJevModelCursor(Math.max(...rows.map((r) => r.rowid)));
  return noted;
}

// ── The job's single lane: one model at a time, in-memory (a restart resumes from the rows) ──
const lane: { running: Promise<void> | null; notBefore: number } = { running: null, notBefore: 0 };

/** Resolves when the running check (if any) has settled: the daemon's shutdown and tests. */
export async function jevJobSettled(): Promise<void> {
  const p = lane.running;
  if (p) await p;
}
/** Test seam only. */
export function resetJevJobForTests(): void { lane.running = null; lane.notBefore = 0; }

function nextModel(store: RunStore, nowMs: number): string | undefined {
  const rows = store.listJevModels();
  return rows.find((r) => r.state === "checking")?.model
    ?? rows.find((r) => r.state === "deferred" && (r.checked_at === null || nowMs - Date.parse(r.checked_at) > JEV_DEFER_RETRY_MS))?.model;
}

export type JevTickInput = Omit<JevJobDeps, "client"> & { makeClient: () => JevJobDeps["client"] };

/**
 * The signal-path tick's part (spec §2.4): discovery, then start the next model's check on its own promise. Synchronous:
 * it returns before the first Jev call settles and never throws. Not started while a check runs, after the stop signal,
 * or inside the outage backoff.
 */
export function jevVersionTick(i: JevTickInput): { noted: string[]; started: string | null } {
  const log = logOf(i);
  let noted: string[] = [];
  try { noted = discoverJevModels(i.store, i.now()); } catch (e) { log(`jev version check: discovery failed: ${errorCode(e)}`); }
  if (lane.running || i.signal.aborted || Date.parse(i.now()) < lane.notBefore) return { noted, started: null };
  let model: string | undefined;
  try { model = nextModel(i.store, Date.parse(i.now())); } catch (e) { log(`jev version check: model read failed: ${errorCode(e)}`); }
  if (!model) return { noted, started: null };
  const backOff = (): void => { lane.notBefore = Date.parse(i.now()) + JEV_JOB_OUTAGE_BACKOFF_MS; };
  const { makeClient, ...rest } = i;
  lane.running = (async () => runJevCheck({ ...rest, client: makeClient() }, model))()
    .then((r) => { if (r === "outage") backOff(); }, (e: unknown) => { log(`jev version check: ${model} failed: ${errorCode(e)}`); backOff(); })
    .finally(() => { lane.running = null; });
  return { noted, started: model };
}

/**
 * One model's check (spec §2.5), resumable: the tree runs A, A2 and B over the anchor's zh and mixed turns, then the golden
 * sets, then the outcome. Returns where it ended; a stop, an outage or a deferral leaves the rows for the next start.
 */
export async function runJevCheck(d: JevJobDeps, model: string): Promise<JevCheckResult> {
  const g = beginCheck(d, model);
  if (g === null) return "skipped";
  const anchor = loadAnchor(d.store);
  if (anchor.zh < JEV_ANCHOR_MIN_ZH) return finishInsufficient(d, model, g, anchor.zh);
  const tree = await runTree(d, model, g, anchor);
  if (tree !== "done") return tree;
  const golden = await runGoldens(d, model, g);
  if (golden !== "done") return golden;
  return finishCheck(d, model, g, anchor);
}

const progressGeneration = (json: string | null): number | null => {
  try { const p = (JSON.parse(json ?? "null") as { progress?: { generation?: unknown } } | null)?.progress?.generation; return typeof p === "number" ? p : null; } catch { return null; }
};

/** The generation this start works on: the stored progress's when it is the model's current one (resume), else a new one (the old rows never count). */
function beginCheck(d: JevJobDeps, model: string): number | null {
  let row = d.store.getJevModel(model);
  if (row?.state === "deferred" && d.store.setJevModelState(model, "deferred", "checking", "{}", d.now())) row = d.store.getJevModel(model);
  if (row?.state !== "checking") return null;
  if (progressGeneration(row.detail_json) === row.generation) return row.generation;
  const g = d.store.bumpJevModelGeneration(model);
  d.store.bumpJevModelAttempts(model);
  if (!d.store.setJevModelProgress(model, g, JSON.stringify({ progress: { generation: g, tree: 0 } }))) return null;
  resolveOpenIncidents(d.store, JEV_MODEL_INCIDENT_KINDS, jevModelSubject(model), d.now()); // a new check's outcome pages afresh
  logOf(d)(`jev version check: ${model} check started (generation ${g})`);
  return g;
}

interface AnchorTurn { turn: string; lang: string; state: RouteState }
/** The anchor as a check reads it: the zh and mixed turns (en inherits zh's verdict, §7), runs A and B, Paco's labels. */
interface AnchorSet { turns: AnchorTurn[]; zh: number; A: CheckRun; B: CheckRun; labels: Map<string, string> }

function loadAnchor(store: RunStore): AnchorSet {
  const turns = store.anchorStates().filter((s) => s.lang === "zh" || s.lang === "mixed")
    .map((s) => ({ turn: s.turn_id, lang: s.lang, state: JSON.parse(s.state_json) as RouteState }));
  const stateOf = new Map(turns.map((t) => [t.turn, t.state]));
  const run = (r: "A" | "B"): CheckRun => {
    const m = new Map<string, { state: RouteState; answers: Record<string, JevAnswer> }>();
    for (const row of store.anchorAnswers(r)) {
      const state = stateOf.get(row.turn_id);
      if (!state) continue;
      const t = m.get(row.turn_id) ?? { state, answers: {} };
      t.answers[row.question_id] = JSON.parse(row.answer_json) as JevAnswer;
      m.set(row.turn_id, t);
    }
    return m;
  };
  return { turns, zh: turns.filter((t) => t.lang === "zh").length, A: run("A"), B: run("B"), labels: new Map(store.anchorLabels().map((l) => [l.turn_id, l.category])) };
}

type FailedAsk = Extract<CandidateAsk, { why: "failed" }>["failure"];
/** A transport-class failure is an outage (retried at the next start); a malformed answer is this turn's failure only. */
const isOutage = (f: FailedAsk): boolean =>
  f.reason !== "error" || !["parse", "malformed_question", "other", "model_missing", "model_refusal"].includes(f.error_kind ?? "");

/** The tree runs (spec §2.5): each anchor turn's stored state through the six questions, canonical (A, A2) and permuted (B). */
async function runTree(d: JevJobDeps, model: string, g: number, anchor: AnchorSet): Promise<JevCheckResult | "done"> {
  const done = new Set(d.store.listJevCheckRuns(model, g, "tree").map((r) => r.run));
  let count = done.size;
  for (const [run, permute] of TREE_RUNS) {
    const questions = Object.fromEntries(treeQuestions(permute).map((q) => [q.id, toJevQuestion(q)]));
    for (const t of anchor.turns) {
      const key = `${run}:${t.turn}`;
      if (done.has(key)) continue;
      if (d.signal.aborted) return "stopped";
      const r = await askCandidate(d.client, { state: t.state, questions }, model);
      const stop = recordTreeAnswer(d, model, g, key, r);
      if (stop) return stop;
      count += 1;
      if (count % PROGRESS_EVERY === 0 && !d.store.setJevModelProgress(model, g, JSON.stringify({ progress: { generation: g, tree: count, of: 3 * anchor.turns.length } }))) return "skipped";
    }
  }
  return "done";
}

function recordTreeAnswer(d: JevJobDeps, model: string, g: number, run: string, r: CandidateAsk): JevCheckResult | null {
  const row = { model, generation: g, entry_id: "tree", run, created_at: d.now() };
  if (r.ok) { d.store.recordJevCheckRun({ ...row, outcome: "answered", detail_json: JSON.stringify(r.answers) }); return null; }
  if (r.why === "other_model") return defer(d, model, g, r.reported);
  if (isOutage(r.failure)) return outage(d, model, r.failure);
  d.store.recordJevCheckRun({ ...row, outcome: "failed", detail_json: JSON.stringify({ reason: r.failure.reason, error_kind: r.failure.error_kind ?? null }) });
  return null;
}

/** Spec §2.4: answers kept reporting another model (the alias served the old id) after the retries → deferred, retried a day later. */
function defer(d: JevJobDeps, model: string, g: number, reported: string): JevCheckResult {
  d.store.setJevModelState(model, "checking", "deferred", JSON.stringify({ reason: "other_model", reported, generation: g }), d.now());
  logOf(d)(`jev version check: ${model} deferred (answers reported ${reported})`);
  return "deferred";
}

/** An outage reaches Paco (the Jev outage incidents) and the check resumes at a later start. */
function outage(d: JevJobDeps, model: string, f: FailedAsk): JevCheckResult {
  openJevIncident(d.store, f, { source: "version_check", model });
  logOf(d)(`jev version check: ${model} paused on an outage (${f.reason}/${f.error_kind ?? "-"})`);
  return "outage";
}

/** Spec §2.5 e: each golden set on the candidate, one row per entry; a drift opens one incident per entry and never disarms. */
async function runGoldens(d: JevJobDeps, model: string, g: number): Promise<JevCheckResult | "done"> {
  for (const entry of d.golden ?? CHECK_GOLDEN_ENTRIES) {
    if (d.store.getJevCheckRun(model, g, entry, "golden")) continue;
    if (d.signal.aborted) return "stopped";
    const r = await runGoldenForModel(entry, model, d.client, d.store, d.signal);
    if (r.kind === "stopped") return "stopped";
    if (r.kind === "wrong_model") return defer(d, model, g, r.reported);
    if (r.kind === "failed" && r.failure && isOutage(r.failure)) return outage(d, model, r.failure);
    const outcome = r.kind === "judged" ? r.outcome : "skipped";
    d.store.recordJevCheckRun({ model, generation: g, entry_id: entry, run: "golden", outcome, detail_json: JSON.stringify(r.kind === "judged" ? { missed: r.missed } : {}), created_at: d.now() });
    const subject = `${entry}:${model}`;
    if (outcome === "drift" && r.kind === "judged") openAlertedIncident(d.store, { kind: "decision_golden_drift", subject, detail: { entry, model, missed: r.missed }, chat_id: d.chatId, now: d.now() });
    if (outcome === "ok") resolveOpenIncidents(d.store, GOLDEN_DRIFT, subject, d.now());
  }
  return "done";
}

/** The candidate's three runs over the anchor turns, from this generation's answered rows only. */
function candidateRuns(store: RunStore, model: string, g: number, anchor: AnchorSet): Record<"A" | "A2" | "B", CheckRun> {
  const stateOf = new Map(anchor.turns.map((t) => [t.turn, t.state]));
  const out = { A: new Map(), A2: new Map(), B: new Map() } as Record<"A" | "A2" | "B", Map<string, { state: RouteState; answers: Record<string, JevAnswer> }>>;
  for (const row of store.listJevCheckRuns(model, g, "tree")) {
    if (row.outcome !== "answered") continue;
    const [run, turn] = [row.run.slice(0, row.run.indexOf(":")), row.run.slice(row.run.indexOf(":") + 1)];
    const state = stateOf.get(turn);
    if (state && (run === "A" || run === "A2" || run === "B")) out[run].set(turn, { state, answers: JSON.parse(row.detail_json) as Record<string, JevAnswer> });
  }
  return out;
}

/** Spec §2.5 a-d over the fully answered zh and mixed turns only: every run of the candidate and of the anchor has the turn. */
function finishCheck(d: JevJobDeps, model: string, g: number, anchor: AnchorSet): JevCheckResult {
  const cand = candidateRuns(d.store, model, g, anchor);
  const full = anchor.turns.filter((t) => [cand.A, cand.A2, cand.B, anchor.A, anchor.B].every((r) => r.has(t.turn)));
  const zh = full.filter((t) => t.lang === "zh").length;
  if (zh < JEV_ANCHOR_MIN_ZH) return finishInsufficient(d, model, g, zh);
  const only = (r: CheckRun): CheckRun => new Map(full.map((t) => [t.turn, r.get(t.turn)!]));
  const [aA, aB, cA, cA2, cB] = [anchor.A, anchor.B, cand.A, cand.A2, cand.B].map(only) as [CheckRun, CheckRun, CheckRun, CheckRun, CheckRun];
  const label = (t: string): string | undefined => anchor.labels.get(t);
  const verdict = judge({ anchorAB: agreementByCheck(aA, aB), anchorLanes: { A: laneCountsOf(aA, label), B: laneCountsOf(aB, label) },
    candVsAnchor: agreementByCheck(cA, aA), candSelf: agreementByCheck(cA, cA2), candAB: agreementByCheck(cA, cB), candLanes: laneCountsOf(cA, label) });
  const out = checkOutcome(verdict);
  const golden = Object.fromEntries((d.golden ?? CHECK_GOLDEN_ENTRIES).map((e) => [e, d.store.getJevCheckRun(model, g, e, "golden")?.outcome ?? "-"]));
  const summary = { turns: full.length, zh_turns: zh, generation: g, golden };
  const detail = { ...(JSON.parse(out.detail_json) as Record<string, unknown>), ...summary, ...(out.state === "drifted" ? { card_chat: d.chatId } : {}) };
  if (!d.store.setJevModelState(model, "checking", out.state, JSON.stringify(detail), d.now())) return "skipped";
  logOf(d)(`jev version check: ${model} ${out.state} (${full.length} turns)`);
  if (out.state === "trusted") sendNotice(d, model, g, verdict, summary);
  else page(d, model, g, "jev_model_drifted", { model, generation: g, failed_questions: verdict.failed_questions, route_failed: verdict.route_failed, lanes_disarmed: verdict.lanes_disarmed },
    driftText(model, verdict, summary));
  return out.state;
}

function finishInsufficient(d: JevJobDeps, model: string, g: number, zh: number): JevCheckResult {
  const detail = { zh_turns: zh, need: JEV_ANCHOR_MIN_ZH, generation: g, command: ANCHOR_COMMAND, card_chat: d.chatId };
  if (!d.store.setJevModelState(model, "checking", "insufficient", JSON.stringify(detail), d.now())) return "skipped";
  logOf(d)(`jev version check: ${model} insufficient (${zh} zh anchor turns)`);
  page(d, model, g, "jev_model_insufficient", { model, generation: g, zh_turns: zh, need: JEV_ANCHOR_MIN_ZH, command: ANCHOR_COMMAND },
    `**Jev version check: ${model} cannot be checked.** The anchor has ${zh} zh turns to compare (need ${JEV_ANCHOR_MIN_ZH}); nothing is armed on this model.\n`
    + `Import Paco's reference with \`${ANCHOR_COMMAND}\`, then \`houge jev check\`. Accept arms everything on ${model}.`);
  return "insufficient";
}

// ── Paco's one message per outcome (spec §2.5 d): a notice on a pass; one incident with an Accept card otherwise ──

const signed = (m: number | null): string => (m === null ? "n/a" : `${m >= 0 ? "+" : ""}${m.toFixed(3)}`);
/** The margins per check (a: close to the anchor; b: not noisier), null rendered as n/a. */
export function marginLines(margins: Record<string, CheckMargin>): string[] {
  return CHECK_IDS.map((id) => `- ${id}: a ${signed(margins[id]?.a ?? null)} · b ${signed(margins[id]?.b ?? null)}`);
}
const recallLines = (drops: readonly RecallDrop[]): string[] =>
  drops.map((r) => `- ${r.lane} ${r.anchor} → ${r.candidate} (allowed drop ${r.allowed}; ${r.labelled} labelled)`);
type Summary = { turns: number; zh_turns: number; golden: Record<string, string> };
const goldenLine = (s: Summary): string[] => (Object.keys(s.golden).length > 0 ? [`Golden sets: ${Object.entries(s.golden).map(([e, o]) => `${e} ${o}`).join(" · ")}`] : []);
const comparedLine = (s: Summary): string => `Compared ${s.turns} anchor turns (${s.zh_turns} zh). Margins (≥ 0 passes; a = close to the anchor, b = not noisier than it):`;

function sendNotice(d: JevJobDeps, model: string, g: number, v: CheckVerdict, s: Summary): void {
  const drops = v.recall_drops.length > 0 ? ["Recall drops (reported only; nothing disarmed, those turns go to the planner):", ...recallLines(v.recall_drops)] : [];
  const text = [`**Jev version check: ${model} passed.** The triage tree arms on it.`, comparedLine(s), ...marginLines(v.margins), ...drops, ...goldenLine(s)].join("\n");
  if (!d.chatId) return;
  d.store.enqueueNotification({ target: { kind: "telegram", chat_id: d.chatId }, intent_type: "progress", idempotency_key: `jev_check:${model}:${g}:notice`,
    correlation_id: "jev-version-check", payload: { text } });
}

function driftText(model: string, v: CheckVerdict, s: Summary): string {
  const what = [v.route_failed ? "the route check failed, so the whole tree" : "", v.failed_questions.length > 0 ? `questions ${v.failed_questions.join(", ")}` : "",
    v.lanes_disarmed.length > 0 ? `lanes ${v.lanes_disarmed.join(", ")}` : ""].filter(Boolean).join("; ");
  const drops = v.recall_drops.length > 0 ? ["Recall drops (reported only):", ...recallLines(v.recall_drops)] : [];
  return [`**Jev version check: ${model} drifted.** Unarmed on this model: ${what}. The rest stays armed.`, comparedLine(s), ...marginLines(v.margins), ...drops, ...goldenLine(s),
    `Accept arms everything on ${model}.`].join("\n");
}

/** One alerted incident whose page is the Accept card (its own notification, never also the generic incident text). */
function page(d: JevJobDeps, model: string, g: number, kind: string, detail: Record<string, unknown>, text: string): void {
  const opened = openAlertedIncident(d.store, { kind, subject: jevModelSubject(model), detail, now: d.now(), ...(d.chatId ? { env: {} } : {}) });
  if (!opened || !d.chatId) return;
  const button: NotificationButton = { text: `Accept ${model}`, data: jevAcceptData(model) };
  d.store.enqueueNotification({ target: { kind: "telegram", chat_id: d.chatId }, intent_type: "progress", idempotency_key: `jev_check:${model}:${g}:card`,
    correlation_id: "jev-version-check", payload: { text, button_rows: [[button]] } });
}
