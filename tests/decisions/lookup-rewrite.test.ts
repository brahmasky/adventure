import { describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { LOOKUP_REWRITE, REWRITE_STEPS, type RewriteInput } from "../../src/decisions/entries/lookup-rewrite.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const verdictOf = (s: RewriteInput) => {
  const rows: Array<{ verdict: string; reason: string | null; rung: string }> = [];
  const recorder: DecisionRecorder = { record: (_e, r) => { rows.push({ verdict: r.verdict, reason: r.reason ?? null, rung: r.rung }); return null; } };
  decideSync(LOOKUP_REWRITE, s, { run_id: "r", tool_call_id: null, recorder });
  return rows;
};

describe("lookup.rewrite (spec R6 §4.1)", () => {
  it("is a rule-only pre_model entry over mixed input that records every consult (Decision 2-A)", () => {
    expect(LOOKUP_REWRITE).toMatchObject({ id: "lookup.rewrite", version: 1, stage: "pre_model", input: "mixed", verdicts: ["rewrite", "bare"], defaultVerdict: "bare", fail: "bare", alwaysRecord: true, armed: { rule: "on" } });
    expect(LOOKUP_REWRITE.locked).toBeUndefined();
    expect(REWRITE_STEPS).toEqual(["rewritten", "no_recent_line", "long_message", "no_time", "late", "failed", "same", "invalid"]);
    expect(LOOKUP_REWRITE.reasonCodes).toEqual([...REWRITE_STEPS]);
  });
  it.each(REWRITE_STEPS.map((step) => [step, step === "rewritten" ? "rewrite" : "bare"] as const))("step %s → %s / the step, one row at the rule rung", (step, verdict) => {
    expect(verdictOf({ step })).toEqual([{ verdict, reason: step, rung: "rule" }]);
  });
  it("the default bare/same still writes a row through the store recorder (alwaysRecord)", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createQueuedTurnRun(store, "q");
      decideSync(LOOKUP_REWRITE, { step: "same" }, { run_id: run, tool_call_id: null, recorder: storeRecorder(store) });
      expect(store.listDecisionsForRun(run).map((r) => [r.entry_id, r.verdict, r.reason_code, r.rung])).toEqual([["lookup.rewrite", "bare", "same", "rule"]]);
    } finally { store.close(); }
  });
});
