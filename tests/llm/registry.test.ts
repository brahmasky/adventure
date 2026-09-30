import { describe, expect, it, vi } from "vitest";
import { answerWithChain } from "../../src/llm/registry.js";
import type { LlmProvider, LlmResult } from "../../src/llm/types.js";
import type { LlmAuditSink } from "../../src/llm/audit.js";
import { recordingSink } from "../helpers/llm-audit.js";

function provider(name: string, result: LlmResult): LlmProvider {
  return { name, answer: async () => result };
}

// The chain builder (buildLlmChain, resolveChainBudgetMs, the metered ceiling filter) left with the
// pi/kimi/gemini providers (Task 14); every seat is an omp one-shot now (tests/llm/seat-routing.test.ts).
// answerWithChain survives for the one non-omp leg — agy-cli voice (ruling 2) — so its contract stays pinned here.

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

describe("answerWithChain with media (multimodal ingest, spec 2026-09-29)", () => {
  const media = { path: "/tmp/houge-media-x/media.opus", mime: "audio/ogg" };
  const ok = (name: string): LlmProvider => ({ ...provider(name, { ok: true, provider: name, model: "m", answer: `from ${name}` }), supportsMedia: (mime) => mime === "audio/ogg" });

  it("attempts only legs that support the mime — an ineligible leg is never called and writes no audit row", async () => {
    const calls: string[] = [];
    const deaf: LlmProvider = { name: "deaf", answer: async () => { calls.push("deaf"); return { ok: true, provider: "deaf", model: "m", answer: "x" }; } };
    const hears: LlmProvider = { name: "hears", supportsMedia: (mime) => mime === "audio/ogg", answer: async () => { calls.push("hears"); return { ok: true, provider: "hears", model: "m", answer: "transcript" }; } };
    const audit = recordingSink();
    const result = await answerWithChain([deaf, hears], { question: "transcribe", media }, audit);
    expect(result).toMatchObject({ ok: true, provider: "hears", answer: "transcript" });
    expect(calls).toEqual(["hears"]);
    expect(audit.attempts.map((a) => a.provider)).toEqual(["hears"]);
  });

  it("no media-capable leg → a code-owned chain error, no attempts", async () => {
    const audit = recordingSink();
    const result = await answerWithChain([provider("deaf", { ok: true, provider: "deaf", model: "m", answer: "x" })], { question: "q", media }, audit);
    expect(result).toEqual({ ok: false, provider: "chain", error: "no media-capable leg" });
    expect(audit.attempts).toHaveLength(0);
  });

  it("fallthrough reasons for a media request carry the error KIND, never the leg's error text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flaky: LlmProvider = { name: "flaky", supportsMedia: () => true, answer: async () => ({ ok: false, provider: "flaky", error: "agy timed out after 45000ms; prompt was: SECRET CAPTION" }) };
    const result = await answerWithChain([flaky, ok("good")], { question: "q", media }, recordingSink());
    expect(result.ok).toBe(true);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[llm-chain]")) ?? "";
    expect(line).toContain("flaky: timeout");
    expect(line).not.toContain("SECRET CAPTION");
    warn.mockRestore();
  });

  it("without media the chain is unchanged: every leg is eligible, reasons carry the text as before", async () => {
    const result = await answerWithChain([provider("a", { ok: false, provider: "a", error: "boom" }), provider("b", { ok: true, provider: "b", model: "m", answer: "fine" })], { question: "q" }, recordingSink());
    expect(result).toMatchObject({ ok: true, provider: "b" });
  });
});
