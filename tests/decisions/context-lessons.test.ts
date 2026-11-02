import { describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { CONTEXT_LESSONS, type LessonsInput, type LessonsVerdict } from "../../src/decisions/entries/context-lessons.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { Entry } from "../../src/decisions/types.js";
import { RunStore } from "../../src/run/run-store.js";

type Row = { entry_id: string; verdict: string; reason_code: string | null; rung: string; run_id: string | null };
const rows = (store: RunStore): Row[] =>
  (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db.prepare("SELECT entry_id, verdict, reason_code, rung, run_id FROM decisions WHERE entry_id = 'context.lessons' ORDER BY rowid").all() as Row[];
function run(s: LessonsInput, entry: Entry<LessonsInput, LessonsVerdict> = CONTEXT_LESSONS) {
  const store = RunStore.openInMemory();
  const r = decideSync(entry, s, { run_id: "r", tool_call_id: null, recorder: storeRecorder(store) });
  const out = rows(store); store.close();
  return { r, rows: out };
}
const throwing: Entry<LessonsInput, LessonsVerdict> = { ...CONTEXT_LESSONS, ladder: [{ kind: "rule", name: "lesson_char_cap", decide: () => { throw new Error("planted"); } }] };

describe("context.lessons (spec R5 §4.3)", () => {
  it("is a rule-only pre_model entry over tool input; full is the routine answer and writes no row", () => {
    expect(CONTEXT_LESSONS).toMatchObject({ id: "context.lessons", version: 1, stage: "pre_model", input: "tool", verdicts: ["full", "capped", "none"], defaultVerdict: "full", fail: "full", armed: { rule: "on" } });
    expect(CONTEXT_LESSONS.locked).toBeUndefined();
    expect(CONTEXT_LESSONS.alwaysRecord).toBeUndefined();
    expect(CONTEXT_LESSONS.reasonCodes).toEqual(["char_cap", "render_failed"]);
  });
  it("{3,0,false} → full, no reason, zero rows through storeRecorder", () => {
    const { r, rows } = run({ rendered: 3, skipped: 0, failed: false });
    expect([r.verdict, r.reason, r.rung]).toEqual(["full", null, "rule"]);
    expect(rows).toEqual([]);
  });
  it("{2,1,false} → capped/char_cap, one row", () => {
    const { r, rows } = run({ rendered: 2, skipped: 1, failed: false });
    expect([r.verdict, r.reason]).toEqual(["capped", "char_cap"]);
    expect(rows).toEqual([{ entry_id: "context.lessons", verdict: "capped", reason_code: "char_cap", rung: "rule", run_id: "r" }]);
  });
  it("{0,0,true} → none/render_failed, one row", () => {
    const { r, rows } = run({ rendered: 0, skipped: 0, failed: true });
    expect([r.verdict, r.reason]).toEqual(["none", "render_failed"]);
    expect(rows).toEqual([{ entry_id: "context.lessons", verdict: "none", reason_code: "render_failed", rung: "rule", run_id: "r" }]);
  });
  it("{3,0,true} → none/render_failed: a failed render outranks the rendered count", () => {
    const { r, rows } = run({ rendered: 3, skipped: 0, failed: true });
    expect([r.verdict, r.reason]).toEqual(["none", "render_failed"]);
    expect(rows).toEqual([{ entry_id: "context.lessons", verdict: "none", reason_code: "render_failed", rung: "rule", run_id: "r" }]);
  });
  it("a throwing rule records its fail verdict (full) at the fail rung: one row, the only trace (spec §4.6)", () => {
    const { r, rows } = run({ rendered: 2, skipped: 1, failed: false }, throwing);
    expect([r.verdict, r.rung, r.fallbackReason]).toEqual(["full", "fail", "threw"]);
    expect(rows).toEqual([{ entry_id: "context.lessons", verdict: "full", reason_code: null, rung: "fail", run_id: "r" }]);
  });
});
