import { createHash } from "node:crypto";
import { errorCode } from "../domain/error-code.js";
import { ANCHOR_COMMAND } from "../jev/anchor-import.js";
import { JEV_INCIDENT_SUBJECT, openJevIncident, resolveJevIncidentsOnAnswer } from "../jev/jev-incidents.js";
import type { JevAnswer, JevQuestion, JevRequest, JevResult } from "../jev/jev-client.js";
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
  /** The pause before every ask (default JEV_CHECK_PACE_MS); tests pass 0. */
  paceMs?: number;
}
/**
 * `retrying`: too few turns answered fully; the failed turns are asked once more at the next start. `pending`: a golden
 * set did not run (a malformed answer set); it is retried at a later start, after the outage backoff (final fix D1).
 */
export type JevCheckResult = "trusted" | "drifted" | "insufficient" | "deferred" | "stopped" | "outage" | "skipped" | "retrying" | "pending";

/**
 * The pause before each ask (runs and golden items alike): ~840 calls on Paco's TypeSafe key must not burst into a 429 that
 * makes his live triage fall back. A check then takes ~20-30 minutes on the background lane.
 */
export const JEV_CHECK_PACE_MS = 1_500;
/** A sleep that resolves at once when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
const paceOf = (d: JevJobDeps) => (): Promise<void> => abortableSleep(d.paceMs ?? JEV_CHECK_PACE_MS, d.signal);

/** After an outage the next start waits this long: the tick runs every poll cycle and must not hammer a down Jev. */
export const JEV_JOB_OUTAGE_BACKOFF_MS = 10 * 60_000;
/**
 * A deferred model (the alias served another id for too many turns) is retried an hour later, or sooner once the newest
 * JEV_DEFER_SERVED_ANSWERS Jev answers all report it (final fix A2: a canary day must not keep the lanes off for a day).
 */
export const JEV_DEFER_RETRY_MS = 3_600_000;
export const JEV_DEFER_SERVED_ANSWERS = 5;
export const JEV_MODEL_INCIDENT_KINDS: ReadonlySet<string> = new Set(["jev_model_drifted", "jev_model_insufficient"]);
/** Final fix B1: a turn whose ask hits an outage on this many separate starts is recorded unanswered; the pass moves on. */
export const JEV_TURN_OUTAGE_STARTS = 3;
/** Final fix B2: a model `checking` longer than this from its generation's start pages once (a check takes ~45 min). */
export const JEV_CHECK_STALL_MS = 3 * 3_600_000;
const STALLED: ReadonlySet<string> = new Set(["jev_model_check_stalled"]);
export const jevModelSubject = (model: string): string => `${JEV_INCIDENT_SUBJECT}:model:${model}`;
/** The Accept button's model key: 8 hex of sha256, so callback data stays short and carries no model text. */
export const modelHash = (model: string): string => createHash("sha256").update(model).digest("hex").slice(0, 8);
/** Keyed by the check's generation too: an old card cannot accept a newer drift Paco has not seen (≤ 29 bytes). */
export const jevAcceptData = (model: string, generation: number): string => `dec:jv:${modelHash(model)}:${generation}:acc`;
const TREE_RUNS = [["A", false], ["A2", false], ["B", true]] as const;
const TREE_RUN_IDS = TREE_RUNS.map(([r]) => r);
const PROGRESS_EVERY = 25;
const GOLDEN_DRIFT: ReadonlySet<string> = new Set(["decision_golden_drift"]);

/**
 * Final fix D2: the check no longer pages golden drift (its outcome notice or card carries it); boot resolves the
 * `decision_golden_drift` incidents an older check opened under `<entry>:<model>`, which nothing else would ever close.
 * The daily ticks' own incidents (subject = the bare entry id) stay. Returns how many were resolved.
 */
export function resolveLegacyGoldenModelIncidents(store: RunStore, now: string): number {
  let n = 0;
  for (const i of store.listOpenIncidents()) {
    if (!GOLDEN_DRIFT.has(i.kind) || !CHECK_GOLDEN_ENTRIES.some((e) => i.subject.startsWith(`${e}:`))) continue;
    n += resolveOpenIncidents(store, GOLDEN_DRIFT, i.subject, now);
  }
  return n;
}

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

