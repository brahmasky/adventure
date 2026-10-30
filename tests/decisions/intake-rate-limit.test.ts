import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_RATE_LIMIT, INTAKE_RATE_LIMIT_REASONS } from "../../src/decisions/entries/intake-rate-limit.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_RATE_LIMIT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: null, tool_call_id: null, recorder };

describe("intake.rate_limit — a Telegram command the per-chat limiter refuses leaves a row naming the check", () => {
  it("is rule-only, unlocked, refusal-only, fails to limit (consulted only after a denial), sound", () => {
    expect(INTAKE_RATE_LIMIT.locked).toBeUndefined();
    expect(INTAKE_RATE_LIMIT.alwaysRecord).toBeUndefined();
    expect(INTAKE_RATE_LIMIT.stage).toBe("intake");
    expect(INTAKE_RATE_LIMIT.fail).toBe("limit");
    expect(INTAKE_RATE_LIMIT.reasonCodes).toEqual(["command_window", "active_runs", "pending_approvals"]);
    expect(entryProblems(INTAKE_RATE_LIMIT as unknown as AnyEntry)).toEqual([]);
  });
  it("not limited → allow, not recorded (the accepted audit row already counts it)", () => {
    expect(decideSync(INTAKE_RATE_LIMIT, { limited: null }, ctx).verdict).toBe("allow");
    expect(rows).toEqual([]);
  });
  it.each([...INTAKE_RATE_LIMIT_REASONS])("limited by %s → limit with that reason, recorded", (code) => {
    expect(decideSync(INTAKE_RATE_LIMIT, { limited: code }, ctx)).toMatchObject({ verdict: "limit", reason: code });
    expect(rows).toEqual([{ verdict: "limit", reason: code }]);
  });
});
