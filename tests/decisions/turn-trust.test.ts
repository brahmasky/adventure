import { describe, expect, it } from "vitest";
import { entryById, entryProblems } from "../../src/decisions/registry.js";
import { CAUSE_LEVEL, TRUST_ORDER, trustRule, type TrustCause, type TrustLevel } from "../../src/decisions/entries/turn-trust.js";
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
  it("hostile sends one urgent card; a schedule-born hostile turn also pages hostile_schedule_turn once", () => {
    const tg = setup();
    tg.trust.raise("injection_withheld");
    expect(tg.store.listOpenIncidents().filter((i) => i.kind === "hostile_schedule_turn")).toEqual([]);
    const sc = setup("schedule");
    sc.trust.raise("injection_withheld");
    expect(sc.store.listOpenIncidents().filter((i) => i.kind === "hostile_schedule_turn")).toHaveLength(1);
    const db = (sc.store as unknown as { db: { prepare(q: string): { all(): Array<{ payload_json: string }> } } }).db;
    expect(db.prepare(`SELECT payload_json FROM notification_outbox WHERE idempotency_key LIKE 'urgent:trust_hostile:%'`).all()).toHaveLength(1);
    expect(HOSTILE_CARD_TEXT).toContain("text aimed at the assistant");
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
    expect(Object.getOwnPropertyNames(TurnTrust.prototype).filter((n) => n !== "constructor" && !n.startsWith("_")).sort())
      .toEqual(["finalize", "ledger", "level", "onHostile", "raise"]);
    const { trust } = setup();
    expect(Object.keys(trust)).toEqual(["d"]); // the level is an ES private field: no property to overwrite
    trust.raise("injection_withheld");
    for (const cause of causes) trust.raise(cause);
    expect(trust.level()).toBe("hostile");
  });
});
