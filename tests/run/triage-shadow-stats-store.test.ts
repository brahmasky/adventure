import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const step = (n: number, capability: string) => ({ step: n, action: "tool", capability, ok: true, result_digest: "d" });
type Triage = { lane: string; complete: string; decision: "shadow" | "fallback" | "act" };

/** One turn with its live `triage` row written at `at`, the planner's loop steps and the run's terminal state. */
function turn(store: RunStore, at: string, t: Triage, caps: string[], end: "completed" | "failed" = "completed"): string {
  vi.setSystemTime(new Date(at));
  const run = createQueuedTurnRun(store, "x");
  caps.forEach((c, i) => store.appendRunLedgerEvent(run, "loop_step", "core", step(i + 1, c)));
  store.appendRunLedgerEvent(run, "triage", "core", { status: "answered", lane: t.lane, complete: t.complete, scope: "ask", confidence: 0.9,
    top_prob: 0.93, margin: 0.88, lang: "zh", decision: t.decision });
  store.transition(run, "queued", "running", "test");
  if (end === "failed") store.transition(run, "running", "failed", "test");
  else { store.transition(run, "running", "reporting", "test"); store.transition(run, "reporting", "completed", "test"); }
  return run;
}
function laneDecision(store: RunStore, run_id: string, state_hash: string, decision: "shadow" | "fallback", question_id = "lane"): void {
  store.insertJevDecision({ run_id, point: "triage", question_id, criteria_hash: "c", model_reported: "jev-1.13.0", state_hash, lang: "zh", answers_json: "{}",
    confidence: 0.9, top_prob: 0.9, margin: 0.8, threshold_version: "v", threshold_used: null, decision, latency_ms: 1, input_tokens: 1,
    status: "answered", skip_reason: null, created_at: "2026-10-02T00:00:00.000Z" });
}

afterEach(() => vi.useRealTimers());

// Spec §5.9 step 4: the live shadow is the false-positive watch the arm decision reads; a wrong count here arms a lane
// whose `pure` verdict would have skipped the planner on a turn that needed tools.
describe("RunStore.triageShadowStats", () => {
  it("counts distinct shadow days (not the first-to-last span), matched lesson_write turns and pure verdicts on tool / no-tool turns over shadow rows only", () => {
    const store = RunStore.openInMemory();
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      turn(store, "2026-09-20T00:00:00.000Z", { lane: "memory", complete: "pure", decision: "shadow" }, ["web_search"]); // before sinceIso
      const r1 = turn(store, "2026-10-01T00:00:00.000Z", { lane: "memory", complete: "pure", decision: "shadow" }, ["lesson_write"]);
      turn(store, "2026-10-02T00:00:00.000Z", { lane: "memory", complete: "pure", decision: "shadow" }, ["web_search", "lesson_write"]);
      turn(store, "2026-10-03T00:00:00.000Z", { lane: "memory", complete: "pure", decision: "shadow" }, []);
      turn(store, "2026-10-04T00:00:00.000Z", { lane: "memory", complete: "mixed", decision: "shadow" }, ["lesson_write", "http_fetch"]);
      turn(store, "2026-10-05T00:00:00.000Z", { lane: "memory", complete: "pure", decision: "fallback" }, ["web_search"]); // not a shadow row
      turn(store, "2026-10-17T00:00:00.000Z", { lane: "none", complete: "mixed", decision: "shadow" }, []);
      turn(store, "2026-10-17T23:59:59.000Z", { lane: "none", complete: "mixed", decision: "shadow" }, []); // same UTC day: still 5 days
      vi.useRealTimers();
      laneDecision(store, r1, "s1", "shadow");
      laneDecision(store, r1, "s1", "shadow", "complete"); // one hash per turn: the lane row only
      laneDecision(store, r1, "s9", "fallback");
      expect(store.triageShadowStats("2026-09-25T00:00:00.000Z")).toEqual({
        days: 5, matched_lesson_write: 3, pure_on_tool_turns: 1, pure_on_no_tool_turns: 1, live_state_rows: [{ run_id: r1, state_hash: "s1" }]
      });
    } finally {
      store.close();
    }
  });

  // Spec §5.9 step 4: "matched" = a triage row AND a completed planner run. A failed run that tried lesson_write never
  // saved a lesson, so counting it would let failed turns satisfy the report's minimum and issue calibration rows.
  it("counts matched lesson_write only on turns whose planner run completed", () => {
    const store = RunStore.openInMemory();
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      turn(store, "2026-10-01T00:00:00.000Z", { lane: "memory", complete: "pure", decision: "shadow" }, ["lesson_write"], "failed");
      turn(store, "2026-10-02T00:00:00.000Z", { lane: "memory", complete: "pure", decision: "shadow" }, ["lesson_write"]);
      vi.useRealTimers();
      expect(store.triageShadowStats("2026-09-25T00:00:00.000Z").matched_lesson_write).toBe(1);
    } finally {
      store.close();
    }
  });

  it("an empty shadow is zero days, never a pass", () => {
    const store = RunStore.openInMemory();
    try {
      expect(store.triageShadowStats("2026-09-25T00:00:00.000Z")).toEqual({ days: 0, matched_lesson_write: 0, pure_on_tool_turns: 0, pure_on_no_tool_turns: 0, live_state_rows: [] });
    } finally {
      store.close();
    }
  });
});
