import { describe, expect, it } from "vitest";
import { NotificationOutbox } from "../../src/notifications/notification-outbox.js";
import { RunStore } from "../../src/run/run-store.js";

describe("NotificationOutbox", () => {
  it("deduplicates by target and idempotency key and marks delivery", () => {
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const first = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "progress",
        idempotency_key: "run_1:progress:queued",
        run_id: "run_1",
        correlation_id: "telegram:update:1",
        payload: { text: "Queued run_1" }
      });
      const second = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "progress",
        idempotency_key: "run_1:progress:queued",
        run_id: "run_1",
        correlation_id: "telegram:update:1",
        payload: { text: "Queued run_1" }
      });
      expect(second.notification_id).toBe(first.notification_id);
      expect(outbox.claimNext("sender-1", 30)?.notification_id).toBe(first.notification_id);
      outbox.markDelivered(first.notification_id, "telegram:1");
      expect(outbox.get(first.notification_id)?.state).toBe("delivered");
    } finally {
      store.close();
    }
  });

  it("handles retry_wait recovery, terminal failure, and stale sending lease recovery", () => {
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const retry = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "approval_prompt",
        idempotency_key: "appr_1:prompt",
        run_id: "run_1",
        approval_id: "appr_1",
        correlation_id: "appr_1",
        payload: { text: "Approval required", expires_at: "2026-12-31T01:00:00.000Z" }
      });
      outbox.claimNext("sender-1", 30);
      outbox.markFailed(retry.notification_id, "network down", true, "2026-05-28T00:00:10.000Z", 3);
      expect(outbox.get(retry.notification_id)?.state).toBe("retry_wait");
      expect(store.requeueRetryWaitNotifications("2026-05-28T00:00:11.000Z")).toEqual([retry.notification_id]);

      outbox.claimNext("sender-2", 30);
      outbox.markFailed(retry.notification_id, "bad request", false, "2026-05-28T00:00:12.000Z", 3);
      expect(outbox.get(retry.notification_id)?.state).toBe("failed_terminal");

      const stale = outbox.enqueue({
        target: { kind: "local" },
        intent_type: "progress",
        idempotency_key: "run_1:stale",
        run_id: "run_1",
        correlation_id: "run_1:stale",
        payload: { text: "stale lease" }
      });
      outbox.claimNext("sender-stale", -1);
      expect(store.recoverStaleSendingNotifications("2026-05-28T00:00:20.000Z")).toEqual([stale.notification_id]);
      expect(outbox.get(stale.notification_id)?.state).toBe("queued");
    } finally {
      store.close();
    }
  });

  it("only one sender can claim a queued notification", () => {
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const queued = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "progress",
        idempotency_key: "run_1:double-claim",
        run_id: "run_1",
        correlation_id: "run_1:double-claim",
        payload: { text: "Queued" }
      });

      expect(outbox.claimNext("sender-a", 30)?.notification_id).toBe(queued.notification_id);
      expect(outbox.claimNext("sender-b", 30)).toBeNull();
    } finally {
      store.close();
    }
  });
});
