import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { SecretBroker } from "../../src/config/secret-broker.js";
import type { CoreWorker } from "../../src/core/core-worker.js";
import { LANE_PREFACE, REWRITE_INSTRUCTION } from "../../src/core/lanes/lane-compose.js";
import { CATEGORIES, TREE_CATEGORY, TREE_QUESTIONS, type Category } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TREE_ANSWER_ARM_ID, TREE_LOOKUP_ARM_ID, TREE_STATUS_ARM_ID } from "../../src/jev/tree-policy.js";
import type { TurnModality } from "../../src/media/media-config.js";
import type { TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { ompWorker } from "./omp-worker.js";
import { createQueuedTurnRun } from "./runs.js";

/**
 * One triage harness for the pin (Task 2) and the ladder tests (Task 8b): a fake Jev answer, the test-injected seat told
 * apart by its prompt, and every arming row in a gate-only calibration file. Tests only. Frozen after Task 2: a change
 * here could hide a behaviour change from the pin.
 */
export const REPORTED = "jev-1.13.0";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const n = CATEGORIES.length;
/** A category answer: the given probabilities, the rest split evenly (sums to 1, as Jev's do). */
export function cat(p: Partial<Record<Category, number>>) {
  const used = Object.values(p).reduce((a, b) => a + (b ?? 0), 0);
  const rest = CATEGORIES.filter((c) => p[c] === undefined);
  const probabilities = Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? (1 - used) / rest.length]));
  const [choice, pMax] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
}
/** Only the named categories carry probability (every other option exactly 0). */
export const only = (p: Partial<Record<Category, number>>) => cat(Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? 0])));
export const scope = (ask: number) => ({ type: "choice", choice: ask >= 0.5 ? "ask" : "research", probabilities: { ask, research: 1 - ask }, confidence: Math.abs(2 * ask - 1) });
export const level = (probs: number[]) => ({ type: "score", score: probs.reduce((s, p, k) => s + k * p, 0),
  probabilities: Object.fromEntries(probs.map((p, k) => [String(k), p])), confidence: 0.8 });
export const LIGHT = [0.1, 0.9, 0, 0]; // expected 0.9 → Fast, effort low
export const NONE = [1, 0, 0, 0];      // expected 0
export const HEAVY = [0, 0, 0.2, 0.8]; // expected 2.8 → Thinking, effort high
export interface Says { category?: ReturnType<typeof cat>; sets_rule?: number; ask?: number; breadth?: number[]; reasoning?: number[]; actions?: number[]; model?: string }
export const treeSays = (o: Says = {}) => vi.fn(async (_url?: unknown, _init?: unknown) => json(200, {
  model: o.model ?? REPORTED, usage: { input_tokens: 900, output_tokens: 0 }, answers: {
    category: o.category ?? cat({ other: 0.9 }), sets_rule: { type: "noul", noul: o.sets_rule ?? 0.05 }, rule_scope: scope(o.ask ?? 0.9),
    breadth: level(o.breadth ?? LIGHT), reasoning: level(o.reasoning ?? LIGHT), actions: level(o.actions ?? NONE) } }));
export const jevDown = () => vi.fn(async () => { throw new TypeError("fetch failed"); });
export const jevStatus = (status: number) => vi.fn(async () => new Response("{}", { status }));
/** A 200 whose body is not JSON: the client's `parse` skip (jev-client.ts:173). */
export const jevNotJson = () => vi.fn(async () => new Response("not json", { status: 200 }));

