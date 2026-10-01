// tests/notifications/notification-retry.test.ts
import { describe, expect, it, vi } from "vitest";
import { NotificationDispatcher } from "../../src/notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../../src/notifications/notification-outbox.js";
import { NOTIFICATION_MAX_ATTEMPTS } from "../../src/notifications/notification-types.js";
import { detectViolations } from "../../src/run/invariant-sweep.js";
import { NOTIFICATION_RESEND_MAX_AGE_MS, NOTIFICATION_RETRY_BACKOFF_MS, RunStore } from "../../src/run/run-store.js";

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
    const due = new Date(Date.now() + 31_000).toISOString(); // past the first 30 s backoff
    expect(store.retryUndeliveredNotifications(due).requeued).toEqual([row.notification_id]);
    expect(outbox.get(row.notification_id)?.state).toBe("queued");
  });

  it("a retry_wait row older than the resend window is failed_terminal with a ledger line, never sent", () => {
    const { store, outbox, enqueue, backdate, failOnce } = setup();
    const row = enqueue("reply:old");
    failOnce(row.notification_id);
    backdate(row.notification_id, NOTIFICATION_RESEND_MAX_AGE_MS + HOUR);
    const r = store.retryUndeliveredNotifications(new Date().toISOString());
    expect(r).toEqual({ abandoned: [row.notification_id], recovered: [], requeued: [] });
    expect(outbox.get(row.notification_id)?.state).toBe("failed_terminal");
    expect(outbox.claimNext("s", 30)).toBeNull();
    expect(store.getLedgerEvents().filter((e) => e.event_type === "notification_failed").at(-1)?.payload)
      .toMatchObject({ notification_id: row.notification_id, error_ref: "stale_retry_abandoned", retryable: false });
  });

  it("the resend window is 6 h: a reply 5 h 59 late is still sent, one 6 h 01 late is abandoned (controller ruling)", () => {
    expect(NOTIFICATION_RESEND_MAX_AGE_MS).toBe(6 * HOUR);
    const { store, outbox, enqueue, backdate, failOnce } = setup();
    const young = enqueue("reply:5h59");
    const old = enqueue("reply:6h01");
    failOnce(young.notification_id);
    failOnce(old.notification_id);
    backdate(young.notification_id, 6 * HOUR - 60_000);
    backdate(old.notification_id, 6 * HOUR + 60_000);
    const r = store.retryUndeliveredNotifications(new Date(Date.now() + 31_000).toISOString()); // past the 30 s backoff
    expect(r.abandoned).toEqual([old.notification_id]);
    expect(r.requeued).toEqual([young.notification_id]);
    expect(outbox.get(old.notification_id)?.state).toBe("failed_terminal");
  });

  it("a QUEUED row past the resend window is abandoned too: a reply that never left is as stale as one that failed", () => {
    const { store, outbox, enqueue, backdate } = setup();
    const row = enqueue("reply:queued-old");
    backdate(row.notification_id, 6 * HOUR + 60_000);
    expect(store.retryUndeliveredNotifications(new Date().toISOString()).abandoned).toEqual([row.notification_id]);
    expect(outbox.get(row.notification_id)?.state).toBe("failed_terminal");
    expect(outbox.claimNext("s", 30)).toBeNull();
  });

  it("a `sending` row whose lease expired (a crash mid-send) is recovered to the queue", () => {
    const { store, outbox, enqueue } = setup();
    const row = enqueue("reply:stuck");
    expect(outbox.claimNext("s", 1)?.notification_id).toBe(row.notification_id);
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(store.retryUndeliveredNotifications(later).recovered).toEqual([row.notification_id]);
    expect(outbox.get(row.notification_id)?.state).toBe("queued");
  });

  it("crash recovery honours the attempt cap: a send that crashes the daemon every time ends terminal, not requeued forever", () => {
    const { store, outbox, enqueue } = setup();
    const row = enqueue("reply:crashes");
    let claims = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let crash = 0; crash < 10; crash += 1) {
        if (outbox.claimNext("s", 1)) claims += 1; // the send starts, then the daemon dies mid-send
        vi.setSystemTime(Date.now() + 60_000); // launchd restarts it a minute later
        store.retryUndeliveredNotifications(new Date().toISOString()); // the restarted daemon's retry step
      }
    } finally { vi.useRealTimers(); }
    expect(claims).toBe(NOTIFICATION_MAX_ATTEMPTS);
    expect(outbox.get(row.notification_id)).toMatchObject({ state: "failed_terminal", attempt_count: NOTIFICATION_MAX_ATTEMPTS });
    expect(store.getLedgerEvents().filter((e) => e.event_type === "notification_failed").at(-1)?.payload)
      .toMatchObject({ notification_id: row.notification_id, error_ref: "attempt_cap_after_crash", retryable: false });
  });

  it("a stuck `sending` row older than the resend window is abandoned, not recovered", () => {
    const { store, outbox, enqueue, backdate } = setup();
    const row = enqueue("reply:stuck-old");
    outbox.claimNext("s", 1);
    backdate(row.notification_id, NOTIFICATION_RESEND_MAX_AGE_MS + HOUR);
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
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let cycle = 0; cycle < 8; cycle += 1) {
        store.retryUndeliveredNotifications(new Date().toISOString());
        await dispatcher.dispatchOnce("d");
        vi.setSystemTime(Date.now() + 31 * 60_000); // past the longest backoff
      }
    } finally { vi.useRealTimers(); }
    expect(attempts).toBe(5);
    expect(outbox.get(row.notification_id)?.state).toBe("failed_terminal");
  });
});

