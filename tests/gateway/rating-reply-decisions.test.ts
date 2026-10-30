import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { RATING_ACK_TEXT } from "../../src/capabilities/session-rating.js";

// Spec 2026-10-30 R1 §4.2: an open rating ask that meets a message leaves one decisions row; behaviour is unchanged.
const PINNED = ["HOUGE_TELEGRAM_CHAT_ID", "HOUGE_RATING_PENDING_MINUTES"] as const;
const saved: Partial<Record<(typeof PINNED)[number], string>> = {};
beforeEach(() => {
  for (const k of PINNED) { if (process.env[k] !== undefined) saved[k] = process.env[k]; else delete saved[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

const NOW = "2026-07-03T12:00:00.000Z";
const CHAT = "222";
const minutesAgo = (m: number): string => new Date(Date.parse(NOW) - m * 60_000).toISOString();

function turnEvent(text: string, key: string) {
  return buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: text,
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: `telegram:${key}`, source_reference: `telegram:update:${key}`
  });
}
type Db = { db: { prepare(s: string): { all(): Array<Record<string, unknown>>; get<T>(...v: unknown[]): T | undefined } } };
function notificationText(store: RunStore, key: string): string | undefined {
  const row = (store as unknown as Db).db.prepare("SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?").get<{ payload_json: string }>(key);
  return row ? (JSON.parse(row.payload_json) as { text: string }).text : undefined;
}
const ratingRows = (store: RunStore) => (store as unknown as Db).db
  .prepare("SELECT verdict, reason_code, run_id FROM decisions WHERE entry_id = 'intake.rating_reply' ORDER BY rowid").all();
const ask = (store: RunStore, minutes = 40) => store.writePendingRating({ chat_id: CHAT, asked_at: minutesAgo(minutes), window_start: minutesAgo(120) });
/** Records the order in which the named store methods are called (pass-through). */
function trace(store: RunStore, methods: string[]): string[] {
  const calls: string[] = [];
  for (const m of methods) {
    const orig = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!.bind(store);
    (vi.spyOn(store as never, m as never) as unknown as { mockImplementation(f: unknown): void }).mockImplementation(((...a: unknown[]) => { calls.push(m); return orig(...a); }) as never);
  }
  return calls;
}

describe("intake.rating_reply — one row per fresh decision an open ask makes", () => {
  it("bare digit → consumed with the ack as before, one consume/bare_digit row with no run", () => {
    const store = RunStore.openInMemory(); ask(store);
    const r = new Gateway(store).intake(turnEvent("3", "k1"), NOW);
    expect(r).toMatchObject({ ok: true, status: "rating_captured", rating: 3 });
    expect(notificationText(store, "telegram:k1:rating")).toBe(RATING_ACK_TEXT);
    expect(ratingRows(store)).toEqual([{ verdict: "consume", reason_code: "bare_digit", run_id: null }]);
  });
  it("digit + comment → the turn runs on the comment, one forward/digit_comment row", () => {
    const store = RunStore.openInMemory(); ask(store);
    const r = new Gateway(store).intake(turnEvent("2，synthetic comment", "k2"), NOW);
    expect(r).toMatchObject({ ok: true, status: "created" });
    expect(ratingRows(store)).toEqual([{ verdict: "forward", reason_code: "digit_comment", run_id: null }]);
  });
  it("an ordinary message → the ask lapses, the turn runs, one lapse/not_rating row", () => {
    const store = RunStore.openInMemory(); ask(store);
    new Gateway(store).intake(turnEvent("synthetic question", "k3"), NOW);
    expect(store.getPendingRating(CHAT)?.active).toBeFalsy();
    expect(ratingRows(store)).toEqual([{ verdict: "lapse", reason_code: "not_rating", run_id: null }]);
  });
  it("no ask, an expired ask, an inactive ask, a scheduled source → no row", () => {
    const none = RunStore.openInMemory();
    new Gateway(none).intake(turnEvent("3", "n1"), NOW);
    const expired = RunStore.openInMemory(); ask(expired, 24 * 60 * 30);
    new Gateway(expired).intake(turnEvent("3", "n2"), NOW);
    const inactive = RunStore.openInMemory(); ask(inactive); inactive.cancelPendingRating(CHAT);
    new Gateway(inactive).intake(turnEvent("3", "n3"), NOW);
    const sched = RunStore.openInMemory(); ask(sched);
    new Gateway(sched).intake(buildTypedTaskEvent({ ...turnEvent("3", "n4"), source: "schedule" } as never), NOW);
    for (const s of [none, expired, inactive, sched]) expect(ratingRows(s)).toEqual([]);
  });
  it("a replayed bare digit or comment repeats its result and writes no second row (A6 idempotency is mechanics)", () => {
    const store = RunStore.openInMemory(); ask(store);
    const g = new Gateway(store);
    const first = g.intake(turnEvent("3", "r1"), NOW);
    expect(g.intake(turnEvent("3", "r1"), NOW)).toEqual(first);
    const s2 = RunStore.openInMemory(); ask(s2);
    const g2 = new Gateway(s2);
    g2.intake(turnEvent("1 synthetic", "r2"), NOW);
    g2.intake(turnEvent("1 synthetic", "r2"), NOW);
    expect(ratingRows(store)).toHaveLength(1);
    expect(ratingRows(s2)).toHaveLength(1);
  });
  it("an idempotency conflict → the same conflict result as before, no row", () => {
    const store = RunStore.openInMemory(); ask(store);
    const g = new Gateway(store);
    g.intake(turnEvent("3", "c1"), NOW);
    const r = g.intake(turnEvent("2", "c1"), NOW);
    expect(r).toMatchObject({ ok: false });
    expect(ratingRows(store)).toHaveLength(1);
  });
});

describe("the row is written after the existing writes it follows (byte-identical order)", () => {
  it("consume: trigger processed, telegram accepted, then the decision row", () => {
    const store = RunStore.openInMemory(); ask(store);
    const calls = trace(store, ["recordTriggerProcessed", "recordTelegramCommandAudit", "insertDecision"]);
    new Gateway(store).intake(turnEvent("3", "o1"), NOW);
    expect(calls).toEqual(["recordTriggerProcessed", "recordTelegramCommandAudit", "insertDecision"]);
  });
  it("forward: trigger processed, then the decision row", () => {
    const store = RunStore.openInMemory(); ask(store);
    const calls = trace(store, ["recordTriggerProcessed", "insertDecision"]);
    new Gateway(store).intake(turnEvent("2 synthetic comment", "o2"), NOW);
    expect(calls.slice(0, 2)).toEqual(["recordTriggerProcessed", "insertDecision"]);
  });
  it("lapse: the ask is cancelled, then the decision row", () => {
    const store = RunStore.openInMemory(); ask(store);
    const calls = trace(store, ["cancelPendingRating", "insertDecision"]);
    new Gateway(store).intake(turnEvent("synthetic question", "o3"), NOW);
    expect(calls).toEqual(["cancelPendingRating", "insertDecision"]);
  });
});

describe("a failing decision write never changes the rating outcome (spec §4.4)", () => {
  it.each([["3", "consume"], ["2 synthetic comment", "forward"]])("insert fault on %s (%s) → same result, rating banked, incident opened", (text) => {
    const store = RunStore.openInMemory(); ask(store);
    vi.spyOn(store, "insertDecision").mockImplementationOnce(() => { throw new Error("disk full"); });
    const r = new Gateway(store).intake(turnEvent(text, "f1"), NOW);
    expect(r).toMatchObject({ ok: true, status: text === "3" ? "rating_captured" : "created" });
    const db = (store as unknown as Db).db;
    expect(db.prepare("SELECT rating FROM session_ratings").all()).toHaveLength(1);
    expect(db.prepare("SELECT kind FROM incidents").all().map((x) => x.kind)).toContain("decision_record_failed");
  });
});
