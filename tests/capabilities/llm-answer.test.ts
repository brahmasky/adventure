import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLM_MODEL,
  createLlmAnswerAdapter,
  type FetchImpl
} from "../../src/capabilities/llm-answer.js";

function okResponse(json: unknown, status = 200): Awaited<ReturnType<FetchImpl>> {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

const textResponse = {
  content: [{ type: "text", text: "The capital of France is Paris." }]
};

describe("createLlmAnswerAdapter", () => {
  it("returns the answer and sends a correct Anthropic Messages request", async () => {
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
        model: "claude-sonnet-4-6"
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
      output: { question: "ping", answer: "The capital of France is Paris.", model: DEFAULT_LLM_MODEL }
    });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).model).toBe("claude-haiku-4-5");
  });

  it("fails without calling fetch when the API key is missing", async () => {
    const fetchImpl = vi.fn(async () => okResponse(textResponse));
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const adapter = createLlmAnswerAdapter({ model: "claude-sonnet-4-6", fetchImpl });
      const result = await adapter({ question: "hi" });

      expect(result).toEqual({ ok: false, error: "ANTHROPIC_API_KEY is not set" });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
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

  it("maps a non-2xx HTTP response to a structured error", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ error: "rate limited" }, 429));
    const adapter = createLlmAnswerAdapter({ apiKey: "test-key", model: "claude-sonnet-4-6", fetchImpl });

    const result = await adapter({ question: "hi" });

    expect(result).toEqual({ ok: false, error: "LLM request returned HTTP 429" });
  });

  it("fails when the response has no text content block", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ content: [] }));
    const adapter = createLlmAnswerAdapter({ apiKey: "test-key", model: "claude-sonnet-4-6", fetchImpl });

    const result = await adapter({ question: "hi" });

    expect(result).toEqual({ ok: false, error: "LLM response missing text content" });
  });

  it("maps a thrown fetch error to a structured failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const adapter = createLlmAnswerAdapter({ apiKey: "test-key", model: "claude-sonnet-4-6", fetchImpl });

    const result = await adapter({ question: "hi" });

    expect(result).toEqual({ ok: false, error: "LLM request failed: socket hang up" });
  });
});
