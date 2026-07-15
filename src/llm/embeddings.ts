/**
 * Local embeddings client (Phase M, ADR 0005 §1 amendment 2026-07-15): vectors come from
 * a LOCAL Ollama HTTP endpoint (`/api/embed`) — a system-service dependency in the same
 * class as the pi/agy CLIs, so `dependencies: {}` holds. GRACEFUL DEGRADATION is the
 * contract: ANY failure (Ollama down, model missing, timeout, malformed body) returns
 * `null` and the caller stores the fact without an embedding (backfillable); retrieval
 * falls back to FTS5. NO retries — fire-and-degrade, never block a distill pass on a
 * sidecar service.
 */

export const DEFAULT_EMBED_URL = "http://localhost:11434";
export const DEFAULT_EMBED_MODEL = "embeddinggemma";
export const DEFAULT_EMBED_TIMEOUT_MS = 5_000;

export interface EmbedConfig {
  url: string;
  model: string;
  timeoutMs: number;
}

export function resolveEmbedConfig(env: NodeJS.ProcessEnv): EmbedConfig {
  const timeout = Number(env.HOUGE_EMBED_TIMEOUT_MS);
  return {
    url: env.HOUGE_EMBED_URL?.trim() || DEFAULT_EMBED_URL,
    model: env.HOUGE_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL,
    timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_EMBED_TIMEOUT_MS
  };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Embed one text via Ollama's `/api/embed` (request `{model, input}`, response
 * `{embeddings: [[...]]}`). Returns the vector, or `null` on ANY failure — a fetch
 * throw, a non-200, a timeout, a malformed body, or an empty vector.
 */
export async function embedText(
  text: string,
  config: EmbedConfig,
  fetchImpl: FetchLike = fetch
): Promise<Float32Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, input: text }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const embeddings = (body as { embeddings?: unknown })?.embeddings;
    if (!Array.isArray(embeddings)) return null;
    const vector = embeddings[0];
    if (!Array.isArray(vector) || vector.length === 0) return null;
    if (!vector.every((v): v is number => typeof v === "number" && Number.isFinite(v))) return null;
    return Float32Array.from(vector);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cosine similarity in [-1, 1]; mismatched lengths or a zero-norm vector ⇒ 0. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Float32Array → the BLOB bytes stored in `episodic_facts.embedding`. */
export function float32ToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

/** BLOB bytes → Float32Array (copies, so any byte offset/alignment is safe). */
export function blobToFloat32(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}
