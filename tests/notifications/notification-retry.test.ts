// tests/notifications/notification-retry.test.ts
import { describe, expect, it } from "vitest";
import { NotificationDispatcher } from "../../src/notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../../src/notifications/notification-outbox.js";
import { NOTIFICATION_RETRY_MAX_AGE_MS, RunStore } from "../../src/run/run-store.js";

// Live gate 2026-10-01: requeueRetryWaitNotifications / recoverStaleSendingNotifications had no caller outside tests,
// so one transient Telegram error lost the reply for good (two rows stuck since 2026-09-18 and 2026-10-01). The
// retry step resends what is young, abandons what is a day old (a two-week-old reply is worse than none), and the
// attempt cap ends a persistent failure.
type Db = { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } };
const HOUR = 3_600_000;

function setup() {
  const store = RunStore.openInMemory();
  const outbox = new NotificationOutbox(store);
  const enqueue = (key: string) => outbox.enqueue({ target: { kind: "telegram", chat_id: "222" }, intent_type: "progress",
    idempotency_key: key, correlation_id: key, payload: { text: key } });
  const backdate = (id: string, ms: number) => (store as unknown as Db).db
    .prepare("UPDATE notification_outbox SET created_at = ? WHERE notification_id = ?").run(new Date(Date.now() - ms).toISOString(), id);
  const failOnce = (id: string) => {
    expect(outbox.claimNext("s", 30)?.notification_id).toBe(id);
    outbox.markFailed(id, "HTTP 502", true, new Date().toISOString(), 5);
  };
  return { store, outbox, enqueue, backdate, failOnce };
}

describe("RunStore.retryUndeliveredNotifications", () => {
  it("a young retry_wait row goes back to the queue and is claimable again", () => {
    const { store, outbox, enqueue, failOnce } = setup();
    const row = enqueue("reply:1");
    failOnce(row.notification_id);
    expect(outbox.get(row.notification_id)?.state).toBe("retry_wait");
    expect(store.retryUndeliveredNotifications(new Date().toISOString()).requeued).toEqual([row.notification_id]);
    expect(outbox.claimNext("s", 30)?.notification_id).toBe(row.notification_id);
  });

  it("a retry_wait row older than 24 h is failed_terminal with a ledger line, never sent", () => {
    const { store, outbox, enqueue, backdate, failOnce } = setup();
    const row = enqueue("reply:old");
    failOnce(row.notification_id);
    backdate(row.notification_id, NOTIFICATION_RETRY_MAX_AGE_MS + HOUR);
    const r = store.retryUndeliveredNotifications(new Date().toISOString());
    expect(r).toEqual({ abandoned: [row.notification_id], recovered: [], requeued: [] });
    expect(outbox.get(row.notification_id)?.state).toBe("failed_terminal");
    expect(outbox.claimNext("s", 30)).toBeNull();
    expect(store.getLedgerEvents().filter((e) => e.event_type === "notification_failed").at(-1)?.payload)
      .toMatchObject({ notification_id: row.notification_id, error_ref: "stale_retry_abandoned", retryable: false });
  });

  it("a `sending` row whose lease expired (a crash mid-send) is recovered to the queue", () => {
    const { store, outbox, enqueue } = setup();
    const row = enqueue("reply:stuck");
    expect(outbox.claimNext("s", 1)?.notification_id).toBe(row.notification_id);
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(store.retryUndeliveredNotifications(later).recovered).toEqual([row.notification_id]);
    expect(outbox.get(row.notification_id)?.state).toBe("queued");
  });

  it("a stuck `sending` row older than 24 h is abandoned, not recovered", () => {
    const { store, outbox, enqueue, backdate } = setup();
    const row = enqueue("reply:stuck-old");
    outbox.claimNext("s", 1);
    backdate(row.notification_id, NOTIFICATION_RETRY_MAX_AGE_MS + HOUR);
    const r = store.retryUndeliveredNotifications(new Date(Date.now() + 60_000).toISOString());
    expect(r.abandoned).toEqual([row.notification_id]);
    expect(outbox.get(row.notification_id)?.state).toBe("failed_terminal");
  });

  it("the attempt cap: a send that always fails is failed_terminal after 5 attempts, and never tried a 6th time", async () => {
    const { store, outbox, enqueue } = setup();
    const row = enqueue("reply:doomed");
    let attempts = 0;
    const failing = { send: async () => { attempts += 1; throw new Error("HTTP 502"); } };
    const dispatcher = new NotificationDispatcher(outbox, { local: failing, telegram: failing });
    for (let cycle = 0; cycle < 8; cycle += 1) {
      store.retryUndeliveredNotifications(new Date().toISOString());
      await dispatcher.dispatchOnce("d");
    }
    expect(attempts).toBe(5);
    expect(outbox.get(row.notification_id)?.state).toBe("failed_terminal");
  });
});

describe("the sweep's undelivered_notification check after abandonment", () => {
  it("a failed_terminal row older than 24 h no longer counts, so its incident can resolve; a young one still does", () => {
    const { store, enqueue, backdate, outbox } = setup();
    const old = enqueue("reply:old");
    const young = enqueue("reply:young");
    for (const id of [old.notification_id, young.notification_id]) {
      outbox.claimNext("s", 30);
      outbox.markFailed(id, "HTTP 400", false, new Date().toISOString(), 5);
    }
    backdate(old.notification_id, NOTIFICATION_RETRY_MAX_AGE_MS + HOUR);
    backdate(young.notification_id, 2 * HOUR);
    const flagged = store.findUndeliveredNotifications(new Date().toISOString(), 30 * 60_000).map((r) => r.subject);
    expect(flagged).toEqual([young.notification_id]);
  });
});
