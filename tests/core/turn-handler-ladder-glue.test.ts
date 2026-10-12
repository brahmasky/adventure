import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackOfSkip, jevSkipReason, planTree, treeDetailOf, urlRule, type AnsweredDecision, type PlanInput, type TreeDetail } from "../../src/core/turn-handler-ladder.js";
import { decide } from "../../src/decisions/decide.js";
import { TURN_GEAR } from "../../src/decisions/entries/turn-gear.js";
import { TURN_HANDLER, type TurnHandlerState, type TurnHandlerVerdict } from "../../src/decisions/entries/turn-handler.js";
import type { DecideResult, DecisionRecorder, RungResult } from "../../src/decisions/types.js";
import { fallbackRoute } from "../../src/jev/tree-policy.js";
import { cat } from "../helpers/triage-harness.js";

// Spec §6.2 "wrap": the pure half of turn.handler's rungs reproduces today's policy calls exactly, including where a
// failure lands. Plan ruling 19: a throw before today's held.answered (arming, routeTree) fails with NO detail, so the turn
// settles skipped `error` and Jev's rows are dropped, as at 3bff437; only a throw after it keeps the detail.
const answered = (category = cat({ other: 0.9 })) => ({ status: "answered", model: "jev-1.13.0", answers: { category }, rows: [] }) as unknown as AnsweredDecision;
const input = (o: Partial<PlanInput> = {}): PlanInput => ({ userText: "帮我整理一下这周的待办", mode: "shadow", lang: "zh", thinkHarder: false, rows: [], lanesOff: new Set(), ...o });

describe("the pure glue", () => {
  it("fallbackOfSkip maps every Jev skip to a closed fallback reason", () => {
    expect([fallbackOfSkip("timeout"), fallbackOfSkip("parse"), fallbackOfSkip("malformed_question"), fallbackOfSkip("state_too_large"), fallbackOfSkip("transport"),
      fallbackOfSkip("rate_limited"), fallbackOfSkip("no_key")]).toEqual(["timeout", "parse", "parse", "budget", "outage", "outage", "outage"]);
  });
  it("treeDetailOf prefers the cascade's detail; jevSkipReason reads the tree rung's reason, else error", () => {
    const d = { status: "answered" } as never;
    const r = { walk: [{ kind: "system_one", name: "tree", mode: "on", result: { abstain: true, detail: { d, armed: {} } } },
      { kind: "model", name: "cascade", mode: "on", result: { verdict: "planner", detail: { d, armed: {}, route: fallbackRoute("cascade", false) } } }] } as unknown as DecideResult<"planner", never>;
    expect(treeDetailOf(r as never)?.route?.reason).toBe("cascade");
    const skip = { walk: [{ kind: "system_one", name: "tree", mode: "on", result: { failed: "outage", reason: "transport" } }] } as unknown as DecideResult<"planner", never>;
    expect([jevSkipReason(skip as never), jevSkipReason({ walk: [] } as never)]).toEqual(["transport", "error"]);
  });
  it("urlRule moved verbatim: a lookup naming a URL becomes the planner (lane_limits)", () => {
    const lookup = { ...fallbackRoute("routed", false), lane: "lookup" as const, category: "lookup" as const };
    expect(urlRule(lookup, "see https://example.com", () => ({ kind: "final", route: fallbackRoute("routed", false) })).reason).toBe("lane_limits");
    expect(urlRule(lookup, "no link here", () => { throw new Error("not called"); })).toBe(lookup);
  });
  it("planTree in shadow arms nothing: the planner, uncalibrated, p = the category's top probability (today's shadow route)", () => {
    const r = planTree(answered(), input());
    expect(r).toMatchObject({ verdict: "planner", reason: "uncalibrated", p: 0.9 });
    expect("detail" in r && r.detail?.route?.reason).toBe("uncalibrated");
  });
  it("planTree: a throw while arming fails with no detail (skipped error, Jev's rows dropped, as at 3bff437)", () => {
    const r = planTree(answered(), input({ mode: "arm", rows: null as never })); // treeArmed reads rows.some → TypeError
    expect(r).toEqual({ failed: "threw", reason: "error" });
  });
});

// Task 6 review: turn.gear's Jev rung is bounded at 1 s, the shared tree call's client at 1.5 s. turn.gear makes no call of
// its own: its executor reads the route the handler's ladder already produced, so its bound races a resolved promise and a
// slow-but-successful shared call cannot leave the gear timed out while the handler answered.
describe("turn.gear derives from the one shared Jev call", () => {
  afterEach(() => { vi.useRealTimers(); });
  const recorder: DecisionRecorder = { record: () => null };
  const gate: TurnHandlerState = { mode: "arm", overridden: false, posture: null, modality: "text", hasTurnState: true, isAck: () => false };

  it("a shared call slower than turn.gear's 1 s bound still gives the gear the handler's role, not a timeout", async () => {
    vi.useFakeTimers();
    const slowTree = (): Promise<RungResult<TurnHandlerVerdict, TreeDetail>> =>
      new Promise((resolve) => { setTimeout(() => resolve(planTree(answered(), input({ mode: "arm" }))), 1_200); });
    const pending = decide(TURN_HANDLER, gate, { run_id: null, recorder, exec: { system_one: slowTree } });
    await vi.advanceTimersByTimeAsync(1_200);
    const handler = await pending;
    expect(handler).toMatchObject({ rung: "system_one", verdict: "planner", fallbackReason: null });
    const route = treeDetailOf(handler)!.route!;
    // applied forced true so the gear's Jev rung actually runs (unarmed, the rule would answer before it)
    const gear = await decide(TURN_GEAR, { role: route.role, reason: route.reason, applied: true },
      { run_id: null, recorder, exec: { system_one: async () => ({ verdict: route.role, reason: route.reason }) } });
    expect(gear).toMatchObject({ rung: "system_one", verdict: "default", fallbackReason: null });
  });
});
