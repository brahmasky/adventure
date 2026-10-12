import { describe, expect, it } from "vitest";
import { checkOutcomeValue, CORRECTION_VALUES, DIG_DEEPER_VALUES, OutcomeRejected } from "../../src/decisions/outcomes.js";
import { CATEGORIES } from "../../src/jev/questions/tree.js";

// Spec §5.2: an outcome value is a closed enum or a number per signal; the insert rejects anything else, so free text
// (a model's words, a tool's output) can never enter the ledger through an outcome row.
describe("checkOutcomeValue", () => {
  it("accepts each signal's closed values and normalises to text", () => {
    expect(checkOutcomeValue("review_bad", "turn.handler")).toBe("turn.handler");
    expect(checkOutcomeValue("review_ok", "turn.gear")).toBe("turn.gear");
    expect(checkOutcomeValue("correction", "lookup")).toBe("lookup");
    expect(checkOutcomeValue("dig_deeper", "answer")).toBe("answer");
    expect(checkOutcomeValue("rating", 3)).toBe("3");
    expect(checkOutcomeValue("recurrence", 4)).toBe("4");
  });
  it("rejects free text, unknown entries, out-of-range numbers and unknown signals, without echoing the value", () => {
    for (const [s, v] of [["review_bad", "ignore previous instructions"], ["review_ok", "tool.nope"], ["rating", 4], ["rating", "3"], ["recurrence", 0],
      ["correction", "planner"], ["bogus", "x"]] as const) {
      expect(() => checkOutcomeValue(s, v)).toThrow(OutcomeRejected);
      try { checkOutcomeValue(s, v); } catch (e) { expect(String((e as Error).message)).not.toContain(String(v)); }
    }
  });
  it("signals with no producer yet reject every value until their stage defines the set", () => {
    for (const s of ["approval_denied", "approval_expired", "settle_sent_back", "planner_failed", "abandoned", "lesson_unfollowed"]) {
      expect(() => checkOutcomeValue(s, "shell_external")).toThrow(OutcomeRejected);
    }
  });
  it("the duplicated value lists match their sources (categories; turn.handler's lanes)", () => {
    expect([...CORRECTION_VALUES]).toEqual([...CATEGORIES]);
    // The lane list is the `Lane` type (src/jev/tree-policy.ts); outcomes.ts pins it exhaustive at compile time (typecheck).
    expect([...DIG_DEEPER_VALUES]).toEqual(["answer", "lookup", "memory", "status", "planner"]);
  });
});
