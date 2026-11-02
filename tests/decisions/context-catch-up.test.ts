import { describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { CATCH_UP_MAX_ENTRIES, CATCH_UP_REASONS, CONTEXT_CATCH_UP, type CatchUpInput } from "../../src/decisions/entries/context-catch-up.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";

const verdictOf = (s: CatchUpInput) => {
  const rows: Array<{ verdict: string; reason: string | null; rung: string }> = [];
  const recorder: DecisionRecorder = { record: (_e, r) => { rows.push({ verdict: r.verdict, reason: r.reason ?? null, rung: r.rung }); return null; } };
  decideSync(CONTEXT_CATCH_UP, s, { run_id: "r", tool_call_id: null, recorder });
  return rows;
};
const input = (read_failed: boolean, available: number, shown: number): CatchUpInput => ({ read_failed, available, shown });

describe("context.catch_up (spec R5 §4.2)", () => {
  it("is a rule-only pre_model entry over mixed input that records every consult (Decision 2-A)", () => {
    expect(CONTEXT_CATCH_UP).toMatchObject({ id: "context.catch_up", version: 1, stage: "pre_model", input: "mixed", verdicts: ["inject", "none"], defaultVerdict: "none", fail: "none", alwaysRecord: true, armed: { rule: "on" } });
    expect(CONTEXT_CATCH_UP.locked).toBeUndefined();
    expect(CATCH_UP_MAX_ENTRIES).toBe(6);
    expect(CATCH_UP_REASONS).toEqual(["all", "entry_capped", "trimmed", "all_trimmed", "read_failed"]);
  });
  it.each([
    [input(true, 3, 0), "none", "read_failed"],
    [input(false, 2, 2), "inject", "all"],
    [input(false, 6, 6), "inject", "all"],
    [input(false, 8, 6), "inject", "entry_capped"],
    [input(false, 8, 5), "inject", "trimmed"],
    [input(false, 3, 2), "inject", "trimmed"],
    [input(false, 1, 0), "none", "all_trimmed"]
  ] as const)("%o → %s / %s, one row at the rule rung", (s, verdict, reason) => {
    expect(verdictOf(s)).toEqual([{ verdict, reason, rung: "rule" }]);
  });
  it("inject ⇔ shown > 0 && !read_failed, over every combination", () => {
    for (const read_failed of [true, false]) for (let available = 0; available <= 8; available++) for (let shown = 0; shown <= Math.min(available, 6); shown++) {
      const [row] = verdictOf(input(read_failed, available, shown));
      expect(row!.verdict === "inject", `read_failed=${read_failed} available=${available} shown=${shown}`).toBe(shown > 0 && !read_failed);
    }
  });
});
