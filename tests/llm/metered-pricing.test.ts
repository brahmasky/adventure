import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmUsage } from "../../src/run/llm-usage.js";
import {
  computeCostUsd,
  DEFAULT_METERED_PRICES,
  METERED_PROVIDERS,
  resolvePriceTable
} from "../../src/llm/metered-pricing.js";

// Hermetic by construction: every call passes an EXPLICIT env object (PINNED_ENV rule) —
// process.env is never read or mutated here.

function usage(input: number, output: number, cached = 0): LlmUsage {
  return { input_tokens: input, output_tokens: output, cached_input_tokens: cached };
}

afterEach(() => vi.restoreAllMocks());

describe("METERED_PROVIDERS", () => {
  it("is exactly the pay-per-token HTTP legs — the flat-rate CLIs are never priced", () => {
    expect([...METERED_PROVIDERS].sort()).toEqual(["gemini-api", "kimi-api"]);
  });
});

describe("computeCostUsd", () => {
  it("prices the current kimi default (moonshot-v1 prefix) from the seed table", () => {
    // 1M in @ $2.00 + 1M out @ $5.00 = $7.00
    expect(computeCostUsd("kimi-api", "moonshot-v1-auto", usage(1_000_000, 1_000_000), {})).toBeCloseTo(7.0, 10);
  });

  it("prices the current gemini default and bills cached prompt tokens at the cached rate", () => {
    // cached tokens are a SUBSET of input: 1M input of which 400k cached →
    // 600k @ $0.30 + 400k @ $0.075 + 100k out @ $2.50 = 0.18 + 0.03 + 0.25 = $0.46
    expect(
      computeCostUsd("gemini-api", "gemini-3.5-flash", usage(1_000_000, 100_000, 400_000), {})
    ).toBeCloseTo(0.46, 10);
  });

  it("clamps a cached count larger than input (defensive against a lying usage block)", () => {
    // all 1M input billed at the cached rate, nothing negative
    expect(
      computeCostUsd("gemini-api", "gemini-3.5-flash", usage(1_000_000, 0, 9_999_999), {})
    ).toBeCloseTo(0.075, 10);
  });

  it("longest prefix wins: gemini-3.5-flash-something matches the specific entry, not 'gemini-'", () => {
    const env = {
      HOUGE_METERED_PRICES_JSON: JSON.stringify({
        "gemini-3.5-flash": { input_usd_per_mtok: 100, output_usd_per_mtok: 0 }
      })
    };
    expect(computeCostUsd("gemini-api", "gemini-3.5-flash-preview", usage(1_000_000, 0), env)).toBeCloseTo(100, 10);
  });

  it("non-metered providers cost null — flat-rate legs never accrue toward the ceiling", () => {
    expect(computeCostUsd("pi", "whatever", usage(1_000_000, 1_000_000), {})).toBeNull();
    expect(computeCostUsd("agy-cli", "gemini-3.5-flash", usage(1_000_000, 0), {})).toBeNull();
    expect(computeCostUsd("codex", "gpt-5", usage(1_000_000, 0), {})).toBeNull();
  });

  it("an UNKNOWN metered model costs null and warns exactly once (spend is invisible until priced)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = `mystery-model-${Date.now()}`; // unique — the warn-once set is process-global
    expect(computeCostUsd("kimi-api", model, usage(1_000_000, 0), {})).toBeNull();
    expect(computeCostUsd("kimi-api", model, usage(1_000_000, 0), {})).toBeNull();
    const hits = warn.mock.calls.filter((call) => String(call[0]).includes(model));
    expect(hits).toHaveLength(1);
    expect(String(hits[0]?.[0])).toContain("INVISIBLE");
  });
});

describe("resolvePriceTable (HOUGE_METERED_PRICES_JSON)", () => {
  it("merges the override OVER the defaults, keeping unlisted entries", () => {
    const env = {
      HOUGE_METERED_PRICES_JSON: JSON.stringify({
        "moonshot-v1": { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
        "brand-new-model": { input_usd_per_mtok: 3, output_usd_per_mtok: 4, cached_input_usd_per_mtok: 0.5 }
      })
    };
    const table = resolvePriceTable(env);
    expect(table["moonshot-v1"]).toEqual({ input_usd_per_mtok: 1, output_usd_per_mtok: 2 });
    expect(table["brand-new-model"]?.cached_input_usd_per_mtok).toBe(0.5);
    expect(table["gemini-3.5-flash"]).toEqual(DEFAULT_METERED_PRICES["gemini-3.5-flash"]); // untouched
  });

  it("is TOLERANT: garbage JSON and malformed entries fall back to defaults (a broken override must not kill pricing)", () => {
    expect(resolvePriceTable({ HOUGE_METERED_PRICES_JSON: "{not json" })).toEqual({ ...DEFAULT_METERED_PRICES });
    expect(resolvePriceTable({ HOUGE_METERED_PRICES_JSON: "[1,2,3]" })).toEqual({ ...DEFAULT_METERED_PRICES });
    // negative/NaN rates are rejected entry-by-entry, valid siblings still apply
    const table = resolvePriceTable({
      HOUGE_METERED_PRICES_JSON: JSON.stringify({
        bad: { input_usd_per_mtok: -1, output_usd_per_mtok: 2 },
        good: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 }
      })
    });
    expect(table.bad).toBeUndefined();
    expect(table.good).toEqual({ input_usd_per_mtok: 1, output_usd_per_mtok: 2 });
  });
});
