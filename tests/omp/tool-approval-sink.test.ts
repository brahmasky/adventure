import { describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createToolApprovalSink, ToolApprovalWaiters } from "../../src/omp/tool-approval-sink.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

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
