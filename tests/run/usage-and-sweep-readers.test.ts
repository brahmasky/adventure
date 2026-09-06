import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createLedgerEvent } from "../../src/run/run-ledger.js";

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

/**
 * Append one HISTORICAL `llm_call` row at a CONTROLLED wall-clock instant (occurred_at is stamped
 * by `createLedgerEvent`). The `recordLlmCall` writer is gone (slice 2: `llm_attempt` via
 * `llmAuditSink` supersedes it), but pre-2026-09-06 history stays readable through the readers'
 * UNION — these tests pin the reader semantics (grouping, ordering, windowing) on that shape with
 * arbitrary providers/costs, which the pricing seam in `llmAuditSink` would rewrite.
 */
let historicalSequence = 0;
function recordCallAt(
  at: string,
  info: { provider: string; model: string; input: number; output: number; cost?: number },
  run = "run_usage"
): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  try {
    store.appendLedgerEvent(
      createLedgerEvent({
        run_id: run,
        correlation_id: run,
        event_type: "llm_call",
        actor: "capability_runner",
        sequence: ++historicalSequence,
        payload: {
          provider: info.provider,
          model: info.model,
          role: "answer",
          input_tokens: info.input,
          output_tokens: info.output,
          cached_input_tokens: 0,
          ...(info.cost !== undefined ? { cost_usd: info.cost } : {})
        }
      })
    );
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

  it("usageByModel and meteredSpendUsd read llm_attempt(ok) UNIONED with historical llm_call", () => {
    const store = RunStore.openInMemory();
    try {
      // one historical row, written the pre-slice-2 way
      store.appendLedgerEvent(createLedgerEvent({
        correlation_id: "run:old", event_type: "llm_call", actor: "capability_runner", sequence: 1,
        payload: { provider: "gemini-api", model: "gemini-3.5-flash", role: "reader", input_tokens: 100, output_tokens: 10, cached_input_tokens: 0, cost_usd: 0.5 }
      }));
      const sink = store.llmAuditSink({ correlation_id: "tick:idea_radar", role: "extract" });
      sink.record({ provider: "gemini-api", role: "", outcome: "ok", model: "gemini-3.5-flash", usage: { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0 } });
      sink.record({ provider: "gemini-api", role: "", outcome: "error", model: "gemini-3.5-flash", error_kind: "transport" });
      sink.record({ provider: "agy-cli", role: "", outcome: "ok", model: "g", usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 0 } });

      const gemini = store.usageByModel().find((r) => r.provider === "gemini-api")!;
      expect(gemini.calls).toBe(2);                 // the failed attempt is NOT a call
      expect(gemini.input_tokens).toBe(1_000_100);
      expect(gemini.cost_usd).toBeGreaterThan(0.5); // historical 0.5 + the priced attempt
      expect(store.usageByModel().find((r) => r.provider === "agy-cli")!.cost_usd).toBe(0);

      expect(store.meteredSpendUsd(new Date().toISOString()).daily_usd).toBeCloseTo(gemini.cost_usd, 6);
    } finally {
      store.close();
    }
  });

  it("the ledger has indexes for the readers' predicate and for nextLedgerSequence", () => {
    const store = RunStore.openInMemory();
    try {
      const names = (store as unknown as { db: { prepare(sql: string): { all<T>(): T[] } } }).db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ledger_events'`)
        .all<{ name: string }>()
        .map((r) => r.name);
      expect(names).toContain("ledger_events_type_time_idx");
      expect(names).toContain("ledger_events_sequence_idx");
    } finally {
      store.close();
    }
  });
});
