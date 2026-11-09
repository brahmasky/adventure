import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleApiDeps } from "../../src/capabilities/google-api.js";
import type { GoogleAuthClient } from "../../src/capabilities/google-auth.js";
import type { MailAsk } from "../../src/jev/mail-ask.js";
import type { GmailMetadata } from "../../src/mail/envelope.js";
import { FIRST_RUN_QUERY, mailStale, runMailTick, type PollDeps } from "../../src/mail/poller.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec 2026-11-09 §3.2 and §7: the poller is off unless both switches, a token and no auth pause; the cursor advances only
// when every collected id is stored or 404-skipped, so a deadline mid-range leaves it and the next tick finishes without a
// double row; a 404 on history.list resyncs with one mail_log line; invalid_grant pauses with exactly one mail_auth_lost page;
// 5xx backs off and pages mail_poll_failing through the one shared stale predicate after two hours.
const NOW = new Date("2026-11-09T02:00:00.000Z");
const EPOCH = "1970-01-01T00:00:00.000Z";
const ENV = { HOUGE_MAIL_ENABLED: "1", HOUGE_TELEGRAM_CHAT_ID: "555" };
const auth: GoogleAuthClient = { getAccessToken: async () => "ya29.t", invalidate: () => undefined };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const ref = (id: string) => ({ id, threadId: `t-${id}` });
const metaOf = (id: string, from = "ann@example.com"): GmailMetadata => ({ id, threadId: `t-${id}`, snippet: "s", labelIds: ["INBOX"], internalDate: String(NOW.getTime() - 3_600_000),
  payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: `Subject ${id}` }] } });
const NOW_ANSWER: MailAsk = { urgency: { type: "choice", choice: "now", probabilities: { now: 0.9 }, confidence: 0.9 }, kind: undefined, model: "jev-1.14.0" };

/** A Gmail fake keyed by endpoint; a number is an HTTP status. Every request must be a GET under users/me without a full/raw body. */
type Script = { profile?: string | number; history?: (u: URL) => unknown | number; list?: (u: URL) => unknown | number; msg?: (id: string) => GmailMetadata | number; sent?: boolean };
function gmail(s: Script) {
  const urls: URL[] = [];
  const body = (v: unknown) => (typeof v === "number" ? json({}, v) : json(v));
  const fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(i));
    expect(init?.method ?? "GET").toBe("GET");
    expect(u.pathname.startsWith("/gmail/v1/users/me/")).toBe(true);
    expect(["full", "raw"]).not.toContain(u.searchParams.get("format"));
    urls.push(u);
    const p = u.pathname.slice("/gmail/v1/users/me/".length);
    if (p === "profile") return body(s.profile === undefined ? { historyId: "100" } : typeof s.profile === "number" ? s.profile : { historyId: s.profile });
    if (p === "history") return body(s.history ? s.history(u) : 500);
    if (p === "messages") return u.searchParams.get("q")?.startsWith("in:sent") ? json({ messages: s.sent === false ? [] : [ref("sent1")] }) : body(s.list ? s.list(u) : 500);
    if (p.startsWith("messages/")) { const id = p.slice("messages/".length); return body(s.msg ? s.msg(id) : metaOf(id)); }
    throw new Error(`unexpected path ${p}`);
  }) as typeof fetch;
  const deps: GoogleApiDeps = { fetchImpl, now: () => new Date() };
  return { urls, deps, paths: () => urls.map((u) => u.pathname.slice("/gmail/v1/users/me/".length)) };
}
type Over = Partial<Omit<PollDeps, "gmail">> & { now?: () => Date };
function pollDeps(store: RunStore, g: ReturnType<typeof gmail>, o: Over = {}): PollDeps {
  return { store, chatId: "555", pacoAddress: "paco@example.com", env: ENV, now: () => NOW, brokerRedact: (s) => s, ask: async () => NOW_ANSWER,
    gmail: { deps: g.deps, auth }, hasRefreshToken: true, signal: new AbortController().signal, ...o };
}
const on = (store: RunStore, patch: Parameters<RunStore["setMailState"]>[0] = {}) => store.setMailState({ enabled: true, enabled_at: NOW.toISOString(), ...patch });
const items = (store: RunStore): { gmail_message_id: string; lane: string; reason_code: string; known_sender: number }[] =>
  (store as any).db.prepare("SELECT gmail_message_id, lane, reason_code, known_sender FROM mail_items ORDER BY gmail_message_id").all();
