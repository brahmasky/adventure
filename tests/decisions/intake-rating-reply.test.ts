import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_RATING_REPLY } from "../../src/decisions/entries/intake-rating-reply.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_RATING_REPLY as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: null, tool_call_id: null, recorder };

describe("intake.rating_reply — an open rating ask that meets a message leaves one row for what happened to it", () => {
  it("is rule-only, unlocked, always recorded, reads Paco's own message, sound", () => {
    expect(INTAKE_RATING_REPLY.locked).toBeUndefined();
    expect(INTAKE_RATING_REPLY.alwaysRecord).toBe(true);
    expect(INTAKE_RATING_REPLY.input).toBe("paco");
    expect(INTAKE_RATING_REPLY.reasonCodes).toEqual(["bare_digit", "digit_comment", "not_rating"]);
    expect(entryProblems(INTAKE_RATING_REPLY as unknown as AnyEntry)).toEqual([]);
  });
  it.each([["consume", "bare_digit"], ["forward", "digit_comment"], ["lapse", "not_rating"]] as const)("%s → reason %s (a 1:1 map), recorded", (outcome, reason) => {
    expect(decideSync(INTAKE_RATING_REPLY, { outcome }, ctx)).toMatchObject({ verdict: outcome, reason });
    expect(rows).toEqual([{ verdict: outcome, reason }]);
  });
});
