import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

// Spec §3.4: one row per question when answered, one skipped row otherwise; no text columns; replay joins on state_hash.
describe("jev_decisions", () => {
  const base = { run_id: "run_1", point: "triage", question_id: "lane", criteria_hash: "h", model_reported: "jev-1.13.0", state_hash: "s", lang: "zh",
    answers_json: JSON.stringify({ none: 0.1, status: 0.0, memory: 0.9 }), confidence: 0.85, top_prob: 0.9, margin: 0.8, threshold_version: "2026-10-04.1",
    threshold_used: null, decision: null, latency_ms: 300, input_tokens: 1200, status: "answered" as const, skip_reason: null };
  it("inserts, marks and lists rows for a run in insertion order", () => {
    const store = RunStore.openInMemory();
    const a = store.insertJevDecision(base);
    const b = store.insertJevDecision({ ...base, question_id: "complete" });
    store.markJevDecision(a, "act", "memory:0.85/0.5/0.8");
    const rows = store.listJevDecisions("run_1");
    expect(rows.map((r) => r.question_id)).toEqual(["lane", "complete"]);
    expect(rows[0]).toMatchObject({ decision_id: a, decision: "act", threshold_used: "memory:0.85/0.5/0.8", outcome_source: "none" });
    expect(rows[1]).toMatchObject({ decision_id: b, decision: null });
    store.close();
  });
  it("records a skipped call as one row with question_id NULL and keeps the reason as an enum", () => {
    const store = RunStore.openInMemory();
    store.insertJevDecision({ ...base, question_id: null, criteria_hash: null, model_reported: null, state_hash: null, answers_json: null, confidence: null,
      top_prob: null, margin: null, threshold_version: null, latency_ms: null, input_tokens: null, status: "skipped", skip_reason: "no_key" });
    expect(store.listJevDecisions("run_1")).toMatchObject([{ status: "skipped", skip_reason: "no_key", question_id: null }]);
    store.close();
  });
  it("outcome labels attach later without touching the answer", () => {
    const store = RunStore.openInMemory();
    const id = store.insertJevDecision(base);
    store.recordJevOutcome(id, "paco_correction", "override");
    expect(store.listJevDecisions("run_1")[0]).toMatchObject({ outcome_source: "paco_correction", outcome_value: "override", confidence: 0.85 });
    store.close();
  });
});
