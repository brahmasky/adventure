import type { LlmUsage } from "../run/llm-usage.js";

/**
 * Metered-API pricing (ADR 0019, Phase S-2).
 *
 * Houge's chain mixes FLAT-RATE legs (pi, agy-cli — subscription CLIs, marginal cost 0)
 * with METERED legs (kimi-api, gemini-api — pay-per-token HTTP). Only the metered legs
 * can run away financially, so only they are priced: {@link computeCostUsd} turns a
 * normalized {@link LlmUsage} into a USD figure that rides the existing optional
 * `cost_usd` field of the `llm_call` ledger event — the $ ceiling then derives spend
 * from the ledger (no second bookkeeping).
 *
 * The price table is keyed by MODEL-ID PREFIX (longest match wins) and is deliberately
 * operator-tunable via `HOUGE_METERED_PRICES_JSON` — list prices drift, and the exact
 * numbers matter less than the mechanism. An UNKNOWN metered model logs once and costs
 * `null`: its spend is invisible to the ceiling until priced (documented residual).
 */

/** Provider names (chain leg names) whose usage is metered (pay-per-token). */
export const METERED_PROVIDERS: ReadonlySet<string> = new Set(["kimi-api", "gemini-api"]);

export interface MeteredModelPrice {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  /** Cached prompt tokens billed cheaper when the provider reports them; falls back to input rate. */
  cached_input_usd_per_mtok?: number;
}

/**
 * Seed prices (USD per million tokens), public list prices as of 2026-07 — sensible,
 * not sacred: override/extend via `HOUGE_METERED_PRICES_JSON`. Keys are model-id
 * PREFIXES (longest match wins), so one entry covers a model family.
 */
export const DEFAULT_METERED_PRICES: Readonly<Record<string, MeteredModelPrice>> = {
  // Moonshot / kimi-api. `moonshot-v1-auto` is the code default (registry falls back to it).
  "moonshot-v1": { input_usd_per_mtok: 2.0, output_usd_per_mtok: 5.0 },
  "kimi-": { input_usd_per_mtok: 0.6, output_usd_per_mtok: 2.5, cached_input_usd_per_mtok: 0.15 },
  // Google / gemini-api. `gemini-3.5-flash` is the code default.
  "gemini-3.5-flash": { input_usd_per_mtok: 0.3, output_usd_per_mtok: 2.5, cached_input_usd_per_mtok: 0.075 },
  "gemini-": { input_usd_per_mtok: 0.3, output_usd_per_mtok: 2.5, cached_input_usd_per_mtok: 0.075 }
};

function asPrice(value: unknown): MeteredModelPrice | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const rate = (raw: unknown): number | null => {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const input = rate(record.input_usd_per_mtok);
  const output = rate(record.output_usd_per_mtok);
  if (input === null || output === null) return null;
  const cached = rate(record.cached_input_usd_per_mtok);
  return {
    input_usd_per_mtok: input,
    output_usd_per_mtok: output,
    ...(cached !== null ? { cached_input_usd_per_mtok: cached } : {})
  };
}

/**
 * Resolve the effective price table: `HOUGE_METERED_PRICES_JSON` (an object of
 * prefix → price) MERGED over the defaults. TOLERANT: garbage JSON or malformed
 * entries are ignored (a broken override must never take pricing down with it).
 */
export function resolvePriceTable(env: NodeJS.ProcessEnv = process.env): Record<string, MeteredModelPrice> {
  const table: Record<string, MeteredModelPrice> = { ...DEFAULT_METERED_PRICES };
  const raw = env.HOUGE_METERED_PRICES_JSON;
  if (!raw) return table;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return table;
    for (const [prefix, value] of Object.entries(parsed)) {
      const price = asPrice(value);
      if (prefix.length > 0 && price) table[prefix] = price;
    }
  } catch {
    // tolerant: unparseable override → defaults
  }
  return table;
}

/** Longest-prefix match over the table keys (an exact model id is just the longest prefix). */
function matchPrice(table: Record<string, MeteredModelPrice>, model: string): MeteredModelPrice | null {
  let best: { prefix: string; price: MeteredModelPrice } | null = null;
  for (const [prefix, price] of Object.entries(table)) {
    if (model.startsWith(prefix) && (best === null || prefix.length > best.prefix.length)) {
      best = { prefix, price };
    }
  }
  return best?.price ?? null;
}

/** Unknown metered models we already warned about (once per process — not per call). */
const warnedUnknownModels = new Set<string>();

/**
 * USD cost of one call, or `null` when the call is not priceable:
 *   - a non-metered provider (flat-rate legs cost 0 marginal — never priced), or
 *   - a metered provider with an UNKNOWN model (logged once; spend invisible until priced).
 *
 * Cached prompt tokens are a SUBSET of `input_tokens` (OpenAI-compat semantics), billed at
 * the cached rate when the table has one; the count is clamped defensively.
 */
export function computeCostUsd(
  provider: string,
  model: string,
  usage: LlmUsage,
  env: NodeJS.ProcessEnv = process.env
): number | null {
  if (!METERED_PROVIDERS.has(provider)) return null;
  const price = matchPrice(resolvePriceTable(env), model);
  if (!price) {
    const key = `${provider}:${model}`;
    if (!warnedUnknownModels.has(key)) {
      warnedUnknownModels.add(key);
      console.warn(
        `[metered-pricing] no price for metered model "${model}" (${provider}) — ` +
          `its spend is INVISIBLE to the $ ceiling until priced via HOUGE_METERED_PRICES_JSON`
      );
    }
    return null;
  }
  const cached = Math.min(Math.max(usage.cached_input_tokens, 0), Math.max(usage.input_tokens, 0));
  const uncached = Math.max(usage.input_tokens, 0) - cached;
  const cachedRate = price.cached_input_usd_per_mtok ?? price.input_usd_per_mtok;
  return (
    (uncached * price.input_usd_per_mtok +
      cached * cachedRate +
      Math.max(usage.output_tokens, 0) * price.output_usd_per_mtok) /
    1_000_000
  );
}
