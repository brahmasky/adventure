import { describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createToolApprovalSink, ToolApprovalWaiters } from "../../src/omp/tool-approval-sink.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";

describe("tool-approval sink — the runner's existing approval contract, backed by tool_approvals (plan deviation 3)", () => {
  it("requestApproval creates a pending tool approval bound to this call and returns its id", () => {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    store.claimRun(run_id, "planner:c:a", 120);
    const sink = createToolApprovalSink({ store, worker_id: "planner:c:a", tool_call_id: "tc9", approvalTimeoutMs: 60_000 });
    const { approval_id } = sink.requestApproval({ run_id, approval_type: "capability", capability: "shell_external",
      action_fingerprint: "f", adapter_input_hash: "h", adapter_input_json: "{}", action_summary: "git push",
      side_effect_level: "external_write", risk_level: "medium", affected_resources: [], requester: { kind: "user", id: "1" },
      expires_at: new Date(Date.now() + 1e5).toISOString() });
    expect(store.getToolApproval(approval_id)).toMatchObject({ state: "pending", tool_call_id: "tc9", worker_id: "planner:c:a", summary: "git push" });
  });

  it("waiters resolve on /approve, time out to expired, and abort cleanly", async () => {
    const w = new ToolApprovalWaiters();
    const p1 = w.wait("a1", 5_000); w.resolve("a1", "approved");
    expect(await p1).toBe("approved");
    expect(await w.wait("a2", 20)).toBe("expired");
    const ac = new AbortController(); const p3 = w.wait("a3", 5_000, ac.signal); ac.abort();
    expect(await p3).toBe("aborted");
  });

  it("a decision that lands before wait() registers is not lost", async () => {
    const w = new ToolApprovalWaiters();
    w.resolve("early", "approved");
    expect(await w.wait("early", 5_000)).toBe("approved");
  });

  it("wait removes its abort listener when it settles (per-turn signals are reused)", async () => {
    const w = new ToolApprovalWaiters();
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    const p = w.wait("l1", 5_000, ac.signal); w.resolve("l1", "denied");
    expect(await p).toBe("denied");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("tool-approval sink — standingUse authorises through the store CAS, never on its own", () => {
  // the runner only sees this mapping: an ok must carry the store's move id, a refusal the store's exact code
  function setup() {
    const store = RunStore.openInMemory();
    const schedule_id = store.addScheduledTask({ chat_id: "555", goal: "post it", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: new Date(Date.now() + 86_400_000).toISOString(), now: new Date().toISOString() }).schedule_id;
    const move_id = store.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
    const row = store.insertStandingApprovalForTest({ schedule_id, chat_id: "555", action_fingerprint: "fp", state: "standing", move_id, expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "post it", requested_by: { kind: "schedule", id: schedule_id },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `schedule:${schedule_id}:1`, source_reference: `scheduled_tasks.${schedule_id}` }));
    if (!r.ok) throw new Error(JSON.stringify(r));
    const sink = createToolApprovalSink({ store, worker_id: "planner:555:w", tool_call_id: "tc1", approvalTimeoutMs: 60_000 });
    return { store, sink, run_id: r.run_id, standing_id: row.standing_id, move_id };
  }
  it("maps the store's ok to the runner's ok with the move id, and records the use", () => {
    const { store, sink, run_id, standing_id, move_id } = setup();
    // the runner's id differs from the sink's construction id ("tc1"): the ledger must name the call the runner authorised
    expect(sink.standingUse?.({ standing_id, action_fingerprint: "fp", run_id, tool_call_id: "tc_runner" })).toEqual({ ok: true, move_id });
    expect(store.getStandingApproval(standing_id)?.last_used_run_id).toBe(run_id);
    expect(store.getLedgerEvents(run_id).filter((e) => e.event_type === "standing_used").map((e) => e.payload.tool_call_id)).toEqual(["tc_runner"]);
  });
  it("passes the store's refusal code through unchanged (a second use in one run is already_used)", () => {
    const { sink, run_id, standing_id } = setup();
    sink.standingUse?.({ standing_id, action_fingerprint: "fp", run_id, tool_call_id: "tc1" });
    expect(sink.standingUse?.({ standing_id, action_fingerprint: "fp", run_id, tool_call_id: "tc2" })).toEqual({ ok: false, code: "already_used" });
  });
});
