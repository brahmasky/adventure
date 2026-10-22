import { describe, expect, it } from "vitest";
import { decide } from "../../src/decisions/decide.js";
import { checkOutcomeValue, OutcomeRejected } from "../../src/decisions/outcomes.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { Entry } from "../../src/decisions/types.js";
import { RunStore } from "../../src/run/run-store.js";

// The ledger must say which passage a p came from and whether the noise band re-asked, or the digest cannot count re-asks
// and the calibration evidence credits a mean to a single call. A malformed index or re-ask from an executor is untrusted
// input and must parse-fail, never reach the row.
type V = "pass" | "withhold";
const E: Entry<null, V> = {
  id: "test.judge", version: 1, stage: "post_tool", input: "tool", question: "q", verdicts: ["pass", "withhold"],
  ladder: [{ kind: "rule", name: "floor", decide: () => ({ abstain: true }) },
    { kind: "system_one", name: "j", questions: [], bars: { kind: "provisional", question: "q", criteriaHash: "h", p: 0.5, source: "s" }, timeoutMs: 100 }],
  fail: "pass", monotone: { order: ["pass", "withhold"] }, defaultVerdict: "pass", alwaysRecord: true, outcomes: [], armed: { rule: "on", system_one: "on" },
  effects: { pass: { kind: "none", reversible: true, announced: "none" }, withhold: { kind: "tighten", reversible: true, announced: "none" } }, reasonCodes: []
};

describe("pIndex and reask through the runner", () => {
  it("lands both on the decisions row", async () => {
    const store = RunStore.openInMemory();
    const r = await decide(E, null, { run_id: null, recorder: storeRecorder(store),
      exec: { system_one: async () => ({ verdict: "withhold", p: 0.72, pIndex: 4, reask: { kind: "mean", pFirst: 0.66 } }) } });
    expect(r).toMatchObject({ verdict: "withhold", pIndex: 4, reask: { kind: "mean", pFirst: 0.66 } });
    expect(store.getDecision(r.decisionId!)).toMatchObject({ p: 0.72, p_index: 4, reask: "mean", p_first: 0.66 });
    store.close();
  });
  it("keeps a re-ask recorded on an abstaining judge (the mean landed below the bar and a later rung decided)", async () => {
    const store = RunStore.openInMemory();
    const r = await decide(E, null, { run_id: null, recorder: storeRecorder(store),
      exec: { system_one: async () => ({ abstain: true, reask: { kind: "failed", pFirst: 0.55 } }) } });
    expect(r.rung).toBe("fail");
    expect(store.getDecision(r.decisionId!)).toMatchObject({ reask: "failed", p_first: 0.55 });
    store.close();
  });
  it("parse-fails a negative or fractional index and a malformed re-ask", async () => {
    for (const bad of [{ verdict: "pass", pIndex: -1 }, { verdict: "pass", pIndex: 1.5 }, { verdict: "pass", reask: { kind: "thrice", pFirst: 0.5 } },
      { verdict: "pass", reask: { kind: "mean", pFirst: 2 } }]) {
      const r = await decide(E, null, { run_id: null, recorder: { record: () => null }, exec: { system_one: async () => bad as never } });
      expect(r.fallbackReason).toBe("parse");
    }
  });
});

describe("the two new outcome signals (Addition A)", () => {
  it("lesson_undone takes a lane; think_harder takes a planner role; anything else is refused", () => {
    expect(checkOutcomeValue("lesson_undone", "memory")).toBe("memory");
    expect(checkOutcomeValue("think_harder", "fast")).toBe("fast");
    expect(() => checkOutcomeValue("lesson_undone", "hostile")).toThrow(OutcomeRejected);
    expect(() => checkOutcomeValue("think_harder", "turbo")).toThrow(OutcomeRejected);
  });
});