/**
 * Requests always name the alias, so only the model it serves can be checked: the newest Jev answer in the ledger names it.
 * Checked when `checking`, or `deferred` an hour ago (sooner when the newest Jev answers all report it); an older id the
 * alias no longer serves is left as it is.
 */
function nextModel(store: RunStore, nowMs: number): string | undefined {
  const served = store.latestJevAttemptModel()?.model;
  const r = served === undefined ? undefined : store.getJevModel(served);
  if (r?.state === "checking") return r.model;
  if (r?.state !== "deferred") return undefined;
  if (r.checked_at === null || nowMs - Date.parse(r.checked_at) > JEV_DEFER_RETRY_MS) return r.model;
  const newest = store.latestJevAttemptModels(JEV_DEFER_SERVED_ANSWERS);
  return newest.length === JEV_DEFER_SERVED_ANSWERS && newest.every((m) => m === r.model) ? r.model : undefined;
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
  try { stallTick(i); } catch (e) { log(`jev version check: stall check failed: ${errorCode(e)}`); }
  if (lane.running || i.signal.aborted || Date.parse(i.now()) < lane.notBefore) return { noted, started: null };
  let model: string | undefined;
  try { model = nextModel(i.store, Date.parse(i.now())); } catch (e) { log(`jev version check: model read failed: ${errorCode(e)}`); }
  if (!model) return { noted, started: null };
  const backOff = (): void => { lane.notBefore = Date.parse(i.now()) + JEV_JOB_OUTAGE_BACKOFF_MS; };
  const { makeClient, ...rest } = i;
  lane.running = (async () => runJevCheck({ ...rest, client: makeClient() }, model))()
    .then((r) => { if (r === "outage" || r === "pending") backOff(); }, (e: unknown) => { log(`jev version check: ${model} failed: ${errorCode(e)}`); backOff(); })
    .finally(() => { lane.running = null; });
  return { noted, started: model };
}

/**
 * Final fix B2: the served model `checking` longer than JEV_CHECK_STALL_MS from its generation's start opens ONE alerted
 * incident; any model that left `checking` (its check finished, or it deferred) has it resolved.
 */
