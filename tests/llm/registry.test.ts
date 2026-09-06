import { describe, expect, it, vi } from "vitest";
import {
  answerWithChain,
  buildLlmChain,
  resolveChainBudgetMs,
  METERED_FALLBACK_PROVIDERS,
  RUNNER_TIMEOUT_BUFFER_MS
} from "../../src/llm/registry.js";
import { PI_DEFAULT_TIMEOUT_MS } from "../../src/llm/providers/pi.js";
import { AGY_DEFAULT_TIMEOUT_MS } from "../../src/llm/providers/agy-cli.js";
import { METERED_PROVIDERS } from "../../src/llm/metered-pricing.js";
import type { LlmProvider, LlmResult } from "../../src/llm/types.js";
import type { LlmAuditSink } from "../../src/llm/audit.js";
import { recordingSink } from "../helpers/llm-audit.js";

function provider(name: string, result: LlmResult): LlmProvider {
  return { name, answer: async () => result };
}

describe("buildLlmChain", () => {
  it("defaults to the flat-rate pi,agy-cli chain", () => {
    const chain = buildLlmChain({});
    expect(chain.map((p) => p.name)).toEqual(["pi", "agy-cli"]);
  });

  it("has a non-empty metered set, so the guarantee below cannot be emptied away", () => {
    // The assertion under test iterates METERED_PROVIDERS; an empty set would pass vacuously.
    expect(METERED_PROVIDERS.size).toBeGreaterThan(0);
  });

  it("names NO metered provider in the default chain", () => {
    // The guarantee of the CLI-only migration: nothing reaches a pay-per-token API by default.
    // An unset HOUGE_LLM_PROVIDERS must never be able to spend money.
    const names = buildLlmChain({}).map((p) => p.name);
    for (const metered of METERED_PROVIDERS) expect(names).not.toContain(metered);
  });

  it("still builds a metered chain when one is named explicitly (the escape hatch)", () => {
    const chain = buildLlmChain({ HOUGE_LLM_PROVIDERS: "gemini-api,kimi-api" } as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["gemini-api", "kimi-api"]);
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

  it("resolves the agy-cli and gemini-api providers when named", () => {
    const chain = buildLlmChain({ HOUGE_LLM_PROVIDERS: "agy-cli,gemini-api" } as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["agy-cli", "gemini-api"]);
  });

  it("resolves the full 4-leg Phase 3.4 chain in order", () => {
    const chain = buildLlmChain({
      HOUGE_LLM_PROVIDERS: "pi,agy-cli,kimi-api,gemini-api"
    } as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["pi", "agy-cli", "kimi-api", "gemini-api"]);
  });

  it("drops an operator's EXPLICIT metered leg once the ceiling latches", () => {
    // Documents the sharp edge in the escape hatch: an operator who names a metered leg because
    // both CLIs are down loses it the moment the fuse latches, and the fallback is a flat-rate leg
    // — possibly the very one that was failing. The chain builder logs when it does this; this
    // test pins the behavior so the substitution is a decision, not a surprise.
    const chain = buildLlmChain({ HOUGE_LLM_PROVIDERS: "gemini-api" } as NodeJS.ProcessEnv, {
      meteredBreached: () => true
    });
    expect(chain.map((p) => p.name)).toEqual([...METERED_FALLBACK_PROVIDERS]);
  });

  it("keeps the flat-rate legs when the ceiling latches on a mixed chain", () => {
    const chain = buildLlmChain({ HOUGE_LLM_PROVIDERS: "pi,gemini-api,agy-cli" } as NodeJS.ProcessEnv, {
      meteredBreached: () => true
    });
    expect(chain.map((p) => p.name)).toEqual(["pi", "agy-cli"]);
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
  // NOTE: the CLI-only default (pi,agy-cli) budgets 120s, up from 90s for pi,kimi-api — agy's
  // 60s leg replaces kimi's 30s one. The derived runner cap moves 105s → 135s. That is the
  // worst case of a chain falling through every leg, not the normal path.
  it("sums the per-provider timeouts of the default pi,agy-cli chain", () => {
    const budget = resolveChainBudgetMs({});
    expect(budget).toBe(PI_DEFAULT_TIMEOUT_MS + AGY_DEFAULT_TIMEOUT_MS);
    expect(budget).toBe(120_000);
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
    expect(runnerTimeout).toBe(135_000);
  });
});

describe("answerWithChain fall-through visibility", () => {
  it("logs the legs that fell through even when a later leg succeeds", async () => {
    // The exact mechanism by which D1 hid for ~3 months: agy failed every call, pi answered, and
    // the only record that agy had failed was the reason string — discarded on success.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const chain = [
        provider("agy-cli", { ok: false, provider: "agy-cli", error: "dead model", unavailable: true }),
        provider("pi", { ok: true, provider: "pi", model: "m", answer: "hi" })
      ];

      const result = await answerWithChain(chain, { question: "q" }, recordingSink());

      expect(result.ok).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("agy-cli");
      expect(warn.mock.calls[0]![0]).toContain("dead model");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when the first leg serves", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await answerWithChain(
        [provider("pi", { ok: true, provider: "pi", model: "m", answer: "hi" })],
        { question: "q" },
        recordingSink()
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("answerWithChain", () => {
  it("returns the first successful provider", async () => {
    const chain = [
      provider("a", { ok: true, provider: "a", model: "m1", answer: "first" }),
      provider("b", { ok: true, provider: "b", model: "m2", answer: "second" })
    ];

    const result = await answerWithChain(chain, { question: "hi" }, recordingSink());

    expect(result).toEqual({ ok: true, provider: "a", model: "m1", answer: "first" });
  });

  it("skips an unavailable provider to reach a later one", async () => {
    const chain = [
      provider("a", { ok: false, provider: "a", error: "no key", unavailable: true }),
      provider("b", { ok: true, provider: "b", model: "m2", answer: "from b" })
    ];

    const result = await answerWithChain(chain, { question: "hi" }, recordingSink());

    expect(result).toEqual({ ok: true, provider: "b", model: "m2", answer: "from b" });
  });

  it("falls through a plain error to a later provider", async () => {
    const chain = [
      provider("a", { ok: false, provider: "a", error: "HTTP 500" }),
      provider("b", { ok: true, provider: "b", model: "m2", answer: "from b" })
    ];

    const result = await answerWithChain(chain, { question: "hi" }, recordingSink());

    expect(result).toEqual({ ok: true, provider: "b", model: "m2", answer: "from b" });
  });

  it("aggregates per-provider reasons when all fail", async () => {
    const chain = [
      provider("a", { ok: false, provider: "a", error: "no key", unavailable: true }),
      provider("b", { ok: false, provider: "b", error: "HTTP 500" })
    ];

    const result = await answerWithChain(chain, { question: "hi" }, recordingSink());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.provider).toBe("chain");
      expect(result.error).toBe("a: no key (unavailable); b: HTTP 500 (error)");
    }
  });
});

describe("answerWithChain audit", () => {
  it("records exactly one attempt per leg tried, in order, with outcome, latency, group and index", async () => {
    const sink = recordingSink();
    const chain = [
      provider("agy-cli", {
        ok: false,
        provider: "agy-cli",
        error: 'agy status ERROR: invalid model selection (--model "x")',
        unavailable: true
      }),
      provider("kimi-api", { ok: false, provider: "kimi-api", error: "Kimi request returned HTTP 503" }),
      provider("pi", {
        ok: true,
        provider: "pi",
        model: "kimi-for-coding",
        answer: "hi",
        usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 }
      })
    ];

    const result = await answerWithChain(chain, { question: "q" }, sink);

    expect(result.ok).toBe(true);
    expect(sink.attempts.map((a) => [a.provider, a.outcome, a.error_kind, a.leg_index])).toEqual([
      ["agy-cli", "unavailable", "model_missing", 0],
      ["kimi-api", "error", "transport", 1],
      ["pi", "ok", undefined, 2]
    ]);
    expect(sink.attempts[2]).toMatchObject({
      model: "kimi-for-coding",
      usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 }
    });
    const groups = new Set(sink.attempts.map((a) => a.attempt_group));
    expect(groups.size).toBe(1);
    expect([...groups][0]).toMatch(/^[0-9a-f]{12}$/);
    for (const a of sink.attempts) expect(typeof a.latency_ms).toBe("number");
  });

  it("mints a NEW attempt_group per invocation", async () => {
    const sink = recordingSink();
    const p = provider("pi", { ok: true, provider: "pi", model: "m", answer: "hi" });
    await answerWithChain([p], { question: "a" }, sink);
    await answerWithChain([p], { question: "b" }, sink);
    expect(sink.attempts[0]!.attempt_group).not.toBe(sink.attempts[1]!.attempt_group);
  });

  it("does not record legs that were never tried", async () => {
    const sink = recordingSink();
    await answerWithChain(
      [
        provider("pi", { ok: true, provider: "pi", model: "m", answer: "hi" }),
        provider("agy-cli", { ok: true, provider: "agy-cli", model: "g", answer: "never" })
      ],
      { question: "q" },
      sink
    );
    expect(sink.attempts.map((a) => a.provider)).toEqual(["pi"]);
  });

  it("records every leg when all fail and still returns the aggregate error", async () => {
    const sink = recordingSink();
    const result = await answerWithChain(
      [
        provider("pi", { ok: false, provider: "pi", error: "pi timed out after 60000ms" }),
        provider("agy-cli", { ok: false, provider: "agy-cli", error: "agy binary not found (ENOENT)", unavailable: true })
      ],
      { question: "q" },
      sink
    );
    expect(result.ok).toBe(false);
    expect(sink.attempts.map((a) => [a.outcome, a.error_kind])).toEqual([
      ["error", "timeout"],
      ["unavailable", "spawn"]
    ]);
  });

  it("a THROWING provider is recorded as an error and the chain falls through", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sink = recordingSink();
      const boom: LlmProvider = {
        name: "agy-cli",
        answer: async () => {
          throw new Error("socket hang up");
        }
      };
      const result = await answerWithChain(
        [boom, provider("pi", { ok: true, provider: "pi", model: "m", answer: "hi" })],
        { question: "q" },
        sink
      );
      expect(result.ok).toBe(true);
      expect(sink.attempts.map((a) => [a.provider, a.outcome, a.error_kind])).toEqual([
        ["agy-cli", "error", "other"],
        ["pi", "ok", undefined]
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a throwing sink never fails a good answer, and is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sink: LlmAuditSink = {
        record: () => {
          throw new Error("ledger down");
        }
      };
      const result = await answerWithChain(
        [provider("pi", { ok: true, provider: "pi", model: "m", answer: "hi" })],
        { question: "q" },
        sink
      );
      expect(result.ok).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("ledger down"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
