import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chatContextSince, resolveChatContextTurnChars, resolveChatContextTurns } from "../capabilities/intent.js";
import { computeCostUsd, JEV_PROVIDER } from "../llm/metered-pricing.js";
import { isBareAck } from "../omp/bare-ack.js";
import type { ReplayTurnRow, RunStore } from "../run/run-store.js";
import { stateHash } from "./decide.js";
import { langOf, type Lang } from "./intent-question.js";
import { JEV_REQUEST_MODEL, type JevAnswer, type JevRequest, type JevResult } from "./jev-client.js";
import { buildTreeState, CATEGORIES, lastHougeTurnOf, quotedTurnFromRow, TREE_CATEGORY, TREE_QUESTIONS, type Category,
  type HougeTurnKind } from "./questions/tree.js";
import { criteriaHash, toJevQuestion, type ChoiceQuestion, type Question } from "./questions/types.js";
import { readDone, runReplayCore, type ReplayCoreOutcome } from "./replay-core.js";
import { preJudge } from "./tree-policy.js";

/**
 * `houge jev replay triage` engine for the decision tree (spec 2026-10-06 §7). Every Telegram turn since the comparator
 * epoch is replayed against the six frozen tree questions on the state the LIVE path would have built (same
 * buildTreeState, lastHougeTurnOf and quoted-turn rebuild; only the broker pass is absent in the CLI), so `state_hash`
 * joins to `jev_decisions.state_hash`. The proxy label comes from the tools the planner actually ran. Rows carry ids,
 * enums and numbers only — never message text.
 *
 * State parity: the thread cut and every `age_s` use the instants the live path recorded on its answered row
 * (`thread_cut_at`, the claim; `state_built_at`, just before the Jev call); a row without them falls back to its write
 * time, else the `triage` event, else the anchor. Known gap: no broker in the CLI.
 */
export const TREE_REPLAY_OUT = ".houge/jev-tree/replay.jsonl";
export const TREE_PERMUTED_OUT = ".houge/jev-tree/replay-permuted.jsonl";
export const TREE_LABELS_PATH = ".houge/jev-tree/labels.jsonl";
/** loop_step.capability exists since 2026-07-02: the proxy label's epoch. */
export const TREE_LABEL_SINCE = "2026-07-02T00:00:00.000Z";
export const TREE_DONE: ReadonlySet<string> = new Set(["ok", "skipped_state_too_large"]);
/** CJK text tokenises ~1.8× worse than chars/3 suggests (2026-09-26 lesson): reserve high, never under. */
const CJK_UNDERCOUNT = 1.8;

export type ProxyRule = "houge_status" | "memory_correct_write" | "lesson_write" | "self_change" | "wiki" | "schedule_task"
  | "mail_calendar" | "machine_task" | "research" | "lookup" | "no_tool" | "ack_after_proposal" | "unmatched_tools";
export interface ProxyLabel { category: Category | null; rule: ProxyRule }
export interface TreeLabel { category: Category; by: "paco"; at: string }
export interface TreeReplayRow {
  key: string; turn_id: string; run_id: string; lang: Lang; status: "ok" | "dry_run" | "skipped_state_too_large" | "jev_failed"; est_usd: number;
  attempt?: number; usd?: number; stop?: "auth" | "fused"; error?: string;
  state_hash: string; tools: Record<string, number>; proxy: Category | null; proxy_rule: ProxyRule;
  pre_judge: "ack_answer" | "judge"; think_harder: boolean; bare_ack: boolean; quoted: boolean;
  model?: string; criteria_hashes?: Record<string, string>; answers?: Record<string, JevAnswer>;
}
type Prepared = TreeReplayRow & { state: Record<string, unknown>; chars: number };
type Tools = Readonly<Record<string, number>>;

const count = (t: Tools, name: string): number => t[name] ?? 0;
const anyTool = (t: Tools, re: RegExp): boolean => Object.keys(t).some((k) => re.test(k));
const webSteps = (t: Tools): number => count(t, "web_search") + count(t, "http_fetch");

/** Spec §7, first match wins: the order IS the precedence (a status check beats the lesson the same turn wrote). */
const PROXY_RULES: ReadonlyArray<readonly [ProxyRule, Category, (t: Tools) => boolean]> = [
  ["houge_status", "status", (t) => count(t, "houge_status") > 0],
  ["memory_correct_write", "memory", (t) => count(t, "memory_correct_write") > 0],
  ["lesson_write", "memory", (t) => count(t, "lesson_write") > 0],
  ["self_change", "self_change", (t) => anyTool(t, /^(self_write_.+|self_diagnose|skill_author)$/)],
  ["wiki", "wiki", (t) => anyTool(t, /^wiki_(build|refine)$/)],
  ["schedule_task", "schedule", (t) => count(t, "schedule_task") > 0],
  ["mail_calendar", "mail_calendar", (t) => anyTool(t, /^(gmail_.+|google_api)$/)],
  ["machine_task", "machine_task", (t) => anyTool(t, /^(shell|shell_external|fs_.+)$/)],
  ["research", "research", (t) => (count(t, "web_search") > 0 && webSteps(t) >= 3) || count(t, "http_fetch") >= 2],
  ["lookup", "lookup", (t) => webSteps(t) > 0 && webSteps(t) <= 2]
];

