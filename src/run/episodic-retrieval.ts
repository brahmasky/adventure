import { blobToFloat32, cosineSimilarity } from "../llm/embeddings.js";
import type { EpisodicFactRow, RunStore } from "./run-store.js";

/**
 * Episodic retrieval (Phase M B3, ADR 0005 §2 + the 0016 embeddings amendment): score
 * a chat's stored facts against the incoming turn and return the handful worth folding
 * into the composed prompt. Scoring is the Generative-Agents triple, multiplicative:
 *
 *   score = relevance × recency × reuse × salience
 *
 * - relevance = max(normalized BM25, cosine, floor). TWO legs on purpose: FTS5's
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

/** Relevance floor for a candidate with neither an FTS hit nor a comparable embedding. */
export const EPISODIC_RELEVANCE_FLOOR = 0.05;

/** Reuse weight: log-compressed and small so reuse tie-breaks rather than dominates. */
export const EPISODIC_REUSE_WEIGHT = 0.15;

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

export function retrieveEpisodicFacts(input: EpisodicRetrievalInput): EpisodicFactRow[] {
  try {
    const env = input.env ?? process.env;
    const cap = input.cap ?? resolveEpisodicRetrieveCap(env);
    const halflifeDays = resolveEpisodicRecencyHalflifeDays(env);
    const nowMs = Date.parse(input.now);

    // Candidate pool: FTS keyword hits ∪ the chat's most recent active facts.
    const ftsHits = input.store.searchEpisodicFactsFts(input.chat_id, input.queryText, FTS_POOL);
    const rankById = new Map<number, number>(ftsHits.map((row) => [row.id, row.rank]));
    const pool = new Map<number, EpisodicFactRow>(ftsHits.map((row) => [row.id, row]));
    for (const row of input.store.getActiveEpisodicFacts(input.chat_id, RECENT_POOL)) {
      if (!pool.has(row.id)) pool.set(row.id, row);
    }
    if (pool.size === 0) return [];

    // BM25 normalization is RELATIVE to the best hit (bm25 ranks are negative,
    // more negative = better): best hit → 1, weaker hits → rank/bestRank ∈ (0,1].
    const bestRank = Math.min(...(ftsHits.length > 0 ? ftsHits.map((r) => r.rank) : [0]));

    const scored = [...pool.values()].map((row) => {
      const rank = rankById.get(row.id);
      const bm25 =
        rank !== undefined && bestRank < 0 ? clamp01(rank / bestRank) : 0;
      // Number.isFinite guards a NaN/±Infinity cosine (possible only from out-of-band
      // blob writes — zero vectors, corrupt bytes): NaN survives clamp01/Math.max and
      // makes the sort comparator lie, floating the poisoned row to the top.
      const rawCosine =
        input.queryEmbedding && row.embedding
          ? cosineSimilarity(input.queryEmbedding, blobToFloat32(row.embedding))
          : 0;
      const cosine = Number.isFinite(rawCosine) ? clamp01(rawCosine) : 0;
      const relevance = Math.max(bm25, cosine, EPISODIC_RELEVANCE_FLOOR);
      const lastAlive = Date.parse(maxIso(row.created_at, row.last_used));
      const ageDays = Math.max(0, nowMs - lastAlive) / 86_400_000;
      const recency = 2 ** (-ageDays / halflifeDays);
      const reuse = 1 + EPISODIC_REUSE_WEIGHT * Math.log1p(Math.max(0, row.reuse_value));
      const salience = clamp01(row.salience);
      return { row, score: relevance * recency * reuse * salience };
    });

    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.row.id - b.row.id));

    // Top-cap, then the char guard: walk best-first and stop at the first overflow —
    // everything dropped is by construction lower-scored than everything kept.
    const selected: EpisodicFactRow[] = [];
    let chars = 0;
    for (const { row } of scored.slice(0, cap)) {
      if (chars + row.fact.length > EPISODIC_RETRIEVE_CHAR_GUARD) break;
      chars += row.fact.length;
      selected.push(row);
    }
    return selected;
  } catch {
    return []; // retrieval is best-effort — a store/scoring failure never costs the turn
  }
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

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function maxIso(a: string, b: string | null): string {
  return b !== null && b > a ? b : a;
}
