import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { CRASH_LIMIT, CRASH_WINDOW_MS, PLANNER_CRASH_GUARD } from "../../src/decisions/entries/planner-crash-guard.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(PLANNER_CRASH_GUARD as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: "r", tool_call_id: null, recorder };

describe("planner.crash_guard — 3 crash exits in 10 min halt spawning until re-armed (D2)", () => {
  it("is rule-only, unlocked, supervision, tool input, fails to halt, sound; the limits are today's", () => {
    expect(PLANNER_CRASH_GUARD.locked).toBeUndefined();
    expect(LOCKED_ENTRY_IDS).not.toContain("planner.crash_guard");
    expect(PLANNER_CRASH_GUARD.stage).toBe("supervision");
    expect(PLANNER_CRASH_GUARD.input).toBe("tool");
    expect(PLANNER_CRASH_GUARD.fail).toBe("halt");
    expect(PLANNER_CRASH_GUARD.defaultVerdict).toBe("spawn");
    expect(PLANNER_CRASH_GUARD.alwaysRecord).toBeUndefined();
    expect(PLANNER_CRASH_GUARD.reasonCodes).toEqual(["limit_reached", "latched"]);
    expect(PLANNER_CRASH_GUARD.effects.halt).toMatchObject({ kind: "tighten", reversible: true });
    expect(CRASH_LIMIT).toBe(3); expect(CRASH_WINDOW_MS).toBe(600_000);
    expect(entryProblems(PLANNER_CRASH_GUARD as unknown as AnyEntry)).toEqual([]);
  });
  it("latched → halt/latched, recorded (latched wins over a full window)", () => {
    expect(decideSync(PLANNER_CRASH_GUARD, { latched: true, recent: 5 }, ctx)).toMatchObject({ verdict: "halt", reason: "latched" });
    expect(rows).toEqual([{ verdict: "halt", reason: "latched" }]);
  });
  it("three recent exits → halt/limit_reached, recorded", () => {
    expect(decideSync(PLANNER_CRASH_GUARD, { latched: false, recent: 3 }, ctx)).toMatchObject({ verdict: "halt", reason: "limit_reached" });
    expect(rows).toEqual([{ verdict: "halt", reason: "limit_reached" }]);
  });
  it("two recent exits → spawn, not recorded", () => {
    expect(decideSync(PLANNER_CRASH_GUARD, { latched: false, recent: 2 }, ctx).verdict).toBe("spawn");
    expect(rows).toEqual([]);
  });
});
