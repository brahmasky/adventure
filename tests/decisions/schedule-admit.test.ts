import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { SCHEDULE_ADMIT, type ScheduleAdmitInput } from "../../src/decisions/entries/schedule-admit.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(SCHEDULE_ADMIT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const run = (s: ScheduleAdmitInput) => decideSync(SCHEDULE_ADMIT, s, { run_id: "r", tool_call_id: null, recorder });

describe("schedule.admit — every schedule_task change the model makes leaves an audit row (Decision 2-A)", () => {
  it("is rule-only, unlocked, always recorded, sound", () => {
    expect(SCHEDULE_ADMIT.locked).toBeUndefined();
    expect(SCHEDULE_ADMIT.alwaysRecord).toBe(true);
    expect(SCHEDULE_ADMIT.reasonCodes).toEqual(["create", "update", "cancel", "no_chat", "not_found", "cap"]);
    expect(entryProblems(SCHEDULE_ADMIT as unknown as AnyEntry)).toEqual([]);
  });
  it.each(["create", "update", "cancel"] as const)("admit %s → admit with the verb as reason, recorded", (verb) => {
    expect(run({ verb, outcome: "admit" })).toMatchObject({ verdict: "admit", reason: verb });
    expect(rows).toEqual([{ verdict: "admit", reason: verb }]);
  });
  it("a duplicate create → exists/create", () => {
    expect(run({ verb: "create", outcome: "exists" })).toMatchObject({ verdict: "exists", reason: "create" });
  });
  it.each([["none", "no_chat"], ["cancel", "not_found"], ["update", "not_found"], ["create", "cap"]] as const)("refuse %s/%s → refuse with the code", (verb, code) => {
    expect(run({ verb, outcome: "refuse", code })).toMatchObject({ verdict: "refuse", reason: code });
    expect(rows).toEqual([{ verdict: "refuse", reason: code }]);
  });
});
