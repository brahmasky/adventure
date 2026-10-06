import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chatContextSince, resolveChatContextTurnChars, resolveChatContextTurns } from "../capabilities/intent.js";
import { computeCostUsd, JEV_PROVIDER } from "../llm/metered-pricing.js";
import type { ReplayTurnRow, RunStore } from "../run/run-store.js";
import type { CalibrationRow } from "./calibration.js";
import { marginOf, stateHash } from "./decide.js";
import { langOf, type Lang } from "./intent-question.js";
import { JEV_MODEL, type JevChoiceAnswer, type JevRequest, type JevResult } from "./jev-client.js";
import { buildTriageState, lastHougeTurnOf, TRIAGE_LANE, TRIAGE_QUESTIONS } from "./questions/triage.js";
import { criteriaHash, toJevQuestion, type Question } from "./questions/types.js";
import { runReplayCore, type ReplayCoreOutcome } from "./replay-core.js";
import { resolveTriageBars, TRIAGE_STATUS_ARM_ID, triageVerdict, type TriageBars } from "./thresholds.js";

/**
 * `houge jev replay triage` engine (spec §5.9 step 1). Every Telegram turn since the comparator epoch is replayed
 * against the frozen lane 1 questions on the state the LIVE path would have built at the turn's anchor (same
 * buildTriageState, same lastHougeTurnOf, same sanitiser — only the broker pass is absent in the CLI), so `state_hash`
 * joins to `jev_decisions.state_hash`. Rows carry ids, enums and numbers only — never message text.
 *
 * State parity: the thread cut and `last_houge_turn.age_s` use the live decision instant when the run has one (its
 * answered triage `jev_decisions` row, else its `triage` event), and the anchor otherwise. Known gaps: no broker in the
 * CLI (a turn carrying one of the broker secrets hashes differently); live cut the thread at claim and built the state
 * just before the Jev call, while the recorded instant is just after it, so an age on a half-second boundary can differ
 * by one; a pre-shadow turn has only its anchor. The report counts live rows with no replay match.
 */
export const TRIAGE_REPLAY_OUT = ".houge/jev-triage/replay.jsonl";
export const TRIAGE_PERMUTED_OUT = ".houge/jev-triage/replay-permuted.jsonl";
export const TRIAGE_LABELS_PATH = ".houge/jev-triage/labels.jsonl";
/** loop_step.capability exists since 2026-07-02: the comparator label's epoch (spec §5.9 universe = 288 Telegram runs). */
export const TRIAGE_LABEL_SINCE = "2026-07-02T00:00:00.000Z";
const DONE: ReadonlySet<string> = new Set(["ok", "skipped_state_too_large"]);
/** CJK text tokenises ~1.8× worse than chars/3 suggests (2026-09-26 lesson): reserve high, never under. */
const CJK_UNDERCOUNT = 1.8;

export interface TriageLabel { memory: boolean; status: boolean; pure: boolean | null; scope: "ask" | "research" | null; by: "paco"; at: string }
export type TriageReplayVerdict = "status" | "memory_pure" | "memory_mixed" | "fallthrough";
export interface TriageReplayRow {
  key: string; turn_id: string; run_id: string; lang: Lang; status: "ok" | "dry_run" | "skipped_state_too_large" | "jev_failed"; est_usd: number;
  attempt?: number; usd?: number; observed_lesson_write: boolean; observed_other_tools: boolean; state_hash: string;
  jev_lane?: string; p_memory?: number; p_status?: number; p_none?: number; conf_lane?: number; margin_lane?: number; p_pure?: number; scope?: string;
  verdict?: TriageReplayVerdict; model?: string; criteria_hash_lane?: string; error?: string; stop?: "auth" | "fused";
  p_none_tools?: never;
}
type Prepared = TriageReplayRow & { state: Record<string, unknown>; chars: number };

/** The lane question asked with its options reversed (memory, status, none): the order-bias probe (spec §3.6). */
export const TRIAGE_LANE_PERMUTED: Question = { ...TRIAGE_LANE, criteria: [...TRIAGE_LANE.criteria].reverse() };

