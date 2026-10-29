import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { SECRET_REDACT, type RedactSeam } from "../../src/decisions/entries/secret-redact.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
// decideSync hands every verdict to the recorder; the clean-skips-the-ledger filter is shouldRecord, which the store recorder applies.
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(SECRET_REDACT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const run = (s: { masked: boolean; seam: RedactSeam }) => decideSync(SECRET_REDACT, s, { run_id: "r", tool_call_id: "t", recorder });

describe("secret.redact — a masked secret in an outbound report is counted by the seam that caught it", () => {
  it("is locked, rule-only, sound, and not always-recorded (clean reports stay out of the ledger)", () => {
    expect(SECRET_REDACT.locked).toBe(true);
    expect(SECRET_REDACT.reasonCodes).toEqual(["final_report","failure_report","evolution_report"]); // the store nulls any reason not listed here
    expect(SECRET_REDACT.alwaysRecord).toBeUndefined();
    expect(SECRET_REDACT.ladder.map((r) => r.kind)).toEqual(["rule"]);
    expect(entryProblems(SECRET_REDACT as unknown as AnyEntry)).toEqual([]);
  });
  it("nothing masked → clean, no reason", () => {
    const r = run({ masked: false, seam: "final_report" });
    expect(r).toMatchObject({ verdict: "clean", rung: "rule" });
    expect(r.reason ?? null).toBeNull();
    expect(rows).toEqual([]); // clean is the default verdict and alwaysRecord is unset: no row
  });
  it.each(["final_report", "failure_report", "evolution_report"] as const)("masked at %s → masked with the seam as reason", (seam) => {
    expect(run({ masked: true, seam })).toMatchObject({ verdict: "masked", reason: seam });
    expect(rows).toEqual([{ verdict: "masked", reason: seam }]);
  });
});
