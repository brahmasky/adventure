import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ASK_SYSTEM_PROMPT,
  createLlmAnswerAdapter
} from "../../src/capabilities/llm-answer.js";
import type { LlmProvider, LlmRequest } from "../../src/llm/types.js";

/** A provider that records the request it received, so we can assert on `system`. */
function capturingProvider(): { provider: LlmProvider; last(): LlmRequest | undefined } {
  let captured: LlmRequest | undefined;
  return {
    provider: {
      name: "capture",
      async answer(req) {
        captured = req;
        return { ok: true, provider: "capture", model: "m", answer: "ok" };
      }
    },
    last: () => captured
  };
}

const SAVED_ASK_PROMPT = process.env.HOUGE_ASK_SYSTEM_PROMPT;
afterEach(() => {
  if (SAVED_ASK_PROMPT === undefined) delete process.env.HOUGE_ASK_SYSTEM_PROMPT;
  else process.env.HOUGE_ASK_SYSTEM_PROMPT = SAVED_ASK_PROMPT;
});

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

  it("threads the default identity system prompt to the chain", async () => {
    delete process.env.HOUGE_ASK_SYSTEM_PROMPT;
    const { provider, last } = capturingProvider();
    const adapter = createLlmAnswerAdapter({ chain: [provider] });

    await adapter({ question: "hi" });

    expect(last()?.system).toBe(DEFAULT_ASK_SYSTEM_PROMPT);
  });

  it("lets HOUGE_ASK_SYSTEM_PROMPT override the default", async () => {
    process.env.HOUGE_ASK_SYSTEM_PROMPT = "Answer like a pirate.";
    const { provider, last } = capturingProvider();
    const adapter = createLlmAnswerAdapter({ chain: [provider] });

    await adapter({ question: "hi" });

    expect(last()?.system).toBe("Answer like a pirate.");
  });

  it("lets a per-call input.system take precedence over the env and default", async () => {
    process.env.HOUGE_ASK_SYSTEM_PROMPT = "env one";
    const { provider, last } = capturingProvider();
    const adapter = createLlmAnswerAdapter({ chain: [provider] });

    await adapter({ question: "hi", system: "call one" });

    expect(last()?.system).toBe("call one");
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