/**
 * The replay judges every turn AS IF the lane were armed for its language and the reported model: with no calibration
 * row yet (slice 1 ships none) `triageVerdict` would answer `uncalibrated` for every turn and the report would be empty.
 * These rows never leave this module; production arming stays `CALIBRATED_ROWS` (Paco's commit).
 */
function armedAsIf(model: string): CalibrationRow[] {
  const ids = [...TRIAGE_QUESTIONS.map((q) => [q.id, criteriaHash(q)] as const), [TRIAGE_STATUS_ARM_ID, criteriaHash(TRIAGE_LANE)] as const];
  return ids.flatMap(([question_id, criteria_hash]) => (["zh", "en"] as const).map((lang) => ({ question_id, criteria_hash, model, lang, approved: "replay", evidence: "replay" })));
}

/** The verdict the live code would reach on these answers once armed (the one gate, `triageVerdict`, not a copy). */
export function replayVerdict(answers: Record<string, JevChoiceAnswer>, bars: TriageBars, lang: Lang, model: string): TriageReplayVerdict {
  const v = triageVerdict(answers, bars, lang, model, armedAsIf(model));
  return v.kind === "memory" ? (v.complete === "pure" ? "memory_pure" : "memory_mixed") : v.kind;
}

const LABEL_SCOPES = new Set(["ask", "research", null]);
function isLabel(r: Record<string, unknown>): r is Record<string, unknown> & TriageLabel & { turn_id: string } {
  return typeof r.turn_id === "string" && typeof r.memory === "boolean" && typeof r.status === "boolean"
    && (r.pure === null || typeof r.pure === "boolean") && LABEL_SCOPES.has(r.scope as string | null) && r.by === "paco" && typeof r.at === "string";
}

/** Paco's labels, keyed by turn_id (a later line overrides an earlier one). A malformed line throws: a dropped label is a silent bias. */
export function loadLabels(path: string): Map<string, TriageLabel> {
  const m = new Map<string, TriageLabel>();
  if (!existsSync(path)) return m;
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line) as Record<string, unknown>; } catch { throw new Error(`labels: line ${i + 1} is not JSON`); }
    if (!isLabel(r)) throw new Error(`labels: line ${i + 1} is not {turn_id, memory, status, pure, scope, by:"paco", at}`);
    const { turn_id, memory, status, pure, scope, by, at } = r;
    m.set(turn_id, { memory, status, pure, scope, by, at });
  });
  return m;
}

export interface TriageReplayDeps {
  store: RunStore; env: NodeJS.ProcessEnv; jev: (req: JevRequest) => Promise<JevResult>; outPath: string; maxUsd: number; dryRun: boolean;
  limit?: number; log?: (l: string) => void; permute?: boolean;
}

/** The real replay universe: Telegram turns since the label epoch, ignoring `--limit` (the report's denominator, not rows.length). */
export function triageUniverse(store: RunStore): number {
  return store.listReplayTurns({ sinceIso: TRIAGE_LABEL_SINCE }).filter((t) => store.runSource(t.run_id) === "telegram").length;
}

export async function runTriageReplay(d: TriageReplayDeps): Promise<ReplayCoreOutcome<TriageReplayRow>> {
  guardOutPath(d);
  const lane = d.permute ? TRIAGE_LANE_PERMUTED : TRIAGE_LANE;
  const suffix = d.permute ? ":perm" : "";
  const turns = d.store.listReplayTurns({ sinceIso: TRIAGE_LABEL_SINCE, ...(d.limit !== undefined ? { limit: d.limit } : {}) })
    .filter((t) => d.store.runSource(t.run_id) === "telegram");
  const byKey = new Map(turns.map((t) => [`${t.turn_id}${suffix}`, t]));
  return runReplayCore<TriageReplayRow>({
    source: () => [...byKey.keys()].map((key) => ({ key })),
    doneStatuses: DONE, outPath: d.outPath, maxUsd: d.maxUsd, dryRun: d.dryRun, ...(d.log ? { log: d.log } : {}),
    estimateUsd: (row) => jevUsd(Math.ceil(((row as Prepared).chars / 3) * CJK_UNDERCOUNT), d.env),
    prepare: async ({ key }) => prepareTurn(d, key, byKey.get(key)!),
    publicRow: (row) => { const { state: _s, chars: _c, ...rest } = row as Prepared; return rest; }, // no text in the outcome
    dispatch: async (row) => dispatchTurn(d, row as Prepared, lane)
  });
}