function stallTick(i: Pick<JevJobDeps, "store" | "chatId" | "now">): void {
  const now = i.now();
  const served = i.store.latestJevAttemptModel()?.model;
  for (const r of i.store.listJevModels()) {
    if (r.state !== "checking") { resolveOpenIncidents(i.store, STALLED, jevModelSubject(r.model), now); continue; }
    const p = progressOf(r.detail_json);
    if (r.model !== served || !p?.started_at || p.generation !== r.generation || Date.parse(now) - Date.parse(p.started_at) <= JEV_CHECK_STALL_MS) continue;
    const text = `**Stalled:** the Jev version check for ${r.model} is not finishing; lanes stay on the planner. Started ${p.started_at}; `
      + `\`houge jev models\` shows its progress, \`houge jev accept ${r.model}\` arms it without the check.`;
    const opened = openAlertedIncident(i.store, { kind: "jev_model_check_stalled", subject: jevModelSubject(r.model), detail: { model: r.model, generation: r.generation, started_at: p.started_at }, now, ...(i.chatId ? { env: {} } : {}) });
    if (opened && i.chatId) notify(i, `jev_check:${r.model}:${r.generation}:stalled`, text);
  }
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

/**
 * A running check's progress in `detail_json`: its generation and when it started, tree answers so far, whether the one
 * retry was spent, and the outage count per tree ask (final fix B1).
 */
interface Progress { generation: number; started_at?: string; tree?: number; of?: number; retried?: boolean; outages?: Record<string, number> }
function progressOf(json: string | null): Progress | null {
  try {
    const p = (JSON.parse(json ?? "null") as { progress?: Progress } | null)?.progress;
    return p && typeof p.generation === "number" ? p : null;
  } catch { return null; }
}
/** Merge into the stored progress; false when the model left `checking` or this generation (another writer moved it). */
function writeProgress(d: JevJobDeps, model: string, g: number, patch: Partial<Progress>): boolean {
  const cur = progressOf(d.store.getJevModel(model)?.detail_json ?? null) ?? { generation: g };
  return d.store.setJevModelProgress(model, g, JSON.stringify({ progress: { ...cur, ...patch, generation: g } }));
}

/** The generation this start works on: the stored progress's when it is the model's current one (resume, also after a deferral), else a new one (the old rows never count). */
function beginCheck(d: JevJobDeps, model: string): number | null {
  let row = d.store.getJevModel(model);
  if (row?.state === "deferred" && d.store.setJevModelState(model, "deferred", "checking", row.detail_json ?? "{}", d.now())) row = d.store.getJevModel(model);
  if (row?.state !== "checking") return null;
  const p = progressOf(row.detail_json);
  if (p?.generation === row.generation) return p.started_at || writeProgress(d, model, row.generation, { started_at: d.now() }) ? row.generation : null;
  const g = d.store.bumpJevModelGeneration(model);
  d.store.bumpJevModelAttempts(model);
  if (!d.store.setJevModelProgress(model, g, JSON.stringify({ progress: { generation: g, started_at: d.now(), tree: 0 } }))) return null;
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

/** One tree ask: an anchor turn's stored state and one run's questions, recorded under `key` (`<run>:<turn>`). */
interface TreeAsk { key: string; state: RouteState; questions: Record<string, JevQuestion> }
/** The ask's end: a result that ends the start, null when recorded, or `other` when every try reported another id (nothing recorded). */
async function askTurn(d: JevJobDeps, model: string, g: number, a: TreeAsk): Promise<JevCheckResult | null | { other: string }> {
  const r = await askCandidate(d.client, { state: a.state, questions: a.questions }, model, { signal: d.signal, pace: paceOf(d) });
  if (!r.ok && r.why === "other_model") return { other: r.reported };
  return recordTreeAnswer(d, model, g, a.key, r);
}

/**
 * The tree runs (spec §2.5): each anchor turn's stored state through the six questions, canonical (A, A2) and permuted (B).
 * Final fix A1: an ask the alias keeps answering from another id is skipped, and re-asked once at the end of the pass.
 */
async function runTree(d: JevJobDeps, model: string, g: number, anchor: AnchorSet): Promise<JevCheckResult | "done"> {
  const done = new Set(d.store.listJevCheckRuns(model, g, "tree").map((r) => r.run));
  const skipped: TreeAsk[] = [];
  let count = done.size;
  for (const [run, permute] of TREE_RUNS) {
    const questions = Object.fromEntries(treeQuestions(permute).map((q) => [q.id, toJevQuestion(q)]));
    for (const t of anchor.turns) {
      const a = { key: `${run}:${t.turn}`, state: t.state, questions };
      if (done.has(a.key)) continue;
      const r = await askTurn(d, model, g, a);
      if (r !== null && typeof r === "object") { skipped.push(a); continue; }
      if (r) return r;
      count += 1;
      if (count % PROGRESS_EVERY === 0 && !writeProgress(d, model, g, { tree: count, of: 3 * anchor.turns.length })) return "skipped";
    }
  }
  return reaskSkipped(d, model, g, anchor, skipped);
}

/** The skipped asks once more; then a deferral only when too few zh turns have the candidate's answers in every run. */
async function reaskSkipped(d: JevJobDeps, model: string, g: number, anchor: AnchorSet, skipped: readonly TreeAsk[]): Promise<JevCheckResult | "done"> {
  let reported: string | null = null;
  for (const a of skipped) {
    const r = await askTurn(d, model, g, a);
    if (r !== null && typeof r === "object") { reported = r.other; continue; }
    if (r) return r;
  }
  if (reported === null || candidateZh(d.store, model, g, anchor) >= JEV_ANCHOR_MIN_ZH) return "done";
  return defer(d, model, g, reported);
}

/** The zh anchor turns the candidate answered in every tree run of this generation. */
function candidateZh(store: RunStore, model: string, g: number, anchor: AnchorSet): number {
  const answered = new Set(store.listJevCheckRuns(model, g, "tree").filter((r) => r.outcome === "answered").map((r) => r.run));
  return anchor.turns.filter((t) => t.lang === "zh" && TREE_RUN_IDS.every((run) => answered.has(`${run}:${t.turn}`))).length;
}

function recordTreeAnswer(d: JevJobDeps, model: string, g: number, run: string, r: CandidateAsk): JevCheckResult | null {
  const row = { model, generation: g, entry_id: "tree", run, created_at: d.now() };
  if (r.ok) {
    d.store.recordJevCheckRun({ ...row, outcome: "answered", detail_json: JSON.stringify(r.answers) });
    resolveJevIncidentsOnAnswer(d.store); // as the live path: an answer disproves an open outage (the next one pages again)
    return null;
  }
  if (r.why === "stopped") return "stopped";
  if (r.why === "other_model") return defer(d, model, g, r.reported); // askTurn takes this case first; kept so the switch stays total
  if (isOutage(r.failure)) return turnOutage(d, model, g, run, r.failure);
  d.store.recordJevCheckRun({ ...row, outcome: "failed", detail_json: JSON.stringify({ reason: r.failure.reason, error_kind: r.failure.error_kind ?? null }) });
  return null;
}

/** Final fix B1: an outage on one ask pauses the start, until the same ask has hit one on JEV_TURN_OUTAGE_STARTS starts: then it is unanswered. */
function turnOutage(d: JevJobDeps, model: string, g: number, run: string, f: FailedAsk): JevCheckResult | null {
  const outages = progressOf(d.store.getJevModel(model)?.detail_json ?? null)?.outages ?? {};
  const n = (outages[run] ?? 0) + 1;
  if (!writeProgress(d, model, g, { outages: { ...outages, [run]: n } })) return "skipped";
  if (n < JEV_TURN_OUTAGE_STARTS) return outage(d, model, f);
  openJevIncident(d.store, f, { source: "version_check", model });
  d.store.recordJevCheckRun({ model, generation: g, entry_id: "tree", run, outcome: "failed", created_at: d.now(),
    detail_json: JSON.stringify({ reason: f.reason, error_kind: f.error_kind ?? null, outages: n }) });
  logOf(d)(`jev version check: ${model} ask unanswered after ${n} outages (${f.reason}/${f.error_kind ?? "-"})`);
  return null;
}

/**
 * Spec §2.4, final fix A2: the alias kept serving another id → deferred, retried an hour later (or sooner, nextModel). The
 * state and ONE notice (per check generation, never an alerted page) commit together.
 */
function defer(d: JevJobDeps, model: string, g: number, reported: string): JevCheckResult {
  const progress = progressOf(d.store.getJevModel(model)?.detail_json ?? null) ?? { generation: g }; // kept: a later start resumes this generation
  const written = d.store.inTransaction(() => {
    if (!d.store.setJevModelState(model, "checking", "deferred", JSON.stringify({ reason: "other_model", reported, generation: g, progress }), d.now())) return false;
    notify(d, `jev_check:${model}:${g}:deferred`, `**Jev version check: ${model} waits.** Jev is serving two versions; the check retries in an hour, `
      + `or sooner once Jev answers only from ${model}. Nothing is armed on ${model} until it passes; those turns go to the planner.`);
    return true;
  });
  if (!written) return "skipped";
  logOf(d)(`jev version check: ${model} deferred (answers reported ${reported})`);
  return "deferred";
}

/** A plain notice (no page, no button) to Paco's chat, or the operator chat when the job has none; logged when there is neither. */
function notify(d: Pick<JevJobDeps, "store" | "chatId" | "log">, key: string, text: string): void {
  const chat = d.chatId ?? process.env.HOUGE_TELEGRAM_CHAT_ID?.trim();
  if (!chat) { logOf(d)("jev version check: no chat for the notice"); return; }
  d.store.enqueueNotification({ target: { kind: "telegram", chat_id: chat }, intent_type: "progress", idempotency_key: key, correlation_id: "jev-version-check", payload: { text } });
}

/** An outage reaches Paco (the Jev outage incidents) and the check resumes at a later start. */
function outage(d: JevJobDeps, model: string, f: FailedAsk): JevCheckResult {
  openJevIncident(d.store, f, { source: "version_check", model });
  logOf(d)(`jev version check: ${model} paused on an outage (${f.reason}/${f.error_kind ?? "-"})`);
  return "outage";
}

/**
 * Spec §2.5 e: each golden set on the candidate, one row per judged entry; a drift is reported in the outcome message and
 * never disarms (final fix D2: no incident of its own). Final fix D1: an entry that did not run (another id after the
 * retries, a malformed answer set, an outage) records nothing and stays pending for a later start; the model cannot
 * finish while one is pending.
 */
async function runGoldens(d: JevJobDeps, model: string, g: number): Promise<JevCheckResult | "done"> {
  let reported: string | null = null; let pending = 0;
  for (const entry of d.golden ?? CHECK_GOLDEN_ENTRIES) {
    if (d.store.getJevCheckRun(model, g, entry, "golden")) continue;
    if (d.signal.aborted) return "stopped";
    const r = await runGoldenForModel(entry, model, d.client, d.store, d.signal, paceOf(d));
    if (r.kind === "stopped") return "stopped";
    if (r.kind === "wrong_model") { reported = r.reported; continue; }
    if (r.kind === "failed") {
      if (r.failure && isOutage(r.failure)) return outage(d, model, r.failure);
      pending += 1; logOf(d)(`jev version check: ${model} golden ${entry} did not run (${r.failure?.error_kind ?? "malformed"}); pending`);
      continue;
    }
    resolveJevIncidentsOnAnswer(d.store);
    d.store.recordJevCheckRun({ model, generation: g, entry_id: entry, run: "golden", outcome: r.outcome, detail_json: JSON.stringify({ missed: r.missed }), created_at: d.now() });
  }
  if (reported !== null) return defer(d, model, g, reported);
  return pending > 0 ? "pending" : "done";
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
  if (zh < JEV_ANCHOR_MIN_ZH) return tooFewAnswered(d, model, g, zh, anchor.zh);
  const only = (r: CheckRun): CheckRun => new Map(full.map((t) => [t.turn, r.get(t.turn)!]));
  const [aA, aB, cA, cA2, cB] = [anchor.A, anchor.B, cand.A, cand.A2, cand.B].map(only) as [CheckRun, CheckRun, CheckRun, CheckRun, CheckRun];
  const label = (t: string): string | undefined => anchor.labels.get(t);
  const verdict = judge({ anchorAB: agreementByCheck(aA, aB), anchorLanes: { A: laneCountsOf(aA, label), B: laneCountsOf(aB, label) },
    candVsAnchor: agreementByCheck(cA, aA), candSelf: agreementByCheck(cA, cA2), candAB: agreementByCheck(cA, cB), candLanes: laneCountsOf(cA, label) });
  const out = checkOutcome(verdict);
  const golden = Object.fromEntries((d.golden ?? CHECK_GOLDEN_ENTRIES).map((e) => [e, d.store.getJevCheckRun(model, g, e, "golden")?.outcome ?? "-"]));
  const summary = { turns: full.length, zh_turns: zh, generation: g, golden };
  const detail = { ...(JSON.parse(out.detail_json) as Record<string, unknown>), ...summary, ...(out.state === "drifted" ? { card_chat: d.chatId } : {}) };
  const written = d.store.inTransaction(() => { // the state and its one message commit together: a crash never loses Paco's message
    if (!d.store.setJevModelState(model, "checking", out.state, JSON.stringify(detail), d.now())) return false;
    if (out.state === "trusted") sendNotice(d, model, g, verdict, summary);
    else page(d, model, g, "jev_model_drifted", { model, generation: g, failed_questions: verdict.failed_questions, route_failed: verdict.route_failed, lanes_disarmed: verdict.lanes_disarmed },
      driftText(model, verdict, summary));
    return true;
  });
  if (!written) return "skipped";
  logOf(d)(`jev version check: ${model} ${out.state} (${full.length} turns)`);
  return out.state;
}

/** Terminal `insufficient` with its own detail and card, state and message in one transaction. */
function markInsufficient(d: JevJobDeps, model: string, g: number, detail: Record<string, unknown>, text: string): JevCheckResult {
  const written = d.store.inTransaction(() => {
    if (!d.store.setJevModelState(model, "checking", "insufficient", JSON.stringify({ ...detail, generation: g, card_chat: d.chatId }), d.now())) return false;
    page(d, model, g, "jev_model_insufficient", { model, generation: g, ...detail }, text);
    return true;
  });
  return written ? "insufficient" : "skipped";
}

/** The anchor itself is too small (or absent): nothing to compare against until Paco imports it. */
function finishInsufficient(d: JevJobDeps, model: string, g: number, zh: number): JevCheckResult {
  logOf(d)(`jev version check: ${model} insufficient (${zh} zh anchor turns)`);
  return markInsufficient(d, model, g, { reason: "anchor_too_small", zh_turns: zh, need: JEV_ANCHOR_MIN_ZH, command: ANCHOR_COMMAND },
    `**Jev version check: ${model} cannot be checked.** The anchor has ${zh} zh turns to compare (need ${JEV_ANCHOR_MIN_ZH}); nothing is armed on this model.\n`
    + `Import Paco's reference with \`${ANCHOR_COMMAND}\`; the check then runs by itself. Accept arms everything on ${model}.`);
}

/**
 * The anchor is there but the candidate answered too few zh turns fully (its malformed answers): the failed turns are asked
 * once more at the next start; a second shortfall is `insufficient` with this reason, never the no-anchor text.
 */
function tooFewAnswered(d: JevJobDeps, model: string, g: number, answered: number, anchorZh: number): JevCheckResult {
  if (!progressOf(d.store.getJevModel(model)?.detail_json ?? null)?.retried) {
    d.store.deleteFailedJevCheckRuns(model, g);
    if (!writeProgress(d, model, g, { retried: true })) return "skipped";
    logOf(d)(`jev version check: ${model} answered ${answered} zh turns fully; failed turns retried at the next start`);
    return "retrying";
  }
  logOf(d)(`jev version check: ${model} insufficient (${answered} of ${anchorZh} zh turns answered)`);
  return markInsufficient(d, model, g, { reason: "answered_too_few", answered_zh: answered, anchor_zh: anchorZh, need: JEV_ANCHOR_MIN_ZH },
    `**Jev version check: ${model} answered too few turns.** It answered ${answered} of ${anchorZh} zh anchor turns fully (need ${JEV_ANCHOR_MIN_ZH}), after one retry; nothing is armed on this model.\n`
    + `\`houge jev check\` runs the check again. Accept arms everything on ${model} and makes its answers the reference the next Jev version is checked against.`);
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
  notify(d, `jev_check:${model}:${g}:notice`, text);
}

function driftText(model: string, v: CheckVerdict, s: Summary): string {
  const what = [v.route_failed ? "the route check failed, so the whole tree" : "", v.failed_questions.length > 0 ? `questions ${v.failed_questions.join(", ")}` : "",
    v.lanes_disarmed.length > 0 ? `lanes ${v.lanes_disarmed.join(", ")}` : ""].filter(Boolean).join("; ");
  const drops = v.recall_drops.length > 0 ? ["Recall drops (reported only):", ...recallLines(v.recall_drops)] : [];
  return [`**Jev version check: ${model} drifted.** Unarmed on this model: ${what}. The rest stays armed.`, comparedLine(s), ...marginLines(v.margins), ...drops, ...goldenLine(s),
    `Accept arms everything on ${model} and makes its answers the reference the next Jev version is checked against.`].join("\n");
}

/** One alerted incident whose page is the Accept card (its own notification, never also the generic incident text). */
function page(d: JevJobDeps, model: string, g: number, kind: string, detail: Record<string, unknown>, text: string): void {
  const opened = openAlertedIncident(d.store, { kind, subject: jevModelSubject(model), detail, now: d.now(), ...(d.chatId ? { env: {} } : {}) });
  if (!opened || !d.chatId) return;
  const button: NotificationButton = { text: `Accept ${model}`, data: jevAcceptData(model, g) };
  d.store.enqueueNotification({ target: { kind: "telegram", chat_id: d.chatId }, intent_type: "progress", idempotency_key: `jev_check:${model}:${g}:card`,
    correlation_id: "jev-version-check", payload: { text, button_rows: [[button]] } });
}
