import { describe, expect, it } from "vitest";
import { RunStore, DecisionRejected } from "../../src/run/run-store.js";
import { recordStrict } from "../../src/decisions/record.js";
import type { AnyEntry, AnyDecideResult } from "../../src/decisions/types.js";

const entry = { id: "attach.path", version: 1, stage: "settle", alwaysRecord: true, defaultVerdict: "send", reasonCodes: ["checked"] } as unknown as AnyEntry;
const result = { verdict: "send", rung: "rule", reason: "checked", p: null, armedMode: "on", walk: [{ kind: "rule" }], latencyMs: 1, fallbackReason: null, fallbackRung: null, decisionId: null } as unknown as AnyDecideResult;

describe("recordStrict", () => {
  it("returns the decision id inside a caller's transaction", () => {
    const s = RunStore.openInMemory();
    const id = s.inTransaction(() => recordStrict(s, entry, result, { run_id: null, tool_call_id: "mi_x" }, "2026-11-09T00:00:00.000Z"));
    expect(id).toMatch(/^dec_/);
  });
  it("throws on an insert failure (the stage), so the caller's transaction rolls back", () => {
    const s = RunStore.openInMemory();
    const bad = { ...entry, stage: "not_a_stage" } as unknown as AnyEntry;
    let err: unknown;
    try { s.inTransaction(() => recordStrict(s, bad, result, { run_id: null, tool_call_id: null }, "2026-11-09T00:00:00.000Z")); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DecisionRejected);
    expect((err as DecisionRejected).column).toBe("stage");
  });
});