/**
 * The tool proxy for one run. No rule and no tool → `answer`, unless the previous (or quoted) Houge turn was a proposal:
 * a tool-less "好" there may be agreement whose work never ran, so it is unlabelled. Tools that match no rule are
 * unlabelled too: the spec's `answer` means "no tool".
 */
export function proxyLabel(tools: Tools, prevKind: HougeTurnKind | null): ProxyLabel {
  const hit = PROXY_RULES.find(([, , matches]) => matches(tools));
  if (hit) return { category: hit[1], rule: hit[0] };
  if (Object.keys(tools).length > 0) return { category: null, rule: "unmatched_tools" };
  return prevKind === "proposal" ? { category: null, rule: "ack_after_proposal" } : { category: "answer", rule: "no_tool" };
}

/** `category` asked with its options reversed: the order-bias probe (spec §7 permutation agreement). */
export const TREE_CATEGORY_PERMUTED: ChoiceQuestion = { ...TREE_CATEGORY, criteria: [...TREE_CATEGORY.criteria].reverse() };
export function treeQuestions(permute: boolean): readonly Question[] {
  return permute ? TREE_QUESTIONS.map((q) => (q.id === TREE_CATEGORY.id ? TREE_CATEGORY_PERMUTED : q)) : TREE_QUESTIONS;
}

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIES);
function isLabel(r: Record<string, unknown>): r is Record<string, unknown> & TreeLabel & { turn_id: string } {
  return typeof r.turn_id === "string" && typeof r.category === "string" && CATEGORY_SET.has(r.category) && r.by === "paco" && typeof r.at === "string";
}

/** Paco's labels, keyed by turn_id (a later line overrides an earlier one). A malformed line throws: a dropped label is a silent bias. */
export function loadLabels(path: string): Map<string, TreeLabel> {
  const m = new Map<string, TreeLabel>();
  if (!existsSync(path)) return m;
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line) as Record<string, unknown>; } catch { throw new Error(`labels: line ${i + 1} is not JSON`); }
    if (!isLabel(r)) throw new Error(`labels: line ${i + 1} is not {turn_id, category (one of the 11), by:"paco", at}`);
    m.set(r.turn_id, { category: r.category, by: r.by, at: r.at });
  });
  return m;
}

/** One row per key, latest wins: what the report and the labeller read. */
export function readReplayFile(path: string): TreeReplayRow[] {
  return [...readDone(path, TREE_DONE).values()] as unknown as TreeReplayRow[];
}

export interface TreeReplayDeps {
  store: RunStore; env: NodeJS.ProcessEnv; jev: (req: JevRequest) => Promise<JevResult>; outPath: string; maxUsd: number; dryRun: boolean;
  limit?: number; log?: (l: string) => void; permute?: boolean;
}

function telegramTurns(store: RunStore, limit?: number): ReplayTurnRow[] {
  return store.listReplayTurns({ sinceIso: TREE_LABEL_SINCE, ...(limit !== undefined ? { limit } : {}) })
    .filter((t) => store.runSource(t.run_id) === "telegram");
}

/** The real replay universe, ignoring `--limit` (the report's denominator, not rows.length). */
export function treeUniverse(store: RunStore): number {
  return telegramTurns(store).length;
}

export async function runTreeReplay(d: TreeReplayDeps): Promise<ReplayCoreOutcome<TreeReplayRow>> {
  guardOutPath(d);
  const questions = treeQuestions(d.permute === true);
  const suffix = d.permute ? ":perm" : "";
  const byKey = new Map(telegramTurns(d.store, d.limit).map((t) => [`${t.turn_id}${suffix}`, t]));
  // Reported models seen in this run's evidence, seeded from rows already in the file (a move across a resume still warns).
  const models = new Set<string>(d.dryRun ? [] : [...readDone(d.outPath, TREE_DONE).values()].flatMap((r) => (typeof r.model === "string" ? [r.model] : [])));
  return runReplayCore<TreeReplayRow>({
    source: () => [...byKey.keys()].map((key) => ({ key })),
    doneStatuses: TREE_DONE, outPath: d.outPath, maxUsd: d.maxUsd, dryRun: d.dryRun, ...(d.log ? { log: d.log } : {}),
    estimateUsd: (row) => jevUsd(Math.ceil(((row as Prepared).chars / 3) * CJK_UNDERCOUNT), d.env),
    prepare: async ({ key }) => prepareTurn(d, key, byKey.get(key)!),
    publicRow: (row) => { const { state: _s, chars: _c, ...rest } = row as Prepared; return rest; }, // no text in the outcome
    dispatch: async (row) => dispatchTurn(d, row as Prepared, questions, models)
  });
}

