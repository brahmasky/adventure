import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

describe("CoreWorker approvals", () => {
  it("parks as waiting_for_approval instead of failing", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-approval-park-"));
    writeFileSync(join(root, "AGENTS.md"), "Rules");
    const store = RunStore.openInMemory();
    try {
      const intake = new Gateway(store).intake(buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "force approval fixture",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:worker-park",
        source_reference: "argv",
        metadata: { force_gated_capability: true }
      }));
      if (!intake.ok) throw new Error("expected intake");

      const result = await new CoreWorker(store, root).executeRun(intake.run_id, "worker-approval");

      expect(result).toEqual({ status: "waiting_for_approval", run_id: intake.run_id, approval_id: expect.stringMatching(/^appr_/) });
      expect(store.getRunState(intake.run_id)).toBe("waiting_for_approval");
    } finally {
      store.close();
    }
  });

  it("resumes after approval and executes the gated action once", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-approval-resume-"));
    writeFileSync(join(root, "AGENTS.md"), "Rules");
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const intake = gateway.intake(buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "force approval fixture",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:worker-resume",
        source_reference: "argv",
        metadata: { force_gated_capability: true }
      }));
      if (!intake.ok) throw new Error("expected intake");

      const parked = await new CoreWorker(store, root).executeRun(intake.run_id, "worker-approval");
      if (parked.status !== "waiting_for_approval") throw new Error("expected approval wait");
      const pending = store.getApprovalForRun(intake.run_id, "pending");
      if (!pending) throw new Error("expected pending approval");

      store.processApprovalTrigger({
        event: buildTypedTaskEvent({
        source: "telegram",
        type: "approve",
        approval_id: pending.approval_id,
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:worker-resume-approve",
        source_reference: "telegram:update:20:message:1"
        }),
        decision: "approved",
        resolved_at: "2026-05-28T00:10:00.000Z"
      });

      const completed = await new CoreWorker(store, root).executeRun(intake.run_id, "worker-approval");

      expect(completed.status).toBe("completed");
      expect(store.getLedgerEvents(intake.run_id).map((event) => event.event_type)).toContain("tool_finished");
    } finally {
      store.close();
    }
  });
});
