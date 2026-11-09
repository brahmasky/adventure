import { describe, expect, it } from "vitest";
import { foldCardPayload, inQuietHours, mailCardPayload, openUrl } from "../../src/mail/card.js";
import type { MailItemRow } from "../../src/run/run-store.js";

const ID = "mi_123e4567-e89b-12d3-a456-426614174000";
function item(over: Partial<MailItemRow> = {}): MailItemRow {
  return { item_id: ID, gmail_message_id: "m1", gmail_thread_id: "t1", from_address: "ann@example.com", from_name: "Ann", known_sender: true,
    labels: [], important: false, received_at: "2026-11-09T00:00:00.000Z", subject: "Invoice due", snippet: "SECRET-SNIPPET", lane: "ping", kind: "action",
    reason_code: "jev_now", thread_followup: false, decision_id: null, notification_id: null, created_at: "2026-11-09T00:00:00.000Z", seen_at: null, text_cleared_at: null, ...over } as MailItemRow;
}
const card = (over: Partial<MailItemRow> = {}, o: { quiet?: boolean; jevUnavailable?: boolean } = {}) =>
  mailCardPayload({ item: item(over), pacoAddress: "paco@example.com", quiet: o.quiet ?? false, jevUnavailable: o.jevUnavailable ?? false });

describe("mailCardPayload", () => {
  it("renders name, kind and subject, never the snippet", () => {
    const c = card();
    expect(c.text).toBe("📧 Ann · action\nInvoice due");
    expect(c.text).not.toContain("SECRET");
    expect(c.silent).toBe(false);
  });
  it("falls back to mail / (no subject) / Jev unavailable line", () => {
    expect(card({ kind: null, subject: null }, { jevUnavailable: true }).text).toBe("📧 Ann · mail\n(no subject)\n(Jev unavailable)");
  });
  it("escapes markdown in untrusted name and subject", () => {
    expect(card({ from_name: "A*[x](y)", subject: "`b`_" }).text).toBe("📧 Axy · action\nb");
  });
  it("marks a thread follow-up and sends it silent", () => {
    const c = card({ thread_followup: true });
    expect(c.text.startsWith("↪ +1 in this thread · Ann")).toBe(true);
    expect(c.silent).toBe(true);
  });
  it("is silent when quiet", () => expect(card({}, { quiet: true }).silent).toBe(true));
  it("has an Open URL row and a Wrong urgency callback row within 64 bytes", () => {
    const rows = card().button_rows!;
    expect(rows[0]).toEqual([{ text: "Open", url: "https://mail.google.com/mail/u/?authuser=paco%40example.com#inbox/t1" }]);
    expect(rows[1]).toEqual([{ text: "Wrong urgency", data: `mail:wu:${ID}` }]);
    for (const fam of ["wu", "never", "always", "shp"]) expect(Buffer.byteLength(`mail:${fam}:${ID}`)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength("mail:page:9999")).toBeLessThanOrEqual(64);
  });
  it("falls back to the address when the name is null", () => expect(card({ from_name: null }).text.startsWith("📧 ann@example.com")).toBe(true));
});

describe("openUrl / foldCardPayload", () => {
  it("encodes the account", () => expect(openUrl("a+b@example.com", "T")).toBe("https://mail.google.com/mail/u/?authuser=a%2Bb%40example.com#inbox/T"));
  it("fold card is silent text only", () => expect(foldCardPayload()).toEqual({ text: "More urgent mail this hour — see /inbox", silent: true }));
});

describe("inQuietHours (Sydney AEDT = UTC+11)", () => {
  const w = { start: 23, end: 7 };
  const at = (utc: string) => inQuietHours(new Date(utc), w, "Australia/Sydney");
  it("true at 23:30 and 06:59", () => { expect(at("2026-11-09T12:30:00Z")).toBe(true); expect(at("2026-11-08T19:59:00Z")).toBe(true); });
  it("false at 07:00 and 22:59", () => { expect(at("2026-11-08T20:00:00Z")).toBe(false); expect(at("2026-11-09T11:59:00Z")).toBe(false); });
});
