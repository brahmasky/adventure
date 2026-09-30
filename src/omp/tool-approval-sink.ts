import type { ApprovalRequestSink } from "../capabilities/capability-runner.js";
import type { RunStore } from "../run/run-store.js";

export type WaitOutcome = "approved" | "denied" | "expired" | "aborted";

export class ToolApprovalWaiters {
  private readonly pending = new Map<string, (o: WaitOutcome) => void>();
  wait(approval_id: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    return new Promise((resolve) => {
      const done = (o: WaitOutcome) => { clearTimeout(timer); this.pending.delete(approval_id); resolve(o); };
      const timer = setTimeout(() => done("expired"), timeoutMs);
      this.pending.set(approval_id, done);
      if (signal?.aborted) done("aborted");
      signal?.addEventListener("abort", () => done("aborted"), { once: true });
    });
  }
  resolve(approval_id: string, decision: "approved" | "denied"): void {
    this.pending.get(approval_id)?.(decision);
  }
}

/** Process-wide: the gateway resolves, the bridge waits. */
export const toolApprovalWaiters = new ToolApprovalWaiters();

export function createToolApprovalSink(deps: { store: RunStore; worker_id: string; tool_call_id: string; approvalTimeoutMs: number }): ApprovalRequestSink {
  return {
    requestApproval: (input) => {
      const row = deps.store.createToolApproval({
        run_id: input.run_id, worker_id: deps.worker_id, tool_call_id: deps.tool_call_id, capability: input.capability,
        input_hash: input.adapter_input_hash, action_fingerprint: input.action_fingerprint, requester: input.requester,
        summary: input.action_summary, side_effect_level: input.side_effect_level,
        expires_at: new Date(Date.now() + deps.approvalTimeoutMs).toISOString()
      });
      return { approval_id: row.approval_id };
    },
    consumeApprovedApproval: (input) => {
      const r = deps.store.consumeToolApproval({ approval_id: input.approval_id, run_id: input.run_id, worker_id: deps.worker_id,
        capability: input.capability, action_fingerprint: input.action_fingerprint, requester: input.requester, now: input.consumed_at });
      return r.ok ? { ok: true, approval_id: input.approval_id, state: "consumed" } : { ok: false, error: { code: r.code, message: r.code } };
    }
  };
}
