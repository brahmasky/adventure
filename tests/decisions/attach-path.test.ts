import { describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { ATTACH_PATH, SEND_REASONS, type AttachInput } from "../../src/decisions/entries/attach-path.js";
import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { storeRecorder } from "../../src/decisions/record.js";
import { entryById, entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";
import { REFUSAL_TEXT } from "../../src/notifications/attachment-check.js";
import { RunStore } from "../../src/run/run-store.js";

const answer = (s: AttachInput) => { const calls: Array<[string, string | null, string]> = [];
  const recorder: DecisionRecorder = { record: (_e, r) => { calls.push([r.verdict, r.reason, r.rung]); return null; } };
  decideSync(ATTACH_PATH, s, { run_id: "run_1", tool_call_id: null, recorder }); return calls[0]; };

describe("attach.path (spec R7 §4.3)", () => {
  it("maps each seam's answer: accepted/ok send, everything else refuse with the check as its reason", () => {
    expect(answer({ seam: "parse", check: "accepted" })).toEqual(["send", "parsed", "rule"]);
    expect(answer({ seam: "parse", check: "marker_outside" })).toEqual(["refuse", "marker_outside", "rule"]);
    expect(answer({ seam: "send", check: "ok" })).toEqual(["send", "checked", "rule"]);
    for (const c of SEND_REASONS) expect(answer({ seam: "send", check: c })).toEqual(["refuse", c, "rule"]);
  });
  it("the send reasons are exactly the check's refusals (every refusal but send_failed)", () => {
    expect([...SEND_REASONS].sort()).toEqual(Object.keys(REFUSAL_TEXT).filter((k) => k !== "send_failed").sort());
    expect(ATTACH_PATH.reasonCodes).toEqual(["marker_outside", ...SEND_REASONS, "parsed", "checked"]);
  });
  it("is locked, rule-only, settle-stage over tool input; fail refuse, default send; no alwaysRecord (1-A); registered and sound", () => {
    const e = entryById("attach.path") as AnyEntry;
    expect(e).toBe(ATTACH_PATH as unknown as AnyEntry);
    expect([e.stage, e.input, e.locked, e.fail, e.defaultVerdict, e.alwaysRecord]).toEqual(["settle", "tool", true, "refuse", "send", undefined]);
    expect(e.ladder.map((r) => [r.kind, r.name])).toEqual([["rule", "attach_check"]]);
    expect(LOCKED_ENTRY_IDS).toContain("attach.path");
    expect(entryProblems(e)).toEqual([]);
  });
  it("rows (1-A): accepted and ok write none; each refusal writes one with the run; a thrown rule writes refuse at rung fail", () => {
    const store = RunStore.openInMemory();
    try {
      const rec = storeRecorder(store); const ctx = { run_id: "run_1", tool_call_id: null, recorder: rec };
      decideSync(ATTACH_PATH, { seam: "parse", check: "accepted" }, ctx); decideSync(ATTACH_PATH, { seam: "send", check: "ok" }, ctx);
      decideSync(ATTACH_PATH, { seam: "send", check: "too_large" }, ctx);
      const rung = ATTACH_PATH.ladder[0] as { decide: (s: AttachInput) => unknown }; const orig = rung.decide;
      rung.decide = () => { throw new Error("planted"); };
      try { decideSync(ATTACH_PATH, { seam: "send", check: "ok" }, { ...ctx, log: () => undefined }); } finally { rung.decide = orig; }
      expect(store.listDecisionsForRun("run_1").map((r) => [r.entry_id, r.verdict, r.reason_code, r.rung, r.tool_call_id]))
        .toEqual([["attach.path", "refuse", "too_large", "rule", null], ["attach.path", "refuse", null, "fail", null]]);
    } finally { store.close(); }
  });
});
