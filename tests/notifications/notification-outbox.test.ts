import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationOutbox } from "../../src/notifications/notification-outbox.js";
import { RunStore } from "../../src/run/run-store.js";

describe("NotificationOutbox", () => {
  afterEach(() => vi.useRealTimers());

  it("claimNext returns the row it just claimed, not an earlier unacked same-owner row with a tying updated_at", () => {
    // Regression: claimNextNotification used to UPDATE the oldest queued row and then
    // RE-FIND "the claimed row" via `lease_owner + state='sending' ORDER BY updated_at DESC,
    // notification_id DESC`. When the same owner still holds an earlier `sending` row
    // (unacked/in flight) and both claims land in the same millisecond, updated_at ties
    // and the random-UUID id decides — the OLD row came back ~50% of the time.
    // Pin the clock so the tie is certain, and pin the tiebreak so the old row wins it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const enqueue = (key: string) =>
        outbox.enqueue({
          target: { kind: "telegram", chat_id: "222" },
          intent_type: "progress",
          idempotency_key: key,
          correlation_id: `telegram:update:${key}`,
          payload: { text: key }
        });
      const first = enqueue("pick:1");
      expect(outbox.claimNext("sender-1", 30)?.notification_id).toBe(first.notification_id);
      // Left in `sending` on purpose (never acked) — then make its id sort LAST.
      (store as unknown as { db: { exec(sql: string): void } }).db.exec(
        `UPDATE notification_outbox SET notification_id = 'notif_zzzzzzzz' WHERE notification_id = '${first.notification_id}'`
      );

      const second = enqueue("pick:2");
      const claimed = outbox.claimNext("sender-1", 30);
      expect(claimed?.notification_id).toBe(second.notification_id);
      expect(claimed?.payload.text).toBe("pick:2");
      expect(outbox.get(second.notification_id)?.state).toBe("sending");
      // A third claim finds nothing queued — the second row was really claimed, not skipped.
      expect(outbox.claimNext("sender-1", 30)).toBeNull();
    } finally {
      store.close();
    }
  });

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
