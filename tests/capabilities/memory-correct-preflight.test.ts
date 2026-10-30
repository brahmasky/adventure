import { afterEach, describe, expect, it, vi } from "vitest";
import { executeMemoryCorrect, memoryWritePreflight, newMemoryTurnState, MEMORY_REFUSAL_TEXT, type MemoryToolDeps } from "../../src/capabilities/memory-correct.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

const CHAT = "555";
let seq = 0;

function makeRun(store: RunStore, source: "telegram" | "schedule"): string {
  seq += 1;
  const schedule = source === "schedule";
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source, type: "turn", program: "turn", goal: "forget the synthetic fact",
    requested_by: schedule ? { kind: "schedule", id: "sch_t" } : { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: `mcp:${seq}`, source_reference: schedule ? "scheduled_tasks.sch_t" : `telegram:update:${seq}:message:${seq}`
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}

type Raw = Array<[string, string, string | null]>;
function rawRecorder(): { recorder: DecisionRecorder; rows: Raw } {
  const rows: Raw = [];
  return { rows, recorder: { record: (e, r) => { rows.push([e.id, r.verdict, r.reason]); return "d"; } } };
}

function setup(o: { source?: "telegram" | "schedule"; offered?: number[]; recorder?: DecisionRecorder } = {}) {
  const store = RunStore.openInMemory();
  const ids = [1, 2, 3].map((n) => store.addEpisodicFact({ chat_id: CHAT, fact: `synthetic fact ${n}`, created_at: "2026-10-01T00:00:00.000Z" }));
  const run_id = makeRun(store, o.source ?? "telegram");
  const state = newMemoryTurnState();
  for (const id of o.offered ?? ids) state.offered.fact.add(id);
  const deps: MemoryToolDeps = { store, run_id, chat_id: CHAT, state, embed: async () => null, gated: true, ...(o.recorder ? { recorder: o.recorder } : {}) };
  return { store, run_id, state, ids, deps };
}
const pre = (d: MemoryToolDeps) => ({ store: d.store, run_id: d.run_id, chat_id: d.chat_id, state: d.state, ...(d.recorder ? { recorder: d.recorder } : {}) });
const refusedOf = (reason: string) => ({ refused: { reason, text: `${reason}: ${MEMORY_REFUSAL_TEXT[reason]}` } });

afterEach(() => { vi.restoreAllMocks(); });

describe("memory.correct_preflight: the trust-limit answer is recorded at preflight and at write", () => {
  it("a scheduled turn → not_operator_turn, result unchanged", () => {
    const { recorder, rows } = rawRecorder();
    const t = setup({ source: "schedule", recorder });
    try {
      expect(memoryWritePreflight(pre(t.deps), { action: "retire", ids: [t.ids[0]] })).toEqual(refusedOf("not_operator_turn"));
      expect(rows).toEqual([["memory.correct_preflight", "refuse", "not_operator_turn"]]);
    } finally { t.store.close(); }
  });

  it("an earlier untrusted step in the turn → tainted_turn", () => {
    const { recorder, rows } = rawRecorder();
    const t = setup({ recorder });
    try {
      t.store.appendRunLedgerEvent(t.run_id, "loop_step", "core", { step: 1, action: "x", capability: "web_fetch", ok: true, result_digest: "1 bytes" });
      expect(memoryWritePreflight(pre(t.deps), { action: "retire", ids: [t.ids[0]] })).toEqual(refusedOf("tainted_turn"));
      expect(rows).toEqual([["memory.correct_preflight", "refuse", "tainted_turn"]]);
    } finally { t.store.close(); }
  });

  it("6 ids → too_many; an un-offered id → not_offered; changed=9 with 2 ids → too_many", () => {
    const { recorder, rows } = rawRecorder();
    const t = setup({ recorder, offered: [1, 2, 3, 4, 5, 6, 7] });
    try {
      expect(memoryWritePreflight(pre(t.deps), { action: "retire", ids: [1, 2, 3, 4, 5, 6] })).toEqual(refusedOf("too_many"));
      expect(memoryWritePreflight(pre(t.deps), { action: "retire", ids: [1, 99] })).toEqual(refusedOf("not_offered"));
      t.state.changed = 9;
      expect(memoryWritePreflight(pre(t.deps), { action: "retire", ids: [1, 2] })).toEqual(refusedOf("too_many"));
      expect(rows).toEqual([
        ["memory.correct_preflight", "refuse", "too_many"],
        ["memory.correct_preflight", "refuse", "not_offered"],
        ["memory.correct_preflight", "refuse", "too_many"]
      ]);
    } finally { t.store.close(); }
  });

  it("a passing preflight returns the card detail unchanged; the raw recorder sees one allow, a storeRecorder over a real store keeps 0 rows", () => {
    const { recorder, rows } = rawRecorder();
    const t = setup({ recorder });
    const real = setup();
    try {
      const expected = { card_detail: `retire 1 fact(s):\n#${t.ids[0]}: "synthetic fact 1"` };
      expect(memoryWritePreflight(pre(t.deps), { action: "retire", ids: [t.ids[0]] })).toEqual(expected);
      expect(rows).toEqual([["memory.correct_preflight", "allow", null]]);
      const withStore: MemoryToolDeps = { ...real.deps, recorder: storeRecorder(real.store) };
      expect(memoryWritePreflight(pre(withStore), { action: "retire", ids: [real.ids[0]] })).toEqual({ card_detail: `retire 1 fact(s):\n#${real.ids[0]}: "synthetic fact 1"` });
      expect(real.store.listDecisionsForRun(real.run_id)).toEqual([]);
    } finally { t.store.close(); real.store.close(); }
  });

  it("a refusal through a real storeRecorder stores one refuse row", () => {
    const t = setup({ source: "schedule" });
    try {
      memoryWritePreflight(pre({ ...t.deps, recorder: storeRecorder(t.store) }), { action: "retire", ids: [t.ids[0]] });
      expect(t.store.listDecisionsForRun(t.run_id).map((r) => [r.entry_id, r.verdict, r.reason_code])).toEqual([["memory.correct_preflight", "refuse", "not_operator_turn"]]);
    } finally { t.store.close(); }
  });

  it("executeMemoryCorrect (gated) after a passing preflight with offered cleared → not_offered text unchanged, refuse recorded", async () => {
    const { recorder, rows } = rawRecorder();
    const t = setup({ recorder });
    try {
      const input = { action: "retire", ids: [t.ids[0]] };
      expect(memoryWritePreflight(pre(t.deps), input)).toHaveProperty("card_detail");
      t.state.offered.fact.clear();
      const r = await executeMemoryCorrect(t.deps, input);
      expect(r).toEqual({ ok: false, error: `not_offered: ${MEMORY_REFUSAL_TEXT.not_offered}` });
      expect(rows).toEqual([["memory.correct_preflight", "allow", null], ["memory.correct_preflight", "refuse", "not_offered"]]);
      expect(t.store.getEpisodicFact(t.ids[0]!)?.status).toBe("active");
    } finally { t.store.close(); }
  });

  it("search and a parse refusal record nothing", async () => {
    const { recorder, rows } = rawRecorder();
    const t = setup({ recorder });
    try {
      await executeMemoryCorrect(t.deps, { action: "search", query: "synthetic" });
      expect(await executeMemoryCorrect(t.deps, { action: "retire", ids: [] })).toEqual({ ok: false, error: `bad_input: ${MEMORY_REFUSAL_TEXT.bad_input}` });
      expect(memoryWritePreflight(pre(t.deps), { action: "search", query: "x" })).toEqual(refusedOf("bad_input"));
      expect(rows).toEqual([]);
    } finally { t.store.close(); }
  });

  it("without a recorder the results are identical (refusal and pass)", () => {
    const sched = setup({ source: "schedule" });
    const ok = setup();
    try {
      expect(memoryWritePreflight(pre(sched.deps), { action: "retire", ids: [sched.ids[0]] })).toEqual(refusedOf("not_operator_turn"));
      expect(memoryWritePreflight(pre(ok.deps), { action: "retire", ids: [ok.ids[0]] })).toEqual({ card_detail: `retire 1 fact(s):\n#${ok.ids[0]}: "synthetic fact 1"` });
    } finally { sched.store.close(); ok.store.close(); }
  });

  it("a recorder that throws leaves the result identical, logs, and throws nothing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup({ source: "schedule", recorder: { record: () => { throw new Error("recorder down"); } } });
    try {
      expect(memoryWritePreflight(pre(t.deps), { action: "retire", ids: [t.ids[0]] })).toEqual(refusedOf("not_operator_turn"));
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toBe("decisions: memory.correct_preflight record threw past the recorder: recorder down");
    } finally { t.store.close(); }
  });
});
