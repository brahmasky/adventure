import { describe, expect, it, vi } from "vitest";
import { decide } from "../../src/decisions/decide.js";
import { TURN_HANDLER, turnHandlerGate, type TurnHandlerState } from "../../src/decisions/entries/turn-handler.js";
import { TURN_GEAR, turnGearRule } from "../../src/decisions/entries/turn-gear.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";

// The gate rule IS today's order of code exits (core-worker.ts:2756-2769): flag off, override, posture, modality, no turn
// state, then the ack rule only when armed. A clean-looking text abstains, so it reaches the Jev rung (spec §4.1 codex B1).
const S: TurnHandlerState = { mode: "arm", overridden: false, posture: null, modality: "text", hasTurnState: true, isAck: () => false };
const recorder: DecisionRecorder = { record: () => null };

describe("turnHandlerGate", () => {
  it("answers each code exit in today's order, with today's skip reason", () => {
    expect(turnHandlerGate({ ...S, mode: "off", overridden: true })).toEqual({ verdict: "planner", reason: "disabled" });
    expect(turnHandlerGate({ ...S, overridden: true, posture: "killed" })).toEqual({ verdict: "planner", reason: "override" });
    expect(turnHandlerGate({ ...S, posture: "killed", modality: "photo" })).toEqual({ verdict: "planner", reason: "posture" });
    expect(turnHandlerGate({ ...S, modality: "photo", hasTurnState: false })).toEqual({ verdict: "planner", reason: "modality" });
    expect(turnHandlerGate({ ...S, hasTurnState: false })).toEqual({ verdict: "planner", reason: "error" });
    expect(turnHandlerGate({ ...S, isAck: () => true })).toEqual({ verdict: "planner", reason: "ack_rule" });
  });
  it("shadow never runs the ack rule (it changes the role), and the ack check runs only after the earlier exits", () => {
    const isAck = vi.fn(() => true);
    expect(turnHandlerGate({ ...S, mode: "shadow", isAck })).toEqual({ abstain: true });
    expect(isAck).not.toHaveBeenCalled();
    turnHandlerGate({ ...S, posture: "killed", isAck });
    expect(isAck).not.toHaveBeenCalled();
  });
  // Plan ruling 19: at 3bff437 a throw while computing the ack check settled skipped `error`; a thrown rule would
  // otherwise be an abstention and hand the turn to Jev — a behaviour change.
  it("a throwing ack check answers planner / error, never the Jev rung's turn", async () => {
    const jev = vi.fn(async () => ({ verdict: "planner" as const, reason: "routed" }));
    const boom = { ...S, isAck: () => { throw new Error("clock"); } };
    expect(turnHandlerGate(boom)).toEqual({ verdict: "planner", reason: "error" });
    const r = await decide(TURN_HANDLER, boom, { run_id: null, recorder, exec: { system_one: jev } });
    expect(r).toMatchObject({ rung: "rule", reason: "error" });
    expect(jev).not.toHaveBeenCalled();
  });
  it("an eligible, clean-looking text reaches the Jev rung", async () => {
    const jev = vi.fn(async () => ({ verdict: "planner" as const, reason: "routed" }));
    const r = await decide(TURN_HANDLER, S, { run_id: null, recorder, exec: { system_one: jev } });
    expect(jev).toHaveBeenCalledOnce();
    expect(r.rung).toBe("system_one");
  });
});

describe("turn.gear", () => {
  it("the rule answers the route's role unless the gear questions were applied; then the Jev rung answers", async () => {
    expect(turnGearRule({ role: "thinking", reason: "routed", applied: false })).toEqual({ verdict: "thinking", reason: "gear_not_applied" });
    expect(turnGearRule({ role: "fast", reason: "routed", applied: true })).toEqual({ abstain: true });
    const r = await decide(TURN_GEAR, { role: "fast", reason: "routed", applied: true }, { run_id: null, recorder, exec: { system_one: async () => ({ verdict: "fast" as const, reason: "routed" }) } });
    expect(r).toMatchObject({ verdict: "fast", rung: "system_one" });
  });
});
