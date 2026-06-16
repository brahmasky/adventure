import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLM_MODEL,
  createAnthropicProvider,
  type FetchImpl
} from "../../../src/llm/providers/anthropic.js";

function okResponse(json: unknown, status = 200): Awaited<ReturnType<FetchImpl>> {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

const textResponse = {
  content: [{ type: "text", text: "The capital of France is Paris." }]
};

describe("createAnthropicProvider", () => {
  it("returns an ok LlmResult with provider/model/answer", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse(textResponse));
    const provider = createAnthropicProvider({ apiKey: "test-key", model: "claude-sonnet-4-6", fetchImpl });

    const result = await provider.answer({ question: "What is the capital of France?" });

    expect(result).toEqual({
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      answer: "The capital of France is Paris."
    });
    expect(provider.name).toBe("anthropic");
  });

  it("defaults the model to claude-haiku-4-5", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse(textResponse));
    const provider = createAnthropicProvider({ apiKey: "test-key", fetchImpl });

    const result = await provider.answer({ question: "ping" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe(DEFAULT_LLM_MODEL);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).model).toBe("claude-haiku-4-5");
  });

  it("classifies a missing API key as unavailable without calling fetch", async () => {
    const fetchImpl = vi.fn(async () => okResponse(textResponse));
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const provider = createAnthropicProvider({ model: "claude-sonnet-4-6", fetchImpl });
      const result = await provider.answer({ question: "hi" });

      expect(result).toEqual({
        ok: false,
        provider: "anthropic",
        error: "ANTHROPIC_API_KEY is not set",
        unavailable: true
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  it("maps a non-2xx HTTP response to a plain (non-unavailable) error", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ error: "rate limited" }, 429));
    const provider = createAnthropicProvider({ apiKey: "test-key", model: "claude-sonnet-4-6", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "anthropic",
      error: "LLM request returned HTTP 429"
    });
  });

  it("fails when the response has no text content block", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ content: [] }));
    const provider = createAnthropicProvider({ apiKey: "test-key", model: "claude-sonnet-4-6", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "anthropic",
      error: "LLM response missing text content"
    });
  });

  it("maps a thrown fetch error to a structured failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const provider = createAnthropicProvider({ apiKey: "test-key", model: "claude-sonnet-4-6", fetchImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "anthropic",
      error: "LLM request failed: socket hang up"
    });
  });
});
