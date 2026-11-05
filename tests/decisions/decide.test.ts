import { afterEach, describe, expect, it, vi } from "vitest";
import { decide, decideSync } from "../../src/decisions/decide.js";
import { ENTRY_IDS, FRONT_DOOR_ENTRIES } from "../../src/decisions/entry-ids.js";
import type { AnyDecideResult, DecideCtx, DecisionRecorder, Entry, RungResult } from "../../src/decisions/types.js";

// Spec §4.1 / §5.1: code goes first; a thrown rule, a timeout or an outage is an abstention, so `fail` decides, never an
// accident; a monotone judge can only tighten; no rung has a shadow or off mode (R13, by type); recording never changes a decision.
type V = "pass" | "ask" | "deny";
const NO_FX = { kind: "none", reversible: true, announced: "none" } as const;
type S = { rule: V | "abstain" | "throw"; floor?: V };
const recorded: AnyDecideResult[] = [];
const recorder: DecisionRecorder = { record: (_e, r) => { recorded.push(r); return "dec_test"; } };
const rule = (s: S) => {
  if (s.rule === "throw") throw new Error("rule bug");
  if (s.rule === "abstain") return s.floor ? { abstain: true as const, floor: s.floor } : { abstain: true as const };
  return { verdict: s.rule, reason: "code" };
};
function entry(o: Partial<Entry<S, V>> = {}): Entry<S, V> {
  return {
    id: "test.entry", version: 1, stage: "pre_tool", input: "paco", question: "q", verdicts: ["pass", "ask", "deny"],
    ladder: [{ kind: "rule", name: "r", decide: rule }, { kind: "system_one", name: "j", questions: [], bars: { kind: "calibrated", questionIds: [], p: 0.5 }, timeoutMs: 50 },
      { kind: "model", name: "m", role: "tiny", prompt: { id: "p", version: 1 }, timeoutMs: 50 }],
    fail: "ask", defaultVerdict: "pass", outcomes: [], armed: { rule: "on", system_one: "on", model: "on" },
    effects: { pass: NO_FX, ask: NO_FX, deny: NO_FX }, reasonCodes: ["code", "judge"], ...o
  };
}
const answers = (v: V, p = 0.9) => vi.fn(async (): Promise<RungResult<V>> => ({ verdict: v, p, reason: "judge" }));
const fails = (why: "outage" | "parse") => vi.fn(async (): Promise<RungResult<V>> => ({ failed: why }));

afterEach(() => { recorded.length = 0; vi.useRealTimers(); });

