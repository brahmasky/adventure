import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { CONTRACT_REFUSAL_REASONS, TURN_CONTRACT } from "../../src/decisions/entries/turn-contract.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(TURN_CONTRACT as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: null, tool_call_id: null, recorder };

describe("turn.contract — a refused contract, or a schedule-born turn's narrowed envelope, leaves a row (spec R2 §4.2, Decision 1-B)", () => {
  it("is unlocked, rule-only, pre_model, tool input, sound", () => {
    expect(TURN_CONTRACT.locked).toBeUndefined();
    expect(LOCKED_ENTRY_IDS).not.toContain("turn.contract");
    expect(TURN_CONTRACT.alwaysRecord).toBeUndefined();
    expect(TURN_CONTRACT.stage).toBe("pre_model");
    expect(TURN_CONTRACT.input).toBe("tool");
    expect(TURN_CONTRACT.fail).toBe("refuse");
    expect(TURN_CONTRACT.reasonCodes).toEqual(["schedule_born", "goal_missing", "unknown_program", "unsupported_type"]);
    expect(entryProblems(TURN_CONTRACT as unknown as AnyEntry)).toEqual([]);
  });
  it("a full contract → compile, not recorded (the contract is already on the run)", () => {
    expect(decideSync(TURN_CONTRACT, { refused: null, restricted: false }, ctx).verdict).toBe("compile");
    expect(rows).toEqual([]);
  });
  it("a schedule-born turn's narrowed envelope → restrict/schedule_born, recorded", () => {
    expect(decideSync(TURN_CONTRACT, { refused: null, restricted: true }, ctx)).toMatchObject({ verdict: "restrict", reason: "schedule_born" });
    expect(rows).toEqual([{ verdict: "restrict", reason: "schedule_born" }]);
  });
  it.each([...CONTRACT_REFUSAL_REASONS])("refused for %s → refuse with that reason, recorded (a refusal wins over restricted)", (reason) => {
    expect(decideSync(TURN_CONTRACT, { refused: reason, restricted: true }, ctx)).toMatchObject({ verdict: "refuse", reason });
    expect(rows).toEqual([{ verdict: "refuse", reason }]);
  });
});
