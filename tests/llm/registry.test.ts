import { describe, expect, it } from "vitest";
import {
  answerWithChain,
  buildLlmChain,
  resolveChainBudgetMs,
  RUNNER_TIMEOUT_BUFFER_MS
} from "../../src/llm/registry.js";
import { PI_DEFAULT_TIMEOUT_MS } from "../../src/llm/providers/pi.js";
import { KIMI_DEFAULT_TIMEOUT_MS } from "../../src/llm/providers/kimi.js";
import type { LlmProvider, LlmResult } from "../../src/llm/types.js";

function provider(name: string, result: LlmResult): LlmProvider {
  return { name, answer: async () => result };
}

describe("buildLlmChain", () => {
  it("defaults to the pi,kimi-api chain", () => {
    const chain = buildLlmChain({});
    expect(chain.map((p) => p.name)).toEqual(["pi", "kimi-api"]);
  });

  it("resolves the pi provider when named (but does not default to it)", () => {
    const chain = buildLlmChain({ HOUGE_LLM_PROVIDERS: "pi" } as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["pi"]);
  });

  it("resolves the kimi-api provider when named", () => {
    const chain = buildLlmChain({ HOUGE_LLM_PROVIDERS: "kimi-api" } as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["kimi-api"]);
  });

  it("resolves a mixed pi,kimi-api chain in order", () => {
    const chain = buildLlmChain({
      HOUGE_LLM_PROVIDERS: "pi,kimi-api"
    } as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["pi", "kimi-api"]);
  });

  it("throws a clear error on an unknown provider name", () => {
    expect(() =>
      buildLlmChain({ HOUGE_LLM_PROVIDERS: "pi,kimi" } as NodeJS.ProcessEnv)
    ).toThrow("Unknown LLM provider: kimi");
  });

  it("treats anthropic as an unknown provider", () => {
    expect(() =>
      buildLlmChain({ HOUGE_LLM_PROVIDERS: "anthropic" } as NodeJS.ProcessEnv, {})
    ).toThrow(/Unknown LLM provider: anthropic/);
  });
});

describe("resolveChainBudgetMs", () => {
  it("sums the per-provider timeouts of the default pi,kimi-api chain", () => {
    const budget = resolveChainBudgetMs({});
    expect(budget).toBe(PI_DEFAULT_TIMEOUT_MS + KIMI_DEFAULT_TIMEOUT_MS);
    expect(budget).toBe(90_000);
  });

  it("honors HOUGE_LLM_TIMEOUT_MS_<NAME> per-provider overrides", () => {
    const budget = resolveChainBudgetMs({
      HOUGE_LLM_PROVIDERS: "pi,kimi-api",
      HOUGE_LLM_TIMEOUT_MS_PI: "10000",
      HOUGE_LLM_TIMEOUT_MS_KIMI: "5000"
    } as NodeJS.ProcessEnv);
    expect(budget).toBe(15_000);
  });

  it("falls back to HOUGE_LLM_TIMEOUT_MS for providers without a specific override", () => {
    const budget = resolveChainBudgetMs({
      HOUGE_LLM_PROVIDERS: "pi,kimi-api",
      HOUGE_LLM_TIMEOUT_MS: "20000"
    } as NodeJS.ProcessEnv);
    expect(budget).toBe(40_000);
  });

  it("derives a runner timeout STRICTLY GREATER than the chain budget", () => {
    // The runner's Promise.race timeout_ms must never kill a healthy chain that
    // is legitimately falling through every provider.
    const chainBudget = resolveChainBudgetMs({});
    const runnerTimeout = chainBudget + RUNNER_TIMEOUT_BUFFER_MS;
    expect(runnerTimeout).toBeGreaterThan(chainBudget);
    expect(runnerTimeout).toBe(105_000);
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
