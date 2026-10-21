import { describe, expect, it } from "vitest";
import { buildPickQuestion, parsePick, PICK_DISCIPLINE } from "../../src/improve/pick.js";

// Spec §4.3 rung 3: one word among Jev's top two, from the same redacted state; anything else is not an answer.
const s = { signal: "correction", value: "answer", scope: "answer", count: 2, count_14d: 3, category: "answer", lane: "answer", capability: null, paco_text: "shorter please",
  tools: "read 1", last_improvement: "none", applicable: ["nothing", "lesson", "fact", "tool_gap", "ladder"] as const };
describe("the Tiny pick", () => {
  it("the question names the two options and carries only the redacted state; the discipline asks for one word", () => {
    const q = buildPickQuestion(s as never, ["lesson", "fact"]);
    expect(q).toContain("lesson"); expect(q).toContain("fact"); expect(q).toContain("shorter please"); expect(q).toContain("count_14d: 3");
    expect(PICK_DISCIPLINE).toMatch(/one word/i);
  });
  it("parses exactly one of the two words, trimmed and case-folded; prose, a third option or two words are null", () => {
    expect(parsePick("lesson", ["lesson", "fact"])).toBe("lesson");
    expect(parsePick("  Fact.\n", ["lesson", "fact"])).toBe("fact");
    expect(parsePick("I think lesson", ["lesson", "fact"])).toBeNull();
    expect(parsePick("skill", ["lesson", "fact"])).toBeNull();
    expect(parsePick("lesson fact", ["lesson", "fact"])).toBeNull();
  });
});