export type Llm = (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
export interface LlmScript { compose?: Llm; cascade?: Llm; distill?: Llm }
const READ_OK = JSON.stringify({ summary: "Sydney tomorrow", facts: ["Sunny, max 22°C"], time_claims: [], answer_to_objective: "Sunny, 22°C", contains_instructions: false });
/** The injected seat: the cascade (by its system line), lane compose / rewrite / reader (by prompt), the lesson service's two calls. */
export const scriptedLlm = (s: LlmScript = {}): Llm => async (input) => {
  const q = String(input.question ?? ""); const sys = String(input.system ?? "");
  if (/exactly one of these two words/.test(sys)) return s.cascade ? s.cascade(input) : { ok: false, error: "no cascade fake" };
  if (q.startsWith(LANE_PREFACE)) return s.compose ? s.compose(input) : { ok: true, output: { answer: "放在书房更好。", model: "claude-sonnet-5-5" } };
  if (q.startsWith(REWRITE_INSTRUCTION)) return { ok: true, output: { answer: "SAME" } };
  if (q.includes("<<<UNTRUSTED>>>")) return { ok: true, output: { answer: READ_OK } };
  if (/durable/i.test(sys)) return s.distill ? s.distill(input) : { ok: true, output: { answer: JSON.stringify({ durable: true, lesson: "Keep replies short." }) } };
  return { ok: true, output: { answer: JSON.stringify({ verdict: "ADD", theme: "format" }) } };
};
export const picks = (answer: string): Llm => async () => ({ ok: true, output: { answer } });
export const webOk = () => vi.fn(async (_input: Record<string, unknown>): Promise<ToolAdapterResult> => ({ ok: true,
  output: { query: "q", provider: "tavily", results: [{ title: "BOM", url: "https://weather.example/sydney", content: "Tomorrow: sunny, max 22." }] } }));

/** The gate-only rows: the six questions and the three lane pseudo-rows, zh + en, on REPORTED. */
export function calibrationFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), "hpin-cal-")), "rows.json");
  const ids = [...TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)] as const),
    ...[TREE_STATUS_ARM_ID, TREE_ANSWER_ARM_ID, TREE_LOOKUP_ARM_ID].map((id) => [id, criteriaHash(TREE_CATEGORY)] as const)];
  writeFileSync(f, JSON.stringify(ids.flatMap(([question_id, criteria_hash]) => (["zh", "en"] as const).map((lang) =>
    ({ question_id, criteria_hash, model: REPORTED, lang, approved: "test", evidence: "test" })))));
  return f;
}
export const ARM: Record<string, string> = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" };
export const SHADOW: Record<string, string> = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "shadow" };

export interface HarnessOptions { env?: Record<string, string>; llm?: Llm; web?: Llm; jevNow?: () => Date; broker?: SecretBroker }
/** `noState`: skip buildOmpTools, so the turn has no OmpTurnState (today's `!state` exit, skip reason `error`). */
export interface TurnOptions { signal?: AbortSignal; modality?: TurnModality; posture?: string | null; noState?: boolean }
/** Env first (the worker reads boot-time switches in its constructor), then the store and the worker. */
export function triageHarness(fetchImpl: unknown, o: HarnessOptions = {}) {
  vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", calibrationFile()); vi.stubEnv("HOUGE_JEV_GATE", "1"); vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  for (const [k, v] of Object.entries(o.env ?? ARM)) vi.stubEnv(k, v);
  const store = o.broker ? RunStore.openInMemory({ redact: o.broker.redact }) : RunStore.openInMemory(); // boot wiring: the store and the worker share the broker's redactor
  const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hpin-")), { llm: o.llm ?? scriptedLlm(), jevFetch: fetchImpl as typeof fetch,
    ...(o.broker ? { broker: o.broker } : {}),
    ...(o.web ? { web: o.web } : {}), ...(o.jevNow ? { jevNow: o.jevNow } : {}) });
  const turn = (text: string, t: TurnOptions = {}) => {
    const run_id = createQueuedTurnRun(store, text);
    const claim = store.claimRun(run_id, "w", 120)!;
    if (!t.noState) worker.buildOmpTools(claim, "555");
    return { run_id, input: { claim, text, userText: text, modality: t.modality ?? "text", posture: t.posture ?? null, signal: t.signal ?? new AbortController().signal } };
  };
  return { store, worker, turn };
}
export type Harness = ReturnType<typeof triageHarness>;
export const sinkOf = (w: CoreWorker) => (w as unknown as { ompOutcomeSink: (chat: string) => TurnOutcomeSink }).ompOutcomeSink("555");

