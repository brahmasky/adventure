import { afterEach, describe, expect, it, vi } from "vitest";
import { decide } from "../../src/decisions/decide.js";
import { fallbackCardText, shouldRecord, storeRecorder } from "../../src/decisions/record.js";
import type { AnyDecideResult, AnyEntry, Entry, RungResult } from "../../src/decisions/types.js";
import { TURN_SETTLE } from "../../src/decisions/entries/turn-settle.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec §5.2: a row only when it matters (non-default, beyond the first rule, late, Paco, or alwaysRecord), so the ledger
// stays at ~10–15 rows a turn. Spec §4.1: a failed write never changes the decision and opens decision_record_failed.
// Spec §8.2 + plan ruling 9: three named fallbacks of one entry in an hour page once (decision_fallback:<entry>); only a
// judge's answer clears it; a reopen inside the 10-minute quiet window sends no second card; a failure another incident
// already pages (the front door's Jev rung) never pages twice; `budget` is not a failure.
type V = "pass" | "ask";
type S = { v: V | "abstain" };
const FX = { kind: "reply", reversible: true, announced: "card" } as const;
const E: Entry<S, V> = {
  id: "test.judge", version: 3, stage: "pre_model", input: "paco", question: "q", verdicts: ["pass", "ask"],
  ladder: [{ kind: "rule", name: "r", decide: (s) => (s.v === "abstain" ? { abstain: true } : { verdict: s.v, reason: "routed" }) },
    { kind: "system_one", name: "j", questions: [], bars: { kind: "calibrated", questionIds: [], p: 0.6 }, timeoutMs: 50 }],
  fail: "pass", defaultVerdict: "pass", outcomes: [], armed: { rule: "on", system_one: "on" }, effects: { pass: FX, ask: FX }, reasonCodes: ["routed", "transport"]
};
const any = E as unknown as AnyEntry;
const HANDLER: Entry<S, V> = { ...E, id: "turn.handler",
  ladder: [...E.ladder, { kind: "model", name: "m", role: "tiny", prompt: { id: "p", version: 1 }, timeoutMs: 50 }], armed: { rule: "on", system_one: "on", model: "on" } };
const result = (o: Partial<AnyDecideResult>): AnyDecideResult => ({ verdict: "pass", rung: "rule", reason: null, fallbackReason: null, fallbackRung: null,
  armedMode: "on", decisionId: null, walk: [{ kind: "rule", name: "r", mode: "on", result: { verdict: "pass" } }], latencyMs: 1, ...o });
const ENV = { HOUGE_TELEGRAM_CHAT_ID: "555" };
const jevDown = vi.fn(async (): Promise<RungResult<V>> => ({ failed: "outage", reason: "transport" }));
const jevAnswers = vi.fn(async (): Promise<RungResult<V>> => ({ verdict: "pass", reason: "routed" }));
const jevAbstains = vi.fn(async (): Promise<RungResult<V>> => ({ abstain: true }));
const modelDown = vi.fn(async (): Promise<RungResult<V>> => ({ failed: "outage", reason: "transport" }));
const open = (store: RunStore) => store.listOpenIncidents().map((i) => [i.kind, i.subject]);
/** The decision_fallback card is decision_internal: a change_log row, never chat (spec 2026-11-03 §4). */
const logged = (store: RunStore) => store.listChangeLog("1970-01-01T00:00:00.000Z", 50).map((r) => r.text);
const cards = (store: RunStore) => [...drainOutbox(store).values()].map((p) => p.text);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("shouldRecord", () => {
  it("routine: the first rule gave the default verdict, nothing late: no row", () => {
    expect(shouldRecord(any, result({}))).toBe(false);
  });
  it("a row for: a non-default verdict, a judge, a fail, a late verdict, a later rule, alwaysRecord", () => {
    expect(shouldRecord(any, result({ verdict: "ask" }))).toBe(true);
    expect(shouldRecord(any, result({ rung: "system_one" }))).toBe(true);
    expect(shouldRecord(any, result({ rung: "fail" }))).toBe(true);
    expect(shouldRecord(any, result({ armedMode: "late" }))).toBe(true);
    expect(shouldRecord(any, result({ walk: [{ kind: "rule", name: "a", mode: "on", result: { abstain: true } }, { kind: "rule", name: "b", mode: "on", result: { verdict: "pass" } }] }))).toBe(true);
    expect(shouldRecord({ ...any, alwaysRecord: true }, result({}))).toBe(true);
  });
});

