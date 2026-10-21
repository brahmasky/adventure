import { createHash } from "node:crypto";
import { recordImproveSignal } from "../decisions/improve-signals.js";
import { cosineSimilarity } from "../llm/embeddings.js";
import { resolveCosineGate } from "../run/relevance-gate.js";
import type { RecurrenceCandidateRow, RunStore } from "../run/run-store.js";
import { RECURRENCE_WINDOW_DAYS, type RecurrenceInfo } from "./groups.js";

/**
 * Recurrence (2b-ii §3.3, P2): 3 or more of Paco's telegram turns in 14 days, one category, request cosine ≥ the gate.
 * Short turns and the other/status/memory categories are not a skill (P2: at 0.42 the greetings formed a 15-turn cluster).
 * Embeddings are stored once per turn; Ollama down means no recurrence today, said in the Watch line.
 */
export const RECURRENCE_MIN_TURNS = 3;
export const RECURRENCE_MIN_CHARS = 20;
export const RECURRENCE_EXCLUDED_CATEGORIES: readonly string[] = ["other", "status", "memory"];
export const RECURRENCE_GATE_DEFAULT = 0.6;
export const EMBED_TEXT_CHAR_CAP = 1_500;
const DAY_MS = 24 * 60 * 60 * 1000;
export type Embedder = (text: string) => Promise<Float32Array | null>;
export type RecurrenceCluster = RecurrenceInfo & { newestRun: string; chatId: string };

export const resolveRecurrenceGate = (env: NodeJS.ProcessEnv): number => resolveCosineGate(env.HOUGE_RECURRENCE_COSINE_GATE, RECURRENCE_GATE_DEFAULT);
export const clusterIdOf = (category: string, turnIds: readonly string[]): string =>
  `rec_${createHash("sha256").update(category + [...turnIds].sort().join(",")).digest("hex").slice(0, 16)}`;

/** Final fix E1: embeds per call; the rest wait for a later tick (the first night after a kickstart is 14 days of turns on a CPU-only box). */
export const EMBED_PER_TICK_MAX = 50;

/**
 * Stored vectors for the turns, embedding the missing ones (text capped) and storing them; a null embed counts as unavailable.
 * Final fix E1: the first null is an outage, so every remaining missing turn counts unavailable without another call, and
 * at most EMBED_PER_TICK_MAX turns are embedded per call. Final fix 3: a spent tick budget (`overBudget`) holds the rest back like the cap.
 */
export async function ensureEmbeddings(store: RunStore, turns: readonly { turn_id: string; text: string }[], embed: Embedder, model: string, now: string, signal?: AbortSignal,
  overBudget?: () => boolean)
  : Promise<{ vectors: Map<string, Float32Array>; unavailable: number; capped: boolean }> {
  const vectors = store.getTurnEmbeddings(turns.map((t) => t.turn_id));
  let unavailable = 0; let calls = 0; let down = false;
  for (const t of turns) {
    if (vectors.has(t.turn_id)) continue;
    // an aborted run is a partial window, an outage or the cap a deferral: each counted so the caller never clusters it
    if (signal?.aborted || down || calls >= EMBED_PER_TICK_MAX || overBudget?.() === true) { unavailable += 1; continue; }
    calls += 1;
    const v = await embed(Array.from(t.text).slice(0, EMBED_TEXT_CHAR_CAP).join(""));
    if (!v) { unavailable += 1; down = true; continue; }
    store.putTurnEmbedding(t.turn_id, model, v, now);
    vectors.set(t.turn_id, v);
  }
  // final fix 2/3: `capped` — only the cap or the budget (no outage, no abort) left turns missing: a backlog the next segment continues
  return { vectors, unavailable, capped: unavailable > 0 && !down && !signal?.aborted };
}

/** Single linkage per category: union-find over pairs at or over the gate; clusters of RECURRENCE_MIN_TURNS or more. */
export function clusterCandidates(cands: readonly RecurrenceCandidateRow[], vectors: ReadonlyMap<string, Float32Array>, gate: number): RecurrenceCluster[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const union = (a: string, b: string): void => { parent.set(find(a), find(b)); };
  const withVec = cands.filter((c) => vectors.has(c.turn_id));
  for (let i = 0; i < withVec.length; i++) for (let j = i + 1; j < withVec.length; j++) {
    const a = withVec[i]!, b = withVec[j]!;
    if (a.category === b.category && cosineSimilarity(vectors.get(a.turn_id)!, vectors.get(b.turn_id)!) >= gate) union(a.turn_id, b.turn_id);
  }
  const groups = new Map<string, RecurrenceCandidateRow[]>();
  for (const c of withVec) { const r = find(c.turn_id); groups.set(r, [...(groups.get(r) ?? []), c]); }
  return [...groups.values()].filter((g) => g.length >= RECURRENCE_MIN_TURNS).map((g) => {
    const sorted = [...g].sort((x, y) => x.created_at.localeCompare(y.created_at) || x.turn_id.localeCompare(y.turn_id));
    const turnIds = sorted.map((c) => c.turn_id);
    const category = sorted[0]!.category;
    const times = sorted.map((c) => Date.parse(c.created_at));
    const spanDays = Math.max(1, Math.ceil((Math.max(...times) - Math.min(...times)) / DAY_MS));
    return { clusterId: clusterIdOf(category, turnIds), category, turnIds, texts: sorted.map((c) => c.text), idempotencyKey: `${category}:${turnIds[0]}`, spanDays,
      newestRun: sorted.at(-1)!.run_id, chatId: sorted.at(-1)!.chat_id };
  });
}

export async function computeRecurrence(d: { store: RunStore; env: NodeJS.ProcessEnv; now: string; embed: Embedder; embedModel: string; signal: AbortSignal; overBudget?: () => boolean })
  : Promise<{ clusters: Map<string, RecurrenceCluster>; embedUnavailable: number; backlog: number }> {
  const since = new Date(Date.parse(d.now) - RECURRENCE_WINDOW_DAYS * DAY_MS).toISOString();
  const cands = d.store.listRecurrenceCandidates(since, RECURRENCE_MIN_CHARS, RECURRENCE_EXCLUDED_CATEGORIES);
  const { vectors, unavailable, capped } = await ensureEmbeddings(d.store, cands, d.embed, d.embedModel, d.now, d.signal, d.overBudget);
  const clusters = new Map<string, RecurrenceCluster>();
  if (capped) return { clusters, embedUnavailable: 0, backlog: unavailable }; // a backlog, not an outage: the caller stops the segment and resumes
  if (unavailable > 0) return { clusters, embedUnavailable: unavailable, backlog: 0 }; // a partial day would cluster a partial window: skip recurrence today (§3.3 step 2)
  for (const c of clusterCandidates(cands, vectors, resolveRecurrenceGate(d.env))) clusters.set(`rec:${c.clusterId}`, c);
  return { clusters, embedUnavailable: 0, backlog: 0 };
}

/** One inbox row per (cluster, size): `source_outcome_id = rec:<id>:<size>` (ruling 4); value = the size, about = the newest run. */
export function recordRecurrenceSignals(store: RunStore, clusters: ReadonlyMap<string, RecurrenceCluster>, now: string): number {
  let n = 0;
  for (const c of clusters.values()) {
    if (recordImproveSignal(store, { signal: "recurrence", value: c.turnIds.length, run_id: c.newestRun, chat_id: c.chatId, about_run_id: c.newestRun, source_outcome_id: `rec:${c.clusterId}:${c.turnIds.length}`, created_at: now })) n += 1;
  }
  return n;
}
