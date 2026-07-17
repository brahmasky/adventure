import {
  parseWikiContradictions,
  parseWikiStringArray,
  resolveWikiRecencyHalflifeDays,
  resolveWikiRetrieveCap
} from "../capabilities/wiki.js";
import { blobToFloat32, cosineSimilarity } from "../llm/embeddings.js";
import type { RunStore, WikiPageRow } from "./run-store.js";

/**
 * Wiki retrieval (Phase W Slice W2, ADR 0020 §7c): score the GLOBAL active wiki pages
 * against the incoming turn and return the handful worth folding into the composed
 * prompt. The episodic-retrieval clone (Phase M B3), multiplicative:
 *
 *   score = relevance × recency × reuse
 *
 * - relevance = max(normalized BM25, cosine, floor). TWO legs on purpose: FTS5's
 *   unicode61 tokenizer does NOT segment CJK, so the cosine leg (local Ollama
 *   embeddings) carries Chinese; with no embeddings BM25 still ranks English.
 * - recency = exponential half-life decay on max(created_at, last_verified, last_used):
 *   a page freshly re-verified or re-applied is "alive" — never stale-by-birthday.
 * - reuse = 1 + w·log1p(reuse_value): a log-compressed TIE-BREAKER by construction.
 * - confidence is DISPLAYED, never ranked (decision: verification calibrates the
 *   reader's trust, it must not hide an unverified-but-relevant page).
 *
 * NEVER throws; ANY failure degrades to [] (a wiki hiccup must not cost the turn).
 */

/** Total char budget across the rendered pages — overflow drops the LOWEST-scored. */
export const WIKI_RETRIEVE_CHAR_GUARD = 1200;

/** Relevance floor for a candidate with neither an FTS hit nor a comparable embedding. */
export const WIKI_RELEVANCE_FLOOR = 0.05;

/** Reuse weight: log-compressed and small so reuse tie-breaks rather than dominates. */
export const WIKI_REUSE_WEIGHT = 0.15;

/** Candidate pool sizes: FTS top-K ∪ most-recent actives (global cap is 200 — cheap). */
const FTS_POOL = 30;
const RECENT_POOL = 50;

export interface WikiRetrievalInput {
  store: Pick<RunStore, "searchWikiPagesFts" | "getActiveWikiPages">;
  queryText: string;
  /** Resolved ONCE per turn by the caller (shared with episodic); null → BM25/recency-only. */
  queryEmbedding: Float32Array | null;
  now: string;
  cap?: number;
  env?: NodeJS.ProcessEnv;
}

export function retrieveWikiPages(input: WikiRetrievalInput): WikiPageRow[] {
  try {
    const env = input.env ?? process.env;
    const cap = input.cap ?? resolveWikiRetrieveCap(env);
    const halflifeDays = resolveWikiRecencyHalflifeDays(env);
    const nowMs = Date.parse(input.now);

    // Candidate pool: FTS keyword hits ∪ the most recent active pages.
    const ftsHits = input.store.searchWikiPagesFts(input.queryText, FTS_POOL);
    const rankById = new Map<number, number>(ftsHits.map((row) => [row.id, row.rank]));
    const pool = new Map<number, WikiPageRow>(ftsHits.map((row) => [row.id, row]));
    for (const row of input.store.getActiveWikiPages(RECENT_POOL)) {
      if (!pool.has(row.id)) pool.set(row.id, row);
    }
    if (pool.size === 0) return [];

    // BM25 normalization is RELATIVE to the best hit (bm25 ranks are negative,
    // more negative = better): best hit → 1, weaker hits → rank/bestRank ∈ (0,1].
    const bestRank = Math.min(...(ftsHits.length > 0 ? ftsHits.map((r) => r.rank) : [0]));

    const scored = [...pool.values()].map((row) => {
      const rank = rankById.get(row.id);
      const bm25 = rank !== undefined && bestRank < 0 ? clamp01(rank / bestRank) : 0;
      // Number.isFinite guards a NaN/±Infinity cosine (out-of-band blob corruption):
      // NaN survives clamp01/Math.max and makes the sort comparator lie.
      const rawCosine =
        input.queryEmbedding && row.embedding
          ? cosineSimilarity(input.queryEmbedding, blobToFloat32(row.embedding))
          : 0;
      const cosine = Number.isFinite(rawCosine) ? clamp01(rawCosine) : 0;
      const relevance = Math.max(bm25, cosine, WIKI_RELEVANCE_FLOOR);
      const lastAlive = Date.parse(maxIso(row.created_at, row.last_verified, row.last_used));
      const ageDays = Math.max(0, nowMs - lastAlive) / 86_400_000;
      const recency = 2 ** (-ageDays / halflifeDays);
      const reuse = 1 + WIKI_REUSE_WEIGHT * Math.log1p(Math.max(0, row.reuse_value));
      return { row, score: relevance * recency * reuse };
    });

    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.row.id - b.row.id));

    // Top-cap, then the char guard on the RENDERED projection: walk best-first and stop
    // at the first overflow — everything dropped is lower-scored than everything kept.
    const selected: WikiPageRow[] = [];
    let chars = 0;
    for (const { row } of scored.slice(0, cap)) {
      const size = renderWikiPageLines(row).join("\n").length;
      if (chars + size > WIKI_RETRIEVE_CHAR_GUARD) break;
      chars += size;
      selected.push(row);
    }
    return selected;
  } catch {
    return []; // retrieval is best-effort — a store/scoring failure never costs the turn
  }
}

/** The composed contradiction line's prefix — exported so tests assert via the constant. */
export const WIKI_CONTRADICTION_LINE_PREFIX = "⚠ sources disagree:";

/** Rendered in place of the confidence label when confidence is NULL (verify-fail save). */
export const WIKI_UNVERIFIED_LABEL = "unverified";

/**
 * One page's composed lines: a flattened title line carrying the DISPLAYED confidence
 * (never a ranking factor), then the sanitized key facts, then one ⚠ line per stored
 * contradiction (the claim only — both verbatim sides stay on the row/.md). body_md is
 * NEVER rendered into a prompt (ADR 0020 decision 7c). The whitespace flatten is
 * defense-in-depth over the write-time sanitize, so a stored line break can never forge
 * an extra section line in the SYSTEM prompt.
 */
export function renderWikiPageLines(
  page: Pick<WikiPageRow, "title" | "key_facts" | "contradictions" | "confidence" | "last_verified">
): string[] {
  const title = flatten(page.title);
  if (title.length === 0) return [];
  const label =
    page.confidence === null
      ? WIKI_UNVERIFIED_LABEL
      : `confidence ${page.confidence.toFixed(2)}` +
        (page.last_verified ? `, verified ${page.last_verified.slice(0, 10)}` : "");
  const lines = [`- ${title} (${label}):`];
  for (const fact of parseWikiStringArray(page.key_facts)) {
    const flat = flatten(fact);
    if (flat.length > 0) lines.push(`  - ${flat}`);
  }
  for (const c of parseWikiContradictions(page.contradictions)) {
    const claim = flatten(c.claim);
    if (claim.length > 0) lines.push(`  - ${WIKI_CONTRADICTION_LINE_PREFIX} ${claim}`);
  }
  return lines;
}

/** Render the retrieved pages as the composed wiki section's body. */
export function renderWikiBlock(pages: ReadonlyArray<WikiPageRow>): string {
  return pages.flatMap((page) => renderWikiPageLines(page)).join("\n");
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function maxIso(a: string, ...rest: Array<string | null>): string {
  let best = a;
  for (const candidate of rest) {
    if (candidate !== null && candidate > best) best = candidate;
  }
  return best;
}
