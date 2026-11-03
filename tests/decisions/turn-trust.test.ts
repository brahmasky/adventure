import { describe, expect, it } from "vitest";
import { entryById, entryProblems } from "../../src/decisions/registry.js";
import { CARRY_LEVEL, CAUSE_LEVEL, TRUST_ORDER, trustRule, type TrustCause, type TrustLevel } from "../../src/decisions/entries/turn-trust.js";
import { HOSTILE_CARD_TEXT, resolveTrustAskTtlMs, TRUST_ASK_TTL_DEFAULT_MS, TurnTrust, turnTrustFinal } from "../../src/decisions/trust.js";
import type { AnyEntry } from "../../src/decisions/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Spec §7.2: what a turn has read sets how far it is trusted, and the level only rises. Every rise is ledgered; every turn
// end writes the final level; a hostile turn tells Paco at once, and a schedule-born one (no one to tap) pages once.
// turn.trust is locked: no judge may ever decide it (ADR 0030 decision 6).
function setup(born: "telegram" | "schedule" = "telegram") {
  const store = RunStore.openInMemory(); const run_id = createQueuedTurnRun(store);
  const trust = new TurnTrust({ store, run_id, chat_id: "555", born, env: { HOUGE_TELEGRAM_CHAT_ID: "555" } });
  const events = (t: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === t).map((e) => e.payload);
  return { store, run_id, trust, events };
}

