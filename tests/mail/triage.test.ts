import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailAsk } from "../../src/jev/mail-ask.js";
import type { GmailMetadata } from "../../src/mail/envelope.js";
import { triageOne, type TriageDeps } from "../../src/mail/triage.js";
import { RunStore, type MailItemRow } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec 2026-11-09 §3.4 write path: one Jev call before any write, then ONE transaction that stores the item, its decision row
// (strict flush) and, for a ping, its card. Nothing of an item is ever half-stored: a failed decision insert or a failed enqueue
// rolls the item back and the next tick retries it. §3.4 fold and thread rules are code, after the verdict. §9: no sender or
// subject ever reaches `decisions` or `change_log`.
const NOW = new Date("2026-11-09T02:00:00.000Z"); // 13:00 Sydney: not quiet hours
const QUIET_NOW = new Date("2026-11-09T13:30:00.000Z"); // 00:30 Sydney
const EPOCH = "1970-01-01T00:00:00.000Z";
const choice = (c: string, p: number) => ({ type: "choice" as const, choice: c, probabilities: { [c]: p }, confidence: p });
const answer = (c: "now" | "later", p: number, kind = "action"): MailAsk => ({ urgency: choice(c, p), kind: choice(kind, 0.9), model: "jev-1.14.0" });
const DOWN: MailAsk = { failed: "outage", reason: "error" };

function meta(id: string, o: { thread?: string; from?: string; subject?: string; snippet?: string } = {}): GmailMetadata {
  return { id, threadId: o.thread ?? `t-${id}`, snippet: o.snippet ?? "snippet text", labelIds: ["INBOX"], internalDate: String(NOW.getTime() - 60_000),
    payload: { headers: [{ name: "From", value: o.from ?? "Ann <ann@example.com>" }, { name: "Subject", value: o.subject ?? "Invoice due" }] } };
}
function deps(store: RunStore, ask: MailAsk | TriageDeps["ask"], now = NOW): TriageDeps {
  return { store, chatId: "555", pacoAddress: "paco@example.com", env: { HOUGE_TELEGRAM_CHAT_ID: "555" }, now: () => now, brokerRedact: (s) => s,
    ask: typeof ask === "function" ? ask : async () => ask };
}
const items = (store: RunStore): MailItemRow[] => (store as any).db.prepare("SELECT item_id, lane, reason_code, kind, thread_followup, decision_id, notification_id, gmail_thread_id FROM mail_items ORDER BY gmail_message_id").all();
const decisions = (store: RunStore) => store.listDecisionsBetween(EPOCH, "2999-01-01T00:00:00.000Z");
const open = (store: RunStore) => store.listOpenIncidents().map((i) => [i.kind, i.subject]);
const changeLog = (store: RunStore) => store.listChangeLog(EPOCH, 50).map((r) => r.text);
const ping = (store: RunStore, id: string, o: { thread?: string } = {}) => triageOne(deps(store, answer("now", 0.9)), meta(id, o), { known_sender: true, backfill: false });

afterEach(() => vi.restoreAllMocks());

