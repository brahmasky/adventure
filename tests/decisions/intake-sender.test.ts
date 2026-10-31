import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_SENDER, SENDER_DENIAL_REASONS } from "../../src/decisions/entries/intake-sender.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; rung: string; reason: string | null; fallback: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_SENDER as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, rung: r.rung, reason: r.reason, fallback: r.fallbackReason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: null, tool_call_id: null, recorder, log: () => undefined };

describe("intake.sender — a refused Telegram sender leaves a row naming why (locked, the allowlist floor)", () => {
  it("is locked, rule-only, refusal-only, reads tool input, sound", () => {
    expect(INTAKE_SENDER.locked).toBe(true);
    expect(LOCKED_ENTRY_IDS).toContain("intake.sender");
    expect(INTAKE_SENDER.alwaysRecord).toBeUndefined();
    expect(INTAKE_SENDER.input).toBe("tool");
    expect(INTAKE_SENDER.stage).toBe("intake");
    expect(INTAKE_SENDER.fail).toBe("deny");
    expect(INTAKE_SENDER.reasonCodes).toEqual(["channel_post", "forwarded", "anonymous", "no_chat", "user_not_allowlisted", "chat_not_allowlisted", "identity_not_for_chat"]);
    expect(entryProblems(INTAKE_SENDER as unknown as AnyEntry)).toEqual([]);
  });
  it.each([...SENDER_DENIAL_REASONS])("denied for %s → deny with that reason, recorded", (reason) => {
    expect(decideSync(INTAKE_SENDER, { denied: reason }, ctx)).toMatchObject({ verdict: "deny", reason });
    expect(rows).toEqual([{ verdict: "deny", rung: "rule", reason, fallback: null }]);
  });
  it("a denial with no reason never records allow: the rule throws and the row is deny at rung fail, fallback threw", () => {
    expect(decideSync(INTAKE_SENDER, { denied: null }, ctx).verdict).toBe("deny");
    expect(rows).toEqual([{ verdict: "deny", rung: "fail", reason: null, fallback: "threw" }]);
  });
});
