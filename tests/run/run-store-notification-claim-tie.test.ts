import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

/**
 * Regression: claimNextNotification identified the row it had just claimed with a
 * second SELECT ordered by `updated_at DESC, notification_id DESC` over every `sending`
 * row owned by the same lease_owner. `updated_at` has millisecond resolution and
 * notification_id is a random UUID, so two claims by one owner inside the same
 * millisecond made the second claim hand back the FIRST row again (a coin flip on the
 * UUID tie-break). gateway-telegram "superseded id → points at the successor" flaked
 * on exactly this: its second claim returned the "#9999 not found" notification.
 */
describe("claimNextNotification same-millisecond claims by one owner", () => {
  let store: RunStore;

  beforeEach(() => {
    store = RunStore.openInMemory();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  function enqueue(key: string, text: string): string {
    const result = store.enqueueNotification({
      target: { kind: "telegram", chat_id: "222" },
      intent_type: "progress",
      idempotency_key: key,
      correlation_id: "test",
      payload: { text }
    });
    if (result.status !== "queued") throw new Error(`expected queued, got ${result.status}`);
    return result.record.notification_id;
  }

  it("returns the row it just claimed, not an earlier still-sending row with the same updated_at", () => {
    const first = enqueue("first", "first");
    const second = enqueue("second", "second");
    // Pin the tie-break the wrong way: the earlier-claimed row sorts LAST by id, so the
    // old `ORDER BY updated_at DESC, notification_id DESC` lookup picks it again.
    const db = (store as unknown as { db: { prepare(sql: string): { run(...v: string[]): unknown } } }).db;
    db.prepare("UPDATE notification_outbox SET notification_id = ? WHERE notification_id = ?").run("notif_zzz", first);
    db.prepare("UPDATE notification_outbox SET notification_id = ? WHERE notification_id = ?").run("notif_aaa", second);

    // The clock is frozen, so both claims stamp the identical updated_at. The first
    // claim is deliberately never delivered/failed — the gateway tests do the same.
    const a = store.claimNextNotification("owner", 30);
    const b = store.claimNextNotification("owner", 30);

    expect(a?.notification_id).toBe("notif_zzz");
    expect(b?.notification_id).toBe("notif_aaa");
    expect(String(b?.payload.text)).toBe("second");
    // Nothing queued remains; a third claim must be empty rather than a re-hand-out.
    expect(store.claimNextNotification("owner", 30)).toBeNull();
  });
});