describe("triageOne: lanes and rows", () => {
  it("Jev now 0.9 → one ping row, one decision row (entry, tool_call_id = item id, run_id null), one card keyed mail:<gmail id>", async () => {
    const store = RunStore.openInMemory();
    expect(await ping(store, "m1")).toEqual({ stored: true, lane: "ping", reason: "jev_now", notified: true });
    const [row] = items(store);
    expect(row).toMatchObject({ lane: "ping", reason_code: "jev_now", kind: "action", thread_followup: 0 });
    const [d] = decisions(store);
    expect(decisions(store)).toHaveLength(1);
    expect(d).toMatchObject({ entry_id: "mail.triage", tool_call_id: row!.item_id, run_id: null, rung: "system_one", verdict: "ping", reason_code: "jev_now", p: 0.9 });
    expect(row!.decision_id).toBe(d!.decision_id);
    const out = drainOutbox(store);
    expect([...out.keys()]).toEqual(["mail:m1"]);
    expect(out.get("mail:m1")).toMatchObject({ silent: false });
    expect(String(out.get("mail:m1")!.text)).toContain("Invoice due");
    expect(row!.notification_id).toMatch(/^ntf_|^[a-z]+_/);
    store.close();
  });
  it("Jev later 0.9 → inbox, no card, decision row present", async () => {
    const store = RunStore.openInMemory();
    expect(await triageOne(deps(store, answer("later", 0.9)), meta("m1"), { known_sender: false, backfill: false })).toEqual({ stored: true, lane: "inbox", reason: "jev_later", notified: false });
    expect(items(store)[0]).toMatchObject({ lane: "inbox", reason_code: "jev_later" });
    expect(decisions(store)).toHaveLength(1);
    expect(drainOutbox(store).size).toBe(0);
    store.close();
  });
  it("Jev down → ping with reason jev_unavailable, rung fail, and the card says so", async () => {
    const store = RunStore.openInMemory();
    expect(await triageOne(deps(store, DOWN), meta("m1"), { known_sender: false, backfill: false })).toMatchObject({ stored: true, lane: "ping", reason: "jev_unavailable" });
    expect(items(store)[0]).toMatchObject({ lane: "ping", reason_code: "jev_unavailable", kind: null });
    expect(decisions(store)[0]).toMatchObject({ rung: "fail", fallback_rung: "system_one", fallback_reason: "outage", verdict: "ping" });
    expect(String(drainOutbox(store).get("mail:m1")!.text)).toContain("(Jev unavailable)");
    store.close();
  });
  it("floors never call Jev: an always rule pings, a never rule and backfill list", async () => {
    const store = RunStore.openInMemory();
    const ask = vi.fn(async () => answer("now", 0.9));
    store.upsertSenderRule({ rule_id: "r1", address: "ann@example.com", action: "always", source_item_id: null, created_at: NOW.toISOString() });
    expect(await triageOne(deps(store, ask), meta("m1"), { known_sender: true, backfill: true })).toMatchObject({ lane: "ping", reason: "rule_always" });
    store.upsertSenderRule({ rule_id: "r1", address: "ann@example.com", action: "never", source_item_id: null, created_at: NOW.toISOString() });
    expect(await triageOne(deps(store, ask), meta("m2"), { known_sender: true, backfill: false })).toMatchObject({ lane: "inbox", reason: "rule_never" });
    expect(await triageOne(deps(store, ask), meta("m3", { from: "bob@example.com" }), { known_sender: false, backfill: true })).toMatchObject({ lane: "inbox", reason: "backfill" });
    expect(ask).not.toHaveBeenCalled();
    expect(decisions(store)).toHaveLength(3);
    store.close();
  });
  it("a card in quiet hours is silent", async () => {
    const store = RunStore.openInMemory();
    await triageOne(deps(store, answer("now", 0.9), QUIET_NOW), meta("m1"), { known_sender: true, backfill: false });
    expect(drainOutbox(store).get("mail:m1")).toMatchObject({ silent: true });
    store.close();
  });
});

