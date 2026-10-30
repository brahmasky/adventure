import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { MEMORY_ADMIT_REASONS, MEMORY_LESSON_ADMIT } from "../../src/decisions/entries/memory-lesson-admit.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(MEMORY_LESSON_ADMIT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });

describe("memory.lesson_admit — a refused memory save leaves a row naming the code check that refused it", () => {
  it("is rule-only, unlocked (§6.1 has no L for B23), refusal-only, sound", () => {
    expect(MEMORY_LESSON_ADMIT.locked).toBeUndefined();
    expect(MEMORY_LESSON_ADMIT.alwaysRecord).toBeUndefined();
    expect(MEMORY_LESSON_ADMIT.input).toBe("mixed"); // the backstop seam judges model output (spec R6)
    expect(MEMORY_LESSON_ADMIT.reasonCodes).toEqual(["scheduled_run", "already_saved", "code_owned", "lesson_backstop", "fact_backstop", "fact_no_evidence"]);
    expect(MEMORY_LESSON_ADMIT.ladder.map((r) => r.kind)).toEqual(["rule"]);
    expect(entryProblems(MEMORY_LESSON_ADMIT as unknown as AnyEntry)).toEqual([]);
  });
  it("nothing refused → admit, not recorded (a save is already a lesson_saved/fact_saved event)", () => {
    expect(decideSync(MEMORY_LESSON_ADMIT, { seam: "pre" }, { run_id: "r", tool_call_id: null, recorder }).verdict).toBe("admit");
    expect(rows).toEqual([]);
  });
  it.each([...MEMORY_ADMIT_REASONS])("refused %s → refuse with that reason, recorded", (code) => {
    expect(decideSync(MEMORY_LESSON_ADMIT, { seam: "backstop", refused: code }, { run_id: "r", tool_call_id: null, recorder })).toMatchObject({ verdict: "refuse", reason: code });
    expect(rows).toEqual([{ verdict: "refuse", reason: code }]);
  });
});