/** A wiring slip must not mix the permuted rows into the canonical file (or back): the report reads each file whole. */
function guardOutPath(d: TreeReplayDeps): void {
  const out = resolve(d.outPath);
  if (d.permute && out === resolve(TREE_REPLAY_OUT)) throw new Error(`a permuted run must not write to the canonical ${TREE_REPLAY_OUT}`);
  if (!d.permute && out === resolve(TREE_PERMUTED_OUT)) throw new Error(`a canonical run must not write to the permuted ${TREE_PERMUTED_OUT}`);
}

/** When the live path cut the thread and built the state: the recorded instants, else the row's write time, else its `triage` event. */
function liveInstantsOf(store: RunStore, run_id: string): { cut: string; before: string; built: string } | undefined {
  const row = store.listJevDecisions(run_id).find((r) => r.point === "triage" && r.status === "answered");
  // Live read with no upper bound right at the cut, so a turn stamped in the cut's own millisecond is in its thread.
  if (row?.thread_cut_at && row.state_built_at) {
    return { cut: row.thread_cut_at, before: new Date(Date.parse(row.thread_cut_at) + 1).toISOString(), built: row.state_built_at };
  }
  const at = row?.created_at ?? store.getLedgerEvents(run_id).find((e) => e.event_type === "triage")?.occurred_at;
  return at ? { cut: at, before: at, built: at } : undefined;
}

function prepareTurn(d: TreeReplayDeps, key: string, t: ReplayTurnRow): Prepared | { skip: TreeReplayRow } {
  const anchor = t.anchor ?? t.created_at;
  const { cut, before, built: builtAt } = liveInstantsOf(d.store, t.run_id) ?? { cut: anchor, before: anchor, built: anchor };
  const recent = d.store.getChatTurnsBefore(t.chat_id, resolveChatContextTurns(d.env), chatContextSince(d.env, new Date(cut)), before, t.run_id);
  const nowMs = Date.parse(builtAt);
  const lastHougeTurn = lastHougeTurnOf(recent, nowMs);
  const quotedRow = t.quoted_turn_id ? d.store.getChatTurnById(t.quoted_turn_id) : undefined;
  const quotedTurn = quotedRow ? quotedTurnFromRow(quotedRow, nowMs) : null;
  const built = buildTreeState({ userText: t.text, recentTurns: recent, turnChars: resolveChatContextTurnChars(d.env), modality: "text",
    lastHougeTurn, quotedTurn });
  const tools = d.store.runLoopCapabilityCounts(t.run_id);
  const proxy = proxyLabel(tools, quotedTurn?.kind === "proposal" ? "proposal" : lastHougeTurn?.kind ?? null);
  const pre = preJudge({ text: t.text, lastHougeTurn, quoted: quotedTurn !== null });
  const base: TreeReplayRow = { key, turn_id: t.turn_id, run_id: t.run_id, lang: langOf(t.text), status: "ok", est_usd: 0,
    state_hash: built.ok ? stateHash(built.state) : "", tools, proxy: proxy.category, proxy_rule: proxy.rule, pre_judge: pre.kind,
    think_harder: pre.kind === "judge" && pre.thinkHarder, bare_ack: isBareAck(t.text), quoted: quotedTurn !== null };
  if (!built.ok) return { skip: { ...base, status: "skipped_state_too_large" } };
  return { ...base, state: built.state, chars: built.chars };
}

/** One request with all six questions (spec §2.3); the answers are stored whole (numbers and option keys only). */
async function dispatchTurn(d: TreeReplayDeps, row: Prepared, questions: readonly Question[], models: Set<string>): Promise<TreeReplayRow> {
  const { state, chars: _chars, ...rest } = row;
  const wire: JevRequest["questions"] = {};
  for (const q of questions) wire[q.id] = toJevQuestion(q);
  const r = await d.jev({ state, questions: wire });
  if (!r.ok) {
    // The reason enum only — never the client's detail string (rows carry ids, enums, numbers).
    const stop = r.reason === "fused" ? "fused" : r.reason === "auth" || r.reason === "no_key" ? "auth" : undefined;
    return { ...rest, status: "jev_failed", error: r.reason, ...(stop ? { stop } : {}) };
  }
  if (models.size > 0 && !models.has(r.model)) {
    d.log?.(`warning: Jev reported model "${r.model}" mid-run, earlier rows reported ${[...models].join(", ")} — the report refuses mixed models`);
  }
  models.add(r.model);
  return { ...rest, status: "ok", usd: jevUsd(r.input_tokens, d.env), model: r.model,
    criteria_hashes: Object.fromEntries(questions.map((q) => [q.id, criteriaHash(q)])), answers: r.answers };
}

/** Priced by the "jev-" prefix row in metered-pricing, which matches the alias and every versioned id alike. */
function jevUsd(tokens: number, env: NodeJS.ProcessEnv): number {
  return computeCostUsd(JEV_PROVIDER, JEV_REQUEST_MODEL, { input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0 }, env) ?? 0;
}
