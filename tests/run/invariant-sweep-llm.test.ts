import { describe, expect, it } from "vitest";
import { detectViolations, LLM_LEG_FAILING_MIN_ATTEMPTS } from "../../src/run/invariant-sweep.js";
import { RunStore } from "../../src/run/run-store.js";

const NOW = "2026-09-07T00:30:00.000Z";
const legs = (store: RunStore) => detectViolations(store, NOW).filter((v) => v.kind === "llm_leg_failing");

describe("llm_leg_failing invariant", () => {
  it("opens for a provider with >= MIN attempts and zero ok in the window (the D1 shape)", () => {
    const store = RunStore.openInMemory();
    try {
      const sink = store.llmAuditSink({ correlation_id: "tick:episodic_distill", role: "distill" });
      for (let i = 0; i < LLM_LEG_FAILING_MIN_ATTEMPTS; i++) sink.record({ provider: "agy-cli", role: "", outcome: "unavailable", latency_ms: 1, error_kind: "model_missing" });
      sink.record({ provider: "pi", role: "", outcome: "ok", model: "m", latency_ms: 1 });
      expect(legs(store)).toEqual([{ kind: "llm_leg_failing", subject: "agy-cli", detail: { attempts: LLM_LEG_FAILING_MIN_ATTEMPTS, ok: 0, last_error_kind: "model_missing" } }]);
    } finally {
      store.close();
    }
  });

  it("stays quiet below the attempt floor, and once any ok lands", () => {
    const store = RunStore.openInMemory();
    try {
      const sink = store.llmAuditSink({ correlation_id: "tick:x", role: "distill" });
      for (let i = 0; i < LLM_LEG_FAILING_MIN_ATTEMPTS - 1; i++) sink.record({ provider: "agy-cli", role: "", outcome: "error", latency_ms: 1, error_kind: "timeout" });
      expect(legs(store)).toEqual([]);
      sink.record({ provider: "agy-cli", role: "", outcome: "error", latency_ms: 1, error_kind: "timeout" });
      expect(legs(store)).toHaveLength(1);
      sink.record({ provider: "agy-cli", role: "", outcome: "ok", model: "g", latency_ms: 1 });
      expect(legs(store)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("ignores attempts outside the window", () => {
    const store = RunStore.openInMemory();
    try {
      // write rows, then age them: occurred_at is set by the store at write time, so back-date via SQL
      const sink = store.llmAuditSink({ correlation_id: "tick:x", role: "distill" });
      for (let i = 0; i < LLM_LEG_FAILING_MIN_ATTEMPTS; i++) sink.record({ provider: "agy-cli", role: "", outcome: "error", latency_ms: 1, error_kind: "timeout" });
      (store as unknown as { db: { exec(sql: string): void } }).db.exec(`UPDATE ledger_events SET occurred_at = '2026-09-01T00:00:00.000Z' WHERE event_type = 'llm_attempt'`);
      expect(legs(store)).toEqual([]);
    } finally {
      store.close();
    }
  });

  /**
   * `last_error_kind` must reflect the MOST RECENT non-ok attempt, not the alphabetically
   * greatest `error_kind` string — "transport" > "timeout" lexically, so a naive
   * `MAX(CASE ... error_kind)` picks "transport" even when "timeout" is what just happened.
   * Back-dates by SEQUENCE rank (like the window test above) so insertion order and
   * chronological order can be pinned independently.
   */
  function backdateBySequenceOrder(store: RunStore, timestamps: string[]): void {
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    timestamps.forEach((ts, i) => {
      db.exec(`
        UPDATE ledger_events SET occurred_at = '${ts}'
        WHERE event_id = (
          SELECT event_id FROM ledger_events WHERE event_type = 'llm_attempt' ORDER BY sequence LIMIT 1 OFFSET ${i}
        )
      `);
    });
  }

  it("last_error_kind is the LATEST failing attempt's kind: an older transport then a newer timeout wins timeout", () => {
    const store = RunStore.openInMemory();
    try {
      const sink = store.llmAuditSink({ correlation_id: "tick:x", role: "distill" });
      sink.record({ provider: "agy-cli", role: "", outcome: "error", latency_ms: 1, error_kind: "transport" });
      sink.record({ provider: "agy-cli", role: "", outcome: "error", latency_ms: 1, error_kind: "transport" });
      sink.record({ provider: "agy-cli", role: "", outcome: "error", latency_ms: 1, error_kind: "timeout" });
      backdateBySequenceOrder(store, [
        "2026-09-06T12:00:00.000Z",
        "2026-09-06T12:05:00.000Z",
        "2026-09-06T12:10:00.000Z"
      ]);
      expect(legs(store)).toEqual([
        { kind: "llm_leg_failing", subject: "agy-cli", detail: { attempts: 3, ok: 0, last_error_kind: "timeout" } }
      ]);
    } finally {
      store.close();
    }
  });

  it("last_error_kind is the LATEST failing attempt's kind: an older timeout then a newer transport wins transport", () => {
    const store = RunStore.openInMemory();
    try {
      const sink = store.llmAuditSink({ correlation_id: "tick:x", role: "distill" });
      sink.record({ provider: "agy-cli", role: "", outcome: "error", latency_ms: 1, error_kind: "timeout" });
      sink.record({ provider: "agy-cli", role: "", outcome: "error", latency_ms: 1, error_kind: "timeout" });
      sink.record({ provider: "agy-cli", role: "", outcome: "error", latency_ms: 1, error_kind: "transport" });
      backdateBySequenceOrder(store, [
        "2026-09-06T12:00:00.000Z",
        "2026-09-06T12:05:00.000Z",
        "2026-09-06T12:10:00.000Z"
      ]);
      expect(legs(store)).toEqual([
        { kind: "llm_leg_failing", subject: "agy-cli", detail: { attempts: 3, ok: 0, last_error_kind: "transport" } }
      ]);
    } finally {
      store.close();
    }
  });
});
