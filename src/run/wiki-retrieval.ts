import {
  parseWikiContradictions,
  parseWikiStringArray,
  resolveWikiRecencyHalflifeDays,
  resolveWikiRetrieveCap
} from "../capabilities/wiki.js";
import { admit, bestOf, noRetrieval, resolveCosineGate, rowCosine, type GatedRetrieval } from "./relevance-gate.js";
import type { RunStore, WikiPageRow } from "./run-store.js";

/**
 * Wiki retrieval (Phase W Slice W2, ADR 0020 §7c): score the GLOBAL active wiki pages
 * against the incoming turn and return the handful worth folding into the composed
 * prompt. The episodic-retrieval clone (Phase M B3), multiplicative:
 *
 *   score = relevance × recency × reuse
 *
 * - relevance = max(normalized BM25, cosine), behind the A1 relevance gate (the floor applies only at gate 0). TWO legs on purpose: FTS5's
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

/** Relevance floor for a candidate with neither an FTS hit nor a comparable embedding. Used only when the gate is 0 (pre-A1 behaviour). */
export const WIKI_RELEVANCE_FLOOR = 0.05;

/** Reuse weight: log-compressed and small so reuse tie-breaks rather than dominates. */
export const WIKI_REUSE_WEIGHT = 0.15;

/** Memory A1 §3: pages embed lower (long documents), so their gate is lower. 0 = the pre-A1 pool and floor. */
export const DEFAULT_WIKI_MIN_COSINE = 0.42;

export function resolveWikiMinCosine(env: NodeJS.ProcessEnv): number {
  return resolveCosineGate(env.HOUGE_WIKI_MIN_COSINE, DEFAULT_WIKI_MIN_COSINE);
}

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

export function retrieveWikiPages(input: WikiRetrievalInput): GatedRetrieval<WikiPageRow> {
  const env = input.env ?? process.env;
  const gate = resolveWikiMinCosine(env);
  const none = noRetrieval<WikiPageRow>(input.queryEmbedding !== null, gate > 0 && input.queryEmbedding === null);
  try {
    const ftsHits = input.store.searchWikiPagesFts(input.queryText, FTS_POOL);
    const pool = new Map<number, WikiPageRow>(ftsHits.map((row) => [row.id, row]));
    if (!(gate > 0 && input.queryEmbedding === null)) {
      for (const row of gate > 0 ? input.store.getActiveWikiPages() : input.store.getActiveWikiPages(RECENT_POOL)) {
        if (!pool.has(row.id)) pool.set(row.id, row);
      }
    }
    if (pool.size === 0) return none;
    const judged = judgePages(input, [...pool.values()], ftsHits, gate, env);
    judged.admitted.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.row.id - b.row.id));
    const rows = pagesWithinGuard(judged.admitted.slice(0, input.cap ?? resolveWikiRetrieveCap(env)).map((s) => s.row));
    return { ...none, rows, best_admitted: bestOf(judged.admittedCos), best_rejected: bestOf(judged.rejectedCos) };
  } catch {
    return none; // retrieval is best-effort — a store/scoring failure never costs the turn
  }
}

type ScoredPage = { row: WikiPageRow; score: number };

function judgePages(
  input: WikiRetrievalInput, pool: WikiPageRow[], ftsHits: Array<WikiPageRow & { rank: number }>, gate: number, env: NodeJS.ProcessEnv
): { admitted: ScoredPage[]; admittedCos: number[]; rejectedCos: number[] } {
  const rankById = new Map<number, number>(ftsHits.map((row) => [row.id, row.rank]));
  const bestRank = Math.min(...(ftsHits.length > 0 ? ftsHits.map((r) => r.rank) : [0]));
  const halflifeDays = resolveWikiRecencyHalflifeDays(env);
  const nowMs = Date.parse(input.now);
  const out = { admitted: [] as ScoredPage[], admittedCos: [] as number[], rejectedCos: [] as number[] };
  for (const row of pool) {
    const rank = rankById.get(row.id);
    const cosine = rowCosine(input.queryEmbedding, row.embedding);
    const ok = admit({ gate, queryEmbedding: input.queryEmbedding !== null, cosine, ftsHit: rank !== undefined });
    if (cosine !== null) (ok ? out.admittedCos : out.rejectedCos).push(cosine);
    if (!ok) continue;
    const bm25 = rank !== undefined && bestRank < 0 ? clamp01(rank / bestRank) : 0;
    const relevance = Math.max(bm25, cosine ?? 0, gate > 0 ? 0 : WIKI_RELEVANCE_FLOOR);
    const ageDays = Math.max(0, nowMs - Date.parse(maxIso(row.created_at, row.last_verified, row.last_used))) / 86_400_000;
    const reuse = 1 + WIKI_REUSE_WEIGHT * Math.log1p(Math.max(0, row.reuse_value));
    out.admitted.push({ row, score: relevance * 2 ** (-ageDays / halflifeDays) * reuse });
  }
  return out;
}

/** The char guard on the RENDERED projection, best-first, stopping at the first overflow. */
function pagesWithinGuard(rows: WikiPageRow[]): WikiPageRow[] {
  const selected: WikiPageRow[] = [];
  let chars = 0;
  for (const row of rows) {
    const size = renderWikiPageLines(row).join("\n").length;
    if (chars + size > WIKI_RETRIEVE_CHAR_GUARD) break;
    chars += size;
    selected.push(row);
  }
  return selected;
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
