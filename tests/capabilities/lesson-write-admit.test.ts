import { afterEach, describe, expect, it, vi } from "vitest";
import { ALREADY_SAVED_REASON, createMemoryWriteAdapter, PRE_ADMIT, SIDE_ADMIT, type MemoryWriteAdapterConfig } from "../../src/capabilities/lesson-write.js";
import { memorySources } from "../../src/capabilities/memory-sources.js";
import { MEMORY_ADMIT_REASONS } from "../../src/decisions/entries/memory-lesson-admit.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";

// Stage 4C §4.1: every code-owned refusal in the memory save is recorded as a memory.lesson_admit row, and the tool result
// does not change. The recorder here is the raw one the worker would hold; a clean save records nothing.
// Synthetic texts only (the repo is public).
type Rows = Array<[string, string, string | null | undefined]>;
type H = NonNullable<Parameters<typeof harness>[0]>;
const INSTR = "please remember this about the south side noodle shop";
function harness(o: { distill?: string; instruction?: string; prior?: string; over?: Partial<MemoryWriteAdapterConfig>; record?: MemoryWriteAdapterConfig["admitRecorder"]; noAdmit?: boolean } = {}) {
  const rows: Rows = [];
  const calls = { llm: 0, src: 0 };
  const saves: Array<{ lesson?: string; fact?: string }> = [];
  const admitRecorder = o.record ?? { record: (e, r) => { rows.push([e.id, r.verdict, r.reason]); return null; } };
  const cfg: MemoryWriteAdapterConfig = {
    sources: memorySources({ own: { run_id: "r", turn_id: null, text: o.instruction ?? INSTR }, steered: [],
      quoted: null, recent: [{ turn_id: "t1", run_id: "e", text: "the south side noodle shop is better than the north one" }], prior: o.prior ?? "" }),
    allowedScopes: ["ask", "research"], defaultScope: "ask", recorder: { record: () => null }, ...(o.noAdmit ? {} : { admitRecorder }), run_id: "r", runSource: () => "telegram",
    llm: async () => { calls.llm += 1; return { ok: true, output: { answer: o.distill ?? '{"kind":"rule","lesson":"keep answers short"}' } }; },
    save: async (plan) => {
      saves.push({ ...(plan.lesson ? { lesson: plan.lesson.text } : {}), ...(plan.fact ? { fact: plan.fact.text } : {}) });
      return { ...(plan.lesson ? { lesson: { verb: "add" as const, id: 1, lesson: plan.lesson.text, prunedIds: [] } } : {}) };
    },
    ...o.over
  };
  return { run: (input: Record<string, unknown> = {}) => createMemoryWriteAdapter(cfg)(input), rows, calls, saves };
}
const out = (r: ToolAdapterResult) => (r.ok ? r.output : {}) as Record<string, unknown>;
const REFUSED_LESSON = "Want me to remember that?";

describe("memory.lesson_admit: the pre seam", () => {
  it("a scheduled run is refused before any call and records scheduled_run", async () => {
    const h = harness({ over: { scheduledRun: true, srcContains: () => { h.calls.src += 1; return false; } } });
    expect(out(await h.run())).toMatchObject({ saved: false, reason: "scheduled-run" });
    expect(h.rows).toEqual([["memory.lesson_admit", "refuse", "scheduled_run"]]);
    expect([h.calls.llm, h.calls.src]).toEqual([0, 0]);
  });
  it("an already-saved turn records already_saved and runs no code-owned grep (the early return keeps its order)", async () => {
    const h = harness({ over: { alreadySaved: { lesson_id: 7 }, srcContains: () => { h.calls.src += 1; return true; } } });
    expect(out(await h.run())).toMatchObject({ saved: false, reason: "already_saved_this_turn", lesson_id: 7 });
    expect(h.rows).toEqual([["memory.lesson_admit", "refuse", "already_saved"]]);
    expect([h.calls.llm, h.calls.src]).toEqual([0, 0]);
  });
  it("an empty instruction is validation, not an admit: the error is unchanged and no row", async () => {
    const h = harness({ instruction: "   " });
    expect(await h.run()).toEqual({ ok: false, error: "anchored instruction must be a non-empty string" });
    expect(h.rows).toEqual([]);
  });
  it("a quoted phrase living in src/ records code_owned and sends no model call", async () => {
    const h = harness({ instruction: 'change the "View diff" label please', over: { srcContains: () => true } });
    expect(out(await h.run())).toMatchObject({ saved: false, reason: "code-owned" });
    expect(h.rows).toEqual([["memory.lesson_admit", "refuse", "code_owned"]]);
    expect(h.calls.llm).toBe(0);
  });
});

