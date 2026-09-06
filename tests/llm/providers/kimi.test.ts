import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KIMI_DEFAULT_MODEL,
  createKimiProvider,
  type KimiFetchImpl
} from "../../../src/llm/providers/kimi.js";

function okResponse(json: unknown, status = 200): Awaited<ReturnType<KimiFetchImpl>> {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

const contentResponse = {
  choices: [{ message: { content: "Paris." } }]
};

// Hermetic env keys: snapshot + restore everything kimi reads.
const ENV_KEYS = [
  "KIMI_API_KEY",
  "HOUGE_KIMI_BASE_URL",
  "HOUGE_LLM_MODEL_KIMI",
  "HOUGE_LLM_MODEL",
  "HOUGE_LLM_TIMEOUT_MS_KIMI",
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
  // Ensure no leakage of the secret/config keys between tests by default.
  for (const key of ENV_KEYS) {
    if (SNAPSHOT[key] === undefined) delete process.env[key];
  }
});

describe("createKimiProvider", () => {
  it("returns an ok LlmResult and shapes the request correctly", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createKimiProvider({ apiKey: "test-key", model: "kimi-test", fetchImpl });

    const result = await provider.answer({ question: "What is the capital of France?" });

    expect(result).toEqual({
      ok: true,
      provider: "kimi-api",
      model: "kimi-test",
      answer: "Paris."
    });
    expect(provider.name).toBe("kimi-api");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe("What is the capital of France?");
    expect(body.messages[0].role).toBe("user");
    expect(body.max_tokens).toBe(4096); // KIMI_DEFAULT_MAX_TOKENS (override: HOUGE_KIMI_MAX_TOKENS)
    expect(body.model).toBe("kimi-test");
  });

  it("fires onUsage with normalized token usage when the response carries a usage block", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () =>
      okResponse({
        choices: [{ message: { content: "Paris." } }],
        usage: {
          prompt_tokens: 42,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 30 }
        }
      })
    );
    const calls: Array<{ usage: unknown; model: string }> = [];
    const provider = createKimiProvider({
      apiKey: "test-key",
      model: "kimi-test",
      fetchImpl,
      onUsage: (usage, model) => calls.push({ usage, model })
    });

    const result = await provider.answer({ question: "What is the capital of France?" });

    // Slice 2: usage rides BOTH the side channel and the result (hooks retire in Task 9).
    expect(result).toEqual({
      ok: true,
      provider: "kimi-api",
      model: "kimi-test",
      answer: "Paris.",
      usage: { input_tokens: 42, output_tokens: 7, cached_input_tokens: 30 }
    });
    expect(calls).toEqual([
      {
        usage: { input_tokens: 42, output_tokens: 7, cached_input_tokens: 30 },
        model: "kimi-test"
      }
    ]);
  });

  it("ALSO returns the same normalized usage on the result (slice 2)", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () =>
      okResponse({
        choices: [{ message: { content: "Paris." } }],
        usage: {
          prompt_tokens: 42,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 30 }
        }
      })
    );
    const provider = createKimiProvider({ apiKey: "test-key", model: "kimi-test", fetchImpl });

    const result = await provider.answer({ question: "What is the capital of France?" });

    expect(result.ok && result.usage).toEqual({ input_tokens: 42, output_tokens: 7, cached_input_tokens: 30 });
  });

  it("does not fire onUsage when the response has no usage block", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => okResponse(contentResponse));
    const onUsage = vi.fn();
    const provider = createKimiProvider({ apiKey: "test-key", model: "kimi-test", fetchImpl, onUsage });

    await provider.answer({ question: "hi" });

    expect(onUsage).not.toHaveBeenCalled();
  });

  it("prepends a system message when a system prompt is provided", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createKimiProvider({ apiKey: "test-key", model: "kimi-test", fetchImpl });

    await provider.answer({ question: "What is the capital of France?", system: "Be neutral." });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: "Be neutral." });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "What is the capital of France?"
    });
  });

  it("sends only the user message when no system prompt is provided", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createKimiProvider({ apiKey: "test-key", model: "kimi-test", fetchImpl });

    await provider.answer({ question: "hi" });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("defaults the model when none is configured", async () => {
    delete process.env.HOUGE_LLM_MODEL_KIMI;
    delete process.env.HOUGE_LLM_MODEL;
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createKimiProvider({ apiKey: "test-key", fetchImpl });

    const result = await provider.answer({ question: "ping" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe(KIMI_DEFAULT_MODEL);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).model).toBe(KIMI_DEFAULT_MODEL);
  });

  it("honors a custom base URL", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createKimiProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test",
      fetchImpl
    });

    await provider.answer({ question: "hi" });

    expect(fetchImpl.mock.calls[0]![0]).toBe("https://example.test/v1/chat/completions");
  });

  it("classifies a missing API key as unavailable without calling fetch", async () => {
    delete process.env.KIMI_API_KEY;
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => okResponse(contentResponse));
    const provider = createKimiProvider({ model: "kimi-test", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "kimi-api",
      error: "KIMI_API_KEY is not set",
      unavailable: true
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a non-2xx HTTP response to a plain (non-unavailable) error", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => okResponse({ error: "rate limited" }, 429));
    const provider = createKimiProvider({ apiKey: "test-key", model: "kimi-test", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "kimi-api",
      error: "Kimi request returned HTTP 429"
    });
  });

  it("fails when the response has no message content (empty choices)", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => okResponse({ choices: [] }));
    const provider = createKimiProvider({ apiKey: "test-key", model: "kimi-test", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "kimi-api",
      error: "Kimi response missing message content"
    });
  });

  it("fails when choices[0].message.content is missing", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () =>
      okResponse({ choices: [{ message: {} }] })
    );
    const provider = createKimiProvider({ apiKey: "test-key", model: "kimi-test", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "kimi-api",
      error: "Kimi response missing message content"
    });
  });

  it("treats malformed (non-object) JSON as missing content", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => okResponse("not an object"));
    const provider = createKimiProvider({ apiKey: "test-key", model: "kimi-test", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "kimi-api",
      error: "Kimi response missing message content"
    });
  });

  it("maps a thrown fetch (network) error to a structured failure", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async () => {
      throw new Error("socket hang up");
    });
    const provider = createKimiProvider({ apiKey: "test-key", model: "kimi-test", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "kimi-api",
      error: "Kimi request failed: socket hang up"
    });
  });

  it("maps an aborted request (timeout) to a timeout error", async () => {
    const fetchImpl = vi.fn<KimiFetchImpl>(async (_url, init) => {
      // Honor the signal: reject with an AbortError-like error if aborted,
      // otherwise simulate an abort.
      const abortErr = Object.assign(new Error("The operation was aborted"), {
        name: "AbortError"
      });
      if (init.signal?.aborted) throw abortErr;
      throw abortErr;
    });
    const provider = createKimiProvider({
      apiKey: "test-key",
      model: "kimi-test",
      timeoutMs: 5000,
      fetchImpl
    });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "kimi-api",
      error: "Kimi request timed out after 5000ms"
    });
    // The signal must have been passed into fetch.
    expect(fetchImpl.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
});
