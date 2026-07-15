import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeMeteredBreaches,
  DEFAULT_METERED_DAILY_USD,
  DEFAULT_METERED_MONTHLY_USD,
  formatMeteredFuseAlert,
  formatMeteredStatusLine,
  resolveMeteredCeilings
} from "../../src/budget/global-budget-ledger.js";
import { checkMeteredCeiling } from "../../src/budget/metered-ceiling.js";
import { CoreWorker } from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { buildLlmChain, METERED_FALLBACK_PROVIDERS } from "../../src/llm/registry.js";
import { RunStore } from "../../src/run/run-store.js";

const dir = mkdtempSync(join(tmpdir(), "houge-metered-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// PINNED_ENV hermeticity: the resolvers below take explicit env objects, but the gateway
// /status path reads process.env for the ceilings — pin + restore the new vars.
const PINNED_ENV = ["HOUGE_METERED_DAILY_USD", "HOUGE_METERED_MONTHLY_USD", "HOUGE_METERED_PRICES_JSON"] as const;
const pinned = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of PINNED_ENV) {
    pinned.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  vi.useRealTimers();
  for (const key of PINNED_ENV) {
    const value = pinned.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Record one priced llm_call at a CONTROLLED wall-clock instant (occurred_at is stamped internally). */
function recordSpendAt(store: RunStore, at: string, cost_usd: number, run = "run_spend"): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  try {
    store.recordLlmCall(run, {
      provider: "kimi-api",
      model: "moonshot-v1-auto",
      role: "answer",
      usage: { input_tokens: 1000, output_tokens: 1000, cached_input_tokens: 0, cost_usd }
    });
  } finally {
    vi.useRealTimers();
  }
}

describe("resolveMeteredCeilings", () => {
  it("defaults $5/24h and $50/month; env overrides; garbage degrades to the default; 0 is a valid hard-off", () => {
    expect(DEFAULT_METERED_DAILY_USD).toBe(5);
    expect(DEFAULT_METERED_MONTHLY_USD).toBe(50);
    expect(resolveMeteredCeilings({})).toEqual({ daily_usd: 5, monthly_usd: 50 });
    expect(resolveMeteredCeilings({ HOUGE_METERED_DAILY_USD: "2.5", HOUGE_METERED_MONTHLY_USD: "20" }))
      .toEqual({ daily_usd: 2.5, monthly_usd: 20 });
    expect(resolveMeteredCeilings({ HOUGE_METERED_DAILY_USD: "junk", HOUGE_METERED_MONTHLY_USD: "-3" }))
      .toEqual({ daily_usd: 5, monthly_usd: 50 });
    expect(resolveMeteredCeilings({ HOUGE_METERED_DAILY_USD: "0" }).daily_usd).toBe(0);
  });
});

describe("computeMeteredBreaches", () => {
  it("breaches when spend has REACHED the ceiling (>= — same rule as the count caps)", () => {
    expect(computeMeteredBreaches({ daily_usd: 4.99, monthly_usd: 49 }, { daily_usd: 5, monthly_usd: 50 })).toEqual([]);
    expect(computeMeteredBreaches({ daily_usd: 5, monthly_usd: 0 }, { daily_usd: 5, monthly_usd: 50 }))
      .toEqual([{ window: "daily", spend_usd: 5, ceiling_usd: 5 }]);
    expect(
      computeMeteredBreaches({ daily_usd: 9, monthly_usd: 60 }, { daily_usd: 5, monthly_usd: 50 }).map((b) => b.window)
    ).toEqual(["daily", "monthly"]);
  });
});

describe("meteredSpendUsd (derived from the llm_call ledger)", () => {
  it("sums cost_usd over the rolling 24h and the calendar month; unpriced events contribute nothing", () => {
    const store = RunStore.openInMemory();
    try {
      recordSpendAt(store, "2026-07-15T10:00:00.000Z", 1.25);
      recordSpendAt(store, "2026-07-15T11:00:00.000Z", 0.75);
      // an event WITHOUT cost_usd (flat-rate leg / unknown metered model) is invisible:
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-15T11:30:00.000Z"));
      store.recordLlmCall("run_spend", {
        provider: "pi",
        model: "whatever",
        role: "answer",
        usage: { input_tokens: 9_999_999, output_tokens: 9_999_999, cached_input_tokens: 0 }
      });
      vi.useRealTimers();

      expect(store.meteredSpendUsd("2026-07-15T12:00:00.000Z")).toEqual({ daily_usd: 2.0, monthly_usd: 2.0 });
      // 25h later the rolling window has dropped both, the month still holds them:
      expect(store.meteredSpendUsd("2026-07-16T13:00:00.000Z")).toEqual({ daily_usd: 0, monthly_usd: 2.0 });
    } finally {
      store.close();
    }
  });

  it("verifier-added (B11): a NaN/Infinity cost_usd never poisons the SUM — JSON serializes it to null, the query excludes it", () => {
    // Defense-in-depth: the provider normalizer (openai-compat toNum) already prevents NaN/Inf
    // token counts from reaching computeCostUsd, but even if a non-finite cost_usd leaked into
    // recordLlmCall it serializes to JSON `null` and the `IS NOT NULL` filter drops it — spend
    // stays finite and the two good calls ($1.50 + $0.50) are the only contributors.
    const store = RunStore.openInMemory();
    try {
      const at = "2026-07-15T10:00:00.000Z";
      recordSpendAt(store, at, 1.5);
      recordSpendAt(store, at, Number.NaN);
      recordSpendAt(store, at, Number.POSITIVE_INFINITY);
      recordSpendAt(store, at, 0.5);
      const spend = store.meteredSpendUsd("2026-07-15T12:00:00.000Z");
      expect(Number.isFinite(spend.daily_usd)).toBe(true);
      expect(Number.isFinite(spend.monthly_usd)).toBe(true);
      expect(spend).toEqual({ daily_usd: 2.0, monthly_usd: 2.0 });
    } finally {
      store.close();
    }
  });

  it("monthly boundary: spend at July 31 23:59Z counts DAILY but not MONTHLY at Aug 1 00:01Z", () => {
    // WHY this case: the two windows deliberately disagree at a month flip — the rolling
    // 24h window still sees two-minute-old spend, while the calendar-month (UTC) window
    // resets to $0 because that's how the provider's invoice resets.
    const store = RunStore.openInMemory();
    try {
      recordSpendAt(store, "2026-07-31T23:59:00.000Z", 3.0);
      expect(store.meteredSpendUsd("2026-07-31T23:59:30.000Z")).toEqual({ daily_usd: 3.0, monthly_usd: 3.0 });
      expect(store.meteredSpendUsd("2026-08-01T00:01:00.000Z")).toEqual({ daily_usd: 3.0, monthly_usd: 0 });
    } finally {
      store.close();
    }
  });
});

describe("checkMeteredCeiling: latch-driven, one deduped alert per episode", () => {
  it("alerts EXACTLY TWICE across a 0→1→0→1 breach cycle (dedupe within an episode, re-alert on a new one)", () => {
    const store = RunStore.openInMemory();
    try {
      recordSpendAt(store, "2026-07-15T10:00:00.000Z", 6.0); // over the $5 daily default
      const now = "2026-07-15T10:05:00.000Z";
      const under = { HOUGE_METERED_DAILY_USD: "100", HOUGE_METERED_MONTHLY_USD: "100" };

      // episode 1: breach → ONE alert, repeats stay silent
      const first = checkMeteredCeiling({ store, chatId: "222", env: {}, now });
      expect(first).toEqual({ breached: true, alerted: true });
      const second = checkMeteredCeiling({ store, chatId: "222", env: {}, now });
      expect(second).toEqual({ breached: true, alerted: false });

      // spend falls back under (here: the operator raised the ceiling; a rolled window
      // reads identically) → the latch disarms
      expect(checkMeteredCeiling({ store, chatId: "222", env: under, now })).toEqual({ breached: false, alerted: false });
      expect(store.meteredFuseLatched()).toBe(false);

      // episode 2: a NEW breach alerts again — and never a third time within the episode
      const third = checkMeteredCeiling({ store, chatId: "222", env: {}, now: "2026-07-15T10:10:00.000Z" });
      expect(third).toEqual({ breached: true, alerted: true });
      expect(checkMeteredCeiling({ store, chatId: "222", env: {}, now: "2026-07-15T10:11:00.000Z" }).alerted).toBe(false);

      // exactly two notifications exist, keyed by each episode's `since`
      expect(store.countNotificationsByIdempotencyKey("metered-fuse:2026-07-15T10:05:00.000Z")).toBe(1);
      expect(store.countNotificationsByIdempotencyKey("metered-fuse:2026-07-15T10:10:00.000Z")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("the alert text names the window, spend, ceiling, and that flat-rate legs survive", () => {
    const text = formatMeteredFuseAlert([{ window: "daily", spend_usd: 6.1234, ceiling_usd: 5 }]);
    expect(text).toContain("daily: $6.12/$5.00");
    expect(text).toContain("rolling 24h");
    expect(text).toContain("kimi-api/gemini-api legs are dropped");
    expect(text).toContain("pi/agy-cli");
  });

  it("drives the latch even with no chat to alert (enforcement never depends on the alert)", () => {
    const store = RunStore.openInMemory();
    try {
      recordSpendAt(store, "2026-07-15T10:00:00.000Z", 6.0);
      const result = checkMeteredCeiling({ store, env: {}, now: "2026-07-15T10:05:00.000Z" });
      expect(result).toEqual({ breached: true, alerted: false });
      expect(store.meteredFuseLatched()).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("buildLlmChain metered filter (enforcement)", () => {
  it("drops the metered legs when breached; flat-rate legs keep working", () => {
    const env = { HOUGE_LLM_PROVIDERS: "pi,agy-cli,kimi-api,gemini-api" };
    const chain = buildLlmChain(env, { meteredBreached: () => true });
    expect(chain.map((p) => p.name)).toEqual(["pi", "agy-cli"]);
  });

  it("NEVER yields an empty chain: an all-metered list falls back to the flat-rate default", () => {
    // WHY: a zero-leg chain silences Houge entirely — a worse failure than one more
    // flat-rate call. The fallback is the flat-rate default, charter: flat-rate first.
    const env = { HOUGE_LLM_PROVIDERS: "kimi-api,gemini-api" };
    const chain = buildLlmChain(env, { meteredBreached: () => true });
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.map((p) => p.name)).toEqual([...METERED_FALLBACK_PROVIDERS]);
  });

  it("no dep / not breached → the chain is untouched", () => {
    const env = { HOUGE_LLM_PROVIDERS: "pi,kimi-api" };
    expect(buildLlmChain(env).map((p) => p.name)).toEqual(["pi", "kimi-api"]);
    expect(buildLlmChain(env, { meteredBreached: () => false }).map((p) => p.name)).toEqual(["pi", "kimi-api"]);
  });
});

describe("cost lands at the CoreWorker recording seam", () => {
  it("recordLlmCallSafe prices a metered call so the ledger-derived spend sees it; unknown models stay invisible", () => {
    const store = RunStore.openInMemory();
    try {
      const worker = new CoreWorker(store, dir);
      const seam = worker as unknown as {
        recordLlmCallSafe(run_id: string, info: Record<string, unknown>): void;
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      // a metered call: priced from the seed table (1M in @ $2 + 1M out @ $5 = $7)
      seam.recordLlmCallSafe("run_seam", {
        provider: "kimi-api",
        model: "moonshot-v1-auto",
        role: "answer",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cached_input_tokens: 0 }
      });
      // an UNKNOWN metered model: recorded, but unpriced → spend unaffected
      seam.recordLlmCallSafe("run_seam", {
        provider: "kimi-api",
        model: `mystery-${Date.now()}`,
        role: "answer",
        usage: { input_tokens: 9_999_999, output_tokens: 9_999_999, cached_input_tokens: 0 }
      });
      // a flat-rate call: never priced
      seam.recordLlmCallSafe("run_seam", {
        provider: "pi",
        model: "whatever",
        role: "classify",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cached_input_tokens: 0 }
      });
      warn.mockRestore();

      const spend = store.meteredSpendUsd(new Date().toISOString());
      expect(spend.daily_usd).toBeCloseTo(7.0, 10);
      expect(store.getLedgerEvents("run_seam")).toHaveLength(3); // all recorded, one priced
    } finally {
      store.close();
    }
  });
});

describe("/status renders the metered line", () => {
  it("formatMeteredStatusLine shows spend vs both ceilings", () => {
    expect(formatMeteredStatusLine({ daily_usd: 1.234, monthly_usd: 12.5 }, { daily_usd: 5, monthly_usd: 50 }))
      .toBe("Metered: $1.23/$5.00 24h, $12.50/$50.00 month");
  });

  it("the /status overview carries the line (real gateway, real store)", () => {
    const store = RunStore.openInMemory();
    try {
      recordSpendAt(store, "2026-07-15T10:00:00.000Z", 1.5);
      const gateway = new Gateway(store);
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "status",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:status-metered",
        source_reference: "telegram:update:1:message:1"
      });
      const result = gateway.intake(event, "2026-07-15T10:30:00.000Z");
      expect(result.ok).toBe(true);
      const db = (store as unknown as {
        db: { prepare(sql: string): { get<T>(...v: unknown[]): T | undefined } };
      }).db;
      const row = db
        .prepare("SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?")
        .get<{ payload_json: string }>("telegram:status-metered:status");
      const text = row ? (JSON.parse(row.payload_json) as { text: string }).text : "";
      expect(text).toContain("Metered: $1.50/$5.00 24h, $1.50/$50.00 month");
    } finally {
      store.close();
    }
  });
});
