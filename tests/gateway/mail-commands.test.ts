import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TelegramAllowlist, TypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { TAP_FAILED_TEXT } from "../../src/gateway/improvement-commands.js";
import { handleMailTap } from "../../src/gateway/mail-commands.js";
import type { GmailMetadata } from "../../src/mail/envelope.js";
import { applySenderRule, maskAddress, undoSenderRule } from "../../src/mail/inbox.js";
import { triageOne } from "../../src/mail/triage.js";
import { RunStore, type MailItemInsert } from "../../src/run/run-store.js";
import { isSelfWriteActionEvent, normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec 2026-11-09 §3.6 + Rev 1.1: /inbox shows the REMAINING unseen items 30 at a time (a "next" tap never skips or repeats),
// the taps write labels and sender rules (each with a masked /changes line), /mail on|off is the stored switch (off drops the
// cached token, on clears a poller paused on auth), and every reply is code-owned. Synthetic mail only.
const NOW = "2026-11-09T02:00:00.000Z";
const allowlist: TelegramAllowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
let upd = 100;
const msg = (text: string): TypedTaskEvent => {
  const n = normalizeTelegramUpdate({ update_id: ++upd, message: { message_id: upd, text, from: { id: 111 }, chat: { id: 222 } } }, allowlist);
  if (!n.ok || isSelfWriteActionEvent(n.event)) throw new Error("expected a task event");
  return n.event;
};
const tapOf = (data: string): TypedTaskEvent => {
  const n = normalizeTelegramUpdate({ update_id: ++upd, callback_query: { id: `cbq_${upd}`, from: { id: 111 }, message: { message_id: 5, chat: { id: 222 } }, data } }, allowlist);
  if (!n.ok || isSelfWriteActionEvent(n.event)) throw new Error("expected a task event");
  return n.event;
};

function seed(store: RunStore, id: string, o: Partial<MailItemInsert> & { n?: number } = {}): string {
  const item_id = `mi_${id}`;
  const at = new Date(Date.parse(NOW) - 3_600_000 + (o.n ?? 0) * 1000).toISOString();
  store.insertMailItem({ item_id, gmail_message_id: `g-${id}`, gmail_thread_id: `t-${id}`, from_address: "ann@example.com", from_name: "Ann", known_sender: false, labels: [],
    important: false, received_at: at, subject: `Subject ${id}`, snippet: "snip", lane: "inbox", kind: "fyi", reason_code: "jev_later", thread_followup: false,
    decision_id: null, notification_id: null, created_at: at, ...o });
  return item_id;
}
const uuidIds = (n: number): string[] => Array.from({ length: n }, () => randomUUID());
const out = (s: RunStore) => [...drainOutbox(s).entries()];
const lastText = (s: RunStore): string => String(out(s).at(-1)?.[1].text ?? "");
const changeLog = (s: RunStore): string[] => s.listChangeLog("1970-01-01T00:00:00.000Z", 50).map((r) => r.text);

describe("/inbox", () => {
  it("lists only unseen inbox items grouped by kind, oldest first, and a second /inbox shows the next unseen", () => {
    const s = RunStore.openInMemory();
    const ids = uuidIds(2);
    const a = seed(s, ids[0]!, { n: 1, kind: "fyi", subject: "Plain note" });
    seed(s, ids[1]!, { n: 2, kind: "risk", subject: "Security alert" });
    seed(s, randomUUID(), { lane: "ping", subject: "Pinged already" });
    s.markMailSeen([seed(s, randomUUID(), { n: 3, subject: "Seen one" })], NOW);
    const g = new Gateway(s);
    expect(g.intake(msg("/inbox"), NOW)).toMatchObject({ ok: true, status: "inbox_returned" });
    const first = out(s)[0]![1];
    const text = String(first.text);
    expect(text.indexOf("Security alert")).toBeGreaterThan(-1);
    expect(text.indexOf("Security alert")).toBeLessThan(text.indexOf("Plain note")); // risk before fyi
    expect(text).not.toContain("Pinged already");
    expect(text).not.toContain("Seen one");
    expect(s.getMailItem(a)!.seen_at).not.toBeNull();
    g.intake(msg("/inbox"), NOW);
    expect(lastText(s)).toContain("Nothing unseen");
    s.close();
  });

  it("70 unseen items: /inbox then two next taps show every item exactly once, none skipped", () => {
    const s = RunStore.openInMemory();
    const ids = uuidIds(70).map((u, i) => seed(s, u, { n: i, subject: `Item number ${String(i).padStart(2, "0")}` }));
    const g = new Gateway(s);
    const shownTexts: string[] = [];
    const take = (ev: TypedTaskEvent) => { g.intake(ev, NOW); const [, p] = out(s).at(-1)!; shownTexts.push(String(p.text)); return p; };
    let p = take(msg("/inbox"));
    for (let page = 2; page <= 3; page += 1) {
      const next = (p.button_rows as Array<Array<{ data: string }>>).flat().find((b) => b.data.startsWith("mail:page:"));
      expect(next?.data).toBe(`mail:page:${page}`);
      p = take(tapOf(next!.data));
    }
    expect((p.button_rows as Array<Array<{ data: string }>>).flat().some((b) => b.data.startsWith("mail:page:"))).toBe(false); // last page
    const all = shownTexts.join("\n");
    for (let i = 0; i < 70; i += 1) expect(all.match(new RegExp(`Item number ${String(i).padStart(2, "0")}\\b`, "g")), `item ${i}`).toHaveLength(1);
    expect(ids.every((id) => s.getMailItem(id)!.seen_at !== null)).toBe(true);
    expect(shownTexts.map((t) => (t.match(/Item number/g) ?? []).length)).toEqual([30, 30, 10]);
    s.close();
  });

  it("a replayed update replies once and a re-tapped page label skips nothing", () => {
    const s = RunStore.openInMemory();
    for (let i = 0; i < 35; i += 1) seed(s, randomUUID(), { n: i, subject: `S${i}` });
    const g = new Gateway(s);
    const ev = msg("/inbox");
    g.intake(ev, NOW); g.intake(ev, NOW);
    expect(out(s)).toHaveLength(1);
    const again = tapOf("mail:page:9"); // any label: still "the remaining unseen"
    g.intake(again, NOW);
    expect((String(out(s)[0]![1].text).match(/^\d+\. /gm) ?? [])).toHaveLength(5);
    s.close();
  });

  it("/inbox all lists the last 7 days seen or not, caps at 50 lines and says how many more, and marks nothing seen", () => {
    const s = RunStore.openInMemory();
    const ids = uuidIds(60).map((u, i) => seed(s, u, { n: i, subject: `Row ${i}` }));
    s.markMailSeen(ids.slice(-3), NOW); // the newest three, which /inbox all lists first
    seed(s, randomUUID(), { subject: "Too old", received_at: "2026-10-01T00:00:00.000Z" });
    new Gateway(s).intake(msg("/inbox all"), NOW);
    const text = lastText(s);
    expect((text.match(/^\d+\. /gm) ?? []).length).toBeLessThanOrEqual(50);
    expect(text).toMatch(/…and \d+ more/);
    expect(text).not.toContain("Too old");
    expect(text).toContain("Row 59"); // a seen row is still listed
    expect(ids.slice(0, -3).every((id) => s.getMailItem(id)!.seen_at === null)).toBe(true);
    s.close();
  });

  it("a row past retention renders sender · date · kind and no subject", () => {
    const s = RunStore.openInMemory();
    const id = seed(s, randomUUID(), { kind: "action" });
    s.clearMailItemText([id], NOW);
    new Gateway(s).intake(msg("/inbox"), NOW);
    expect(lastText(s)).toMatch(/1\. `ann@example\.com` · \d\d-\d\d \d\d:\d\d · action/);
    s.close();
  });
});

describe("/mail", () => {
  it("on refuses, and the switch stays off, when HOUGE_PACO_GMAIL_ADDRESS is unset or invalid", () => {
    const s = RunStore.openInMemory();
    const g = new Gateway(s);
    for (const bad of [undefined, "not-an-address"]) {
      vi.stubEnv("HOUGE_PACO_GMAIL_ADDRESS", bad as string);
      if (bad === undefined) vi.stubEnv("HOUGE_PACO_GMAIL_ADDRESS", "");
      g.intake(msg("/mail on"), NOW);
      expect(s.mailState().enabled).toBe(false);
      expect(lastText(s)).toContain("stays off");
    }
    vi.unstubAllEnvs();
    s.close();
  });
  it("on sets the switch and enabled_at and clears a stored auth pause; off disables and calls onMailOff", () => {
    const s = RunStore.openInMemory();
    s.setMailState({ last_error_code: "auth", failing_since: "2026-11-08T00:00:00.000Z", backoff_n: 4 });
    const onMailOff = vi.fn();
    vi.stubEnv("HOUGE_PACO_GMAIL_ADDRESS", "paco@example.com");
    const g = new Gateway(s, undefined, undefined, undefined, { onMailOff });
    g.intake(msg("/mail on"), NOW);
    vi.unstubAllEnvs();
    expect(s.mailState()).toMatchObject({ enabled: true, enabled_at: NOW, last_error_code: null, failing_since: null, backoff_n: 0 });
    expect(onMailOff).not.toHaveBeenCalled();
    g.intake(msg("/mail off"), "2026-11-09T03:00:00.000Z");
    expect(s.mailState().enabled).toBe(false);
    expect(onMailOff).toHaveBeenCalledTimes(1);
    s.close();
  });
  it("a throwing onMailOff still switches off and replies", () => {
    const s = RunStore.openInMemory();
    s.setMailState({ enabled: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    new Gateway(s, undefined, undefined, undefined, { onMailOff: () => { throw new Error("boom with user@example.com"); } }).intake(msg("/mail off"), NOW);
    expect(s.mailState().enabled).toBe(false);
    expect(out(s)).toHaveLength(1);
    expect(spy.mock.calls.flat().join(" ")).not.toContain("example.com");
    spy.mockRestore();
    s.close();
  });
  it("status reports counts and the Jev state, with no mail text", () => {
    const s = RunStore.openInMemory();
    seed(s, randomUUID(), { subject: "Secret subject" });
    new Gateway(s).intake(msg("/mail"), NOW);
    const text = lastText(s);
    expect(text).toContain("Mail");
    expect(text).toContain("1 unseen");
    expect(text).toContain("Jev: ok");
    expect(text).not.toContain("Secret subject");
    s.close();
  });
});

describe("faults and flips", () => {
  it("a fault while rendering /inbox or a page tap replies the failed-tap text, not silence", () => {
    const s = RunStore.openInMemory();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(s, "listUnseenInbox").mockImplementation(() => { throw new Error("db fault ann@example.com"); });
    const g = new Gateway(s);
    g.intake(msg("/inbox"), NOW);
    expect(lastText(s)).toBe(TAP_FAILED_TEXT);
    g.intake(tapOf("mail:page:2"), NOW);
    expect(lastText(s)).toBe(TAP_FAILED_TEXT);
    expect(spy.mock.calls.flat().join(" ")).not.toContain("example.com");
    spy.mockRestore();
    s.close();
  });
  it("an unknown tap action never makes a rule", () => {
    const s = RunStore.openInMemory();
    const id = seed(s, randomUUID());
    const ev = { ...tapOf(`mail:shp:${id}`), metadata: { mail_action: "bogus", item_id: id } } as TypedTaskEvent;
    handleMailTap(s, ev, new Date(NOW));
    expect(lastText(s)).toBe(TAP_FAILED_TEXT);
    expect(s.senderRule("ann@example.com")).toBeUndefined();
    s.close();
  });
  it("never then always on one sender keeps the rule id, so the first undo command still works", () => {
    const s = RunStore.openInMemory();
    const id = seed(s, randomUUID());
    const a = applySenderRule(s, id, "never", new Date(NOW));
    const b = applySenderRule(s, id, "always", new Date(NOW));
    if (!a.ok || !b.ok) throw new Error("rule");
    expect(b.rule_id).toBe(a.rule_id);
    expect(s.senderRule("ann@example.com")).toEqual({ rule_id: a.rule_id, action: "always" });
    expect(changeLog(s)).toHaveLength(2);
    expect(undoSenderRule(s, a.rule_id, new Date(NOW))).toBe(true);
    s.close();
  });
});

describe("taps and sender rules", () => {
  const meta = (id: string): GmailMetadata => ({ id, threadId: `t-${id}`, snippet: "s", labelIds: ["INBOX"], internalDate: String(Date.parse(NOW) - 60_000),
    payload: { headers: [{ name: "From", value: "Ann <ann@example.com>" }, { name: "Subject", value: "Hello" }] } });

  it("wu writes a label and offers never/always; never writes the rule, a masked /changes line and the next triage lists the sender", async () => {
    const s = RunStore.openInMemory();
    const id = seed(s, randomUUID(), { lane: "ping" });
    const g = new Gateway(s);
    g.intake(tapOf(`mail:wu:${id}`), NOW);
    const offer = out(s)[0]![1];
    expect((offer.buttons as Array<{ data: string }>).map((b) => b.data)).toEqual([`mail:never:${id}`, `mail:always:${id}`]);
    expect((s as any).db.prepare("SELECT label FROM mail_labels WHERE item_id = ?").all(id)).toEqual([{ label: "wrong_urgency" }]);
    g.intake(tapOf(`mail:never:${id}`), NOW);
    const rule = s.senderRule("ann@example.com")!;
    expect(rule).toMatchObject({ action: "never" });
    expect(rule.rule_id).toMatch(/^mr_[0-9a-f-]{36}$/);
    const log = changeLog(s);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain(rule.rule_id);
    expect(log[0]).toContain("a***@example.com");
    expect(log[0]).not.toContain("ann@");
    expect(log[0]).toContain(`/mail_undo ${rule.rule_id}`);
    expect(lastText(s)).toContain("a***@example.com");
    const res = await triageOne({ store: s, chatId: "222", pacoAddress: "paco@example.com", env: {}, now: () => new Date(NOW), brokerRedact: (x) => x,
      ask: async () => { throw new Error("floors never call Jev"); } }, meta("later"), { known_sender: true, backfill: false });
    expect(res).toMatchObject({ lane: "inbox", reason: "rule_never" });
    s.close();
  });

  it("/mail_undo removes the rule and logs it; a second undo says there is none", () => {
    const s = RunStore.openInMemory();
    const id = seed(s, randomUUID());
    const r = applySenderRule(s, id, "always", new Date(NOW));
    if (!r.ok) throw new Error("rule");
    const g = new Gateway(s);
    g.intake(msg(`/mail_undo ${r.rule_id}`), NOW);
    expect(s.senderRule("ann@example.com")).toBeUndefined();
    expect(changeLog(s).filter((l) => l.includes("removed"))).toHaveLength(1);
    expect(changeLog(s).join("\n")).not.toContain("ann@");
    g.intake(msg(`/mail_undo ${r.rule_id}`), NOW);
    expect(lastText(s)).toContain("No such rule");
    s.close();
  });

  it("shp writes should_have_pinged and offers only always", () => {
    const s = RunStore.openInMemory();
    const id = seed(s, randomUUID());
    new Gateway(s).intake(tapOf(`mail:shp:${id}`), NOW);
    expect((out(s)[0]![1].buttons as Array<{ data: string }>).map((b) => b.data)).toEqual([`mail:always:${id}`]);
    expect((s as any).db.prepare("SELECT label FROM mail_labels WHERE item_id = ?").all(id)).toEqual([{ label: "should_have_pinged" }]);
    s.close();
  });

  it("a sender with an invalid address gets no rule and the reply says so; an unknown item says it is gone", () => {
    const s = RunStore.openInMemory();
    const id = seed(s, randomUUID(), { from_address: "invalid", from_name: null });
    const g = new Gateway(s);
    g.intake(tapOf(`mail:never:${id}`), NOW);
    expect(lastText(s)).toContain("Can't make a rule for this sender");
    expect((s as any).db.prepare("SELECT COUNT(*) AS n FROM mail_sender_rules").get()).toEqual({ n: 0 });
    expect(changeLog(s)).toHaveLength(0);
    g.intake(tapOf(`mail:never:mi_${randomUUID()}`), NOW);
    expect(lastText(s)).toContain("no longer tracked");
    s.close();
  });

  it("the same rule tapped twice (two callbacks) makes one rule and one /changes line", () => {
    const s = RunStore.openInMemory();
    const id = seed(s, randomUUID());
    const g = new Gateway(s);
    g.intake(tapOf(`mail:never:${id}`), NOW);
    g.intake(tapOf(`mail:never:${id}`), NOW);
    expect(changeLog(s)).toHaveLength(1);
    s.close();
  });

  it("taps are exempt from the per-chat command rate limit", () => {
    const s = RunStore.openInMemory();
    const id = seed(s, randomUUID());
    const g = new Gateway(s);
    for (let i = 0; i < 12; i += 1) expect(g.intake(tapOf(`mail:shp:${id}`), NOW)).toMatchObject({ ok: true, status: "mail_tapped" });
    s.close();
  });
});

describe("maskAddress", () => {
  it("is the first character, three stars and the domain; a non-address is never echoed", () => {
    expect(maskAddress("ann@example.com")).toBe("a***@example.com");
    expect(maskAddress("invalid")).toBe("***");
  });
});