/** A wiring slip must not mix the permuted rows into the canonical file (or back): the report reads each file whole. */
function guardOutPath(d: TriageReplayDeps): void {
  const out = resolve(d.outPath);
  if (d.permute && out === resolve(TRIAGE_REPLAY_OUT)) throw new Error(`a permuted run must not write to the canonical ${TRIAGE_REPLAY_OUT}`);
  if (!d.permute && out === resolve(TRIAGE_PERMUTED_OUT)) throw new Error(`a canonical run must not write to the permuted ${TRIAGE_PERMUTED_OUT}`);
}

/** When the live path decided this turn: its answered triage decision row, else its `triage` event; undefined pre-shadow. */
function liveInstantOf(store: RunStore, run_id: string): string | undefined {
  return store.listJevDecisions(run_id).find((r) => r.point === "triage" && r.status === "answered")?.created_at
    ?? store.getLedgerEvents(run_id).find((e) => e.event_type === "triage")?.occurred_at;
}

function prepareTurn(d: TriageReplayDeps, key: string, t: ReplayTurnRow): Prepared | { skip: TriageReplayRow } {
  const caps = d.store.runLoopCapabilities(t.run_id);
  const at = liveInstantOf(d.store, t.run_id) ?? t.anchor ?? t.created_at;
  const recent = d.store.getChatTurnsBefore(t.chat_id, resolveChatContextTurns(d.env), chatContextSince(d.env, new Date(at)), at, t.run_id);
  const built = buildTriageState({ userText: t.text, recentTurns: recent, turnChars: resolveChatContextTurnChars(d.env), modality: "text",
    lastHougeTurn: lastHougeTurnOf(recent, Date.parse(at)) });
  const base: TriageReplayRow = { key, turn_id: t.turn_id, run_id: t.run_id, lang: langOf(t.text), status: "ok", est_usd: 0,
    observed_lesson_write: caps.includes("lesson_write"), observed_other_tools: caps.some((c) => c !== "lesson_write"),
    state_hash: built.ok ? stateHash(built.state) : "" };
  if (!built.ok) return { skip: { ...base, status: "skipped_state_too_large" } };
  return { ...base, state: built.state, chars: built.chars };
}

async function dispatchTurn(d: TriageReplayDeps, row: Prepared, lane: Question): Promise<TriageReplayRow> {
  const { state, chars: _chars, ...rest } = row;
  const questions: JevRequest["questions"] = {};
  for (const q of TRIAGE_QUESTIONS) questions[q.id] = toJevQuestion(q.id === lane.id ? lane : q);
  const r = await d.jev({ state, questions });
  if (!r.ok) {
    // The reason enum only — never the client's detail string (spec: rows carry ids, enums, numbers).
    const stop = r.reason === "fused" ? "fused" : r.reason === "auth" || r.reason === "no_key" ? "auth" : undefined;
    return { ...rest, status: "jev_failed", error: r.reason, ...(stop ? { stop } : {}) };
  }
  if (r.model !== JEV_MODEL) d.log?.(`warning: Jev reported model "${r.model}", pinned ${JEV_MODEL} — the report refuses mixed models`);
  const a = r.answers.lane!;
  return { ...rest, status: "ok", usd: jevUsd(r.input_tokens, d.env), model: r.model, criteria_hash_lane: criteriaHash(lane), jev_lane: a.choice,
    p_memory: a.probabilities.memory ?? 0, p_status: a.probabilities.status ?? 0, p_none: a.probabilities.none ?? 0,
    conf_lane: a.confidence, margin_lane: marginOf(a), p_pure: r.answers.complete?.probabilities.pure ?? 0,
    ...(r.answers.scope ? { scope: r.answers.scope.choice } : {}),
    verdict: replayVerdict(r.answers, resolveTriageBars(d.env), rest.lang, r.model) };
}

function jevUsd(tokens: number, env: NodeJS.ProcessEnv): number {
  return computeCostUsd(JEV_PROVIDER, JEV_MODEL, { input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0 }, env) ?? 0;
}