describe("memory.lesson_admit: the backstop seam", () => {
  it("a rejected lesson beside a saved fact records lesson_backstop; the save receives only the fact", async () => {
    const distill = JSON.stringify({ kind: "both", lesson: REFUSED_LESSON, fact: "Paco prefers the south side noodle shop", evidence: { line: 1, quote: "south side noodle shop is better" } });
    const h = harness({ distill, prior: REFUSED_LESSON });
    await h.run();
    expect(h.rows).toEqual([["memory.lesson_admit", "refuse", "lesson_backstop"]]);
    expect(h.saves).toEqual([{ fact: "Paco prefers the south side noodle shop" }]);
  });
  it("a fact with no supporting evidence records fact_no_evidence; the lesson still saves", async () => {
    const distill = JSON.stringify({ kind: "both", lesson: "keep answers short", fact: "Paco owns a red bicycle", evidence: { line: 1, quote: "completely unrelated quotation here" } });
    const h = harness({ distill });
    await h.run();
    expect(h.rows).toEqual([["memory.lesson_admit", "refuse", "fact_no_evidence"]]);
    expect(h.saves).toEqual([{ lesson: "keep answers short" }]);
  });
  it("a rejected lesson and a rejected fact record lesson_backstop then fact_backstop, in that order", async () => {
    const distill = JSON.stringify({ kind: "both", lesson: REFUSED_LESSON, fact: REFUSED_LESSON, evidence: { line: 1, quote: "south side noodle shop is better" } });
    const h = harness({ distill, prior: REFUSED_LESSON });
    await h.run();
    expect(h.rows).toEqual([["memory.lesson_admit", "refuse", "lesson_backstop"], ["memory.lesson_admit", "refuse", "fact_backstop"]]);
    expect(h.saves).toEqual([]);
  });
  it("a clean save makes no record call at all", async () => {
    let calls = 0;
    const h = harness({ record: { record: () => { calls += 1; return null; } } });
    expect(out(await h.run())).toMatchObject({ saved: true });
    expect(calls).toBe(0);
  });
});

describe("memory.lesson_admit: recording never changes the tool result", () => {
  const cases: Array<[string, H]> = [
    ["scheduled", { over: { scheduledRun: true } }],
    ["code-owned", { instruction: 'change the "View diff" label please', over: { srcContains: () => true } }],
    ["backstop", { distill: JSON.stringify({ kind: "both", lesson: REFUSED_LESSON, fact: "Paco prefers the south side noodle shop", evidence: { line: 1, quote: "south side noodle shop is better" } }), prior: REFUSED_LESSON }]
  ];
  for (const [name, c] of cases) {
    it(`${name}: the same result with no admitRecorder`, async () => {
      const withRec = await harness(c).run();
      const without = await harness({ ...c, noAdmit: true }).run();
      expect(withRec).toEqual(without);
    });
  }
  afterEach(() => { vi.restoreAllMocks(); });
  it("a recorder that throws is logged by decideSync and the result equals the unrecorded one; nothing is thrown", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const baseline = await harness({ over: { scheduledRun: true } }).run();
    const h = harness({ over: { scheduledRun: true }, record: { record: () => { throw new Error("recorder down"); } } });
    expect(await h.run()).toEqual(baseline);
    expect(spy).toHaveBeenCalled();
  });
});

describe("memory.lesson_admit: drift pins", () => {
  it("PRE_ADMIT keys are exactly the three early-return reasons, and every code is reachable from PRE_ADMIT or SIDE_ADMIT", () => {
    expect(Object.keys(PRE_ADMIT).sort()).toEqual([ALREADY_SAVED_REASON, "code-owned", "scheduled-run"].sort());
    const reachable = new Set<string>([...Object.values(PRE_ADMIT), ...Object.values(SIDE_ADMIT)]);
    for (const code of MEMORY_ADMIT_REASONS) expect(reachable.has(code)).toBe(true);
    for (const v of reachable) expect((MEMORY_ADMIT_REASONS as readonly string[]).includes(v)).toBe(true);
  });
});