describe("decide: the walk", () => {
  it("a rule answer ends the walk and no judge is asked (code goes first)", async () => {
    const jev = answers("deny");
    const r = await decide(entry(), { rule: "pass" }, { run_id: "run_1", recorder, exec: { system_one: jev } });
    expect(r).toMatchObject({ verdict: "pass", rung: "rule", reason: "code", decisionId: "dec_test" });
    expect(jev).not.toHaveBeenCalled();
  });
  it("an abstaining rule reaches the Jev rung (eligible for judging is an abstention, never a pass)", async () => {
    const jev = answers("deny", 0.8);
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { system_one: jev } });
    expect(jev).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ verdict: "deny", rung: "system_one", p: 0.8, fallbackReason: null, fallbackRung: null });
  });
  it("a failing Jev rung passes to the model; the first failure and its rung kind are recorded (a model answer is not a Jev skip)", async () => {
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { system_one: fails("outage"), model: answers("pass") } });
    expect(r).toMatchObject({ verdict: "pass", rung: "model", fallbackReason: "outage", fallbackRung: "system_one" });
  });
  it("every rung failing: the entry's fail verdict stands, rung fail", async () => {
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { system_one: fails("outage"), model: fails("parse") } });
    expect(r).toMatchObject({ verdict: "ask", rung: "fail", fallbackReason: "outage" });
  });
  it("a thrown rule is an abstention (threw), never a crash; the walk goes on", async () => {
    const log = vi.fn();
    const r = await decide(entry(), { rule: "throw" }, { run_id: null, recorder, log, exec: { system_one: answers("deny") } });
    expect(r).toMatchObject({ verdict: "deny", rung: "system_one", fallbackReason: "threw", fallbackRung: "rule" });
    expect(log.mock.calls[0]?.[0]).toMatch(/test\.entry rung r threw/);
  });
  it("a hung rung is cut at its timeout (timeout)", async () => {
    vi.useFakeTimers();
    const p = decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { system_one: () => new Promise(() => {}), model: answers("pass") } });
    await vi.advanceTimersByTimeAsync(60);
    expect(await p).toMatchObject({ verdict: "pass", rung: "model", fallbackReason: "timeout" });
  });
  it("a verdict outside the closed set is a parse failure, not an answer", async () => {
    const odd = vi.fn(async () => ({ verdict: "maybe" } as unknown as RungResult<V>));
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { system_one: odd } });
    expect(r).toMatchObject({ verdict: "ask", rung: "fail", fallbackReason: "parse" });
  });
  it("a rung with no executor is an outage (no_executor), never a silent pass", async () => {
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder });
    expect(r).toMatchObject({ rung: "fail", fallbackReason: "outage", reason: "no_executor" });
  });
  it("later rungs see the earlier outcomes (the cascade reads the tree's plan)", async () => {
    const model = vi.fn(async (_r: unknown, _s: S, prior: readonly { kind: string }[]): Promise<RungResult<V>> => ({ verdict: prior.length === 2 ? "deny" : "pass" }));
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { system_one: fails("outage"), model } });
    expect(r.verdict).toBe("deny");
  });
});

describe("decide: monotone, locked", () => {
  const mono = (o: Partial<Entry<S, V>> = {}) => entry({ monotone: { order: ["pass", "ask", "deny"] }, ...o });
  // Ruling 17: the floor's verdict is the rule's, so the row must not credit Jev with it (stage 2a calibrates on these rows).
  it("a judge less cautious than the rule's floor cannot loosen it; the floor's rung is named, floor_held, no judge p", async () => {
    const r = await decide(mono(), { rule: "abstain", floor: "ask" }, { run_id: null, recorder, exec: { system_one: answers("pass") } });
    expect(r).toMatchObject({ verdict: "ask", rung: "rule", reason: "floor_held" });
    expect(r.p).toBeUndefined();
  });
  it("a judge more cautious than the floor tightens", async () => {
    const r = await decide(mono(), { rule: "abstain", floor: "ask" }, { run_id: null, recorder, exec: { system_one: answers("deny") } });
    expect(r.verdict).toBe("deny");
  });
  it("no rung answering on a monotone entry: the more cautious of floor and fail", async () => {
    const r = await decide(mono({ fail: "pass" }), { rule: "abstain", floor: "ask" }, { run_id: null, recorder, exec: { system_one: fails("outage"), model: fails("outage") } });
    expect(r).toMatchObject({ verdict: "ask", rung: "rule", reason: "floor_held" });
    expect(r.fallbackReason).toBe("outage"); // the failure stays on the row
  });
  it("R13 by type: no entry can be declared shadow or off, and no caller can pass an arming override", () => {
    // @ts-expect-error — ArmedMode is "on" only
    const bad: Entry<never, "a", never>["armed"] = { system_one: "shadow" };
    const ctx: DecideCtx<never, "a", never> = {
      run_id: null,
      recorder: { record: () => null },
      // @ts-expect-error — DecideCtx has no `armed`
      armed: {}
    };
    expect([bad, ctx]).toHaveLength(2);
  });
});

