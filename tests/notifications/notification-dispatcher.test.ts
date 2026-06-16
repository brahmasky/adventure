import { describe, expect, it } from "vitest";
import { NotificationDispatcher } from "../../src/notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../../src/notifications/notification-outbox.js";
import { RunStore } from "../../src/run/run-store.js";

describe("NotificationDispatcher", () => {
  it("sends queued Telegram notification and marks delivered", async () => {
    const store = RunStore.openInMemory();
    const sent: string[] = [];
    try {
      const outbox = new NotificationOutbox(store);
      const record = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "final_report",
        idempotency_key: "run_1:final",
        run_id: "run_1",
        correlation_id: "run_1:final",
        payload: { text: "Report ready", run_id: "run_1" }
      });
      const dispatcher = new NotificationDispatcher(outbox, {
        local: { send: async () => ({ provider_message_id: "local:1" }) },
        telegram: { send: async (notification) => {
          sent.push(notification.payload.text);
          return { provider_message_id: "telegram:99" };
        } }
      });

      await expect(dispatcher.dispatchOnce("sender-1")).resolves.toEqual({ status: "delivered", notification_id: record.notification_id });
      expect(sent).toEqual(["Report ready"]);
      expect(outbox.get(record.notification_id)?.provider_message_id).toBe("telegram:99");
    } finally {
      store.close();
    }
  });

  it("marks retryable failure when adapter throws", async () => {
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const record = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "progress",
        idempotency_key: "run_1:progress",
        run_id: "run_1",
        correlation_id: "run_1:progress",
        payload: { text: "Queued" }
      });
      const dispatcher = new NotificationDispatcher(outbox, {
        local: { send: async () => ({ provider_message_id: "local:1" }) },
        telegram: { send: async () => { throw new Error("network down"); } }
      });

      await expect(dispatcher.dispatchOnce("sender-1")).resolves.toEqual({ status: "failed", notification_id: record.notification_id, retryable: true });
      expect(outbox.get(record.notification_id)?.state).toBe("retry_wait");
    } finally {
      store.close();
    }
  });
});
