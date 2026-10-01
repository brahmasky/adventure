import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
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

  it("a planner failure is the run's /status last error, never the stale 'ready for worker' (B10)", () => {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    store.claimRun(run_id, "planner:c1:a", 120);
    store.finishRun({ run_id, expected_worker_id: "planner:c1:a", next: "failed", error_type: "no_planner_leg", error_ref: "quota" });
    expect(store.lastRunError(new Date().toISOString())).toBe("no_planner_leg");
  });

  it("an expired planner lease names lease_expired as the run's state_reason (B10)", () => {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    store.claimRun(run_id, "planner:c1:a", 1);
    store.recoverExpiredLeases(new Date(Date.now() + 5_000).toISOString(), 3);
    expect(store.lastRunError(new Date(Date.now() + 5_000).toISOString())).toBe("lease_expired");
  });

  it("planner lease recovery fails only planner-owned expired runs; an inline run's short lease is never touched (B1)", () => {
    const store = RunStore.openInMemory();
    const planner = createQueuedTurnRun(store); const inline = createQueuedTurnRun(store);
    store.claimRun(planner, "planner:c1:a", 1);
    store.claimRun(inline, "telegram-daemon-worker", 1); // executeRun claims 30 s and never heartbeats: it may outlive its lease
    const later = new Date(Date.now() + 5_000).toISOString();
    expect(store.recoverExpiredPlannerLeases(later)).toEqual([{ run_id: planner, worker_id: "planner:c1:a" }]);
    expect([store.getRunState(planner), store.getRunState(inline)]).toEqual(["failed", "running"]);
  });

  it("lists the turns still queued from before a boot, never a newer one or a non-turn run (B1)", () => {
    const store = RunStore.openInMemory();
    const old = createQueuedTurnRun(store);
    const boot = new Date(Date.now() + 1_000).toISOString();
    expect(store.listQueuedTurnRunsBefore(boot)).toEqual([old]);
    expect(store.listQueuedTurnRunsBefore(new Date(Date.now() - 60_000).toISOString())).toEqual([]);
  });

  it("stuck_run sees a turn queued and never claimed for 10 min (a queued run has no lease to expire) (B1)", () => {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    expect(store.findStuckRuns(new Date(Date.now() - 60_000).toISOString())).toEqual([]);
    expect(store.findStuckRuns(new Date(Date.now() + 60_000).toISOString())).toEqual([expect.objectContaining({ subject: run_id, state: "queued" })]);
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

  function setup(ttlSeconds = 120, expiresInMs = 60_000) {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    store.claimRun(run_id, "planner:c1:a", ttlSeconds);
    const requester = { kind: "user" as const, id: "paco" };
    const row = store.createToolApproval({ run_id, worker_id: "planner:c1:a", tool_call_id: "tc1", capability: "shell_external",
      input_hash: "h", action_fingerprint: "f", requester, summary: "git push", side_effect_level: "external_write",
      expires_at: new Date(Date.now() + expiresInMs).toISOString() });
    return { store, run_id, requester, row };
  }
  const ev = (id: string, type: "approve" | "deny", who = "paco") => buildTypedTaskEvent({
    source: "telegram", type, approval_id: id, requested_by: { kind: "user", id: who },
    notify: { kind: "local" }, idempotency_key: `telegram:${id}:${type}:${who}`,
    source_reference: "telegram:update:1:message:1", created_at: new Date().toISOString()
  });

  it("consume refuses on an expired but unswept lease — the gated side effect must not run on a lost lease", () => {
    const { store, run_id, requester, row } = setup(1);
    store.resolveToolApprovalForTest(row.approval_id, "approved");
    const later = new Date(Date.now() + 3_000).toISOString();
    expect(store.consumeToolApproval({ approval_id: row.approval_id, run_id, worker_id: "planner:c1:a",
      capability: "shell_external", action_fingerprint: "f", requester, now: later })).toMatchObject({ ok: false, code: "lease_lost" });
    expect(store.getToolApproval(row.approval_id)?.state).toBe("approved");
  });

  it("the /approve trigger path resolves tool approvals: requester-bound, deduped, run stays running", () => {
    const { store, run_id, row } = setup();
    const id = row.approval_id;
    const now = new Date().toISOString();
    const wrong = store.processApprovalTrigger({ event: ev(id, "approve", "mallory"), decision: "approved", resolved_at: now });
    expect(wrong).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUESTER_MISMATCH" } });
    expect(store.getToolApproval(id)?.state).toBe("pending");
    const event = ev(id, "approve");
    const ok = store.processApprovalTrigger({ event, decision: "approved", resolved_at: now });
    expect(ok).toMatchObject({ ok: true, run_id });
    const replay = store.processApprovalTrigger({ event, decision: "approved", resolved_at: now });
    expect(replay).toEqual(ok);
    expect(store.getLedgerEvents(run_id).filter((e) => e.event_type === "approval_resolved")).toHaveLength(1);
    expect(store.getRunState(run_id)).toBe("running");
    expect(store.getToolApproval(id)?.state).toBe("approved");
  });

  it("an expired tool approval cannot be approved; a denied one cannot be approved later", () => {
    const expired = setup(120, 1_000);
    const late = new Date(Date.now() + 5_000).toISOString();
    expect(expired.store.processApprovalTrigger({ event: ev(expired.row.approval_id, "approve"), decision: "approved", resolved_at: late }))
      .toMatchObject({ ok: false, error: { code: "APPROVAL_EXPIRED" } });
    const { store, row } = setup();
    const now = new Date().toISOString();
    expect(store.processApprovalTrigger({ event: ev(row.approval_id, "deny"), decision: "denied", resolved_at: now })).toMatchObject({ ok: true });
    expect(store.getToolApproval(row.approval_id)?.state).toBe("denied");
    expect(store.processApprovalTrigger({ event: ev(row.approval_id, "approve"), decision: "approved", resolved_at: now }))
      .toMatchObject({ ok: false, error: { code: "APPROVAL_NOT_PENDING" } });
  });
});
