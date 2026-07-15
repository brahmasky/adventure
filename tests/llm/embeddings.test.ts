import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blobToFloat32,
  cosineSimilarity,
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_TIMEOUT_MS,
  DEFAULT_EMBED_URL,
  embedText,
  float32ToBlob,
  resolveEmbedConfig
} from "../../src/llm/embeddings.js";

// Hermetic (self-write test-gate rule): pin every embed env var to its code default
// (delete) so a daemon .env pointing at a real Ollama can never flip these assertions.
const EMBED_ENV_VARS = ["HOUGE_EMBED_URL", "HOUGE_EMBED_MODEL", "HOUGE_EMBED_TIMEOUT_MS"] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of EMBED_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of EMBED_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const CONFIG = { url: "http://localhost:11434", model: "embeddinggemma", timeoutMs: 5_000 };

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("resolveEmbedConfig", () => {
  it("defaults to local Ollama + embeddinggemma + 5s", () => {
    expect(resolveEmbedConfig(process.env)).toEqual({
      url: DEFAULT_EMBED_URL,
      model: DEFAULT_EMBED_MODEL,
      timeoutMs: DEFAULT_EMBED_TIMEOUT_MS
    });
    expect(DEFAULT_EMBED_URL).toBe("http://localhost:11434");
  });

  it("honors overrides; garbage timeout falls back to the default", () => {
    expect(
      resolveEmbedConfig({
        HOUGE_EMBED_URL: "http://box:9999",
        HOUGE_EMBED_MODEL: "nomic-embed-text",
        HOUGE_EMBED_TIMEOUT_MS: "1500"
      })
    ).toEqual({ url: "http://box:9999", model: "nomic-embed-text", timeoutMs: 1_500 });
    expect(resolveEmbedConfig({ HOUGE_EMBED_TIMEOUT_MS: "-3" }).timeoutMs).toBe(DEFAULT_EMBED_TIMEOUT_MS);
    expect(resolveEmbedConfig({ HOUGE_EMBED_TIMEOUT_MS: "soon" }).timeoutMs).toBe(DEFAULT_EMBED_TIMEOUT_MS);
  });
});

describe("embedText (fire-and-degrade — ANY failure ⇒ null, never a throw)", () => {
  it("posts {model, input} to /api/embed and returns the first vector", async () => {
    let captured: { url: string; body: unknown } | undefined;
    const vector = await embedText("Paco lives in Sydney", CONFIG, async (url, init) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return okResponse({ embeddings: [[0.1, 0.2, 0.3]] });
    });
    expect(captured?.url).toBe("http://localhost:11434/api/embed");
    expect(captured?.body).toEqual({ model: "embeddinggemma", input: "Paco lives in Sydney" });
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector!.length).toBe(3);
  });

  it("a fetch throw (Ollama down) ⇒ null", async () => {
    expect(
      await embedText("x", CONFIG, async () => {
        throw new Error("ECONNREFUSED");
      })
    ).toBeNull();
  });

  it("a non-200 (model missing) ⇒ null", async () => {
    expect(await embedText("x", CONFIG, async () => new Response("no such model", { status: 404 }))).toBeNull();
  });

  it("a timeout aborts and ⇒ null", async () => {
    const result = await embedText("x", { ...CONFIG, timeoutMs: 10 }, (_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    expect(result).toBeNull();
  });

  it("malformed bodies ⇒ null: non-JSON, missing/odd embeddings, empty or non-numeric vector", async () => {
    expect(await embedText("x", CONFIG, async () => new Response("not json", { status: 200 }))).toBeNull();
    expect(await embedText("x", CONFIG, async () => okResponse({}))).toBeNull();
    expect(await embedText("x", CONFIG, async () => okResponse({ embeddings: "yes" }))).toBeNull();
    expect(await embedText("x", CONFIG, async () => okResponse({ embeddings: [] }))).toBeNull();
    expect(await embedText("x", CONFIG, async () => okResponse({ embeddings: [[]] }))).toBeNull();
    expect(await embedText("x", CONFIG, async () => okResponse({ embeddings: [["a", "b"]] }))).toBeNull();
    expect(await embedText("x", CONFIG, async () => okResponse({ embeddings: [[1, null, 3]] }))).toBeNull();
  });
});

describe("cosineSimilarity + blob converters", () => {
  it("cosine: identical ⇒ 1, orthogonal ⇒ 0; mismatched lengths or zero norms ⇒ 0", () => {
    const a = Float32Array.from([1, 0, 2]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
    expect(cosineSimilarity(a, Float32Array.from([1, 0]))).toBe(0);
    expect(cosineSimilarity(a, Float32Array.from([0, 0, 0]))).toBe(0);
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
  });

  it("float32ToBlob / blobToFloat32 round-trip, including an offset view", () => {
    const original = Float32Array.from([0.5, -1.25, 3]);
    expect(Array.from(blobToFloat32(float32ToBlob(original)))).toEqual([0.5, -1.25, 3]);

    // A blob that is a non-aligned view over a larger buffer must still decode (copies).
    const padded = new Uint8Array(1 + original.byteLength);
    padded.set(float32ToBlob(original), 1);
    const view = padded.subarray(1);
    expect(Array.from(blobToFloat32(view))).toEqual([0.5, -1.25, 3]);
  });
});
