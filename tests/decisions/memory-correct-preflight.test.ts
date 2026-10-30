import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { MEMORY_CORRECT_PREFLIGHT, MEMORY_CORRECT_REFUSALS } from "../../src/decisions/entries/memory-correct-preflight.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(MEMORY_CORRECT_PREFLIGHT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });

describe("memory.correct_preflight — a memory correction refused by a trust limit leaves a row", () => {
  it("is rule-only, unlocked, refusal-only, sound", () => {
    expect(MEMORY_CORRECT_PREFLIGHT.locked).toBeUndefined();
    expect(MEMORY_CORRECT_PREFLIGHT.alwaysRecord).toBeUndefined();
    expect(MEMORY_CORRECT_PREFLIGHT.reasonCodes).toEqual(["not_operator_turn", "tainted_turn", "too_many", "not_offered"]);
    expect(entryProblems(MEMORY_CORRECT_PREFLIGHT as unknown as AnyEntry)).toEqual([]);
  });
  it("allowed → allow, not recorded", () => {
    expect(decideSync(MEMORY_CORRECT_PREFLIGHT, { refused: null }, { run_id: "r", tool_call_id: null, recorder }).verdict).toBe("allow");
    expect(rows).toEqual([]);
  });
  it.each([...MEMORY_CORRECT_REFUSALS])("refused %s → refuse with that reason", (code) => {
    expect(decideSync(MEMORY_CORRECT_PREFLIGHT, { refused: code }, { run_id: "r", tool_call_id: null, recorder })).toMatchObject({ verdict: "refuse", reason: code });
    expect(rows).toEqual([{ verdict: "refuse", reason: code }]);
  });
});
