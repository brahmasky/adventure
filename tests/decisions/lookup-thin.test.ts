import { describe, expect, it } from "vitest";
import type { ThinInput } from "../../src/core/lanes/lookup-predicates.js";
import { decideSync } from "../../src/decisions/decide.js";
import { LOOKUP_THIN } from "../../src/decisions/entries/lookup-thin.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const verdictOf = (s: ThinInput) => {
  const rows: Array<{ verdict: string; reason: string | null; rung: string }> = [];
  const recorder: DecisionRecorder = { record: (_e, r) => { rows.push({ verdict: r.verdict, reason: r.reason ?? null, rung: r.rung }); return null; } };
  decideSync(LOOKUP_THIN, s, { run_id: "r", tool_call_id: null, recorder });
  return rows;
};

describe("lookup.thin (spec R6 §4.2)", () => {
  it("is a rule-only pre_model entry over tool input that records every consult (Decision 2-A)", () => {
    expect(LOOKUP_THIN).toMatchObject({ id: "lookup.thin", version: 1, stage: "pre_model", input: "tool", verdicts: ["fetch", "none"], defaultVerdict: "none", fail: "none", alwaysRecord: true, armed: { rule: "on" } });
    expect(LOOKUP_THIN.locked).toBeUndefined();
    expect(LOOKUP_THIN.reasonCodes).toEqual(["thin", "answered", "no_url"]);
  });
  it.each([
    [{ answered: false, url: true }, "fetch", "thin"],
    [{ answered: true, url: true }, "none", "answered"],
    [{ answered: true, url: false }, "none", "answered"],
    [{ answered: false, url: false }, "none", "no_url"]
  ] as const)("%o → %s / %s, one row at the rule rung", (s, verdict, reason) => {
    expect(verdictOf(s)).toEqual([{ verdict, reason, rung: "rule" }]);
  });
  it("the default none/answered still writes a row through the store recorder (alwaysRecord)", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createQueuedTurnRun(store, "q");
      decideSync(LOOKUP_THIN, { answered: true, url: true }, { run_id: run, tool_call_id: null, recorder: storeRecorder(store) });
      expect(store.listDecisionsForRun(run).map((r) => [r.entry_id, r.verdict, r.reason_code, r.rung])).toEqual([["lookup.thin", "none", "answered", "rule"]]);
    } finally { store.close(); }
  });
});
