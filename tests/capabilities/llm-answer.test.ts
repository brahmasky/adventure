import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ASK_SYSTEM_PROMPT,
  createLlmAnswerAdapter
} from "../../src/capabilities/llm-answer.js";
import type { LlmProvider, LlmRequest } from "../../src/llm/types.js";
import { UNAUDITED_TEST_SINK, recordingSink } from "../helpers/llm-audit.js";

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
    const adapter = createLlmAnswerAdapter({ chain: [fakeProvider], audit: UNAUDITED_TEST_SINK });

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
    const adapter = createLlmAnswerAdapter({ chain: [provider], audit: UNAUDITED_TEST_SINK });

    await adapter({ question: "hi" });

    expect(last()?.system).toBe(DEFAULT_ASK_SYSTEM_PROMPT);
  });

  it("lets HOUGE_ASK_SYSTEM_PROMPT override the default", async () => {
    process.env.HOUGE_ASK_SYSTEM_PROMPT = "Answer like a pirate.";
    const { provider, last } = capturingProvider();
    const adapter = createLlmAnswerAdapter({ chain: [provider], audit: UNAUDITED_TEST_SINK });

    await adapter({ question: "hi" });

    expect(last()?.system).toBe("Answer like a pirate.");
  });

  it("lets a per-call input.system take precedence over the env and default", async () => {
    process.env.HOUGE_ASK_SYSTEM_PROMPT = "env one";
    const { provider, last } = capturingProvider();
    const adapter = createLlmAnswerAdapter({ chain: [provider], audit: UNAUDITED_TEST_SINK });

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
    const adapter = createLlmAnswerAdapter({ chain: [fakeProvider], audit: UNAUDITED_TEST_SINK });

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
    const adapter = createLlmAnswerAdapter({ chain: [fakeProvider], audit: UNAUDITED_TEST_SINK });

    const result = await adapter({ question: "hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("boom");
    }
  });
});

describe("audit is a required constructor parameter (slice 2, B1)", () => {
  it("threads the sink to answerWithChain — one attempt per leg tried", async () => {
    const sink = recordingSink();
    const dead: LlmProvider = {
      name: "agy-cli",
      answer: async () => ({ ok: false, provider: "agy-cli", error: "agy binary not found (ENOENT)", unavailable: true })
    };
    const live: LlmProvider = {
      name: "pi",
      answer: async () => ({
        ok: true,
        provider: "pi",
        model: "m",
        answer: "hi",
        usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 }
      })
    };
    const result = await createLlmAnswerAdapter({ chain: [dead, live], audit: sink })({ question: "q" });
    expect(result.ok).toBe(true);
    expect(sink.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ["agy-cli", "unavailable"],
      ["pi", "ok"]
    ]);
  });
});
