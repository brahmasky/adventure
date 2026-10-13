import { describe, expect, it } from "vitest";
import { classifyTap, mergeLabels, mustLabel, tapLabels, tapLines } from "../../src/jev/tap-labels.js";
import type { TapOutcomeRow } from "../../src/run/run-store.js";

// Plan Rulings 7–8: a tap is a label only where it says which question was wrong. ✅ on a lane route names the category;
// everything else is evidence that sends the turn to the next sitting. Paco's sitting labels always win; nothing here
// commits a row or moves a bar (SP4).
const T = (o: Partial<TapOutcomeRow>): TapOutcomeRow => ({ outcome_id: "o", signal: "review_ok", value: "turn.handler", source: "paco", created_at: "2026-10-13T00:00:00.000Z",
  decision_id: "d", entry_id: "turn.handler", run_id: "run_1", verdict: "lookup", p: 0.66, ...o });
const turnOf = (run: string) => ({ run_1: "t1", run_2: "t2", run_3: "t3", run_4: "t4", run_5: "t5" } as Record<string, string>)[run];

describe("classifyTap — the mapping table", () => {
  it("maps every tap to its evidence kind", () => {
    expect(classifyTap(T({}))).toBe("lane_right");
    expect(classifyTap(T({ signal: "review_bad" }))).toBe("lane_wrong");
    expect(classifyTap(T({ verdict: "planner" }))).toBe("planner_right");
    expect(classifyTap(T({ verdict: "planner", signal: "review_bad" }))).toBe("planner_wrong");
    expect(classifyTap(T({ entry_id: "turn.gear", verdict: "fast" }))).toBe("gear_right");
    expect(classifyTap(T({ signal: "dig_deeper", value: "lookup" }))).toBe("dig_deeper");
    expect(classifyTap(T({ signal: "lesson_undone", value: "memory" }))).toBe("save_undone");
    expect(classifyTap(T({ signal: "think_harder", value: "fast", entry_id: "turn.gear" }))).toBe("gear_too_low");
    expect(classifyTap(T({ entry_id: "tool.injection" }))).toBeNull();
  });
  it("a code-written row is never a tap: only Paco's taps are labels or evidence", () => {
    expect(classifyTap(T({ source: "code" }))).toBeNull();
  });
});

describe("tapLabels", () => {
  const rows = [T({}), T({ run_id: "run_2", signal: "review_bad", verdict: "answer" }), T({ run_id: "run_3", signal: "lesson_undone", value: "memory", verdict: "memory" }),
    T({ run_id: "run_4", signal: "dig_deeper", value: "lookup" }), T({ run_id: "run_9", verdict: "status" })];
  it("only ✅ on a lane route becomes a category label; a run outside the replay file is evidence only", () => {
    const t = tapLabels(rows, turnOf);
    expect([...t.positive.entries()]).toEqual([["t1", { category: "lookup", by: "tap", at: "2026-10-13T00:00:00.000Z" }]]);
    expect(t.evidence.map((e) => e.kind)).toEqual(["lane_right", "lane_wrong", "save_undone", "dig_deeper", "lane_right"]);
  });
  it("Paco's sitting label wins on the same turn", () => {
    const merged = mergeLabels(new Map([["t1", { category: "research" as const, by: "paco" as const, at: "x" }]]), tapLabels(rows, turnOf));
    expect(merged.get("t1")?.category).toBe("research");
  });
  it("wrong, Dig deeper and Undo turns go on the next sitting's must-label list", () => {
    expect([...mustLabel(tapLabels(rows, turnOf))].sort()).toEqual(["t2", "t3", "t4"]);
  });
  it("prints the evidence lines", () => {
    const lines = tapLines(tapLabels(rows, turnOf)).join("\n");
    expect(lines).toContain("TAP LABELS");
    expect(lines).toContain("positive category labels (✅ on a lane route): 1");
    expect(lines).toContain("not in the replay file (re-run the replay to include): 1");
  });
});