describe("turn.trust", () => {
  it("is locked, rule-only, monotone, and sound in the registry", () => {
    const e = entryById("turn.trust") as AnyEntry;
    expect(e.locked).toBe(true);
    expect(e.ladder.every((r) => r.kind === "rule")).toBe(true);
    expect(e.monotone?.order).toEqual(["clean", "untrusted", "hostile"]);
    expect(entryProblems(e)).toEqual([]);
  });
  it("rises only: a wall read makes it untrusted, a withheld passage hostile, and nothing lowers it", () => {
    const { trust, events } = setup();
    expect(trust.level()).toBe("clean");
    expect(trust.raise("wall_read", "tc1")).toBe(true);
    expect(trust.raise("shell_netread", "tc2")).toBe(false); // already untrusted: no second event
    expect(trust.raise("injection_withheld", "tc3")).toBe(true);
    expect(trust.raise("wall_read", "tc4")).toBe(false);
    expect(trust.level()).toBe("hostile");
    expect(events("turn_trust")).toEqual([{ level: "untrusted", cause: "wall_read" }, { level: "hostile", cause: "injection_withheld" }]);
  });
  it("a framed passage from outside is hostile, from a local read untrusted; a lost judgement is untrusted", () => {
    const a = setup(); a.trust.raise("unjudged_outside"); expect(a.trust.level()).toBe("hostile");
    const b = setup(); b.trust.raise("unjudged_local"); expect(b.trust.level()).toBe("untrusted");
    const c = setup(); c.trust.raise("judge_timeout"); expect(c.trust.level()).toBe("untrusted");
  });
  it("records a decisions row per rise (verdict differs from clean), linked to the tool call", () => {
    const { store, run_id, trust } = setup();
    trust.raise("injection_withheld", "tc9");
    expect(store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "turn.trust")).toEqual([expect.objectContaining({ verdict: "hostile", rung: "rule", reason_code: "injection_withheld", tool_call_id: "tc9" })]);
  });
  it("finalize writes turn_trust_final exactly once, and a turn without it reads as not clean", () => {
    const { store, run_id, trust, events } = setup();
    expect(turnTrustFinal(store, run_id)).toBeNull();
    trust.finalize(); trust.finalize();
    expect(events("turn_trust_final")).toEqual([{ max_level: "clean" }]);
    expect(turnTrustFinal(store, run_id)).toBe("clean");
    expect(trust.raise("wall_read")).toBe(false); // after the end nothing rises
  });
  it("hostile sends one urgent card; a schedule-born hostile turn also pages hostile_schedule_turn once, as an event (opened and resolved)", () => {
    const tg = setup();
    tg.trust.raise("injection_withheld");
    const q = (s: RunStore, sql: string) => (s as unknown as { db: { prepare(q: string): { all(): Array<Record<string, string>> } } }).db.prepare(sql).all();
    expect(q(tg.store, `SELECT 1 FROM incidents WHERE kind = 'hostile_schedule_turn'`)).toEqual([]);
    const sc = setup("schedule");
    sc.trust.raise("injection_withheld");
    // an event: a carried turn re-paged the same morning twice when it stayed open (spec 2026-11-02 §5)
    expect(sc.store.listOpenIncidents().filter((i) => i.kind === "hostile_schedule_turn")).toEqual([]);
    expect(q(sc.store, `SELECT state FROM incidents WHERE kind = 'hostile_schedule_turn'`)).toEqual([{ state: "resolved" }]);
    // hostile_schedule_turn routes to the log (spec 2026-11-03 §5.1); the trust_hostile urgent card is the only page
    expect(q(sc.store, `SELECT idempotency_key FROM notification_outbox`)).toHaveLength(1);
    expect(q(sc.store, `SELECT payload_json FROM notification_outbox WHERE idempotency_key LIKE 'urgent:trust_hostile:%'`)).toHaveLength(1);
    expect(sc.store.listChangeLog("1970-01-01T00:00:00.000Z", 10).filter((r) => r.topic === "incident_log")).toHaveLength(1);
    expect(HOSTILE_CARD_TEXT).toContain("text aimed at the assistant");
  });
  it("two schedule turns that each raise it page twice, once each (the subject is the run id)", () => {
    const store = RunStore.openInMemory();
    for (let n = 0; n < 2; n++) {
      const run_id = createQueuedTurnRun(store);
      new TurnTrust({ store, run_id, chat_id: "555", born: "schedule", env: { HOUGE_TELEGRAM_CHAT_ID: "555" } }).raise("injection_withheld");
    }
    const keys = store.listChangeLog("1970-01-01T00:00:00.000Z", 20).filter((r) => r.topic === "incident_log");
    expect(keys).toHaveLength(2); // a log kind: one row per event, none in chat
    store.close();
  });
  it("a hostile card that cannot be queued opens trust_card_failed, so Paco still learns the turn is hostile", () => {
    const { store, trust } = setup();
    const real = store.enqueueNotification.bind(store);
    store.enqueueNotification = ((n: Parameters<typeof real>[0]) => {
      if (n.idempotency_key.startsWith("urgent:")) throw new Error("outbox down");
      return real(n);
    }) as typeof store.enqueueNotification;
    trust.raise("injection_withheld");
    expect(trust.level()).toBe("hostile");
    expect(store.listOpenIncidents().filter((i) => i.kind === "trust_card_failed")).toHaveLength(1);
  });
  it("HOUGE_TRUST_ASK_TTL_MS: default 5 minutes; a malformed or out-of-range value falls back to the default", () => {
    expect(resolveTrustAskTtlMs({})).toBe(TRUST_ASK_TTL_DEFAULT_MS);
    expect(resolveTrustAskTtlMs({ HOUGE_TRUST_ASK_TTL_MS: "20000" })).toBe(20_000);
    expect(resolveTrustAskTtlMs({ HOUGE_TRUST_ASK_TTL_MS: "-5" })).toBe(TRUST_ASK_TTL_DEFAULT_MS);
    expect(resolveTrustAskTtlMs({ HOUGE_TRUST_ASK_TTL_MS: "99999999" })).toBe(TRUST_ASK_TTL_DEFAULT_MS);
  });
  it("no API can lower it: the rule never answers below the current level, and the class exposes no setter", () => {
    // Monotone within a turn (spec §7.2): if any path could lower the level, a hostile turn could talk itself back to clean.
    const causes = Object.keys(CAUSE_LEVEL) as TrustCause[];
    for (const current of TRUST_ORDER as readonly TrustLevel[]) for (const cause of causes) {
      const v = (trustRule({ current, cause }) as { verdict: TrustLevel }).verdict;
      expect([current, cause, TRUST_ORDER.indexOf(v) >= TRUST_ORDER.indexOf(current)]).toEqual([current, cause, true]);
    }
    expect(Object.getOwnPropertyNames(TurnTrust.prototype).filter((n) => /^(?:set|lower|reset|clear)/i.test(n))).toEqual([]);
    const { trust } = setup();
    expect(Object.keys(trust)).toEqual(["d"]); // the level is an ES private field: no property to overwrite
    trust.raise("injection_withheld");
    for (const cause of causes) trust.raise(cause);
    expect(trust.level()).toBe("hostile");
  });
});

