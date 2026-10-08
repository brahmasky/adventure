import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildIntentQuestion, buildIntentSystemPrompt, chatContextSince, countTrailingClarifyTurns,
  resolveChatContextTurnChars, resolveChatContextTurns, type Intent
} from "../capabilities/intent.js";
import { computeCostUsd, JEV_PROVIDER } from "../llm/metered-pricing.js";
import type { ReplayTurnRow, RunStore } from "../run/run-store.js";
import { JEV_REQUEST_MODEL, type JevRequest, type JevResult } from "./jev-client.js";
import { buildJevIntentRequest, langOf, type Lang } from "./intent-question.js";
import { llmLabel, observedAction, type ObservedAction } from "./labels.js";

export { llmLabel, observedAction, type ObservedAction } from "./labels.js";

/**
 * `houge jev-shadow replay` engine (Jev spec 2026-09-25, rollout steps 1–3). Sequential by design:
 * the replayed LLM leg must not compete with the live daemon, and one-at-a-time dispatch makes the
 * --max-usd reservation exact. Rows carry labels and numbers only — never message text.
 */
export const REPLAY_OUT_PATH = ".houge/jev-shadow/replay.jsonl";

export type ReplayStatus = "ok" | "dry_run" | "skipped_state_too_large" | "skipped_no_anchor" | "jev_failed" | "llm_failed";
export interface ReplayRow {
  turn_id: string;
  run_id: string;
  lang: Lang;
  anchor_kind: "classify" | "run_start" | null;
  status: ReplayStatus;
  recorded_intent: string;
  observed_action: ObservedAction;
  est_tokens: number;
  jev_intent?: string;
  jev_confidence?: number;
  jev_probabilities?: Record<string, number>;
  jev_model?: string;
  llm_intent?: Intent;
  llm_parsed?: boolean;
  error?: string;
}
export interface ReplayDeps {
  store: Pick<RunStore, "listReplayTurns" | "getChatTurnsBefore" | "runLoopCapabilities">;
  env: NodeJS.ProcessEnv;
  jev: (req: JevRequest) => Promise<JevResult>;
  classifyLlm: (question: string, system: string) => Promise<{ ok: true; raw: string } | { ok: false; error: string }>;
  outPath: string;
  maxUsd: number;
  dryRun: boolean;
  sinceIso?: string;
  limit?: number;
  log?: (line: string) => void;
}
export interface ReplayOutcome {
  rows: ReplayRow[];
  spentUsd: number;
  estimatedUsd: number;
  stopped?: "budget" | "auth" | "fused";
}

const DONE: ReadonlySet<ReplayStatus> = new Set(["ok", "skipped_state_too_large", "skipped_no_anchor"]);

/** chars/3 for CJK-heavy text, chars/4 otherwise — only for the pre-dispatch cost reservation. */
function estimateTokens(chars: number, lang: Lang): number {
  return Math.ceil(chars / (lang === "en" ? 4 : 3));
}

