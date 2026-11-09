import { describe, expect, it } from "vitest";
import { purgeMail, runMailRetention } from "../../src/mail/retention.js";
import { RunStore, type MailItemInsert } from "../../src/run/run-store.js";

// Spec 2026-11-09 §4: mail text (subject, snippet, sender name) is kept HOUGE_MAIL_TEXT_DAYS and no longer: past it the row keeps
// its envelope facts, loses the text, and its outbox card is reduced to a bare kind line (whatever state the row is in), so
// nothing quotable is left behind. Once a local date. Purge is the same for every row, plus the known-sender cache.
const NOW = new Date("2026-11-09T02:00:00.000Z"); // 13:00 Sydney
const ENV = { HOUGE_DISPLAY_TZ: "Australia/Sydney" } as NodeJS.ProcessEnv;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function seed(store: RunStore, id: string, ageDays: number, kind: MailItemInsert["kind"] = "action"): string {
  const n = store.enqueueNotification({ topic: "mail_card", target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: `mail:${id}`,
    correlation_id: "t", payload: { text: `📧 Ann · ${kind}\nSecret subject ${id}`, button_rows: [[{ text: "Open", url: "https://mail.example.com/x" }]] } });
  if (n.status !== "queued") throw new Error("not queued");
  store.insertMailItem({ item_id: id, gmail_message_id: `g-${id}`, gmail_thread_id: `t-${id}`, from_address: "ann@example.com", from_name: "Ann", known_sender: true, labels: [],
    important: false, received_at: daysAgo(ageDays), subject: `Secret subject ${id}`, snippet: "snippet text", lane: "ping", kind, reason_code: "jev_now",
    thread_followup: false, decision_id: null, notification_id: n.record.notification_id, created_at: daysAgo(ageDays) });
  return n.record.notification_id;
}
const payload = (store: RunStore, nid: string) => (store as any).db.prepare("SELECT payload_json, payload_hash FROM notification_outbox WHERE notification_id = ?").get(nid) as { payload_json: string; payload_hash: string };

describe("runMailRetention", () => {
  it("clears text older than 30 days and reduces its card to a kind line with a recomputed hash; newer items are untouched", () => {
    const store = RunStore.openInMemory();
    const oldN = seed(store, "old", 31, "risk");
    const newN = seed(store, "new", 5);
    const before = payload(store, oldN).payload_hash;
    expect(runMailRetention(store, NOW, ENV)).toEqual({ cleared: 1, stripped: 1 });
    const old = store.getMailItem("old")!;
    expect([old.subject, old.snippet, old.from_name]).toEqual([null, null, null]);
    expect(old.text_cleared_at).not.toBeNull();
    expect(old.from_address).toBe("ann@example.com");
    expect(JSON.parse(payload(store, oldN).payload_json)).toEqual({ text: "📧 · risk", buttons: [] });
    expect(payload(store, oldN).payload_hash).not.toBe(before);
    expect(store.getMailItem("new")!.subject).toBe("Secret subject new");
    expect(payload(store, newN).payload_json).toContain("Secret subject new");
    store.close();
  });
  it("strips a card whatever state its row is in (already delivered)", () => {
    const store = RunStore.openInMemory();
    const nid = seed(store, "old", 40);
    const claimed = store.claimNextNotification("t", 30)!;
    store.markNotificationDelivered(claimed.notification_id, "tg:1");
    runMailRetention(store, NOW, ENV);
    expect(JSON.parse(payload(store, nid).payload_json).text).toBe("📧 · action");
    store.close();
  });
  it("honours HOUGE_MAIL_TEXT_DAYS", () => {
    const store = RunStore.openInMemory();
    seed(store, "a", 10);
    expect(runMailRetention(store, NOW, { ...ENV, HOUGE_MAIL_TEXT_DAYS: "7" }).cleared).toBe(1);
    store.close();
  });
  it("runs once a local date: a second run the same day does nothing, the next day sweeps again", () => {
    const store = RunStore.openInMemory();
    seed(store, "a", 31);
    runMailRetention(store, NOW, ENV);
    seed(store, "b", 31);
    expect(runMailRetention(store, new Date(NOW.getTime() + 3_600_000), ENV)).toEqual({ cleared: 0, stripped: 0 });
    expect(store.getMailItem("b")!.subject).not.toBeNull();
    expect(store.mailState().retention_on).toBe("2026-11-09");
    expect(runMailRetention(store, new Date(NOW.getTime() + 24 * 3_600_000), ENV).cleared).toBe(1);
    store.close();
  });
});

describe("purgeMail", () => {
  it("clears every item's text and card, regardless of age, and empties the known-sender cache", () => {
    const store = RunStore.openInMemory();
    const n = seed(store, "fresh", 0);
    store.cacheSenderInSent("ann@example.com", true, NOW.toISOString());
    expect(purgeMail(store, NOW)).toEqual({ cleared: 1, stripped: 1 });
    expect(store.getMailItem("fresh")!.subject).toBeNull();
    expect(JSON.parse(payload(store, n).payload_json).text).toBe("📧 · action");
    expect(store.senderInSent("ann@example.com", "1970-01-01T00:00:00.000Z")).toBeUndefined();
    store.close();
  });
});

describe("/inbox replies in the outbox", () => {
  const reply = (store: RunStore, key: string, createdAt: string) => {
    const n = store.enqueueNotification({ topic: "reply", target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: key, correlation_id: "t",
      payload: { text: "📥 Inbox\n1. Ann · Secret subject", button_rows: [[{ text: "🔔 1", data: "mail:shp:mi_x" }]] } });
    if (n.status !== "queued") throw new Error("not queued");
    (store as any).db.prepare("UPDATE notification_outbox SET created_at = ? WHERE notification_id = ?").run(createdAt, n.record.notification_id);
    return n.record.notification_id;
  };
  it("retention strips /inbox replies older than the text window to a bare line with a new hash; younger ones and other replies stay", () => {
    const store = RunStore.openInMemory();
    const old = reply(store, "mail:inbox:u1:inbox", daysAgo(31));
    const young = reply(store, "mail:inbox:u2:inbox", daysAgo(2));
    const other = reply(store, "u3:reply", daysAgo(40));
    const before = payload(store, old).payload_hash;
    expect(runMailRetention(store, NOW, ENV).stripped).toBe(1);
    expect(JSON.parse(payload(store, old).payload_json)).toEqual({ text: "📧 /inbox page (cleared)", buttons: [] });
    expect(payload(store, old).payload_hash).not.toBe(before);
    expect(payload(store, young).payload_json).toContain("Secret subject");
    expect(payload(store, other).payload_json).toContain("Secret subject");
    store.close();
  });
  it("a subject containing (cleared) is still stripped; an already reduced reply is not counted twice", () => {
    const store = RunStore.openInMemory();
    const n = store.enqueueNotification({ topic: "reply", target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: "mail:inbox:u9:inbox",
      correlation_id: "t", payload: { text: "1. Ann · Invoice (cleared)" } });
    if (n.status !== "queued") throw new Error("not queued");
    expect(purgeMail(store, NOW).stripped).toBe(1);
    expect(payload(store, n.record.notification_id).payload_json).not.toContain("Invoice");
    expect(purgeMail(store, NOW).stripped).toBe(0);
    store.close();
  });
  it("purge strips every /inbox reply whatever its age", () => {
    const store = RunStore.openInMemory();
    const young = reply(store, "mail:inbox:u2:mail_page", daysAgo(0));
    expect(purgeMail(store, NOW).stripped).toBe(1);
    expect(payload(store, young).payload_json).not.toContain("Secret subject");
    store.close();
  });
});
