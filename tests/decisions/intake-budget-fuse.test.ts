import { beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_BUDGET_KINDS } from "../../src/budget/global-budget-ledger.js";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_BUDGET_FUSE } from "../../src/decisions/entries/intake-budget-fuse.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_BUDGET_FUSE as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: null, tool_call_id: null, recorder };

describe("intake.budget_fuse — a run the global 24h fuse refuses leaves a row (ADR 0003, locked)", () => {
  it("is locked, rule-only, refusal-only, sound", () => {
    expect(INTAKE_BUDGET_FUSE.locked).toBe(true);
    expect(LOCKED_ENTRY_IDS).toContain("intake.budget_fuse");
    expect(INTAKE_BUDGET_FUSE.alwaysRecord).toBeUndefined();
    expect(INTAKE_BUDGET_FUSE.reasonCodes).toEqual([...GLOBAL_BUDGET_KINDS]);
    expect(entryProblems(INTAKE_BUDGET_FUSE as unknown as AnyEntry)).toEqual([]);
  });
  it("no breach → admit, not recorded (an admitted run is already a global_budget_events row)", () => {
    expect(decideSync(INTAKE_BUDGET_FUSE, { breached: [] }, ctx).verdict).toBe("admit");
    expect(rows).toEqual([]);
  });
  it.each([...GLOBAL_BUDGET_KINDS])("%s breached → refuse with that kind", (kind) => {
    expect(decideSync(INTAKE_BUDGET_FUSE, { breached: [kind] }, ctx)).toMatchObject({ verdict: "refuse", reason: kind });
  });
  it("two kinds breached → the first one is the row's reason (the full list stays in the global_budget_fuse event)", () => {
    expect(decideSync(INTAKE_BUDGET_FUSE, { breached: ["tool_calls", "gated_attempts"] }, ctx)).toMatchObject({ verdict: "refuse", reason: "tool_calls" });
  });
});
