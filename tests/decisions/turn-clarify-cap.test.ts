import { describe, expect, it } from "vitest";
import { clarifyCapOf, type ClarifyCapInput } from "../../src/capabilities/intent.js";
import { decideSync } from "../../src/decisions/decide.js";
import { TURN_CLARIFY_CAP, type ClarifyCapVerdict } from "../../src/decisions/entries/turn-clarify-cap.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder, Entry } from "../../src/decisions/types.js";
import { RunStore } from "../../src/run/run-store.js";

type Row = { entry_id: string; verdict: string; reason_code: string | null; rung: string; run_id: string | null };
const rows = (store: RunStore): Row[] =>
  (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db.prepare("SELECT entry_id, verdict, reason_code, rung, run_id FROM decisions WHERE entry_id = 'turn.clarify_cap' ORDER BY rowid").all() as Row[];
function run(s: ClarifyCapInput, entry: Entry<ClarifyCapInput, ClarifyCapVerdict> = TURN_CLARIFY_CAP) {
  const store = RunStore.openInMemory();
  const r = decideSync(entry, s, { run_id: "r", tool_call_id: null, recorder: storeRecorder(store) });
  const out = rows(store); store.close();
  return { r, rows: out };
}
const noop: DecisionRecorder = { record: () => null };
const throwing: Entry<ClarifyCapInput, ClarifyCapVerdict> = { ...TURN_CLARIFY_CAP, ladder: [{ kind: "rule", name: "clarify_cap", decide: () => { throw new Error("planted"); } }] };

describe("turn.clarify_cap (spec R5 §4.4)", () => {
  it("is a rule-only pre_model entry over tool input; allow is the routine answer", () => {
    expect(TURN_CLARIFY_CAP).toMatchObject({ id: "turn.clarify_cap", version: 1, stage: "pre_model", input: "tool", verdicts: ["allow", "cap"], defaultVerdict: "allow", fail: "allow", armed: { rule: "on" } });
    expect(TURN_CLARIFY_CAP.locked).toBeUndefined();
    expect(TURN_CLARIFY_CAP.alwaysRecord).toBeUndefined();
    expect(TURN_CLARIFY_CAP.reasonCodes).toEqual(["cap_reached"]);
  });
  it.each([
    [{ trailing: 0, max: 1 }, false],
    [{ trailing: 1, max: 1 }, true],
    [{ trailing: 2, max: 1 }, true],
    [{ trailing: 0, max: 0 }, true]
  ] as const)("clarifyCapOf(%o) → %s (max 0 caps every turn)", (s, want) => {
    expect(clarifyCapOf(s)).toBe(want);
  });
  it("the rule's cap ⇔ clarifyCapOf over trailing 0..3 × max 0..3", () => {
    for (let trailing = 0; trailing <= 3; trailing++) for (let max = 0; max <= 3; max++) {
      const r = decideSync(TURN_CLARIFY_CAP, { trailing, max }, { run_id: "r", tool_call_id: null, recorder: noop });
      expect(r.verdict === "cap", `trailing=${trailing} max=${max}`).toBe(clarifyCapOf({ trailing, max }));
      expect(r.reason).toBe(r.verdict === "cap" ? "cap_reached" : null);
    }
  });
  it("{1,1} → one cap/cap_reached row through storeRecorder; {0,1} → zero rows", () => {
    expect(run({ trailing: 1, max: 1 }).rows).toEqual([{ entry_id: "turn.clarify_cap", verdict: "cap", reason_code: "cap_reached", rung: "rule", run_id: "r" }]);
    expect(run({ trailing: 0, max: 1 }).rows).toEqual([]);
  });
  it("a throwing rule records allow at the fail rung: one row (spec §4.6)", () => {
    const { r, rows } = run({ trailing: 1, max: 1 }, throwing);
    expect([r.verdict, r.rung, r.fallbackReason]).toEqual(["allow", "fail", "threw"]);
    expect(rows).toEqual([{ entry_id: "turn.clarify_cap", verdict: "allow", reason_code: null, rung: "fail", run_id: "r" }]);
  });
});
