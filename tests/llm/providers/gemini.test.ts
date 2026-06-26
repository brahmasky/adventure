import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GEMINI_DEFAULT_MODEL,
  GEMINI_DEFAULT_MAX_TOKENS,
  createGeminiProvider,
  type GeminiFetchImpl
} from "../../../src/llm/providers/gemini.js";

function okResponse(json: unknown, status = 200): Awaited<ReturnType<GeminiFetchImpl>> {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

const contentResponse = {
  choices: [{ message: { content: "Paris." } }]
};

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "HOUGE_GEMINI_BASE_URL",
  "HOUGE_LLM_MODEL_GEMINI",
  "HOUGE_GEMINI_MAX_TOKENS",
  "HOUGE_LLM_TIMEOUT_MS_GEMINI",
  "HOUGE_LLM_TIMEOUT_MS"
] as const;

const SNAPSHOT: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) SNAPSHOT[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = SNAPSHOT[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("createGeminiProvider", () => {
  it("returns an ok LlmResult and shapes the request against the OpenAI-compat endpoint", async () => {
    const fetchImpl = vi.fn<GeminiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createGeminiProvider({ apiKey: "test-key", model: "gemini-test", fetchImpl });

    const result = await provider.answer({ question: "What is the capital of France?" });

    expect(result).toEqual({
      ok: true,
      provider: "gemini-api",
      model: "gemini-test",
      answer: "Paris."
    });
    expect(provider.name).toBe("gemini-api");

    const [url, init] = fetchImpl.mock.calls[0]!;
    // Base already includes /v1beta/openai; the factory appends /chat/completions (NOT /v1/...).
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gemini-test");
    expect(body.max_tokens).toBe(GEMINI_DEFAULT_MAX_TOKENS);
    expect(body.messages[0]).toEqual({ role: "user", content: "What is the capital of France?" });
  });

  it("defaults to gemini-3.5-flash when no model is configured", async () => {
    delete process.env.HOUGE_LLM_MODEL_GEMINI;
    const fetchImpl = vi.fn<GeminiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createGeminiProvider({ apiKey: "test-key", fetchImpl });

    const result = await provider.answer({ question: "ping" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe(GEMINI_DEFAULT_MODEL);
    expect(GEMINI_DEFAULT_MODEL).toBe("gemini-3.5-flash");
  });

  it("prepends a system message when a system prompt is provided", async () => {
    const fetchImpl = vi.fn<GeminiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createGeminiProvider({ apiKey: "test-key", model: "g", fetchImpl });

    await provider.answer({ question: "Q", system: "Be neutral." });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: "Be neutral." });
  });

  it("fires onUsage with normalized token usage when the response carries a usage block", async () => {
    const fetchImpl = vi.fn<GeminiFetchImpl>(async () =>
      okResponse({
        choices: [{ message: { content: "Paris." } }],
        usage: { prompt_tokens: 13, completion_tokens: 2 }
      })
    );
    const calls: Array<{ usage: unknown; model: string }> = [];
    const provider = createGeminiProvider({
      apiKey: "test-key",
      model: "gemini-test",
      fetchImpl,
      onUsage: (usage, model) => calls.push({ usage, model })
    });

    await provider.answer({ question: "Q" });

    expect(calls).toEqual([
      { usage: { input_tokens: 13, output_tokens: 2, cached_input_tokens: 0 }, model: "gemini-test" }
    ]);
  });

  it("classifies a missing API key as unavailable without calling fetch", async () => {
    delete process.env.GEMINI_API_KEY;
    const fetchImpl = vi.fn<GeminiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createGeminiProvider({ model: "g", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "gemini-api",
      error: "GEMINI_API_KEY is not set",
      unavailable: true
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a non-2xx HTTP response to a plain (non-unavailable) error with the Gemini label", async () => {
    const fetchImpl = vi.fn<GeminiFetchImpl>(async () => okResponse({ error: "quota" }, 429));
    const provider = createGeminiProvider({ apiKey: "test-key", model: "g", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "gemini-api",
      error: "Gemini request returned HTTP 429"
    });
  });

  it("fails when the response carries no message content", async () => {
    const fetchImpl = vi.fn<GeminiFetchImpl>(async () => okResponse({ choices: [] }));
    const provider = createGeminiProvider({ apiKey: "test-key", model: "g", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "gemini-api",
      error: "Gemini response missing message content"
    });
  });

  it("honors HOUGE_GEMINI_MAX_TOKENS override", async () => {
    process.env.HOUGE_GEMINI_MAX_TOKENS = "16384";
    const fetchImpl = vi.fn<GeminiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createGeminiProvider({ apiKey: "test-key", model: "g", fetchImpl });

    await provider.answer({ question: "hi" });

    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).max_tokens).toBe(16384);
  });
});
