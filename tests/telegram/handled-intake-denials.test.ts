// tests/telegram/handled-intake-denials.test.ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { isHandledIntakeDenial } from "../../src/telegram/telegram-poll-runner.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Live gate 2026-10-01: Paco's /approve of an already-denied id earned APPROVAL_NOT_PENDING, which the
// daemon treated as a poll failure. The update offset was never acknowledged, the same update replayed
// forever, and every later message (his correct /approve included) queued behind it. Every refusal a
// user's /approve or /deny can earn must be a handled denial, or one stale id wedges intake.
describe("approval refusals never wedge Telegram intake", () => {
  function setup(expiresInMs = 60_000) {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    store.claimRun(run_id, "planner:c1:a", 120);
    const row = store.createToolApproval({ run_id, worker_id: "planner:c1:a", tool_call_id: "tc1", capability: "shell_external",
      input_hash: "h", action_fingerprint: "f", requester: { kind: "user", id: "paco" }, summary: "git push",
      side_effect_level: "external_write", expires_at: new Date(Date.now() + expiresInMs).toISOString() });
    return { store, row };
  }
  let n = 0;
  const trigger = (store: RunStore, approval_id: string, type: "approve" | "deny", who = "paco") => {
    n += 1;
    return store.processApprovalTrigger({
      event: buildTypedTaskEvent({ source: "telegram", type, approval_id, requested_by: { kind: "user", id: who },
        notify: { kind: "local" }, idempotency_key: `telegram:${n}:${type}`, source_reference: `telegram:update:${n}:message:${n}`,
        created_at: new Date().toISOString() }),
      decision: type === "approve" ? "approved" : "denied",
      resolved_at: new Date().toISOString()
    });
  };
  const codeOf = (r: ReturnType<typeof trigger>) => (r.ok ? "ok" : r.error.code);

  it("a stale id (already denied) is a handled denial, not a poll failure", () => {
    const { store, row } = setup();
    expect(trigger(store, row.approval_id, "deny").ok).toBe(true);
    const code = codeOf(trigger(store, row.approval_id, "approve"));
    expect(code).toBe("APPROVAL_NOT_PENDING");
    expect(isHandledIntakeDenial(code)).toBe(true);
  });

  it("a mistyped id (the card's markdown once ate the underscore) is a handled denial", () => {
    const { store, row } = setup();
    const code = codeOf(trigger(store, row.approval_id.replace("appr_", "appr"), "deny"));
    expect(code).toBe("APPROVAL_NOT_FOUND");
    expect(isHandledIntakeDenial(code)).toBe(true);
  });

  it("someone other than the requester answering is a handled denial", () => {
    const { store, row } = setup();
    const code = codeOf(trigger(store, row.approval_id, "approve", "stranger"));
    expect(code).not.toBe("ok");
    expect(isHandledIntakeDenial(code)).toBe(true);
  });

  it("an expired approval is a handled denial", () => {
    const { store, row } = setup(-1_000);
    const code = codeOf(trigger(store, row.approval_id, "approve"));
    expect(code).not.toBe("ok");
    expect(isHandledIntakeDenial(code)).toBe(true);
  });
});
