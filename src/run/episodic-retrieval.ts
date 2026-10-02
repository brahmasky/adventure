import { admit, bestOf, noRetrieval, resolveCosineGate, rowCosine, type GatedRetrieval } from "./relevance-gate.js";
import type { EpisodicFactRow, RunStore } from "./run-store.js";

/**
 * Episodic retrieval (Phase M B3, ADR 0005 §2 + the 0016 embeddings amendment): score
 * a chat's stored facts against the incoming turn and return the handful worth folding
 * into the composed prompt. Scoring is the Generative-Agents triple, multiplicative:
 *
 *   score = relevance × recency × reuse × salience
 *
 * - relevance = max(normalized BM25, cosine), behind the A1 relevance gate (the floor applies only at gate 0). TWO legs on purpose: FTS5's
 *   unicode61 tokenizer does NOT segment CJK, so for Chinese the keyword leg is
 *   near-useless and the cosine leg (local Ollama embeddings) carries relevance;
 *   with no embeddings (Ollama down / not yet backfilled) BM25 still ranks English.
 *   A zero-FTS-hit candidate with no embedding keeps a small floor so pure
 *   recency can still surface it.
 * - recency = exponential half-life decay on max(created_at, last_used).
 * - reuse = 1 + w·log1p(reuse_value): a TIE-BREAKER by construction (log-compressed,
 *   small weight) — a stale high-reuse fact must lose to a fresh relevant one.
 *
 * NEVER throws; ANY failure degrades to [] (a memory hiccup must not cost the turn).
 */

/** Max facts folded into one prompt (HOUGE_EPISODIC_RETRIEVE_CAP). */
export const DEFAULT_EPISODIC_RETRIEVE_CAP = 6;

export function resolveEpisodicRetrieveCap(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_EPISODIC_RETRIEVE_CAP);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EPISODIC_RETRIEVE_CAP;
}

/** Recency half-life in days (HOUGE_EPISODIC_RECENCY_HALFLIFE_DAYS). */
export const DEFAULT_EPISODIC_RECENCY_HALFLIFE_DAYS = 14;

export function resolveEpisodicRecencyHalflifeDays(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_EPISODIC_RECENCY_HALFLIFE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EPISODIC_RECENCY_HALFLIFE_DAYS;
}

/** Total char budget across the returned facts — overflow drops the LOWEST-scored. */
export const EPISODIC_RETRIEVE_CHAR_GUARD = 900;

/** Relevance floor for a candidate with neither an FTS hit nor a comparable embedding. Used only when the gate is 0 (pre-A1 behaviour). */
export const EPISODIC_RELEVANCE_FLOOR = 0.05;

/** Reuse weight: log-compressed and small so reuse tie-breaks rather than dominates. */
export const EPISODIC_REUSE_WEIGHT = 0.15;

/** Memory A1 §3: with both embeddings present a fact enters only at cosine ≥ this. 0 = the pre-A1 pool and floor. */
export const DEFAULT_EPISODIC_MIN_COSINE = 0.42;

export function resolveEpisodicMinCosine(env: NodeJS.ProcessEnv): number {
  return resolveCosineGate(env.HOUGE_EPISODIC_MIN_COSINE, DEFAULT_EPISODIC_MIN_COSINE);
}

/** Candidate pool sizes: FTS top-K ∪ most-recent active (active cap is 200 — cheap). */
const FTS_POOL = 30;
const RECENT_POOL = 50;

export interface EpisodicRetrievalInput {
  store: Pick<RunStore, "searchEpisodicFactsFts" | "getActiveEpisodicFacts">;
  chat_id: string;
  queryText: string;
  /** Resolved ONCE per turn by the caller; null → BM25/recency-only degradation. */
  queryEmbedding: Float32Array | null;
  now: string;
  cap?: number;
  env?: NodeJS.ProcessEnv;
}

export function retrieveEpisodicFacts(input: EpisodicRetrievalInput): GatedRetrieval<EpisodicFactRow> {
  const env = input.env ?? process.env;
  const gate = resolveEpisodicMinCosine(env);
  const none = noRetrieval<EpisodicFactRow>(input.queryEmbedding !== null, gate > 0 && input.queryEmbedding === null);
  try {
    const ftsHits = input.store.searchEpisodicFactsFts(input.chat_id, input.queryText, FTS_POOL);
    const pool = factPool(input, ftsHits, gate);
    if (pool.length === 0) return none;
    const judged = judgeFacts(input, pool, ftsHits, gate, env);
    judged.admitted.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.row.id - b.row.id));
    const rows = withinGuard(judged.admitted.slice(0, input.cap ?? resolveEpisodicRetrieveCap(env)).map((s) => s.row));
    return { ...none, rows, best_admitted: bestOf(judged.admittedCos), best_rejected: bestOf(judged.rejectedCos) };
  } catch {
    return none; // retrieval is best-effort — a store/scoring failure never costs the turn
  }
}