const open = (store: RunStore) => store.listOpenIncidents().map((i) => i.kind);
const at = (iso: string) => () => new Date(iso);
const page = (ids: string[], historyId: string, next?: string) => ({ history: ids.map((id) => ({ id: `h${id}`, messagesAdded: [{ message: ref(id) }] })), historyId, ...(next ? { nextPageToken: next } : {}) });

afterEach(() => vi.restoreAllMocks());

describe("runMailTick: gates (no Gmail call)", () => {
  it("off when the env switch or the stored switch is off; no_token; paused on an auth error; not_due inside the cadence", async () => {
    const store = RunStore.openInMemory();
    const g = gmail({});
    expect(await runMailTick(pollDeps(store, g))).toEqual({ ran: false, why: "off" });
    on(store);
    expect(await runMailTick(pollDeps(store, g, { env: { HOUGE_TELEGRAM_CHAT_ID: "555" } }))).toEqual({ ran: false, why: "off" });
    expect(await runMailTick(pollDeps(store, g, { hasRefreshToken: false }))).toEqual({ ran: false, why: "no_token" });
    store.setMailState({ last_error_code: "auth" });
    expect(await runMailTick(pollDeps(store, g))).toEqual({ ran: false, why: "paused" });
    store.setMailState({ last_error_code: null, last_ok_at: new Date(NOW.getTime() - 60_000).toISOString() });
    expect(await runMailTick(pollDeps(store, g))).toEqual({ ran: false, why: "not_due" });
    expect(g.urls).toHaveLength(0);
    expect(store.mailState().last_attempt_at).toBeNull();
    store.close();
  });
});

describe("runMailTick: first run and history", () => {
  it("first run: profile then the 24 h list; items stored backfill in /inbox, no Jev, no card, cursor = profile id", async () => {
    const store = RunStore.openInMemory();
    on(store);
    const ask = vi.fn(async () => NOW_ANSWER);
    const g = gmail({ profile: "100", list: (u) => { expect(u.searchParams.get("q")).toBe(FIRST_RUN_QUERY); expect(u.searchParams.get("maxResults")).toBe("200"); return { messages: ["a", "b", "c"].map(ref) }; } });
    expect(await runMailTick(pollDeps(store, g, { ask }))).toEqual({ ran: true, stored: 3, pinged: 0, cursorAdvanced: true });
    expect(items(store).map((r) => [r.gmail_message_id, r.lane, r.reason_code])).toEqual([["a", "inbox", "backfill"], ["b", "inbox", "backfill"], ["c", "inbox", "backfill"]]);
    expect(ask).not.toHaveBeenCalled();
    expect(drainOutbox(store).size).toBe(0);
    expect(g.paths().slice(0, 2)).toEqual(["profile", "messages"]);
    expect(store.mailState()).toMatchObject({ history_id: "100", last_ok_at: NOW.toISOString(), last_attempt_at: NOW.toISOString(), last_error_code: null });
    store.close();
  });
  it("history across two pages with three new ids → three rows, three cards, cursor = the last page's historyId; a second tick over the same ids sends nothing", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    const ask = vi.fn(async () => NOW_ANSWER);
    const g = gmail({ history: (u) => (u.searchParams.get("pageToken") === "p2" ? page(["c"], "20") : page(["a", "b"], "10", "p2")) });
    expect(await runMailTick(pollDeps(store, g, { ask }))).toEqual({ ran: true, stored: 3, pinged: 3, cursorAdvanced: true });
    expect(store.mailState().history_id).toBe("20");
    expect(items(store).map((r) => r.lane)).toEqual(["ping", "ping", "ping"]);
    store.setMailState({ last_ok_at: null });
    expect(await runMailTick(pollDeps(store, g, { ask }))).toEqual({ ran: true, stored: 0, pinged: 0, cursorAdvanced: true });
    expect(ask).toHaveBeenCalledTimes(3);
    expect([...drainOutbox(store).keys()].sort()).toEqual(["mail:a", "mail:b", "mail:c"]);
    expect(g.paths().filter((p) => p.startsWith("messages/"))).toHaveLength(3);
    store.close();
  });
  it("a deadline of 0 ms stores the first item only and leaves the cursor; the next tick stores the rest without a duplicate and advances", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    const g = gmail({ history: () => page(["a", "b", "c"], "10") });
    expect(await runMailTick(pollDeps(store, g, { deadlineMs: 0 }))).toEqual({ ran: true, stored: 1, pinged: 1, cursorAdvanced: false });
    expect(store.mailState().history_id).toBe("5");
    expect(items(store)).toHaveLength(1);
    store.setMailState({ last_ok_at: null });
    expect(await runMailTick(pollDeps(store, g))).toEqual({ ran: true, stored: 2, pinged: 2, cursorAdvanced: true });
    expect(items(store).map((r) => r.gmail_message_id)).toEqual(["a", "b", "c"]);
    expect(store.mailState().history_id).toBe("10");
    store.close();
  });
  it("an aborted signal stops new work after the first item and leaves the cursor", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    const ac = new AbortController();
    ac.abort();
    const g = gmail({ history: () => page(["a", "b", "c"], "10") });
    expect(await runMailTick(pollDeps(store, g, { signal: ac.signal }))).toMatchObject({ ran: true, stored: 1, cursorAdvanced: false });
    store.close();
  });
  it("a 404 on one messages.get skips that id; the others are stored and the cursor advances", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    const g = gmail({ history: () => page(["a", "gone", "c"], "10"), msg: (id) => (id === "gone" ? 404 : metaOf(id)) });
    expect(await runMailTick(pollDeps(store, g))).toEqual({ ran: true, stored: 2, pinged: 2, cursorAdvanced: true });
    expect(items(store).map((r) => r.gmail_message_id)).toEqual(["a", "c"]);
    expect(store.mailState().history_id).toBe("10");
    store.close();
  });
  it("a partial range (page cap) advances the cursor to the resumable record id once its ids are stored (Task 7 review I1)", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    const g = gmail({ history: (u) => { const n = Number(u.searchParams.get("pageToken") ?? "0"); return { history: [{ id: String(100 + n), ...(n === 0 ? { messagesAdded: [{ message: ref("a") }] } : {}) }], historyId: "999", nextPageToken: String(n + 1) }; } });
    expect(await runMailTick(pollDeps(store, g))).toEqual({ ran: true, stored: 1, pinged: 1, cursorAdvanced: true });
    expect(store.mailState().history_id).toBe("149");
    store.close();
  });
  it("a write failure inside triage leaves the cursor for the next tick", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    vi.spyOn(store, "insertMailItem").mockImplementation(() => { throw new Error("SQLITE_FULL"); });
    const g = gmail({ history: () => page(["a"], "10") });
    expect(await runMailTick(pollDeps(store, g))).toEqual({ ran: true, stored: 0, pinged: 0, cursorAdvanced: false });
    expect(store.mailState().history_id).toBe("5");
    store.close();
  });
});

