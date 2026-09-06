import { describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { computeCostUsd } from "../../src/llm/metered-pricing.js";
import { RunStore } from "../../src/run/run-store.js";

function event(goal: string) {
  return buildTypedTaskEvent({
    source: "cli",
    type: "run",
    program: "research-brief",
    goal,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "local" },
    idempotency_key: "cli:fixed",
    source_reference: "argv",
    created_at: "2026-05-25T00:00:00.000Z"
  });
}

function createRun(store: RunStore): string {
  const created = store.createOrGet(event("audit sink test"));
  if (created.status !== "created") throw new Error(`expected created, got ${created.status}`);
  return created.run_id;
}

const attemptsOf = (store: RunStore) =>
  store.getLedgerEvents().filter((e) => e.event_type === "llm_attempt");

describe("RunStore.llmAuditSink", () => {
  it("run-scoped: writes llm_attempt under the run, with the SCOPED role overriding the chain's", () => {
    const store = RunStore.openInMemory();
    try {
      const run_id = createRun(store);
      const sink = store.llmAuditSink({ run_id, role: "compose" });
      sink.record({
        provider: "pi",
        role: "",
        outcome: "ok",
        model: "kimi-for-coding",
        latency_ms: 5,
        attempt_group: "g1",
        leg_index: 0,
        usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 0 }
      });

      const [row] = attemptsOf(store);
      expect(row!.run_id).toBe(run_id);
      expect(row!.payload).toMatchObject({
        provider: "pi",
        role: "compose",
        outcome: "ok",
        model: "kimi-for-coding",
        input_tokens: 10,
        output_tokens: 3,
        cached_input_tokens: 0,
        latency_ms: 5,
        attempt_group: "g1",
        leg_index: 0
      });
      expect(row!.payload.cost_usd).toBeUndefined(); // flat-rate leg: never a $ figure
    } finally {
      store.close();
    }
  });

  it("run-less: writes under the tick correlation id with NULL run_id", () => {
    const store = RunStore.openInMemory();
    try {
      store
        .llmAuditSink({ correlation_id: "tick:episodic_distill", role: "distill" })
        .record({ provider: "agy-cli", role: "", outcome: "unavailable", latency_ms: 40, error_kind: "model_missing" });
      const [row] = attemptsOf(store);
      // The column is NULL; `readLedgerEvents` omits the key rather than surfacing `null`.
      expect(row!.run_id).toBeUndefined();
      expect(row!.correlation_id).toBe("tick:episodic_distill");
      expect(row!.payload).toMatchObject({
        provider: "agy-cli",
        role: "distill",
        outcome: "unavailable",
        error_kind: "model_missing"
      });
    } finally {
      store.close();
    }
  });

  it("prices a METERED provider at the seam; strips self-reported cost from flat-rate legs", () => {
    const store = RunStore.openInMemory();
    try {
      const sink = store.llmAuditSink({ correlation_id: "tick:idea_radar", role: "extract" });
      sink.record({
        provider: "gemini-api",
        role: "",
        outcome: "ok",
        model: "gemini-3.5-flash",
        usage: { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0 }
      });
      sink.record({
        provider: "codex",
        role: "",
        outcome: "ok",
        model: "gpt",
        usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 0, cost_usd: 99 }
      });
      const [metered, flat] = attemptsOf(store);
      expect(metered!.payload.cost_usd as number).toBeGreaterThan(0);
      expect(flat!.payload.cost_usd).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("a METERED leg's self-reported cost is replaced by the computed figure", () => {
    const store = RunStore.openInMemory();
    try {
      const usage = { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0, cost_usd: 123 };
      store
        .llmAuditSink({ correlation_id: "tick:idea_radar", role: "extract" })
        .record({ provider: "gemini-api", role: "", outcome: "ok", model: "gemini-3.5-flash", usage });
      const expected = computeCostUsd("gemini-api", "gemini-3.5-flash", usage, process.env);
      expect(expected).not.toBeNull();
      const cost = attemptsOf(store)[0]!.payload.cost_usd;
      expect(typeof cost).toBe("number");
      expect(cost as number).toBeGreaterThan(0);
      expect(cost).not.toBe(123);
      expect(cost as number).toBeCloseTo(expected as number, 10);
    } finally {
      store.close();
    }
  });

  it("an UNKNOWN metered model stays unpriced unless the provider self-reported", () => {
    const store = RunStore.openInMemory();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sink = store.llmAuditSink({ correlation_id: "tick:idea_radar", role: "extract" });
      // No family prefix: a `gemini-*` name would prefix-match the gemini price row and be priced.
      const model = `mystery-model-${Date.now()}`;
      sink.record({
        provider: "gemini-api",
        role: "",
        outcome: "ok",
        model,
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cached_input_tokens: 0 }
      });
      sink.record({
        provider: "gemini-api",
        role: "",
        outcome: "ok",
        model,
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cached_input_tokens: 0, cost_usd: 0.25 }
      });
      const [unpriced, selfReported] = attemptsOf(store);
      expect(unpriced!.payload.cost_usd).toBeUndefined();
      expect(selfReported!.payload.cost_usd).toBe(0.25); // the `?? selfReported` fallback
    } finally {
      warn.mockRestore();
      store.close();
    }
  });

  it("sink → meteredSpendUsd end-to-end: the computed figure is what the ceiling sees", () => {
    const store = RunStore.openInMemory();
    try {
      const usage = { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0, cost_usd: 123 };
      store
        .llmAuditSink({ correlation_id: "tick:idea_radar", role: "extract" })
        .record({ provider: "gemini-api", role: "", outcome: "ok", model: "gemini-3.5-flash", usage });
      const expected = computeCostUsd("gemini-api", "gemini-3.5-flash", usage, process.env) as number;
      expect(store.meteredSpendUsd(new Date().toISOString()).daily_usd).toBeCloseTo(expected, 10);
    } finally {
      store.close();
    }
  });

  it("carries thinking_tokens for visibility and never adds them to output", () => {
    const store = RunStore.openInMemory();
    try {
      store.llmAuditSink({ correlation_id: "tick:x", role: "distill" }).record({
        provider: "agy-cli",
        role: "",
        outcome: "ok",
        model: "g",
        usage: { input_tokens: 5590, output_tokens: 1511, cached_input_tokens: 8090, thinking_tokens: 842 }
      });
      expect(attemptsOf(store)[0]!.payload).toMatchObject({ output_tokens: 1511, thinking_tokens: 842 });
    } finally {
      store.close();
    }
  });

  it("an ok attempt without a model is recorded as model 'unknown' and warned about", () => {
    const store = RunStore.openInMemory();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      store
        .llmAuditSink({ correlation_id: "tick:x", role: "distill" })
        .record({ provider: "pi", role: "", outcome: "ok", latency_ms: 1 });
      expect(attemptsOf(store)[0]!.payload.model).toBe("unknown");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      store.close();
    }
  });

  it("no-bodies guarantee: an ok attempt with usage never carries a prompt/response field", () => {
    const store = RunStore.openInMemory();
    try {
      store.llmAuditSink({ correlation_id: "tick:x", role: "distill" }).record({
        provider: "pi",
        role: "",
        outcome: "ok",
        model: "m",
        latency_ms: 5,
        usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 0 }
      });
      const row = attemptsOf(store)[0]!;
      expect(JSON.stringify(row.payload)).not.toMatch(/prompt|diff|response|answer_text|content|question|system/i);
      const allowedKeys = new Set([
        "provider",
        "role",
        "outcome",
        "model",
        "latency_ms",
        "error_kind",
        "attempt_group",
        "leg_index",
        "input_tokens",
        "output_tokens",
        "cached_input_tokens",
        "thinking_tokens",
        "cost_usd"
      ]);
      expect(Object.keys(row.payload).every((k) => allowedKeys.has(k))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("never throws: a failed write logs a warning and returns", () => {
    const store = RunStore.openInMemory();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sink = store.llmAuditSink({ correlation_id: "tick:x", role: "distill" });
      store.close();
      expect(() => sink.record({ provider: "pi", role: "", outcome: "ok", model: "m", latency_ms: 1 })).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