/** Ids become stable placeholders in first-seen order, so two runs of the same case compare equal. */
export class IdMap {
  private readonly seen = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  map(s: string): string {
    return s.replace(/\b(run|jv|jd|lc|dec|ct)_[0-9A-Za-z-]{6,}/g, (id, prefix: string) => {
      const hit = this.seen.get(id);
      if (hit) return hit;
      const k = (this.counts.get(prefix) ?? 0) + 1;
      this.counts.set(prefix, k);
      const ph = `<${prefix}#${k}>`;
      this.seen.set(id, ph);
      return ph;
    });
  }
  deep<T>(x: T): T { return x === undefined ? x : JSON.parse(this.map(JSON.stringify(x))) as T; }
}

/**
 * Columns that are ids or clocks: dropped from the projection. `state_hash` is KEPT (senior W1): with no prior Houge turn
 * and no quote the tree state carries no clock, so its hash pins the Jev request content that Task 8b moves.
 */
const DROP: ReadonlySet<string> = new Set(["decision_id", "ladder_decision_id", "run_id", "verdict_id", "created_at", "updated_at", "latency_ms",
  "thread_cut_at", "state_built_at", "change_id"]);
function clean(row: object, ids: IdMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!DROP.has(k)) out[k] = typeof v === "string" ? ids.map(v) : v;
  return out;
}

/** The verdict → model-call join (consumer 11): each llm_attempt's role and routed_by, ids mapped. */
function attemptsOf(events: ReturnType<RunStore["getLedgerEvents"]>, ids: IdMap): Array<[unknown, string | null]> {
  return events.filter((e) => e.event_type === "llm_attempt").map((e) => {
    const p = e.payload as { role?: unknown; routed_by?: string };
    return [p.role ?? null, p.routed_by === undefined ? null : ids.map(p.routed_by)];
  });
}

/** Raw rows (SELECT *) of one run's table, ids mapped, clocks dropped: nothing a consumer reads is filtered out by a store helper. */
function rawRows(store: RunStore, table: "lane_replies" | "lesson_changes", run_id: string, ids: IdMap): Array<Record<string, unknown>> {
  const db = (store as unknown as { db: { prepare(sql: string): { all(...p: unknown[]): Array<Record<string, unknown>> } } }).db;
  return db.prepare(`SELECT * FROM ${table} WHERE run_id = ? ORDER BY rowid`).all(run_id)
    .map((r) => ({ ...clean(r, ids), ...(typeof r.verdict_id === "string" ? { verdict_id: ids.map(r.verdict_id) } : {}) })); // verdict_id is a link, kept
}

/** Everything triage persists for one run, ids mapped: decision rows, the verdict (with its id, so links show), the route's link, model calls, the triage event(s), saves. */
export function projectRun(store: RunStore, run_id: string, outcome: unknown, ids: IdMap): Record<string, unknown> {
  const v = store.getJevVerdictForRun(run_id);
  const events = store.getLedgerEvents(run_id);
  const routeVerdict = (outcome as { route?: { verdict_id?: string | null } } | null)?.route?.verdict_id;
  return {
    outcome: ids.deep(outcome),
    jev_decisions: store.listJevDecisions(run_id).map((r) => clean(r, ids)),
    verdict: v ? { id: ids.map(v.verdict_id), ...clean(v, ids) } : null,
    // the supervisor sets routed_by from route.verdict_id (planner-supervisor.ts:499): it must name this run's verdict row
    route_links_verdict: routeVerdict === undefined ? null : routeVerdict === (v?.verdict_id ?? null),
    llm_attempts: attemptsOf(events, ids),
    triage: events.filter((e) => e.event_type === "triage").map((e) => ids.deep(e.payload)),
    lessons_saved: events.filter((e) => e.event_type === "lesson_saved").length,
    lane_replies: rawRows(store, "lane_replies", run_id, ids),
    lesson_changes: rawRows(store, "lesson_changes", run_id, ids)
  };
}