describe("triageOne: fold and thread (spec §3.4)", () => {
  it("6 pings in the hour → the 7th is inbox/folded with one fold card; the 8th folds too and the fold card stays one", async () => {
    const store = RunStore.openInMemory();
    for (let n = 1; n <= 6; n += 1) expect(await ping(store, `m${n}`)).toMatchObject({ lane: "ping" });
    const enqueue = vi.spyOn(store, "enqueueNotification");
    expect(await ping(store, "m7")).toEqual({ stored: true, lane: "inbox", reason: "folded", notified: false });
    expect(await ping(store, "m8")).toMatchObject({ lane: "inbox", reason: "folded" });
    const folds = enqueue.mock.calls.map((c, i) => [c[0]!.idempotency_key, (enqueue.mock.results[i]!.value as { status: string }).status]).filter(([k]) => k!.startsWith("mail:fold:"));
    expect(folds).toEqual([["mail:fold:2026-11-09T02", "queued"], ["mail:fold:2026-11-09T02", "duplicate"]]); // the 8th DID enqueue, and the outbox folded it
    const keys = [...drainOutbox(store).keys()];
    expect(keys.filter((k) => k.startsWith("mail:fold:"))).toEqual(["mail:fold:2026-11-09T02"]);
    expect(keys.filter((k) => /^mail:m\d$/.test(k))).toHaveLength(6);
    expect(items(store).filter((r) => r.reason_code === "folded")).toHaveLength(2);
    expect(decisions(store)).toHaveLength(8);
    store.close();
  });
  it("the fold card's payload is fixed per hour bucket (quiet read at the bucket start) and a conflict on its key never rolls a folded item back (codex B2)", async () => {
    const store = RunStore.openInMemory();
    // 12:xx UTC = 23:xx Sydney: quiet from 23:00. Six pings fill the fold; two folds in the same UTC-hour bucket, the second with HOUGE_MAIL_QUIET moved so quietNow(now) flips
    const t = (iso: string) => new Date(iso);
    const d = (now: Date, env: Record<string, string> = {}) => ({ ...deps(store, answer("now", 0.9), now), env: { HOUGE_TELEGRAM_CHAT_ID: "555", ...env } });
    for (let n = 1; n <= 6; n += 1) await triageOne(d(t("2026-11-09T12:10:00.000Z")), meta(`m${n}`), { known_sender: true, backfill: false });
    expect(await triageOne(d(t("2026-11-09T12:20:00.000Z"), { HOUGE_MAIL_QUIET: "23-7" }), meta("m7"), { known_sender: true, backfill: false })).toMatchObject({ lane: "inbox", reason: "folded" });
    expect(await triageOne(d(t("2026-11-09T12:50:00.000Z"), { HOUGE_MAIL_QUIET: "1-2" }), meta("m8"), { known_sender: true, backfill: false })).toMatchObject({ lane: "inbox", reason: "folded" });
    expect(items(store).filter((r) => r.reason_code === "folded")).toHaveLength(2);
    const spy = vi.spyOn(store, "enqueueNotification").mockReturnValue({ status: "conflict", error: "NOTIFICATION_IDEMPOTENCY_CONFLICT" });
    expect(await triageOne(d(t("2026-11-09T12:55:00.000Z")), meta("m9"), { known_sender: true, backfill: false })).toEqual({ stored: true, lane: "inbox", reason: "folded", notified: false });
    spy.mockRestore();
    expect(items(store).filter((r) => r.reason_code === "folded")).toHaveLength(3);
    const folds = [...drainOutbox(store).entries()].filter(([k]) => k.startsWith("mail:fold:"));
    expect(folds).toEqual([["mail:fold:2026-11-09T12", { text: "More urgent mail this hour — see /inbox", silent: true }]]);
    store.close();
  });
  it("a pinged thread's next ping is stored thread_followup = 1 with a silent ↪ card", async () => {
    const store = RunStore.openInMemory();
    await ping(store, "m1", { thread: "T" });
    expect(await ping(store, "m2", { thread: "T" })).toMatchObject({ lane: "ping", notified: true });
    expect(items(store).map((r) => r.thread_followup)).toEqual([0, 1]);
    const card = drainOutbox(store).get("mail:m2")!;
    expect(card.silent).toBe(true);
    expect(String(card.text).startsWith("↪ +1 in this thread")).toBe(true);
    store.close();
  });
});

describe("triageOne: thread race", () => {
  it("two mails of one thread decided together: the second to commit is the silent follow-up (one sound per thread per 6 h)", async () => {
    const store = RunStore.openInMemory();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const ask: TriageDeps["ask"] = async () => { await gate; return answer("now", 0.9); };
    const both = Promise.all([triageOne(deps(store, ask), meta("m1", { thread: "T" }), { known_sender: true, backfill: false }),
      triageOne(deps(store, ask), meta("m2", { thread: "T" }), { known_sender: true, backfill: false })]);
    release();
    expect((await both).map((r) => r.stored && r.lane)).toEqual(["ping", "ping"]);
    expect(items(store).map((r) => r.thread_followup).sort()).toEqual([0, 1]);
    expect([...drainOutbox(store).values()].filter((p) => p.silent === true)).toHaveLength(1);
    store.close();
  });
});

