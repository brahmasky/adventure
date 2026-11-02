import { describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { CONTEXT_RECALL, RECALL_REASONS, type RecallInput } from "../../src/decisions/entries/context-recall.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";

const none: RecallInput = { embedding: true, facts: 0, pages: 0, best_admitted: null, best_rejected: null };
const verdictOf = (s: RecallInput) => {
  const rows: Array<{ verdict: string; reason: string | null; rung: string }> = [];
  const recorder: DecisionRecorder = { record: (_e, r) => { rows.push({ verdict: r.verdict, reason: r.reason ?? null, rung: r.rung }); return null; } };
  decideSync(CONTEXT_RECALL, s, { run_id: "r", tool_call_id: null, recorder });
  return rows;
};

describe("context.recall (spec R5 §4.1)", () => {
  it("is a rule-only pre_model entry over mixed input that records every consult (Decision 1-A)", () => {
    expect(CONTEXT_RECALL).toMatchObject({ id: "context.recall", version: 1, stage: "pre_model", input: "mixed", verdicts: ["include", "none"], defaultVerdict: "none", fail: "none", alwaysRecord: true, armed: { rule: "on" } });
    expect(CONTEXT_RECALL.locked).toBeUndefined();
    expect(RECALL_REASONS).toEqual(["embedded", "fts_only", "embed_failed", "dropped_after_gate", "below_gate", "unscored"]);
  });
  it.each([
    [{ ...none, facts: 2 }, "include", "embedded"],
    [{ ...none, embedding: false, pages: 1 }, "include", "fts_only"],
    [{ ...none, embedding: false, best_rejected: 0.3 }, "none", "embed_failed"],
    [{ ...none, best_admitted: 0.8, best_rejected: 0.2 }, "none", "dropped_after_gate"],
    [{ ...none, best_rejected: 0.3 }, "none", "below_gate"],
    [none, "none", "unscored"]
  ] as const)("%o → %s / %s, one row at the rule rung", (s, verdict, reason) => {
    expect(verdictOf(s)).toEqual([{ verdict, reason, rung: "rule" }]);
  });
  it("include ⇔ something rendered, over every combination", () => {
    for (const embedding of [true, false]) for (const facts of [0, 1]) for (const pages of [0, 1]) for (const b of [null, 0.4]) {
      const [row] = verdictOf({ embedding, facts, pages, best_admitted: b, best_rejected: b });
      expect(row!.verdict === "include").toBe(facts + pages > 0);
    }
  });
});
