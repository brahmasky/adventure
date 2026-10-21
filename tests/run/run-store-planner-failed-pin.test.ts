import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun, createTelegramTurn } from "../helpers/runs.js"; // drop whichever a file does not use

// Spec 2b-ii §2 (codex F4, round 4): every writer of a run_failed ledger event calls noteFailedPlannerRun in the same batch,
// so every failure path (ompFail, lease recovery, stranded turns, refuseOmpTurn, any later one) feeds the inbox without a
// seam list in the worker. The grep pins it; the behaviour test covers finishRun and failExpiredPlannerRow.
describe("planner_failed producer", () => {
  it("every \"run_failed\" write in run-store.ts is followed by noteFailedPlannerRun within 12 lines", () => {
    const lines = readFileSync("src/run/run-store.ts", "utf8").split("\n");
    const writes = lines.map((l, i) => (l.includes("\"run_failed\"") && !l.trim().startsWith("//") && !l.trim().startsWith("*") ? i : -1)).filter((i) => i >= 0);
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const i of writes) expect(lines.slice(i, i + 12).some((l) => l.includes("noteFailedPlannerRun("))).toBe(true);
  });
  it("finishRun failed on a telegram planner run writes planner_failed with the error type (unknown → other); a non-planner owner writes nothing", () => {
    const s = RunStore.openInMemory();
    const a = createQueuedTurnRun(s, "a");
    expect(s.claimRun(a, "planner:555", 60)).not.toBeNull();      // claimRun(run_id, worker_id, lease_ttl_seconds) — run-store.ts:2225
    s.finishRun({ run_id: a, expected_worker_id: "planner:555", next: "failed", error_type: "model_error", error_ref: "x" });
    const b = createQueuedTurnRun(s, "b");
    s.claimRun(b, "planner:555", 60);
    s.finishRun({ run_id: b, expected_worker_id: "planner:555", next: "failed", error_type: "something_new" as never, error_ref: "x" });
    const c = createQueuedTurnRun(s, "c");
    s.claimRun(c, "telegram-daemon-worker", 60);
    s.finishRun({ run_id: c, expected_worker_id: "telegram-daemon-worker", next: "failed", error_type: "model_error", error_ref: "x" });
    expect(s.listUnconsumedSignals(10).map((r) => [r.signal, r.value, r.about_run_id, r.chat_id])).toEqual([["planner_failed", "model_error", a, "555"], ["planner_failed", "other", b, "555"]]);
  });
  it("lease recovery of an expired planner lease writes planner_failed lease_expired, atomically with the state flip and the event", () => {
    const s = RunStore.openInMemory();
    const a = createQueuedTurnRun(s, "a");
    s.claimRun(a, "planner:555", 1);
    expect(s.recoverExpiredPlannerLeases("2026-12-31T00:00:00.000Z")).toHaveLength(1);
    expect(s.listUnconsumedSignals(10).map((r) => [r.signal, r.value])).toEqual([["planner_failed", "lease_expired"]]);
    expect(s.getLedgerEvents(a).some((e) => e.event_type === "run_failed")).toBe(true);
  });
});