describe("triageOne: one transaction (spec §3.4, §7)", () => {
  it("a failing insertDecision rolls the item back, opens decision_record_failed once; the retry pings once and resolves it", async () => {
    const store = RunStore.openInMemory();
    const spy = vi.spyOn(store, "insertDecision").mockImplementation(() => { throw new Error("SQLITE_FULL"); });
    expect(await ping(store, "m1")).toEqual({ stored: false, error: "decision" });
    expect(items(store)).toEqual([]);
    expect(drainOutbox(store).size).toBe(0);
    expect(open(store)).toEqual([["decision_record_failed", "mail.triage"]]);
    spy.mockRestore();
    expect(await ping(store, "m1")).toMatchObject({ stored: true, lane: "ping" });
    expect(items(store)).toHaveLength(1);
    expect([...drainOutbox(store).keys()]).toEqual(["mail:m1"]);
    expect(open(store)).toEqual([]);
    store.close();
  });
  it("a crash on the enqueue after Jev answered stores nothing (no item, no decision); the retry stores once", async () => {
    const store = RunStore.openInMemory();
    const ask = vi.fn(async () => answer("now", 0.9));
    const spy = vi.spyOn(store, "enqueueNotification").mockImplementation(() => { throw new Error("disk gone"); });
    expect(await triageOne(deps(store, ask), meta("m1"), { known_sender: true, backfill: false })).toEqual({ stored: false, error: "write" });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(items(store)).toEqual([]);
    expect(decisions(store)).toEqual([]);
    expect(open(store)).toEqual([]);
    spy.mockRestore();
    expect(await triageOne(deps(store, ask), meta("m1"), { known_sender: true, backfill: false })).toMatchObject({ stored: true });
    expect(items(store)).toHaveLength(1);
    expect(decisions(store)).toHaveLength(1);
    store.close();
  });
  it("a conflict from the outbox rolls the item back (Rev 1.1)", async () => {
    const store = RunStore.openInMemory();
    vi.spyOn(store, "enqueueNotification").mockReturnValue({ status: "conflict", error: "NOTIFICATION_IDEMPOTENCY_CONFLICT" });
    expect(await ping(store, "m1")).toEqual({ stored: false, error: "write" });
    expect(items(store)).toEqual([]);
    expect(decisions(store)).toEqual([]);
    store.close();
  });
  it("a thrown error quoting mail text never reaches the daemon log: codes and the item id only (codex round 1)", async () => {
    const store = RunStore.openInMemory();
    const from = "zed-planted@example.com";
    const subject = "Planted-Subject-QX7";
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sqlite = Object.assign(new Error(`cannot store ${subject} from ${from}`), { code: "SQLITE_FULL" });
    const insertItem = vi.spyOn(store, "insertMailItem").mockImplementation(() => { throw sqlite; });
    expect(await triageOne(deps(store, answer("now", 0.9)), meta("m1", { from: `Zed <${from}>`, subject }), { known_sender: false, backfill: false })).toEqual({ stored: false, error: "write" });
    insertItem.mockRestore();
    vi.spyOn(store, "insertDecision").mockImplementation(() => { throw new Error(`decision for ${subject} <${from}>`); });
    expect(await triageOne(deps(store, answer("now", 0.9)), meta("m2", { from: `Zed <${from}>`, subject }), { known_sender: false, backfill: false })).toEqual({ stored: false, error: "decision" });
    const printed = [...err.mock.calls, ...log.mock.calls].flat().map(String).join("\n");
    expect(err).toHaveBeenCalledTimes(2);
    expect(printed).toContain("SQLITE_FULL");
    for (const planted of [from, subject, "Planted", "cannot store", "decision for"]) expect(printed).not.toContain(planted);
    expect(JSON.stringify(store.listOpenIncidents())).not.toContain("Planted");
    store.close();
  });
  it("the sender address and subject appear in no decisions column and no change_log text (spec §9)", async () => {
    const store = RunStore.openInMemory();
    const from = "zed-planted@example.com";
    const subject = "Planted-Subject-QX7";
    await triageOne(deps(store, DOWN), meta("m1", { from: `Zed Planted <${from}>`, subject }), { known_sender: false, backfill: false });
    await triageOne(deps(store, answer("now", 0.9)), meta("m2", { from: `Zed Planted <${from}>`, subject }), { known_sender: false, backfill: false });
    const blob = JSON.stringify(decisions(store)) + changeLog(store).join("\n") + JSON.stringify(store.listOpenIncidents());
    expect(blob).not.toContain(from);
    expect(blob).not.toContain(subject);
    expect(blob).not.toContain("Planted");
    store.close();
  });
});