function readDone(outPath: string): Map<string, ReplayRow> {
  const done = new Map<string, ReplayRow>();
  if (!existsSync(outPath)) return done;
  for (const line of readFileSync(outPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    let row: ReplayRow;
    try {
      row = JSON.parse(line) as ReplayRow;
    } catch {
      continue; // a torn line from a crash mid-append — skip it, don't crash resume
    }
    if (DONE.has(row.status)) done.set(row.turn_id, row);
    else done.delete(row.turn_id);
  }
  return done;
}

export async function runReplay(deps: ReplayDeps): Promise<ReplayOutcome> {
  const log = deps.log ?? (() => {});
  const done = deps.dryRun ? new Map<string, ReplayRow>() : readDone(deps.outPath);
  if (!deps.dryRun) mkdirSync(dirname(deps.outPath), { recursive: true });
  const turns = deps.store.listReplayTurns({
    ...(deps.sinceIso !== undefined ? { sinceIso: deps.sinceIso } : {}),
    ...(deps.limit !== undefined ? { limit: deps.limit } : {})
  });
  const rows: ReplayRow[] = [];
  let spentUsd = 0;
  let estimatedUsd = 0;
  // Seeded from the resumed rows: a move between two invocations over one file is still a move within the run's evidence.
  const resumedModel = [...done.values()].find((r) => r.jev_model !== undefined)?.jev_model;
  const offModelWarned: ModelWatch = { warned: false, ...(resumedModel ? { first: resumedModel } : {}) };

  for (const turn of turns) {
    const prior = done.get(turn.turn_id);
    if (prior) {
      rows.push(prior);
      continue;
    }
    const prepared = prepare(deps, turn);
    if ("row" in prepared) {
      emit(deps, rows, prepared.row);
      continue;
    }
    const step = await dispatchTurn(deps, turn, prepared, rows, spentUsd, log, turns.length, offModelWarned);
    spentUsd = step.spentUsd;
    estimatedUsd += step.estimatedUsd;
    if (step.stopped) return { rows, spentUsd, estimatedUsd, stopped: step.stopped };
  }
  return { rows, spentUsd, estimatedUsd };
}

type Prepared =
  | { row: ReplayRow }
  | { base: ReplayRow; request: JevRequest; llmQuestion: string; llmSystem: string };
type PreparedOk = Extract<Prepared, { request: JevRequest }>;

/**
 * One turn's dispatch: reserve its estimate, honor --max-usd / --dry-run, call Jev then the LLM,
 * and emit the resulting row. Split out of {@link runReplay} to keep the loop body under the
 * project's ~50-line function rule.
 */
async function dispatchTurn(
  deps: ReplayDeps, turn: ReplayTurnRow, prepared: PreparedOk, rows: ReplayRow[],
  spentUsd: number, log: (line: string) => void, total: number, offModelWarned: ModelWatch
): Promise<{ spentUsd: number; estimatedUsd: number; stopped?: "budget" | "auth" | "fused" }> {
  const estUsd = jevUsd(prepared.base.est_tokens, deps.env);
  if (deps.dryRun) {
    rows.push({ ...prepared.base, status: "dry_run" });
    return { spentUsd, estimatedUsd: estUsd };
  }
  if (spentUsd + estUsd > deps.maxUsd) {
    log(`stopping: next request would exceed --max-usd ${deps.maxUsd}`);
    return { spentUsd, estimatedUsd: estUsd, stopped: "budget" };
  }
  const jev = await deps.jev(prepared.request);
  if (!jev.ok) {
    // Never the provider's own prose here — only our fixed-literal reason/detail (jev-client only
    // emits bounded strings like "HTTP 500" / "timed out after Nms").
    emit(deps, rows, { ...prepared.base, status: "jev_failed", error: `${jev.reason}: ${jev.detail}` });
    const stopped =
      jev.reason === "fused" ? ("fused" as const)
      : jev.reason === "auth" || jev.reason === "no_key" ? ("auth" as const)
      : undefined;
    return { spentUsd, estimatedUsd: estUsd, ...(stopped ? { stopped } : {}) };
  }
  watchModel(offModelWarned, jev.model, log);
  const newSpent = spentUsd + jevUsd(jev.input_tokens, deps.env);
  const answer = jev.answers.intent!;
  const withJev: ReplayRow = {
    ...prepared.base, status: "ok", jev_intent: answer.choice, jev_confidence: answer.confidence,
    jev_probabilities: answer.probabilities, jev_model: jev.model
  };
  const llm = await deps.classifyLlm(prepared.llmQuestion, prepared.llmSystem);
  if (!llm.ok) {
    // Fixed literal only — a stderr excerpt from the agy-cli leg can echo the prompt.
    emit(deps, rows, { ...withJev, status: "llm_failed", error: "llm_chain_failed" });
    return { spentUsd: newSpent, estimatedUsd: estUsd };
  }
  const label = llmLabel(llm.raw);
  emit(deps, rows, { ...withJev, llm_intent: label.intent, llm_parsed: label.parsed });
  log(`${rows.length}/${total} ${turn.turn_id} jev=${answer.choice}@${answer.confidence.toFixed(2)} llm=${label.intent}`);
  return { spentUsd: newSpent, estimatedUsd: estUsd };
}

function prepare(deps: ReplayDeps, turn: ReplayTurnRow): Prepared {
  const lang = langOf(turn.text);
  const base: ReplayRow = {
    turn_id: turn.turn_id, run_id: turn.run_id, lang, anchor_kind: turn.anchor_kind, status: "ok",
    recorded_intent: turn.recorded_intent, observed_action: observedAction(deps.store.runLoopCapabilities(turn.run_id)), est_tokens: 0
  };
  if (turn.anchor === null) return { row: { ...base, status: "skipped_no_anchor" } };
  const anchor = new Date(turn.anchor);
  const turnChars = resolveChatContextTurnChars(deps.env);
  const recent = deps.store.getChatTurnsBefore(
    turn.chat_id, resolveChatContextTurns(deps.env), chatContextSince(deps.env, anchor), turn.anchor, turn.run_id
  );
  const clarifyCount = countTrailingClarifyTurns(recent);
  const built = buildJevIntentRequest(turn.text, recent, turnChars, clarifyCount);
  if (!built.ok) return { row: { ...base, status: "skipped_state_too_large" } };
  return {
    base: { ...base, est_tokens: estimateTokens(built.chars, lang) },
    request: built.request,
    llmQuestion: buildIntentQuestion(turn.text, recent, turnChars, clarifyCount),
    llmSystem: buildIntentSystemPrompt(anchor)
  };
}

/** The run's first reported model; later responses are compared to it (the request names an alias, so there is no pin). */
interface ModelWatch { first?: string; warned: boolean }

/** One warning per run when the reported model changes mid-run (the alias moved): the report splits by jev_model. */
function watchModel(w: ModelWatch, model: string, log: (line: string) => void): void {
  w.first ??= model;
  if (model === w.first || w.warned) return;
  w.warned = true;
  log(`warning: Jev reported model "${model}" mid-run, the run started on ${w.first} — the report splits by jev_model`);
}

/** Priced by the "jev-" prefix row in metered-pricing, which matches the alias and every versioned id alike. */
function jevUsd(tokens: number, env: NodeJS.ProcessEnv): number {
  return computeCostUsd(JEV_PROVIDER, JEV_REQUEST_MODEL, { input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0 }, env) ?? 0;
}

function emit(deps: ReplayDeps, rows: ReplayRow[], row: ReplayRow): void {
  rows.push(row);
  if (!deps.dryRun) appendFileSync(deps.outPath, `${JSON.stringify(row)}\n`);
}

export function parseReplayArgs(
  argv: string[]
): { ok: true; sinceIso?: string; limit?: number; maxUsd: number; dryRun: boolean } | { ok: false; error: string } {
  let sinceIso: string | undefined;
  let limit: number | undefined;
  let maxUsd = 1;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--dry-run") { dryRun = true; continue; }
    if (flag === "--since" && value && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)) { sinceIso = new Date(value).toISOString(); i += 1; continue; }
    if (flag === "--limit" && value && /^\d+$/.test(value)) { limit = Number(value); i += 1; continue; }
    if (flag === "--max-usd" && value && Number(value) > 0) { maxUsd = Number(value); i += 1; continue; }
    return { ok: false, error: `bad argument near "${flag ?? ""}". Usage: houge jev-shadow replay [--since ISO] [--limit N] [--max-usd USD] [--dry-run]` };
  }
  return { ok: true, ...(sinceIso !== undefined ? { sinceIso } : {}), ...(limit !== undefined ? { limit } : {}), maxUsd, dryRun };
}
