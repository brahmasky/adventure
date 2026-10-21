import { describe, expect, it } from "vitest";
import { APPROVAL_CAPABILITY, checkOutcomeValue, CORRECTION_VALUES, DIG_DEEPER_VALUES, outcomeValueOf, OutcomeRejected, PLANNER_FAILED_VALUES } from "../../src/decisions/outcomes.js";
import { SETTLE_DISCARDED_VALUES, SETTLE_REASONS } from "../../src/decisions/entries/turn-settle.js";
import { SETTLE_DISCARDED_VALUE_LIST, SETTLE_REASON_VALUES } from "../../src/decisions/outcomes.js";
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
  // Spec 2b-ii §2: the five dark signals get their closed sets. A capability is a registry name; a planner failure is the
  // PlannerFailure union plus the two finishRun literals P1 found (model_error, killed) and `other` for anything else.
  it("approval signals take a capability name; planner_failed the failure kinds; abandoned and lesson_unfollowed a lane", () => {
    expect(checkOutcomeValue("approval_denied", "shell_external")).toBe("shell_external");
    expect(checkOutcomeValue("approval_expired", "http_fetch")).toBe("http_fetch");
    for (const v of ["planner_exit", "model_error", "killed", "other"]) expect(checkOutcomeValue("planner_failed", v)).toBe(v);
    expect(checkOutcomeValue("abandoned", "answer")).toBe("answer");
    expect(checkOutcomeValue("lesson_unfollowed", "lookup")).toBe("lookup");
    for (const [s, v] of [["approval_denied", "Shell"], ["approval_denied", "rm -rf /"], ["approval_expired", "a".repeat(41)], ["planner_failed", "boom"],
      ["abandoned", "planner_exit"], ["lesson_unfollowed", "x"]] as const) expect(() => checkOutcomeValue(s, v)).toThrow(OutcomeRejected);
    expect(APPROVAL_CAPABILITY.test("a")).toBe(true);
    expect(PLANNER_FAILED_VALUES).toContain("lease_expired");
    expect(PLANNER_FAILED_VALUES.at(-1)).toBe("other");
  });
  // Rev 2 (both reviews): the inbox stores TEXT; rating and recurrence are checked as integers, so the stored text must come back as a number.
  it("outcomeValueOf turns a stored rating or recurrence back into the integer its check needs and leaves the rest as text", () => {
    expect(checkOutcomeValue("rating", outcomeValueOf("rating", "2"))).toBe("2");
    expect(checkOutcomeValue("recurrence", outcomeValueOf("recurrence", "3"))).toBe("3");
    expect(outcomeValueOf("correction", "answer")).toBe("answer");
    expect(() => checkOutcomeValue("rating", outcomeValueOf("rating", "x"))).toThrow(OutcomeRejected);
  });
  it("the duplicated value lists match their sources (categories; turn.handler's lanes)", () => {
    expect([...CORRECTION_VALUES]).toEqual([...CATEGORIES]);
    // The lane list is the `Lane` type (src/jev/tree-policy.ts); outcomes.ts pins it exhaustive at compile time (typecheck).
    expect([...DIG_DEEPER_VALUES]).toEqual(["answer", "lookup", "memory", "status", "planner"]);
    // outcomes.ts cannot import the entry (the store imports outcomes.ts), so turn.settle's lists are duplicated and pinned here
    expect([...SETTLE_REASON_VALUES]).toEqual([...SETTLE_REASONS]);
    expect([...SETTLE_DISCARDED_VALUE_LIST]).toEqual([...SETTLE_DISCARDED_VALUES]);
  });
});
