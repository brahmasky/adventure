import { describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { MODEL_REASONS, TURN_MODEL, type ModelInput } from "../../src/decisions/entries/turn-model.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const verdictOf = (s: ModelInput) => {
  const rows: Array<{ verdict: string; reason: string | null; rung: string }> = [];
  const recorder: DecisionRecorder = { record: (_e, r) => { rows.push({ verdict: r.verdict, reason: r.reason ?? null, rung: r.rung }); return null; } };
  decideSync(TURN_MODEL, s, { run_id: "r", tool_call_id: null, recorder });
  return rows;
};

const cases: Array<[ModelInput, string, string | null]> = [
  [{ leg: "first", outcome: "ok", stepped: false, refused: 0 }, "head", null],
  [{ leg: "first", outcome: "ok", stepped: false, refused: 1 }, "fallback", "refused"],
  [{ leg: "first", outcome: "ok", stepped: true, refused: 2 }, "fallback", "stepped_up"],
  [{ leg: "retry", outcome: "ok", stepped: false, refused: 0 }, "fallback", "next_leg"],
  [{ leg: "retry", outcome: "ok", stepped: false, refused: 1 }, "fallback", "refused"],
  [{ leg: "first", outcome: "pin_failed", stepped: false, refused: 0 }, "held", "pin_failed"],
  [{ leg: "retry", outcome: "pin_failed", stepped: false, refused: 0 }, "none", "pin_failed"],
  [{ leg: "first", outcome: "exhausted", stepped: true, refused: 3 }, "none", "no_leg"],
  // precedence: pin_failed outranks stepped and refused (first match, spec R6 §4.3); both inputs are reachable in production
  [{ leg: "first", outcome: "pin_failed", stepped: true, refused: 1 }, "held", "pin_failed"],
  [{ leg: "retry", outcome: "pin_failed", stepped: false, refused: 1 }, "none", "pin_failed"],
];

describe("turn.model (spec R6 §4.3)", () => {
  it("is a rule-only pre_model entry over tool input; the routine head writes no row (Decision 1-A)", () => {
    expect(TURN_MODEL).toMatchObject({ id: "turn.model", version: 1, stage: "pre_model", input: "tool", verdicts: ["head", "fallback", "held", "none"], defaultVerdict: "head", fail: "head", armed: { rule: "on" } });
    expect(TURN_MODEL.alwaysRecord).toBeUndefined();
    expect(TURN_MODEL.locked).toBeUndefined();
    expect(MODEL_REASONS).toEqual(["stepped_up", "refused", "next_leg", "pin_failed", "no_leg"]);
  });
  it.each(cases)("%o → %s / %s", (s, verdict, reason) => {
    expect(verdictOf(s)).toEqual([{ verdict, reason, rung: "rule" }]);
  });
  it("through the store recorder: head writes no row, fallback writes one", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createQueuedTurnRun(store, "q");
      const recorder = storeRecorder(store);
      decideSync(TURN_MODEL, { leg: "first", outcome: "ok", stepped: false, refused: 0 }, { run_id: run, tool_call_id: null, recorder });
      expect(store.listDecisionsForRun(run)).toEqual([]);
      decideSync(TURN_MODEL, { leg: "first", outcome: "ok", stepped: false, refused: 1 }, { run_id: run, tool_call_id: null, recorder });
      expect(store.listDecisionsForRun(run).map((r) => [r.entry_id, r.verdict, r.reason_code, r.rung])).toEqual([["turn.model", "fallback", "refused", "rule"]]);
    } finally { store.close(); }
  });
});