describe("storeRecorder: the row", () => {
  it("writes entry version and stage from the entry, a reason only if the entry or the runner lists it, the failing rung, never state", async () => {
    const store = RunStore.openInMemory();
    const r = await decide(E, { v: "ask" }, { run_id: "run_1", recorder: storeRecorder(store) });
    expect(store.getDecision(r.decisionId!)).toMatchObject({ entry_id: "test.judge", entry_version: 3, stage: "pre_model", rung: "rule", verdict: "ask",
      reason_code: "routed", run_id: "run_1", armed_mode: "on", fallback_rung: null });
    const odd = storeRecorder(store).record(any, result({ verdict: "ask", reason: "free text from somewhere" }), { run_id: null, tool_call_id: null });
    expect(store.getDecision(odd!)?.reason_code).toBeNull();
    const held = storeRecorder(store).record(any, result({ verdict: "ask", reason: "floor_held" }), { run_id: null, tool_call_id: null });
    expect(store.getDecision(held!)?.reason_code).toBe("floor_held");
    const failed = await decide(E, { v: "abstain" }, { run_id: null, recorder: storeRecorder(store), exec: { system_one: jevDown } });
    expect(store.getDecision(failed.decisionId!)).toMatchObject({ rung: "fail", fallback_reason: "outage", fallback_rung: "system_one" });
    store.close();
  });
  it("a failed write returns null, keeps the verdict, opens decision_record_failed once; the next good write resolves it", async () => {
    const store = RunStore.openInMemory();
    const spy = vi.spyOn(store, "insertDecision").mockImplementation(() => { throw new Error("SQLITE_FULL"); });
    const r = await decide(E, { v: "ask" }, { run_id: null, recorder: storeRecorder(store, { env: ENV }), log: () => {} });
    expect(r).toMatchObject({ verdict: "ask", decisionId: null });
    expect(open(store)).toEqual([["decision_record_failed", "test.judge"]]);
    spy.mockRestore();
    await decide(E, { v: "ask" }, { run_id: null, recorder: storeRecorder(store, { env: ENV }) });
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
});

describe("storeRecorder: decision_fallback (ruling 9)", () => {
  it("three named fallbacks in an hour open decision_fallback:<entry> and log ONE card (no chat needed); a fourth logs nothing more", async () => {
    const store = RunStore.openInMemory();
    vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", "");
    const rec = storeRecorder(store, { env: {} });
    for (let k = 0; k < 4; k += 1) await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: jevDown } });
    expect(open(store)).toEqual([["decision_fallback", "test.judge"]]);
    expect(logged(store)).toHaveLength(2); // the incident line and the card text
    expect(logged(store)).toContain(fallbackCardText("test.judge", 3));
    expect(cards(store)).toEqual([]);
    store.close();
  });
  it("a rule answer (a photo, an ack) does not clear it; the next Jev or model answer does", async () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV });
    for (let k = 0; k < 3; k += 1) await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: jevDown } });
    await decide(E, { v: "ask" }, { run_id: null, recorder: rec }); // a rule answered: proves nothing about the judge
    expect(open(store)).toEqual([["decision_fallback", "test.judge"]]);
    await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: jevAnswers } });
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
  it("a reopen within 10 minutes of resolving logs a second card: a log row is not paged, so no flap damping, and no chat is needed", async () => {
    vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", "");
    const store = RunStore.openInMemory();
    let t = Date.parse("2026-10-12T10:00:00.000Z");
    const rec = storeRecorder(store, { env: {}, now: () => new Date(t).toISOString() });
    const step = async (jev: () => Promise<RungResult<V>>) => { t += 60_000; await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: jev } }); };
    for (let k = 0; k < 3; k += 1) await step(jevDown); // pages at 10:03
    await step(jevAnswers);                            // resolved at 10:04
    await step(jevDown);                               // 10:05: four fails in the hour, reopened inside the quiet window
    expect(open(store)).toEqual([["decision_fallback", "test.judge"]]);
    const lines = logged(store); // each open logs its incident line and its card; the fix logs one line
    expect(lines.filter((t) => t.startsWith("A decider kept falling back"))).toHaveLength(2);
    expect(lines.filter((t) => t.startsWith("⚠️ *test.judge*"))).toHaveLength(2);
    expect(lines.filter((t) => t.startsWith("✅ Fixed:"))).toHaveLength(1);
    expect(cards(store)).toEqual([]);
    store.close();
  });
  it("turn.handler: Jev-rung failures never page here (the Jev incidents do); three cascade failures do", async () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV });
    for (let k = 0; k < 4; k += 1) await decide(HANDLER, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: jevDown, model: jevAbstains } });
    expect(store.listOpenIncidents()).toEqual([]);
    for (let k = 0; k < 3; k += 1) await decide(HANDLER, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: jevAbstains, model: modelDown } });
    expect(open(store)).toEqual([["decision_fallback", "turn.handler"]]);
    store.close();
  });
  it("turn.handler: a confident Jev answer does not clear a cascade incident; the next cascade pick does", async () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV });
    const modelPicks = vi.fn(async (): Promise<RungResult<V>> => ({ verdict: "pass", reason: "routed" }));
    for (let k = 0; k < 3; k += 1) await decide(HANDLER, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: jevAbstains, model: modelDown } });
    await decide(HANDLER, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: jevAnswers } }); // routed by Jev: proves nothing about the cascade
    expect(open(store)).toEqual([["decision_fallback", "turn.handler"]]);
    await decide(HANDLER, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: jevAbstains, model: modelPicks } });
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
  it("ruling 14: turn.settle's Jev-rung timeouts page through the Jev incidents, never decision_fallback; another entry's do", () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV });
    const timedOut = (verdict: string) => result({ verdict, rung: "fail", fallbackReason: "timeout", fallbackRung: "system_one" });
    for (let k = 0; k < 3; k += 1) rec.record(TURN_SETTLE as unknown as AnyEntry, timedOut("settle"), { run_id: null, tool_call_id: null });
    expect(store.listOpenIncidents()).toEqual([]);
    for (let k = 0; k < 3; k += 1) rec.record(any, timedOut("pass"), { run_id: null, tool_call_id: null });
    expect(open(store)).toEqual([["decision_fallback", "test.judge"]]);
    store.close();
  });
  it("budget (an oversized state) and a fail with no named failure (abstained) are not fallbacks and never page", async () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV });
    const budget = vi.fn(async (): Promise<RungResult<V>> => ({ failed: "budget", reason: "state_too_large" }));
    for (let k = 0; k < 4; k += 1) await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: budget } });
    const abstain = vi.fn(async (): Promise<RungResult<V>> => ({ abstain: true }));
    for (let k = 0; k < 4; k += 1) await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: abstain } });
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
});

