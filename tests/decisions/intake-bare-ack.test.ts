import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { INTAKE_BARE_ACK } from "../../src/decisions/entries/intake-bare-ack.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(INTAKE_BARE_ACK as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: "r", tool_call_id: null, recorder };

describe("intake.bare_ack — a bare ack while an approval card waits is nudged, never consent (ADR 0029 §5.1, locked)", () => {
  it("is locked, rule-only, reads Paco's words, fails to nudge, sound", () => {
    expect(INTAKE_BARE_ACK.locked).toBe(true);
    expect(LOCKED_ENTRY_IDS).toContain("intake.bare_ack");
    expect(INTAKE_BARE_ACK.input).toBe("paco");
    expect(INTAKE_BARE_ACK.stage).toBe("intake");
    expect(INTAKE_BARE_ACK.fail).toBe("nudge");
    expect(INTAKE_BARE_ACK.defaultVerdict).toBe("pass");
    expect(INTAKE_BARE_ACK.alwaysRecord).toBeUndefined();
    expect(INTAKE_BARE_ACK.reasonCodes).toEqual(["ack_while_card_waits"]);
    expect(entryProblems(INTAKE_BARE_ACK as unknown as AnyEntry)).toEqual([]);
    expect(INTAKE_BARE_ACK.id).toBe("intake.bare_ack");
    expect(INTAKE_BARE_ACK.version).toBe(1);
    expect(INTAKE_BARE_ACK.question).toBe("While an approval card waits, is this message a bare acknowledgement — nudged, never taken as consent (ADR 0029 §5.1)?");
    expect(INTAKE_BARE_ACK.verdicts).toEqual(["nudge", "pass"]);
    expect(INTAKE_BARE_ACK.ladder.map((r) => [r.kind, r.name])).toEqual([["rule", "isBareAck"]]);
    expect(INTAKE_BARE_ACK.outcomes).toEqual([]);
    expect(INTAKE_BARE_ACK.armed).toEqual({ rule: "on" });
    expect(INTAKE_BARE_ACK.effects).toEqual({
      nudge: { kind: "reply", reversible: true, announced: "none", what: "the code-owned nudge points at the card; nothing is approved" },
      pass: { kind: "none", reversible: true, announced: "none" }
    });
  });
  it("an ack → nudge/ack_while_card_waits, recorded", () => {
    expect(decideSync(INTAKE_BARE_ACK, { acked: true }, ctx)).toMatchObject({ verdict: "nudge", reason: "ack_while_card_waits" });
    expect(rows).toEqual([{ verdict: "nudge", reason: "ack_while_card_waits" }]);
  });
  it("not an ack → pass, not recorded", () => {
    expect(decideSync(INTAKE_BARE_ACK, { acked: false }, ctx).verdict).toBe("pass");
    expect(rows).toEqual([]);
  });
});