describe("runMailTick: known sender (spec §3.3)", () => {
  it("an always rule or a cached answer needs no Sent query; otherwise one query per address, cached", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    store.upsertSenderRule({ rule_id: "r1", address: "ruled@example.com", action: "always", source_item_id: null, created_at: NOW.toISOString() });
    store.cacheSenderInSent("cached@example.com", false, NOW.toISOString());
    const g = gmail({ history: () => page(["a", "b", "c", "d"], "10"), msg: (id) => metaOf(id, { a: "ruled@example.com", b: "cached@example.com", c: "new@example.com", d: "new@example.com" }[id]!), sent: true });
    const ask = vi.fn(async () => NOW_ANSWER);
    await runMailTick(pollDeps(store, g, { ask }));
    const sentQueries = g.urls.filter((u) => u.searchParams.get("q")?.startsWith("in:sent"));
    expect(sentQueries.map((u) => u.searchParams.get("q"))).toEqual(['in:sent to:"new@example.com"']);
    expect(items(store).map((r) => [r.gmail_message_id, r.known_sender])).toEqual([["a", 1], ["b", 0], ["c", 1], ["d", 1]]);
    expect(store.senderInSent("new@example.com", EPOCH)).toBe(true);
    store.close();
  });
});

describe("runMailTick: cursor expired (history 404 → resync)", () => {
  it("lists after the last received epoch, stores backfill, logs one mail_log line, resets the cursor to the profile id", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    store.insertMailItem({ item_id: "mi_old", gmail_message_id: "old", gmail_thread_id: "t", from_address: "ann@example.com", from_name: null, known_sender: false, labels: [], important: false,
      received_at: "2026-11-08T00:00:00.000Z", subject: null, snippet: null, lane: "inbox", kind: null, reason_code: "backfill", thread_followup: false, decision_id: null, notification_id: null, created_at: "2026-11-08T00:00:00.000Z" });
    const g = gmail({ profile: "300", history: () => 404, list: (u) => { expect(u.searchParams.get("q")).toBe(`in:inbox after:${Math.floor(Date.parse("2026-11-08T00:00:00.000Z") / 1000)}`); expect(u.searchParams.get("maxResults")).toBe("500"); return { messages: ["a", "b"].map(ref) }; } });
    expect(await runMailTick(pollDeps(store, g))).toEqual({ ran: true, stored: 2, pinged: 0, cursorAdvanced: true });
    expect(items(store).filter((r) => r.reason_code === "backfill")).toHaveLength(3);
    expect(store.mailState().history_id).toBe("300");
    expect(store.listChangeLog(EPOCH, 10).map((r) => [r.topic, r.text])).toEqual([["mail_log", "Mail caught up: 2 in /inbox"]]);
    expect(drainOutbox(store).size).toBe(0);
    store.close();
  });
  it("with the cap hit the line says older mail is not listed; with no stored mail it falls back to the 24 h query", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    // one id per page with a next token on every page: the client's page cap ends the listing with `more`
    const g = gmail({ profile: "300", history: () => 404, list: (u) => { expect(u.searchParams.get("q")).toBe(FIRST_RUN_QUERY); const n = Number(u.searchParams.get("pageToken") ?? "0"); return { messages: [ref(`m${n}`)], nextPageToken: String(n + 1) }; } });
    expect(await runMailTick(pollDeps(store, g))).toMatchObject({ stored: 50, pinged: 0, cursorAdvanced: true });
    const [line] = store.listChangeLog(EPOCH, 10);
    expect(line!.text).toContain("Mail caught up: 50 in /inbox");
    expect(line!.text).toContain("older not listed");
    store.setMailState({ last_ok_at: null, history_id: "6" });
    const dup = gmail({ profile: "400", history: () => 404, list: () => ({ messages: [ref("a"), ref("a"), ref("a")] }) }); // a listing that repeats an id is processed once
    expect(await runMailTick(pollDeps(store, dup))).toMatchObject({ stored: 1, cursorAdvanced: true });
    expect(store.mailState().history_id).toBe("400");
    store.close();
  });
});

