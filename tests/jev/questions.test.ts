import { describe, expect, it } from "vitest";
import { criteriaHash, toJevQuestion, type ChoiceQuestion, type NoulQuestion, type ScoreQuestion } from "../../src/jev/questions/types.js";

const q = (criteria: ReadonlyArray<readonly [string, string]>): ChoiceQuestion => ({ id: "t", type: "choice", instructions: "pick", criteria });

describe("criteriaHash (spec §3.1: option ORDER is a calibration variable; the model is a separate key)", () => {
  it("changes when options are reordered or a word changes; does not depend on the model", () => {
    const a = criteriaHash(q([["none", "n"], ["memory", "m"]]));
    expect(a).not.toBe(criteriaHash(q([["memory", "m"], ["none", "n"]])));
    expect(a).not.toBe(criteriaHash({ ...q([["none", "n"], ["memory", "m"]]), instructions: "pick one" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("renders the criteria object in listed order", () => {
    expect(Object.keys(toJevQuestion(q([["none", "n"], ["status", "s"], ["memory", "m"]])).criteria ?? {})).toEqual(["none", "status", "memory"]);
  });
});

// Spec §2.3: `Question` is a union over TypeSafe's three types. The hash is the calibration key: a choice question must
// hash byte-identically to the choice-only hash (or every committed calibration row silently disarms), and each new
// shape must hash its own exact request so a wording or level edit disarms that question.
describe("criteriaHash over the question union", () => {
  it("a choice question hashes exactly as before the union (pinned: lane 1's committed `scope` row)", () => {
    // A literal copy of lane 1's TRIAGE_SCOPE, so the pin survives that module's removal; the hash is calibration.ts's.
    const scope: ChoiceQuestion = {
      id: "scope", type: "choice",
      instructions: "If `latest_message` is a preference or correction, which part of Houge's behaviour is it about?",
      criteria: [
        ["ask", "How Houge replies in conversation: length, tone, language, format, what to include or leave out."],
        ["research", "How Houge searches, which sources it trusts, or how it cites and reports what it found."]
      ]
    };
    expect(criteriaHash(scope)).toBe("d3f6c9008b3eaf1e7a4556dd443e422703f8c306932c88de2abf46ff3763e7a4");
  });
  it("a score hashes its ordered levels; reordering or rewording a level changes it", () => {
    const s: ScoreQuestion = { id: "breadth", type: "score", instructions: "How much ground?", levels: ["one known thing", "one topic", "several topics", "open-ended"] };
    const h = criteriaHash(s);
    expect(h).not.toBe(criteriaHash({ ...s, levels: ["one topic", "one known thing", "several topics", "open-ended"] }));
    expect(h).not.toBe(criteriaHash({ ...s, levels: ["one known thing", "one topic", "several topics", "open ended"] }));
    expect(h).not.toBe(criteriaHash({ ...s, instructions: "How much ground does it cover?" }));
  });
  it("a noul hashes its criteria when present; the type is in every hash", () => {
    const n: NoulQuestion = { id: "sets_rule", type: "noul", instructions: "A rule?" };
    expect(criteriaHash(n)).not.toBe(criteriaHash({ ...n, criteria: { true: "yes", false: "no" } }));
    expect(criteriaHash({ ...n, criteria: { true: "yes", false: "no" } })).not.toBe(criteriaHash({ ...n, criteria: { true: "no", false: "yes" } }));
    const asScore: ScoreQuestion = { id: "x", type: "score", instructions: "pick", levels: ["n", "m"] };
    expect(criteriaHash(asScore)).not.toBe(criteriaHash(q([["n", "n"], ["m", "m"]])));
  });
  it("toJevQuestion renders each type's wire shape", () => {
    expect(toJevQuestion({ id: "a", type: "score", instructions: "i", levels: ["x", "y"] })).toEqual({ type: "score", instructions: "i", criteria: ["x", "y"] });
    expect(toJevQuestion({ id: "b", type: "noul", instructions: "i" })).toEqual({ type: "noul", instructions: "i" });
    expect(toJevQuestion({ id: "c", type: "noul", instructions: "i", criteria: { true: "t", false: "f" } })).toEqual({ type: "noul", instructions: "i", criteria: { true: "t", false: "f" } });
  });
});