describe("decide: untrusted rung results", () => {
  // The runner is the gate every entry sits behind: a malformed rung result is a parse failure, never a throw or a made-up verdict.
  it("a rule returning undefined settles on fail with parse (no throw)", async () => {
    const bad = entry({ ladder: [{ kind: "rule", name: "r", decide: (() => undefined) as never }] });
    expect(await decide(bad, { rule: "pass" }, { run_id: null, recorder })).toMatchObject({ verdict: "ask", rung: "fail", fallbackReason: "parse", fallbackRung: "rule" });
    expect(decideSync(bad, { rule: "pass" }, { run_id: null, recorder })).toMatchObject({ rung: "fail", fallbackReason: "parse" });
  });
  it("an executor resolving {} or null settles on fail with parse", async () => {
    for (const out of [{}, null, "deny"]) {
      const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { system_one: (async () => out) as never } });
      expect(r).toMatchObject({ verdict: "ask", rung: "fail", fallbackReason: "parse" });
    }
  });
  it("an accidentally async rule (a Promise) is a parse failure, not a verdict", () => {
    const bad = entry({ ladder: [{ kind: "rule", name: "r", decide: (async () => "pass") as never }] });
    expect(decideSync(bad, { rule: "pass" }, { run_id: null, recorder })).toMatchObject({ rung: "fail", fallbackReason: "parse" });
  });
  it("a p outside [0,1], and an unknown failure reason, are parse failures", async () => {
    for (const out of [{ verdict: "deny", p: 1.5 }, { verdict: "deny", p: Number.NaN }, { failed: "exploded" }]) {
      const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { system_one: (async () => out) as never } });
      expect(r).toMatchObject({ verdict: "ask", rung: "fail", fallbackReason: "parse" });
    }
  });
  it("an abstention with a floor outside the closed set is a parse failure", () => {
    const sync = entry({ monotone: { order: ["pass", "ask", "deny"] }, ladder: [{ kind: "rule", name: "r", decide: () => ({ abstain: true, floor: "maybe" as V }) }] });
    expect(decideSync(sync, { rule: "pass" }, { run_id: null, recorder })).toMatchObject({ rung: "fail", fallbackReason: "parse" });
  });
});

describe("decide: the paco rung", () => {
  it("a paco rung has no timeout: a late tap still answers", async () => {
    vi.useFakeTimers();
    const withPaco = entry({ armed: { rule: "on", paco: "on" }, ladder: [{ kind: "rule", name: "r", decide: rule }, { kind: "paco", name: "p", surface: "card" }] });
    const paco = () => new Promise<RungResult<V>>((resolve) => { setTimeout(() => resolve({ verdict: "deny" }), 3_600_000); });
    const p = decide(withPaco, { rule: "abstain" }, { run_id: null, recorder, exec: { paco } });
    await vi.advanceTimersByTimeAsync(3_600_001);
    expect(await p).toMatchObject({ verdict: "deny", rung: "paco", fallbackReason: null });
  });
});

describe("entry ids", () => {
  it("every front-door entry is a registered entry id", () => {
    for (const id of FRONT_DOOR_ENTRIES) expect((ENTRY_IDS as readonly string[]).includes(id)).toBe(true);
  });
});

describe("decide: recording never changes a decision", () => {
  it("the recorder sees the final result, after the walk", async () => {
    await decide(entry(), { rule: "abstain" }, { run_id: "run_9", recorder, exec: { system_one: answers("deny") } });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ verdict: "deny", rung: "system_one" });
  });
  it("a recorder that throws leaves the verdict standing (decisionId null)", async () => {
    const bad: DecisionRecorder = { record: () => { throw new Error("disk full"); } };
    const r = await decide(entry(), { rule: "deny" }, { run_id: null, recorder: bad, log: () => {} });
    expect(r).toMatchObject({ verdict: "deny", rung: "rule", decisionId: null });
  });
});

describe("decideSync", () => {
  it("decides an all-rule ladder synchronously", () => {
    const sync = entry({ ladder: [{ kind: "rule", name: "r", decide: rule }] });
    expect(decideSync(sync, { rule: "abstain" }, { run_id: null, recorder })).toMatchObject({ verdict: "ask", rung: "fail" });
  });
  it("refuses a ladder with a non-rule rung (a hot path must never await)", () => {
    expect(() => decideSync(entry(), { rule: "pass" }, { run_id: null, recorder })).toThrow(/use decide/);
  });
});
