import { describe, expect, it } from "vitest";
import { answerWithChain, buildLlmChain } from "../../src/llm/registry.js";
import type { LlmProvider, LlmResult } from "../../src/llm/types.js";

function provider(name: string, result: LlmResult): LlmProvider {
  return { name, answer: async () => result };
}

describe("buildLlmChain", () => {
  it("defaults to a single anthropic provider", () => {
    const chain = buildLlmChain({});
    expect(chain.map((p) => p.name)).toEqual(["anthropic"]);
  });

  it("honors HOUGE_LLM_PROVIDERS for the anthropic provider", () => {
    const chain = buildLlmChain({ HOUGE_LLM_PROVIDERS: " anthropic " } as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["anthropic"]);
  });

  it("resolves the pi provider when named (but does not default to it)", () => {
    const chain = buildLlmChain({ HOUGE_LLM_PROVIDERS: "pi" } as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["pi"]);
  });

  it("resolves the kimi-api provider when named", () => {
    const chain = buildLlmChain({ HOUGE_LLM_PROVIDERS: "kimi-api" } as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["kimi-api"]);
  });

  it("resolves a mixed anthropic,pi chain in order", () => {
    const chain = buildLlmChain({
      HOUGE_LLM_PROVIDERS: "anthropic,pi"
    } as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["anthropic", "pi"]);
  });

  it("throws a clear error on an unknown provider name", () => {
    expect(() =>
      buildLlmChain({ HOUGE_LLM_PROVIDERS: "anthropic,kimi" } as NodeJS.ProcessEnv)
    ).toThrow("Unknown LLM provider: kimi");
  });
});

describe("answerWithChain", () => {
  it("returns the first successful provider", async () => {
    const chain = [
      provider("a", { ok: true, provider: "a", model: "m1", answer: "first" }),
      provider("b", { ok: true, provider: "b", model: "m2", answer: "second" })
    ];

    const result = await answerWithChain(chain, { question: "hi" });

    expect(result).toEqual({ ok: true, provider: "a", model: "m1", answer: "first" });
  });

  it("skips an unavailable provider to reach a later one", async () => {
    const chain = [
      provider("a", { ok: false, provider: "a", error: "no key", unavailable: true }),
      provider("b", { ok: true, provider: "b", model: "m2", answer: "from b" })
    ];

    const result = await answerWithChain(chain, { question: "hi" });

    expect(result).toEqual({ ok: true, provider: "b", model: "m2", answer: "from b" });
  });

  it("falls through a plain error to a later provider", async () => {
    const chain = [
      provider("a", { ok: false, provider: "a", error: "HTTP 500" }),
      provider("b", { ok: true, provider: "b", model: "m2", answer: "from b" })
    ];

    const result = await answerWithChain(chain, { question: "hi" });

    expect(result).toEqual({ ok: true, provider: "b", model: "m2", answer: "from b" });
  });

  it("aggregates per-provider reasons when all fail", async () => {
    const chain = [
      provider("a", { ok: false, provider: "a", error: "no key", unavailable: true }),
      provider("b", { ok: false, provider: "b", error: "HTTP 500" })
    ];

    const result = await answerWithChain(chain, { question: "hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.provider).toBe("chain");
      expect(result.error).toBe("a: no key (unavailable); b: HTTP 500 (error)");
    }
  });
});
