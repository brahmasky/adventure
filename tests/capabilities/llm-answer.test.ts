import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLM_MODEL,
  createLlmAnswerAdapter,
  type FetchImpl
} from "../../src/capabilities/llm-answer.js";
import type { LlmProvider } from "../../src/llm/types.js";

function okResponse(json: unknown, status = 200): Awaited<ReturnType<FetchImpl>> {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

const textResponse = {
  content: [{ type: "text", text: "The capital of France is Paris." }]
};

describe("createLlmAnswerAdapter", () => {
  it("returns the answer (with provider) and sends a correct Anthropic Messages request", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse(textResponse));
    const adapter = createLlmAnswerAdapter({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
      fetchImpl
    });

    const result = await adapter({ question: "What is the capital of France?" });

    expect(result).toEqual({
      ok: true,
      output: {
        question: "What is the capital of France?",
        answer: "The capital of France is Paris.",
        model: "claude-sonnet-4-6",
        provider: "anthropic"
      }
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("test-key");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("claude-sonnet-4-6");
    expect(sent.max_tokens).toBe(1024);
    expect(sent.messages[0].content).toBe("What is the capital of France?");
  });

  it("defaults to claude-haiku-4-5 when no model or env override is set", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse(textResponse));
    const adapter = createLlmAnswerAdapter({ apiKey: "test-key", fetchImpl });

    const result = await adapter({ question: "ping" });

    expect(result).toEqual({
      ok: true,
      output: {
        question: "ping",
        answer: "The capital of France is Paris.",
        model: DEFAULT_LLM_MODEL,
        provider: "anthropic"
      }
    });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).model).toBe("claude-haiku-4-5");
  });

  it("rejects a missing or empty question without calling fetch", async () => {
    const fetchImpl = vi.fn(async () => okResponse(textResponse));
    const adapter = createLlmAnswerAdapter({ apiKey: "test-key", model: "claude-sonnet-4-6", fetchImpl });

    expect(await adapter({ question: "" })).toEqual({
      ok: false,
      error: "question must be a non-empty string"
    });
    expect(await adapter({})).toEqual({
      ok: false,
      error: "question must be a non-empty string"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a chain failure to a flat capability error", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ error: "rate limited" }, 429));
    const adapter = createLlmAnswerAdapter({ apiKey: "test-key", model: "claude-sonnet-4-6", fetchImpl });

    const result = await adapter({ question: "hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("anthropic");
      expect(result.error).toContain("HTTP 429");
    }
  });

  it("supports an injected provider chain (no env / network)", async () => {
    const fakeProvider: LlmProvider = {
      name: "fake",
      async answer(req) {
        return { ok: true, provider: "fake", model: "fake-model", answer: `echo:${req.question}` };
      }
    };
    const adapter = createLlmAnswerAdapter({ chain: [fakeProvider] });

    const result = await adapter({ question: "hi" });

    expect(result).toEqual({
      ok: true,
      output: { question: "hi", answer: "echo:hi", model: "fake-model", provider: "fake" }
    });
  });
});