describe("runMailTick: resync is atomic with its log line (codex round 1)", () => {
  const dupItems = () => gmail({ profile: "300", history: () => 404, list: () => ({ messages: ["a"].map(ref) }) });
  it("a conflicting mail_log key fails the tick: items stay stored, cursor unchanged, no half-written line", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    store.enqueueNotification({ topic: "mail_log", idempotency_key: "mail:resync:5", correlation_id: "x", text: "an earlier, different line" });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runMailTick(pollDeps(store, dupItems()))).toMatchObject({ ran: true, stored: 1, cursorAdvanced: false, error: "unavailable" });
    expect(store.mailState()).toMatchObject({ history_id: "5", failing_since: NOW.toISOString() });
    expect(store.listChangeLog(EPOCH, 10).map((r) => r.text)).toEqual(["an earlier, different line"]);
    expect(err.mock.calls.flat().join(" ")).toContain("MAIL_RESYNC_LOG_CONFLICT");
    store.close();
  });
  it("the same line already written (duplicate_log) is fine: cursor advances", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    store.enqueueNotification({ topic: "mail_log", idempotency_key: "mail:resync:5", correlation_id: "x", text: "Mail caught up: 1 in /inbox" });
    expect(await runMailTick(pollDeps(store, dupItems()))).toMatchObject({ ran: true, stored: 1, cursorAdvanced: true });
    expect(store.mailState().history_id).toBe("300");
    expect(store.listChangeLog(EPOCH, 10)).toHaveLength(1);
    store.close();
  });
  it("a thrown error quoting mail text on the poller path is logged as a code and Gmail id only", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store, "threadPingedSince").mockImplementation(() => { throw new Error("thread lookup failed for Planted-Subject-QX7 <zed-planted@example.com>"); });
    expect(await runMailTick(pollDeps(store, gmail({ history: () => page(["a"], "10") })))).toMatchObject({ ran: true, stored: 0, cursorAdvanced: false });
    const printed = err.mock.calls.flat().map(String).join("\n");
    expect(printed).toContain("id=a");
    expect(printed).not.toContain("Planted");
    expect(printed).not.toContain("zed-planted");
    store.close();
  });
});

