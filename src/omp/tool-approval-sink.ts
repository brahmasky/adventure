import type { ApprovalRequestSink } from "../capabilities/capability-runner.js";
import type { RunStore } from "../run/run-store.js";

export type WaitOutcome = "approved" | "denied" | "expired" | "aborted";

const EARLY_DECISION_TTL_MS = 10 * 60_000;

export class ToolApprovalWaiters {
  private readonly pending = new Map<string, (o: WaitOutcome) => void>();
  /** Decisions that arrived before wait() registered (the bridge creates the row, then waits). */
  private readonly early = new Map<string, { decision: "approved" | "denied"; timer: ReturnType<typeof setTimeout> }>();

  wait(approval_id: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    const early = this.early.get(approval_id);
    if (early) {
      clearTimeout(early.timer);
      this.early.delete(approval_id);
      return Promise.resolve(early.decision);
    }
    return new Promise((resolve) => {
      const onAbort = () => done("aborted");
      const done = (o: WaitOutcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(approval_id);
        resolve(o);
      };
      const timer = setTimeout(() => done("expired"), timeoutMs);
      this.pending.set(approval_id, done);
      if (signal?.aborted) return done("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  resolve(approval_id: string, decision: "approved" | "denied"): void {
    const waiter = this.pending.get(approval_id);
    if (waiter) return waiter(decision);
    const timer = setTimeout(() => this.early.delete(approval_id), EARLY_DECISION_TTL_MS);
    timer.unref?.();
    this.early.set(approval_id, { decision, timer });
  }
}

/** Process-wide: the gateway resolves, the bridge waits. */
export const toolApprovalWaiters = new ToolApprovalWaiters();

/** `card_detail` rides the factory closure to the approval card only (never the ledger); the runner stays unchanged. */
export function createToolApprovalSink(deps: {
  store: RunStore; worker_id: string; tool_call_id: string; approvalTimeoutMs: number; card_detail?: string;
}): ApprovalRequestSink {
  return {
    requestApproval: (input) => {
      const row = deps.store.createToolApproval({
        run_id: input.run_id, worker_id: deps.worker_id, tool_call_id: deps.tool_call_id, capability: input.capability,
        input_hash: input.adapter_input_hash, action_fingerprint: input.action_fingerprint, requester: input.requester,
        summary: input.action_summary, side_effect_level: input.side_effect_level,
        expires_at: new Date(Date.now() + deps.approvalTimeoutMs).toISOString(),
        ...(deps.card_detail !== undefined ? { card_detail: deps.card_detail } : {})
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