describe("retry backoff (gate-fixes round 2)", () => {
  it("each failed attempt waits 30 s, 2 min, 8 min, then 30 min before it is due again; the 5th failure is terminal", () => {
    expect(NOTIFICATION_RETRY_BACKOFF_MS).toEqual([30_000, 120_000, 480_000, 1_800_000]);
    const { store, outbox, enqueue } = setup();
    const row = enqueue("reply:backoff");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const waits: number[] = [];
      for (let attempt = 1; attempt <= NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
        expect(outbox.claimNext("s", 30)?.notification_id).toBe(row.notification_id);
        const failedAt = Date.now();
        outbox.markFailed(row.notification_id, "HTTP 502", true, new Date(failedAt).toISOString(), NOTIFICATION_MAX_ATTEMPTS);
        const after = outbox.get(row.notification_id)!;
        if (after.state === "failed_terminal") break;
        const wait = Date.parse(after.next_attempt_at) - failedAt;
        waits.push(wait);
        vi.setSystemTime(failedAt + wait - 1_000); // one second early: not due yet
        expect(store.retryUndeliveredNotifications(new Date().toISOString()).requeued).toEqual([]);
        vi.setSystemTime(failedAt + wait);
        expect(store.retryUndeliveredNotifications(new Date().toISOString()).requeued).toEqual([row.notification_id]);
      }
      expect(waits).toEqual([30_000, 120_000, 480_000, 1_800_000]); // the 5 attempts span about 40 min
      expect(outbox.get(row.notification_id)?.state).toBe("failed_terminal");
    } finally { vi.useRealTimers(); }
  });
});

describe("the sweep's undelivered_notification check after abandonment", () => {
  const setUpdated = (store: RunStore, id: string, msAgo: number) => (store as unknown as Db).db
    .prepare("UPDATE notification_outbox SET updated_at = ? WHERE notification_id = ?").run(new Date(Date.now() - msAgo).toISOString(), id);
  function terminalRows() {
    const t = setup();
    const ids = ["reply:a", "reply:b"].map((k) => t.enqueue(k).notification_id);
    for (const id of ids) {
      t.outbox.claimNext("s", 30);
      t.outbox.markFailed(id, "HTTP 400", false, new Date().toISOString(), 5);
      t.backdate(id, 30 * HOUR); // both were CREATED long ago
    }
    return { ...t, ids };
  }

  it("keys on when the row went terminal (updated_at), not when it was created: a fresh failure is seen at least once", () => {
    const { store, ids: [recent, old] } = terminalRows();
    setUpdated(store, recent!, 1 * HOUR); // gave up an hour ago on a 30 h old row
    setUpdated(store, old!, 25 * HOUR);
    const flagged = store.findUndeliveredNotifications(new Date().toISOString(), 30 * 60_000).map((r) => r.subject);
    expect(flagged).toEqual([recent]);
  });

  it("the sweep's window is never shorter than its own cadence, so a terminal row cannot fall between two sweeps", () => {
    const { store, ids: [row] } = terminalRows();
    setUpdated(store, row!, 30 * HOUR);
    const kinds = (env: NodeJS.ProcessEnv) => detectViolations(store, new Date().toISOString(), env)
      .filter((v) => v.kind === "undelivered_notification").map((v) => v.subject);
    expect(kinds({})).not.toContain(row); // default 12 h cadence: a 30 h old terminal row has been seen
    expect(kinds({ HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: String(20 * 60) })).toContain(row); // 20 h cadence: window 40 h
  });
});