describe("runMailTick: failures (spec §7)", () => {
  it("auth → last_error_code auth, one mail_auth_lost page; later ticks are paused with no fetch", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    const g = gmail({ history: () => 401 });
    expect(await runMailTick(pollDeps(store, g))).toEqual({ ran: true, stored: 0, pinged: 0, cursorAdvanced: false, error: "auth" });
    expect(store.mailState()).toMatchObject({ last_error_code: "auth", history_id: "5" });
    expect(open(store)).toEqual(["mail_auth_lost"]);
    const n = g.urls.length;
    expect(await runMailTick(pollDeps(store, g))).toEqual({ ran: false, why: "paused" });
    expect(g.urls).toHaveLength(n);
    expect([...drainOutbox(store).keys()].filter((k) => k.startsWith("incident_opened:"))).toHaveLength(1);
    store.setMailState({ last_error_code: null }); // what `/mail on` or a restart does after `houge mail auth`
    expect(await runMailTick(pollDeps(store, gmail({ history: () => page([], "10") })))).toMatchObject({ ran: true, cursorAdvanced: true });
    expect(open(store)).toEqual([]); // the condition cleared: the grant works again
    store.close();
  });
  it("unavailable backs off 1, 2, 4 … min and stamps failing_since; mail_poll_failing opens once past two hours; a success resolves it and resets", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5", last_ok_at: NOW.toISOString() });
    const g = gmail({ history: () => 503 });
    const t = (min: number) => new Date(NOW.getTime() + min * 60_000);
    expect(await runMailTick(pollDeps(store, g, { now: () => t(5) }))).toMatchObject({ ran: true, error: "unavailable" });
    expect(store.mailState()).toMatchObject({ failing_since: t(5).toISOString(), backoff_n: 1, last_error_code: "unavailable", history_id: "5" });
    expect(await runMailTick(pollDeps(store, g, { now: () => t(5.5) }))).toEqual({ ran: false, why: "not_due" });
    expect(await runMailTick(pollDeps(store, g, { now: () => t(6) }))).toMatchObject({ ran: true, error: "unavailable" });
    expect(store.mailState().backoff_n).toBe(2);
    expect(await runMailTick(pollDeps(store, g, { now: () => t(7) }))).toEqual({ ran: false, why: "not_due" });
    expect(await runMailTick(pollDeps(store, g, { now: () => t(8) }))).toMatchObject({ ran: true, error: "unavailable" });
    expect(open(store)).toEqual([]);
    expect(await runMailTick(pollDeps(store, g, { now: () => t(125) }))).toMatchObject({ ran: true, error: "unavailable" });
    expect(open(store)).toEqual(["mail_poll_failing"]);
    expect(await runMailTick(pollDeps(store, g, { now: () => t(160) }))).toMatchObject({ ran: true, error: "unavailable" });
    expect(open(store)).toEqual(["mail_poll_failing"]);
    const ok = gmail({ history: () => page([], "10") });
    expect(await runMailTick(pollDeps(store, ok, { now: () => t(200) }))).toEqual({ ran: true, stored: 0, pinged: 0, cursorAdvanced: true });
    expect(store.mailState()).toMatchObject({ failing_since: null, backoff_n: 0, last_error_code: null, last_ok_at: t(200).toISOString(), history_id: "10" });
    expect(open(store)).toEqual([]);
    store.close();
  });
  it("a 404 on one messages.get is not a failure, but a 500 on one stops the tick as unavailable", async () => {
    const store = RunStore.openInMemory();
    on(store, { history_id: "5" });
    const g = gmail({ history: () => page(["a", "b"], "10"), msg: (id) => (id === "b" ? 500 : metaOf(id)) });
    expect(await runMailTick(pollDeps(store, g))).toMatchObject({ ran: true, cursorAdvanced: false, error: "unavailable" });
    expect(store.mailState().history_id).toBe("5");
    store.close();
  });
});

describe("mailStale (the one predicate the poller and the sweep share)", () => {
  const st = (o: Partial<ReturnType<RunStore["mailState"]>>) => ({ enabled: true, enabled_at: null, history_id: null, last_ok_at: null, last_error_code: null, failing_since: null, last_attempt_at: null, backoff_n: 0, retention_on: null, ...o });
  const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
  it("is false when disabled by either switch, or when nothing has started", () => {
    expect(mailStale(st({ enabled: false, last_ok_at: h(5) }), ENV, NOW)).toBe(false);
    expect(mailStale(st({ last_ok_at: h(5) }), {}, NOW)).toBe(false);
    expect(mailStale(st({}), ENV, NOW)).toBe(false);
  });
  it("is true past two hours since the last ok, or since enabled_at when no poll ever succeeded (keeps a sweep from flapping the poller's page)", () => {
    expect(mailStale(st({ last_ok_at: h(1) }), ENV, NOW)).toBe(false);
    expect(mailStale(st({ last_ok_at: h(3) }), ENV, NOW)).toBe(true);
    expect(mailStale(st({ enabled_at: h(3) }), ENV, NOW)).toBe(true);
    expect(mailStale(st({ enabled_at: h(1) }), ENV, NOW)).toBe(false);
  });
});
