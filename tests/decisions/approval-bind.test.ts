import { describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { APPROVAL_BIND } from "../../src/decisions/entries/approval-bind.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
const run = (s: { ok: boolean; code?: string }) => decideSync(APPROVAL_BIND, s, { run_id: "r", tool_call_id: "t", recorder });

describe("approval.bind — a spent Paco tap always leaves a row naming why it bound or not", () => {
  it("is locked, rule-only, always recorded, sound", () => {
    expect(APPROVAL_BIND.locked).toBe(true);
    expect(APPROVAL_BIND.alwaysRecord).toBe(true);
    expect(APPROVAL_BIND.ladder.map((r) => r.kind)).toEqual(["rule"]);
    expect(entryProblems(APPROVAL_BIND as unknown as AnyEntry)).toEqual([]);
  });
  it("ok → bound, no reason", () => { expect(run({ ok: true })).toMatchObject({ verdict: "bound", rung: "rule" }); });
  it.each(["no_sink", "unknown_approval", "not_approved", "expired", "action_mismatch", "owner_mismatch", "requester_mismatch", "lease_lost"])(
    "a listed sink code %s → unbound with that reason", (code) => { expect(run({ ok: false, code })).toMatchObject({ verdict: "unbound", reason: code }); });
  it("an unlisted code (the run-level APPROVAL_* family) → unbound with no reason, so the row's reason_code is null", () => {
    expect(run({ ok: false, code: "APPROVAL_NOT_FOUND" }).reason ?? null).toBeNull();
  });
});
