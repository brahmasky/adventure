import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

describe("store changes for detached planner turns (spec §7.1, §7.2, §8)", () => {
  it("finishRun completes exactly once and only for the lease owner — a stale supervisor cannot finish a reclaimed run", () => {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    expect(store.claimRun(run_id, "planner:c1:a", 120)).not.toBeNull();
    expect(store.finishRun({ run_id, expected_worker_id: "planner:c1:b", next: "failed", error_type: "killed", error_ref: "x" })).toBe(false);
    expect(store.finishRun({ run_id, expected_worker_id: "planner:c1:a", next: "completed", report_ref: "r", duration_ms: 5, tool_calls: 2 })).toBe(true);
    expect(store.finishRun({ run_id, expected_worker_id: "planner:c1:a", next: "completed", report_ref: "r", duration_ms: 5, tool_calls: 2 })).toBe(false);
    const terminal = store.getLedgerEvents(run_id).filter((e) => e.event_type === "run_completed" || e.event_type === "run_failed");
    expect(terminal).toHaveLength(1);
  });

  it("fails an expired planner run instead of requeueing it — its side effects may already have happened", () => {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    store.claimRun(run_id, "planner:c1:a", 1);
    const later = new Date(Date.now() + 5_000).toISOString();
    expect(store.recoverExpiredLeases(later, 3)).toEqual([{ run_id, action: "failed" }]);
    expect(store.getRunState(run_id)).toBe("failed");
    const failed = store.getLedgerEvents(run_id).find((e) => e.event_type === "run_failed");
    expect(failed?.payload).toMatchObject({ error_type: "lease_expired", recoverable: false });
  });

  it("a tool approval authorises exactly one execution, only while the same owner holds the lease", () => {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    store.claimRun(run_id, "planner:c1:a", 120);
    const requester = { kind: "user" as const, id: "42" };
    const row = store.createToolApproval({ run_id, worker_id: "planner:c1:a", tool_call_id: "tc1", capability: "shell_external",
      input_hash: "h", action_fingerprint: "f", requester, summary: "git push", side_effect_level: "external_write",
      expires_at: new Date(Date.now() + 60_000).toISOString() });
    expect(row.approval_id).toMatch(/^appr_/);
    const consume = () => store.consumeToolApproval({ approval_id: row.approval_id, run_id, worker_id: "planner:c1:a",
      capability: "shell_external", action_fingerprint: "f", requester, now: new Date().toISOString() });
    expect(consume()).toMatchObject({ ok: false, code: "not_approved" });
    store.resolveToolApprovalForTest(row.approval_id, "approved");
    expect(consume()).toEqual({ ok: true });
    expect(consume()).toMatchObject({ ok: false });
  });

  it("dedupes llm_attempt rows by request_key and records a wall_collapse event on family collapse (D10 audit)", () => {
    const store = RunStore.openInMemory();
    const sink = store.llmAuditSink({ correlation_id: "tick:t:1", role: "reader" });
    const a = { provider: "kimi-code", role: "", outcome: "ok" as const, model: "k3", family: "kimi" as const, family_collapse: true, request_key: "tick:t:1:0" };
    sink.record(a); sink.record(a);
    const events = store.getLedgerEventsByCorrelation("tick:t:1");
    expect(events.filter((e) => e.event_type === "llm_attempt")).toHaveLength(1);
    expect(events.filter((e) => e.event_type === "wall_collapse")).toHaveLength(1);
    expect(events.find((e) => e.event_type === "llm_attempt")?.payload).toMatchObject({ family: "kimi", family_collapse: true, request_key: "tick:t:1:0" });
  });
});
