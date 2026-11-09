import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { stableHash } from "../../src/domain/canonical.js";
import { RunStore, type MailItemInsert } from "../../src/run/run-store.js";
import { chatIntent } from "../support/intents.js";

// SP2 mail triage spec §4: the five mail tables and the store methods the poller, /inbox and retention call.
const dirs: string[] = [];
const stores: RunStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* already closed */ } } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const open = () => { const s = RunStore.openInMemory(); stores.push(s); return s; };
const item = (n: number, p: Partial<MailItemInsert> = {}): MailItemInsert => ({
  item_id: `mi_${n}`, gmail_message_id: `gm_${n}`, gmail_thread_id: `th_${n}`, from_address: "a@example.com", from_name: "A",
  known_sender: false, labels: ["INBOX"], important: false, received_at: `2026-11-09T10:0${n}:00.000Z`, subject: "s", snippet: "n",
  lane: "inbox", kind: "fyi", reason_code: "jev_later", thread_followup: false, decision_id: null, notification_id: null,
  created_at: `2026-11-09T10:0${n}:30.000Z`, ...p
});

describe("mail store", () => {
  it("migration creates the five tables and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "mail-store-")); dirs.push(dir);
    const path = join(dir, "t.sqlite");
    RunStore.open(path).close();
    const s = RunStore.open(path); stores.push(s);
    const names = db(s).prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mail_%' ORDER BY name").all().map((r) => (r as { name: string }).name);
    expect(names).toEqual(["mail_items", "mail_labels", "mail_sender_rules", "mail_senders", "mail_state"]);
    expect((db(s).prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '2026-11-09-mail-triage'").get() as { n: number }).n).toBe(1);
  });
  it("insert then hasMailItem; a duplicate gmail_message_id throws; the row round-trips", () => {
    const s = open();
    expect(s.hasMailItem("gm_1")).toBe(false);
    s.insertMailItem(item(1, { known_sender: true, labels: ["INBOX", "IMPORTANT"], thread_followup: true }));
    expect(s.hasMailItem("gm_1")).toBe(true);
    expect(() => s.insertMailItem(item(2, { gmail_message_id: "gm_1" }))).toThrow();
    const row = s.getMailItem("mi_1");
    expect(row).toMatchObject({ known_sender: true, labels: ["INBOX", "IMPORTANT"], thread_followup: true, important: false, seen_at: null, text_cleared_at: null });
    expect(s.getMailItem("nope")).toBeUndefined();
  });
  it("CHECK constraints refuse a bad lane, kind and reason_code", () => {
    const s = open();
    expect(() => s.insertMailItem(item(1, { lane: "drop" as never }))).toThrow();
    expect(() => s.insertMailItem(item(2, { kind: "spam" as never }))).toThrow();
    expect(() => s.insertMailItem(item(3, { reason_code: "x" as never }))).toThrow();
    s.insertMailItem(item(4, { kind: null }));
    expect(s.getMailItem("mi_4")?.kind).toBeNull();
  });
  it("countMailPingsSince counts only pings at or after the cutoff", () => {
    const s = open();
    s.insertMailItem(item(1, { lane: "ping", created_at: "2026-11-09T09:00:00.000Z" }));
    s.insertMailItem(item(2, { lane: "ping", created_at: "2026-11-09T10:00:00.000Z" }));
    s.insertMailItem(item(3, { lane: "ping", created_at: "2026-11-09T11:00:00.000Z" }));
    s.insertMailItem(item(4, { lane: "inbox", created_at: "2026-11-09T11:00:00.000Z" }));
    expect(s.countMailPingsSince("2026-11-09T10:00:00.000Z")).toBe(2);
  });
  it("threadPingedSince is true only for a ping of that thread after the cutoff", () => {
    const s = open();
    s.insertMailItem(item(1, { gmail_thread_id: "T", lane: "ping", created_at: "2026-11-09T09:00:00.000Z" }));
    s.insertMailItem(item(2, { gmail_thread_id: "U", lane: "inbox", created_at: "2026-11-09T11:00:00.000Z" }));
    expect(s.threadPingedSince("T", "2026-11-09T08:00:00.000Z")).toBe(true);
    expect(s.threadPingedSince("T", "2026-11-09T09:30:00.000Z")).toBe(false);
    expect(s.threadPingedSince("U", "2026-11-09T08:00:00.000Z")).toBe(false);
  });
  it("listUnseenInbox is oldest first, limited, excludes pings and seen rows; markMailSeen drains it", () => {
    const s = open();
    s.insertMailItem(item(3)); s.insertMailItem(item(1)); s.insertMailItem(item(2)); s.insertMailItem(item(4, { lane: "ping" }));
    expect(s.countUnseenInbox()).toBe(3);
    expect(s.listUnseenInbox(2).map((r) => r.item_id)).toEqual(["mi_1", "mi_2"]);
    s.markMailSeen(["mi_1", "mi_2"], "2026-11-09T12:00:00.000Z");
    expect(s.listUnseenInbox(2).map((r) => r.item_id)).toEqual(["mi_3"]);
    expect(s.countUnseenInbox()).toBe(1);
    expect(s.getMailItem("mi_1")?.seen_at).toBe("2026-11-09T12:00:00.000Z");
  });
  it("listInboxSince returns inbox rows of any seen state, newest first, limited", () => {
    const s = open();
    s.insertMailItem(item(1)); s.insertMailItem(item(2)); s.insertMailItem(item(3)); s.insertMailItem(item(4, { lane: "ping" }));
    s.markMailSeen(["mi_2"], "2026-11-09T12:00:00.000Z");
    expect(s.listInboxSince("2026-11-09T10:02:00.000Z", 10).map((r) => r.item_id)).toEqual(["mi_3", "mi_2"]);
    expect(s.listInboxSince("2026-11-09T10:00:00.000Z", 1).map((r) => r.item_id)).toEqual(["mi_3"]);
  });
  it("upsertSenderRule replaces; deleteSenderRule returns the deleted rule", () => {
    const s = open();
    s.upsertSenderRule({ rule_id: "r1", address: "a@example.com", action: "always", source_item_id: "mi_1", created_at: "2026-11-09T10:00:00.000Z" });
    s.upsertSenderRule({ rule_id: "r2", address: "a@example.com", action: "never", source_item_id: null, created_at: "2026-11-09T10:01:00.000Z" });
    expect(s.senderRule("a@example.com")).toEqual({ rule_id: "r2", action: "never" });
    expect((db(s).prepare("SELECT COUNT(*) AS n FROM mail_sender_rules").get() as { n: number }).n).toBe(1);
    expect(s.deleteSenderRule("r2")).toEqual({ address: "a@example.com", action: "never" });
    expect(s.senderRule("a@example.com")).toBeUndefined();
    expect(s.deleteSenderRule("r2")).toBeUndefined();
  });
  it("insertMailLabel stores a label and refuses an unknown one", () => {
    const s = open();
    s.insertMailLabel({ label_id: "l1", item_id: "mi_1", label: "wrong_urgency", created_at: "2026-11-09T10:00:00.000Z" });
    expect(() => s.insertMailLabel({ label_id: "l2", item_id: "mi_1", label: "bad" as never, created_at: "2026-11-09T10:00:00.000Z" })).toThrow();
  });
  it("mailState is created disabled on first read; setMailState persists a patch", () => {
    const s = open();
    expect(s.mailState()).toEqual({ enabled: false, enabled_at: null, history_id: null, last_ok_at: null, last_error_code: null, failing_since: null, last_attempt_at: null, backoff_n: 0, retention_on: null });
    s.setMailState({ history_id: "123", enabled: true, enabled_at: "2026-11-09T10:00:00.000Z", backoff_n: 2, retention_on: "2026-11-09" });
    expect(s.mailState()).toMatchObject({ enabled: true, enabled_at: "2026-11-09T10:00:00.000Z", history_id: "123", backoff_n: 2, retention_on: "2026-11-09" });
    s.setMailState({ history_id: null });
    expect(s.mailState().history_id).toBeNull();
    expect(s.mailState().enabled).toBe(true);
  });
  it("senderInSent is undefined when stale, the cached value when fresh", () => {
    const s = open();
    expect(s.senderInSent("a@example.com", "2026-11-09T00:00:00.000Z")).toBeUndefined();
    s.cacheSenderInSent("a@example.com", true, "2026-11-09T10:00:00.000Z");
    expect(s.senderInSent("a@example.com", "2026-11-09T09:00:00.000Z")).toBe(true);
    expect(s.senderInSent("a@example.com", "2026-11-09T11:00:00.000Z")).toBeUndefined();
    s.cacheSenderInSent("a@example.com", false, "2026-11-09T12:00:00.000Z");
    expect(s.senderInSent("a@example.com", "2026-11-09T11:00:00.000Z")).toBe(false);
  });
  it("retention helpers: text-before, clear text, card ids, clear senders", () => {
    const s = open();
    s.insertMailItem(item(1, { notification_id: "notif_1" })); s.insertMailItem(item(2)); s.insertMailItem(item(3, { notification_id: "notif_3" }));
    expect(s.mailItemsTextBefore("2026-11-09T10:03:00.000Z").sort()).toEqual(["mi_1", "mi_2"]);
    expect(s.mailCardNotificationIds(["mi_1", "mi_2", "mi_3"]).sort()).toEqual(["notif_1", "notif_3"]);
    s.clearMailItemText(["mi_1"], "2026-11-09T12:00:00.000Z");
    expect(s.getMailItem("mi_1")).toMatchObject({ subject: null, snippet: null, from_name: null, text_cleared_at: "2026-11-09T12:00:00.000Z" });
    expect(s.mailItemsTextBefore("2026-11-09T10:03:00.000Z")).toEqual(["mi_2"]);
    s.cacheSenderInSent("a@example.com", true, "2026-11-09T10:00:00.000Z");
    s.clearMailSenders();
    expect(s.senderInSent("a@example.com", "2000-01-01T00:00:00.000Z")).toBeUndefined();
  });
  it("setMailItemNotification links a card", () => {
    const s = open();
    s.insertMailItem(item(1));
    s.setMailItemNotification("mi_1", "notif_x");
    expect(s.getMailItem("mi_1")?.notification_id).toBe("notif_x");
  });
  it("replaceNotificationPayload changes payload_json and recomputes payload_hash with stableHash", () => {
    const s = open();
    const r = s.enqueueNotification(chatIntent({ idempotency_key: "mail:1", payload: { text: "full card text" } }));
    if (r.status !== "queued") throw new Error(`unexpected ${r.status}`);
    const id = r.record.notification_id;
    const next = { text: "📧 · fyi" };
    s.replaceNotificationPayload(id, next);
    const row = db(s).prepare("SELECT payload_json, payload_hash FROM notification_outbox WHERE notification_id = ?").get(id) as { payload_json: string; payload_hash: string };
    expect(JSON.parse(row.payload_json)).toEqual(next);
    expect(row.payload_hash).toBe(stableHash(next));
  });
  it("countMailDecisionRungs counts mail.triage decisions by rung since the cutoff", () => {
    const s = open();
    const ins = db(s).prepare(`INSERT INTO decisions (decision_id, entry_id, entry_version, stage, rung, verdict, armed_mode, latency_ms, created_at) VALUES (?, ?, 1, 'inbound', ?, 'v', 'on', 1, ?)`);
    ins.run("d1", "mail.triage", "fail", "2026-11-09T10:00:00.000Z");
    ins.run("d2", "mail.triage", "system_one", "2026-11-09T10:01:00.000Z");
    ins.run("d3", "mail.triage", "system_one", "2026-11-09T10:02:00.000Z");
    ins.run("d4", "mail.triage", "rule", "2026-11-09T10:03:00.000Z");
    ins.run("d5", "other.entry", "fail", "2026-11-09T10:04:00.000Z");
    ins.run("d6", "mail.triage", "fail", "2026-11-09T08:00:00.000Z");
    expect(s.countMailDecisionRungs("2026-11-09T09:00:00.000Z")).toEqual({ fail: 1, system_one: 2 });
  });
});
