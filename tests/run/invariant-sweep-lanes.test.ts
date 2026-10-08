import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLaneFallthrough, runInvariantSweep, SWEEP_INCIDENT_KINDS } from "../../src/run/invariant-sweep.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §8: a lane that falls through to the planner still gets Paco an answer (the planner takes every fall-through), so a
// broken memory or status lane looks exactly like a working Houge. Half or more of ≥ 3 settled lane turns in 24 h falling
// through is broken, not quiet; once open it stays open until that lane answers a turn itself, since rows ageing out prove nothing.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

const ARMED: NodeJS.ProcessEnv = { HOUGE_INVARIANT_SWEEP_ENABLED: "1", HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "5" };
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const iso = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();
const open = () => store.listOpenIncidents().filter((i) => i.kind === "lane_fallthrough_rate");
const sweep = (plusMin = 0) => runInvariantSweep({ store, now: iso(plusMin), env: ARMED, chat_id: "555" });
let seq = 0;

/** One routed lane turn as Task 10 writes it: inserted pending by the triage finaliser, then settled by the handler's end. */
function laneTurn(lane: "memory" | "status" | "planner", minutesFromNow: number, outcome: string): void {
  seq += 1;
  const id = store.insertJevVerdict({
    run_id: `run-${seq}`, category: lane === "planner" ? "research" : lane, breadth: 0, reasoning: 0, actions: 0,
    sets_rule: lane === "memory" ? 0.95 : 0.05, rule_scope: lane === "memory" ? "ask" : null, lane, role: "default", effort: null,
    cascade: null, save_outcome: "none", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null,
    created_at: iso(minutesFromNow)
  });
  if (outcome !== "pending") store.updateJevVerdict(id, { handler_outcome: outcome });
}

describe("lane_fallthrough_rate", () => {
  it("is one of the sweep's own kinds, so the sweep may resolve it", () => {
    expect(SWEEP_INCIDENT_KINDS).toContain("lane_fallthrough_rate");
  });

  it("opens per lane (subject = lane name) when half or more of ≥ 3 settled turns fell through; another lane is untouched", () => {
    laneTurn("memory", -60, "lane_reply"); laneTurn("memory", -50, "fallthrough:compose_failed"); laneTurn("memory", -40, "fallthrough:capped");
    laneTurn("status", -30, "lane_reply"); laneTurn("status", -20, "lane_reply"); laneTurn("status", -10, "fallthrough:error");
    expect(checkLaneFallthrough(store, iso(0))).toEqual([
      { lane: "memory", open: true, turns: 3, fallthroughs: 2 }, { lane: "status", open: false, turns: 3, fallthroughs: 1 }
    ]);
    sweep();
    expect(open().map((i) => i.subject)).toEqual(["memory"]);
  });

  it("needs the floor: two fall-throughs on a quiet day are noise", () => {
    laneTurn("memory", -20, "fallthrough:error"); laneTurn("memory", -10, "fallthrough:error");
    expect(checkLaneFallthrough(store, iso(0))[0]).toMatchObject({ open: false, turns: 2, fallthroughs: 2 });
  });

  it("exactly half opens (the bar is inclusive)", () => {
    laneTurn("status", -40, "lane_reply"); laneTurn("status", -30, "lane_reply");
    laneTurn("status", -20, "fallthrough:error"); laneTurn("status", -10, "fallthrough:error");
    expect(checkLaneFallthrough(store, iso(0))[0]).toMatchObject({ lane: "status", open: true, turns: 4, fallthroughs: 2 });
  });

  it("ignores planner rows and pending rows, and a row exactly one window old is out", () => {
    for (let k = 0; k < 4; k++) laneTurn("planner", -10 - k, "planner_failed");
    laneTurn("memory", -5, "pending"); laneTurn("memory", -4, "pending");
    laneTurn("memory", -24 * 60, "fallthrough:error");
    laneTurn("memory", -3, "fallthrough:error"); laneTurn("memory", -2, "fallthrough:error");
    expect(checkLaneFallthrough(store, iso(0))).toEqual([{ lane: "memory", open: false, turns: 2, fallthroughs: 2 }]);
  });

  it("is sticky: rows ageing out keep it open; only a lane reply after it opened clears it", () => {
    laneTurn("memory", -30, "fallthrough:error"); laneTurn("memory", -20, "fallthrough:error"); laneTurn("memory", -10, "lane_reply");
    sweep();
    expect(open()).toHaveLength(1);
    sweep(25 * 60); // every row is now outside the window
    expect(open()).toHaveLength(1);
    laneTurn("memory", 25 * 60 + 1, "lane_reply");
    sweep(26 * 60);
    expect(open()).toHaveLength(0);
  });

  it("a memory turn the planner closed (card failed after a committed save) ended on the planner, so it counts as a fall-through", () => {
    // Task 10: a memory card failure after the save leaves lane=memory pending; the run's terminal closes it planner_done /
    // planner_failed. Counting only `fallthrough:%` would read three planner-answered memory turns as a healthy lane.
    laneTurn("memory", -30, "planner_done"); laneTurn("memory", -20, "planner_failed"); laneTurn("memory", -10, "lane_reply");
    expect(checkLaneFallthrough(store, iso(0))).toEqual([{ lane: "memory", open: true, turns: 3, fallthroughs: 2 }]);
    sweep();
    expect(open().map((i) => i.subject)).toEqual(["memory"]);
  });

  it("a planner-closed memory turn never clears a sticky incident: only a lane reply does", () => {
    laneTurn("memory", -30, "fallthrough:error"); laneTurn("memory", -20, "fallthrough:error"); laneTurn("memory", -10, "lane_reply");
    sweep();
    laneTurn("memory", 25 * 60 + 1, "planner_done");
    sweep(26 * 60);
    expect(open()).toHaveLength(1);
  });

  it("a status render that threw is a status fall-through (fallthrough:render_failed), so a broken status renderer opens it", () => {
    for (const m of [-30, -20, -10]) laneTurn("status", m, "fallthrough:render_failed");
    expect(checkLaneFallthrough(store, iso(0))).toEqual([{ lane: "status", open: true, turns: 3, fallthroughs: 3 }]);
    sweep();
    expect(open().map((i) => i.subject)).toEqual(["status"]);
  });

  it("a lane reply from BEFORE the incident opened does not clear it", () => {
    laneTurn("memory", -40, "lane_reply"); laneTurn("memory", -30, "fallthrough:error"); laneTurn("memory", -20, "fallthrough:error");
    sweep();
    sweep(25 * 60);
    expect(open()).toHaveLength(1);
  });
});