/** FTS hits ∪ (gated: the chat's whole active set | gate 0: the newest 50); FTS hits only without a query embedding. */
function factPool(
  input: EpisodicRetrievalInput, ftsHits: EpisodicFactRow[], gate: number
): EpisodicFactRow[] {
  const pool = new Map<number, EpisodicFactRow>(ftsHits.map((row) => [row.id, row]));
  if (gate > 0 && input.queryEmbedding === null) return [...pool.values()];
  const rest = gate > 0 ? input.store.getActiveEpisodicFacts(input.chat_id) : input.store.getActiveEpisodicFacts(input.chat_id, RECENT_POOL);
  for (const row of rest) if (!pool.has(row.id)) pool.set(row.id, row);
  return [...pool.values()];
}

type Scored = { row: EpisodicFactRow; score: number };

/** Admit each pooled row under the gate and score the admitted (relevance × recency × reuse × salience). */
function judgeFacts(
  input: EpisodicRetrievalInput, pool: EpisodicFactRow[], ftsHits: Array<EpisodicFactRow & { rank: number }>, gate: number, env: NodeJS.ProcessEnv
): { admitted: Scored[]; admittedCos: number[]; rejectedCos: number[] } {
  const rankById = new Map<number, number>(ftsHits.map((row) => [row.id, row.rank]));
  // BM25 is RELATIVE to the best hit (ranks are negative, more negative = better): best → 1.
  const bestRank = Math.min(...(ftsHits.length > 0 ? ftsHits.map((r) => r.rank) : [0]));
  const halflifeDays = resolveEpisodicRecencyHalflifeDays(env);
  const nowMs = Date.parse(input.now);
  const out = { admitted: [] as Scored[], admittedCos: [] as number[], rejectedCos: [] as number[] };
  for (const row of pool) {
    const rank = rankById.get(row.id);
    const cosine = rowCosine(input.queryEmbedding, row.embedding);
    const ok = admit({ gate, queryEmbedding: input.queryEmbedding !== null, cosine, ftsHit: rank !== undefined });
    if (cosine !== null) (ok ? out.admittedCos : out.rejectedCos).push(cosine);
    if (!ok) continue;
    const bm25 = rank !== undefined && bestRank < 0 ? clamp01(rank / bestRank) : 0;
    const relevance = Math.max(bm25, cosine ?? 0, gate > 0 ? 0 : EPISODIC_RELEVANCE_FLOOR);
    const ageDays = Math.max(0, nowMs - Date.parse(maxIso(row.created_at, row.last_used))) / 86_400_000;
    const reuse = 1 + EPISODIC_REUSE_WEIGHT * Math.log1p(Math.max(0, row.reuse_value));
    out.admitted.push({ row, score: relevance * 2 ** (-ageDays / halflifeDays) * reuse * clamp01(row.salience) });
  }
  return out;
}

/** The char guard: walk best-first and stop at the first overflow (everything dropped scored lower). */
function withinGuard(rows: EpisodicFactRow[]): EpisodicFactRow[] {
  const selected: EpisodicFactRow[] = [];
  let chars = 0;
  for (const row of rows) {
    if (chars + row.fact.length > EPISODIC_RETRIEVE_CHAR_GUARD) break;
    chars += row.fact.length;
    selected.push(row);
  }
  return selected;
}

/**
 * Render the retrieved facts as the composed section's body, one `- <fact>` per line.
 * Facts were sanitized at write time (sanitizeFactText flattens newlines); the
 * whitespace flatten here is defense-in-depth so a stored line break can never forge
 * an extra section line in the SYSTEM prompt.
 */
export function renderEpisodicFactsBlock(facts: ReadonlyArray<Pick<EpisodicFactRow, "fact">>): string {
  return facts
    .map((f) => f.fact.replace(/\s+/g, " ").trim())
    .filter((fact) => fact.length > 0)
    .map((fact) => `- ${fact}`)
    .join("\n");
}

/** Total char budget for the always-known core band (kept tight — durable biography is short). */
export const CORE_FACTS_CHAR_GUARD = 600;

/**
 * Render the always-known core facts as the core band's body, one `- <fact>` per line
 * (the {@link renderEpisodicFactsBlock} shape). Facts are sanitized at write time; the
 * whitespace flatten here is defense-in-depth against a stored line break forging a
 * section line. The char guard walks input order and stops at the first overflow. Returns the ids that
 * rendered (memory A1 §4: the core band is touched with them). NEVER throws — a render hiccup degrades to
 * whatever fit, never costs the turn.
 */
export function renderCoreFactsBlock(facts: ReadonlyArray<Pick<EpisodicFactRow, "id" | "fact">>): { block: string; ids: number[] } {
  const lines: string[] = [];
  const ids: number[] = [];
  try {
    let chars = 0;
    for (const f of facts) {
      const fact = f.fact.replace(/\s+/g, " ").trim();
      if (fact.length === 0) continue;
      if (chars + fact.length > CORE_FACTS_CHAR_GUARD) break;
      chars += fact.length;
      lines.push(`- ${fact}`);
      ids.push(f.id);
    }
  } catch {
    // whatever fit so far stands
  }
  return { block: lines.join("\n"), ids };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function maxIso(a: string, b: string | null): string {
  return b !== null && b > a ? b : a;
}
