import { describe, expect, it } from "vitest";
import { createLlmAnswerAdapter } from "../../src/capabilities/llm-answer.js";
import type { LlmProvider } from "../../src/llm/types.js";

describe("createLlmAnswerAdapter", () => {
  it("maps a successful provider result to the capability output", async () => {
    const fakeProvider: LlmProvider = {
      name: "fake",
      async answer({ question }) {
        return { ok: true, provider: "fake", model: "fake-model", answer: `A:${question}` };
      }
    };
    const adapter = createLlmAnswerAdapter({ chain: [fakeProvider] });

    const result = await adapter({ question: "What is the capital of France?" });

    expect(result).toEqual({
      ok: true,
      output: {
        question: "What is the capital of France?",
        answer: "A:What is the capital of France?",
        model: "fake-model",
        provider: "fake"
      }
    });
  });

  it("rejects a missing or empty question without calling the chain", async () => {
    let called = false;
    const fakeProvider: LlmProvider = {
      name: "fake",
      async answer() {
        called = true;
        return { ok: true, provider: "fake", model: "fake-model", answer: "x" };
      }
    };
    const adapter = createLlmAnswerAdapter({ chain: [fakeProvider] });

    expect(await adapter({ question: "" })).toEqual({
      ok: false,
      error: "question must be a non-empty string"
    });
    expect(await adapter({})).toEqual({
      ok: false,
      error: "question must be a non-empty string"
    });
    expect(called).toBe(false);
  });

  it("maps a chain failure to a flat capability error", async () => {
    const fakeProvider: LlmProvider = {
      name: "fake",
      async answer() {
        return { ok: false, provider: "fake", error: "boom" };
      }
    };
    const adapter = createLlmAnswerAdapter({ chain: [fakeProvider] });

    const result = await adapter({ question: "hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("boom");
    }
  });
});
