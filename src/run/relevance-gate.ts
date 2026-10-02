import { blobToFloat32, cosineSimilarity } from "../llm/embeddings.js";

/**
 * The relevance gate shared by fact and wiki retrieval (memory A1 §3). With a query embedding, a row with an
 * embedding enters only at cosine ≥ gate; a row without one only by an FTS hit. Without a query embedding (Ollama
 * down) only FTS hits enter: BM25 is normalised to the best hit, so it cannot gate. A gate of 0 is today's
 * behaviour (FTS ∪ newest pool, relevance floor).
 */
export function resolveCosineGate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** What a turn's retrieval admitted, for A2/C to recalibrate the gates from live turns. Never text. */
export interface RetrievalTelemetry {
  admitted: number;
  best_admitted: number | null;
  best_rejected: number | null;
  embedding: boolean;
  fts_only: boolean;
}

export interface GatedRetrieval<T> {
  rows: T[];
  best_admitted: number | null;
  best_rejected: number | null;
  embedding: boolean;
  fts_only: boolean;
}

export function admit(input: { gate: number; queryEmbedding: boolean; cosine: number | null; ftsHit: boolean }): boolean {
  if (input.gate <= 0) return true; // pre-A1: the pool decides, the floor ranks
  if (!input.queryEmbedding || input.cosine === null) return input.ftsHit;
  return input.cosine >= input.gate;
}

/** Cosine in [0,1], or null when either side has no comparable embedding (a NaN from a corrupt blob counts as none). */
export function rowCosine(query: Float32Array | null, blob: Uint8Array | null): number | null {
  if (!query || !blob) return null;
  const c = cosineSimilarity(query, blobToFloat32(blob));
  return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : null;
}

export function bestOf(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

export function noRetrieval<T>(embedding: boolean, ftsOnly: boolean): GatedRetrieval<T> {
  return { rows: [], best_admitted: null, best_rejected: null, embedding, fts_only: ftsOnly };
}

export function telemetryOf(r: GatedRetrieval<unknown>, admitted: number): RetrievalTelemetry {
  return { admitted, best_admitted: r.best_admitted, best_rejected: r.best_rejected, embedding: r.embedding, fts_only: r.fts_only };
}
