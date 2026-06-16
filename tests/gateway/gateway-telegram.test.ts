import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";

function seedWaitingApprovalRun(store: RunStore): string {
  const gateway = new Gateway(store);
  const intake = gateway.intake(buildTypedTaskEvent({
    source: "cli",
    type: "run",
    program: "research-brief",
    goal: "needs approval",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: "cli:seed-waiting-approval",
    source_reference: "argv"
  }));
  if (!intake.ok) throw new Error("expected run");
  store.claimRun(intake.run_id, "worker-seed", 30);
  store.createApprovalRequest({
    run_id: intake.run_id,
    approval_type: "capability",
    capability: "local_project_write",
    action_fingerprint: "fp_write_report_artifact",
    adapter_input_hash: "input_hash_write_report_artifact",
    adapter_input_json: JSON.stringify({ path: "runs/run_1/artifact.txt", content: "hello" }),
    action_summary: "Write runs/run_1/artifact.txt",
    side_effect_level: "local_write",
    risk_level: "medium",
    affected_resources: ["path:runs/run_1/artifact.txt"],
    requester: { kind: "user", id: "paco" },
    expires_at: "2026-12-31T01:00:00.000Z"
  });
  return intake.run_id;
}

describe("Gateway telegram events", () => {
  it("deduplicates duplicate /status events without duplicate notifications", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "status",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:status-duplicate",
        source_reference: "telegram:update:8:message:1"
      });

      const first = gateway.intake(event);
      const second = gateway.intake(event);

      expect(first).toEqual(second);
      expect(store.countNotificationsByIdempotencyKey("telegram:status-duplicate:status")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("resolves approval once and replays duplicate approve deterministically", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const run_id = seedWaitingApprovalRun(store);
      const pending = store.getApprovalForRun(run_id, "pending");
      if (!pending) throw new Error("expected pending approval");
      const normalized = normalizeTelegramUpdate({
        update_id: 9,
        message: {
          message_id: 1,
          text: `/approve ${pending.approval_id}`,
          from: { id: 111 },
          chat: { id: 222 }
        }
      }, {
        users: [{ telegram_user_id: 111, identity_id: "paco" }],
        chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
      });
      if (!normalized.ok) throw new Error("expected normalized approve");
      const event = normalized.event;

      const first = gateway.intake(event);
      const second = gateway.intake(event);

      expect(first).toEqual({ ok: true, status: "approval_resolved", run_id });
      expect(second).toEqual(first);
      expect(store.getRunState(run_id)).toBe("queued");
    } finally {
      store.close();
    }
  });

  it("queues approval prompt with full action evidence", () => {
    const store = RunStore.openInMemory();
    try {
      const run_id = seedWaitingApprovalRun(store);
      const prompt = store.claimNextNotification("sender-prompt", 30);

      expect(prompt?.intent_type).toBe("approval_prompt");
      expect(prompt?.payload.text).toContain("Action: Write runs/run_1/artifact.txt");
      expect(prompt?.payload.text).toContain("Side effect: local_write");
      expect(prompt?.payload.text).toContain("Risk: medium");
      expect(prompt?.payload.text).toContain("Affected resources: path:runs/run_1/artifact.txt");
      expect(prompt?.payload.text).toContain("Action fingerprint: fp_write_report_artifact");
      expect(prompt?.payload.text).toContain("Adapter input hash: input_hash_write_report_artifact");
      expect(prompt?.payload.text).toContain("Requester: user:paco");
      expect(prompt?.payload.text).toContain("Expected run state: waiting_for_approval");
      expect(prompt?.payload.text).toContain("Consequence if approved:");
      expect(run_id).toMatch(/^run_/);
    } finally {
      store.close();
    }
  });

  it("throttles abusive telegram command volume per actor and chat", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      for (let i = 0; i < 5; i += 1) {
        const result = gateway.intake(buildTypedTaskEvent({
          source: "telegram",
          type: "ask",
          goal: `question ${i}`,
          requested_by: { kind: "user", id: "paco" },
          notify: { kind: "telegram", chat_id: "222" },
          idempotency_key: `telegram:rate:${i}`,
          source_reference: `telegram:update:${i}:message:1`
        }));
        expect(result.ok).toBe(true);
      }
      expect(gateway.intake(buildTypedTaskEvent({
        source: "telegram",
        type: "ask",
        goal: "one too many",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:rate:blocked",
        source_reference: "telegram:update:99:message:1"
      }))).toEqual({
        ok: false,
        error: { code: "TELEGRAM_RATE_LIMITED", message: "Telegram command rate limit exceeded" }
      });
    } finally {
      store.close();
    }
  });
});