// Paco 2026-11-07: improve.route failed every day for two weeks and never reached him — one or two rows a day never make
// three in an hour. An entry that records every decision (alwaysRecord) and whose last three rows are all counted
// fallbacks, however far apart, pages decision_fallback_streak:<entry> to chat; an answer from a counting rung clears it.
describe("storeRecorder: decision_fallback_streak (low-frequency entries)", () => {
  const DAILY = { ...E, id: "test.daily", stage: "after_turn", alwaysRecord: true } as Entry<S, V>;
  const daily = (store: RunStore, env: NodeJS.ProcessEnv = ENV) => {
    let t = Date.parse("2026-11-01T10:00:00.000Z");
    const rec = storeRecorder(store, { env, now: () => new Date(t).toISOString() });
    return async (entry: Entry<S, V>, jev: () => Promise<RungResult<V>>, v: S["v"] = "abstain") => {
      t += 24 * 60 * 60 * 1000; await decide(entry, { v }, { run_id: null, recorder: rec, exec: { system_one: jev } });
    };
  };
  const pages = (store: RunStore) => [...drainOutbox(store).values()].map((p) => p.text);

  it("three fallbacks a day apart page ONCE to chat; the hourly rule never fired", async () => {
    const store = RunStore.openInMemory(); const day = daily(store);
    await day(DAILY, jevDown); await day(DAILY, jevDown);
    expect(store.listOpenIncidents()).toEqual([]);
    await day(DAILY, jevDown);
    expect(open(store)).toEqual([["decision_fallback_streak", "test.daily"]]);
    await day(DAILY, jevDown);
    expect(pages(store)).toHaveLength(1);
    store.close();
  });
  it("left out: an entry that does not record every decision, a per-turn entry (the hourly log covers it), a rule-only entry (nothing could clear it)", async () => {
    const store = RunStore.openInMemory(); const day = daily(store);
    const perTurn = { ...DAILY, id: "test.turn", stage: "pre_model" } as Entry<S, V>;
    const ruleOnly = { ...DAILY, id: "test.rules", ladder: [{ kind: "rule", name: "boom", decide: () => { throw new Error("x"); } }] } as unknown as Entry<S, V>;
    const throws = vi.fn(async (): Promise<RungResult<V>> => ({ failed: "outage", reason: "transport" }));
    for (let k = 0; k < 4; k += 1) { await day(E, jevDown); await day(perTurn, jevDown); }
    for (let k = 0; k < 4; k += 1) await day(ruleOnly, throws, "abstain");
    expect(store.listOpenIncidents().filter((i) => i.kind === "decision_fallback_streak")).toEqual([]);
    store.close();
  });
  it("one run's several failed groups (one created_at) count as one run, not three", async () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV, now: () => "2026-11-01T10:00:00.000Z" });
    for (let k = 0; k < 5; k += 1) await decide(DAILY, { v: "abstain" }, { run_id: null, recorder: rec, exec: { system_one: jevDown } });
    expect(store.listOpenIncidents().filter((i) => i.kind === "decision_fallback_streak")).toEqual([]);
    store.close();
  });
  it("a recorded answer in between breaks the streak; a budget stop is not a failure", async () => {
    const store = RunStore.openInMemory(); const day = daily(store);
    const budget = vi.fn(async (): Promise<RungResult<V>> => ({ failed: "budget" }));
    await day(DAILY, jevDown); await day(DAILY, jevDown); await day(DAILY, jevAnswers); await day(DAILY, jevDown);
    await day(DAILY, budget); await day(DAILY, jevDown);
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
  it("the next answer from a counting rung resolves it; a rule answer does not", async () => {
    const store = RunStore.openInMemory(); const day = daily(store);
    for (let k = 0; k < 3; k += 1) await day(DAILY, jevDown);
    await day(DAILY, jevDown, "ask"); // a rule answered: proves nothing about the judge
    expect(open(store)).toEqual([["decision_fallback_streak", "test.daily"]]);
    await day(DAILY, jevAnswers);
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
});