// Spec 2026-11-02 §6.1 (D2-A, senior B1): a caught, withheld passage never reached the planner, so after the turn the
// transcript carries `untrusted`, not `hostile` — but only when the withhold is the turn's ONLY hostile cause. raise() used to
// drop a cause that did not raise the level, so a withhold followed by unjudged outside text was indistinguishable.
describe("carry level (D2-A)", () => {
  const carryOf = (causes: TrustCause[], carried: string | null = null) => {
    const { trust } = setup(); trust.carry(carried); for (const c of causes) trust.raise(c, "tc"); return [trust.level(), trust.carryLevel()];
  };
  it("withhold only → hostile in the turn, untrusted carried", () => expect(carryOf(["injection_withheld"])).toEqual(["hostile", "untrusted"]));
  it("withhold, then unjudged outside text (bridge-handler.ts:539/540) → hostile carried", () => expect(carryOf(["injection_withheld", "unjudged_outside"])).toEqual(["hostile", "hostile"]));
  it("withhold, then a judgement lost on outside text → hostile carried", () => expect(carryOf(["injection_withheld", "judge_lost_outside"])).toEqual(["hostile", "hostile"]));
  it("a carried-hostile turn that withholds still carries hostile (D2 alone never lowers today's transcript)", () => expect(carryOf(["injection_withheld"], "hostile")).toEqual(["hostile", "hostile"]));
  it("untrusted causes carry untrusted; nothing carries clean", () => {
    expect(carryOf(["unjudged_local", "judge_timeout"])).toEqual(["untrusted", "untrusted"]);
    expect(carryOf([])).toEqual(["clean", "clean"]);
  });
  it("in the turn nothing changes: one turn_trust row per rise, none for the non-rising second cause", () => {
    const { trust, events } = setup(); trust.raise("injection_withheld", "a"); trust.raise("unjudged_outside", "b");
    expect(events("turn_trust")).toEqual([{ level: "hostile", cause: "injection_withheld" }]);
  });
  it("a cause asked after finalize is not kept", () => {
    const { trust } = setup(); trust.raise("injection_withheld"); trust.finalize(); trust.raise("unjudged_outside");
    expect(trust.carryLevel()).toBe("untrusted");
  });
  it("CARRY_LEVEL differs from CAUSE_LEVEL only at injection_withheld", () => {
    expect(Object.keys(CAUSE_LEVEL).filter((c) => CARRY_LEVEL[c as TrustCause] !== CAUSE_LEVEL[c as TrustCause])).toEqual(["injection_withheld"]);
  });
});

// Spec 2026-11-02 §6.4 (D3-A): the turn that read the text paged; a schedule turn that only carries it pages nothing (the
// 10-31 and 11-01 mornings each re-paged the same event).
describe("D3-A", () => {
  it("a carried-hostile schedule turn opens no hostile_schedule_turn and queues no page", () => {
    const sc = setup("schedule"); sc.trust.carry("hostile");
    expect(sc.store.getLedgerEvents().filter((e) => e.event_type === "incident_opened")).toEqual([]);
  });
  it("a schedule turn that itself raises hostile still pages once", () => {
    const sc = setup("schedule"); sc.trust.raise("injection_withheld");
    expect(sc.store.getLedgerEvents().filter((e) => e.event_type === "incident_opened").map((e) => (e.payload as { kind: string }).kind)).toEqual(["hostile_schedule_turn"]);
  });
});
