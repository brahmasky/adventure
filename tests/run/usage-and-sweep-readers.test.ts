import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

/**
 * Read-only reporting seams added for the /status redesign + `houge usage` CLI:
 *   - getInvariantSweepState() surfaces the self-check's last sweep instant for /status.
 *   - usageByModel() powers the per-model token/cost breakdown.
 * Both are pure reads: they must never mutate (getInvariantSweepState must NOT claim the
 * sweep the way claimInvariantSweep does).
 */

let store: RunStore;
beforeEach(() => {
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
});

/** Record one llm_call at a CONTROLLED wall-clock instant (occurred_at is stamped internally). */
function recordCallAt(
  at: string,
  info: { provider: string; model: string; input: number; output: number; cost?: number },
  run = "run_usage"
): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  try {
    store.recordLlmCall(run, {
      provider: info.provider,
      model: info.model,
      role: "answer",
      usage: {
        input_tokens: info.input,
        output_tokens: info.output,
        cached_input_tokens: 0,
        ...(info.cost !== undefined ? { cost_usd: info.cost } : {})
      }
    });
  } finally {
    vi.useRealTimers();
  }
}

describe("getInvariantSweepState", () => {
  it("returns null before any sweep has run, then the last_swept_at row after one", () => {
    // Why: /status must render "never" when the self-check has never swept, not crash on a
    // missing row.
    expect(store.getInvariantSweepState()).toBeNull();

    store.claimInvariantSweep("2026-07-20T00:00:00.000Z", 60_000);
    expect(store.getInvariantSweepState()).toEqual({ last_swept_at: "2026-07-20T00:00:00.000Z" });
  });

  it("does not itself claim the sweep (pure read)", () => {
    // Why: a reader that mutated last_swept_at would reset the throttle latch every /status,
    // silently disabling the sweep's cadence. Reading must be side-effect free.
    store.claimInvariantSweep("2026-07-20T00:00:00.000Z", 3_600_000);
    store.getInvariantSweepState();
    store.getInvariantSweepState();
    // A subsequent claim well inside the interval is still refused — the reads changed nothing.
    expect(store.claimInvariantSweep("2026-07-20T00:10:00.000Z", 3_600_000)).toBe(false);
    expect(store.getInvariantSweepState()).toEqual({ last_swept_at: "2026-07-20T00:00:00.000Z" });
  });
});

describe("usageByModel", () => {
  it("groups by provider+model, summing calls, tokens, and cost", () => {
    recordCallAt("2026-07-15T10:00:00.000Z", { provider: "kimi-api", model: "moonshot-v1-auto", input: 100, output: 50, cost: 0.5 });
    recordCallAt("2026-07-15T11:00:00.000Z", { provider: "kimi-api", model: "moonshot-v1-auto", input: 200, output: 60, cost: 1.5 });
    recordCallAt("2026-07-15T12:00:00.000Z", { provider: "pi", model: "pi-cheap", input: 10, output: 5 });

    const rows = store.usageByModel();
    expect(rows).toEqual([
      { provider: "kimi-api", model: "moonshot-v1-auto", calls: 2, input_tokens: 300, output_tokens: 110, cost_usd: 2.0 },
      { provider: "pi", model: "pi-cheap", calls: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0 }
    ]);
  });

  it("orders by cost_usd DESC then calls DESC", () => {
    recordCallAt("2026-07-15T10:00:00.000Z", { provider: "a", model: "cheap-many", input: 1, output: 1, cost: 0.1 });
    recordCallAt("2026-07-15T10:01:00.000Z", { provider: "a", model: "cheap-many", input: 1, output: 1, cost: 0.1 });
    recordCallAt("2026-07-15T10:02:00.000Z", { provider: "b", model: "pricey-one", input: 1, output: 1, cost: 9.0 });

    expect(store.usageByModel().map((r) => r.model)).toEqual(["pricey-one", "cheap-many"]);
  });

  it("respects the sinceIso window (only calls strictly after the cutoff)", () => {
    // Why: `houge usage --24h/--7d/--month` must scope to a window without a second table.
    recordCallAt("2026-07-15T10:00:00.000Z", { provider: "kimi-api", model: "m", input: 100, output: 100, cost: 1 });
    recordCallAt("2026-07-20T10:00:00.000Z", { provider: "kimi-api", model: "m", input: 200, output: 200, cost: 2 });

    const rows = store.usageByModel("2026-07-18T00:00:00.000Z");
    expect(rows).toEqual([
      { provider: "kimi-api", model: "m", calls: 1, input_tokens: 200, output_tokens: 200, cost_usd: 2 }
    ]);
  });
});
