import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FACT_RECONCILE_DISCIPLINE } from "../../src/capabilities/episodic-extract.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { ompWorker } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Stage 4C §4.1: memory.lesson_admit rows are held by the adapter and written by runMemoryWrite's finally only on a live
// turn (the lost-turn rule, ruling 14): a turn killed or replaced mid-save writes no decisions row, memory.kind's included.
// Synthetic texts only (the repo is public).
const CHAT = "555";
const OPINION = "I think the south side noodle shop is better than the north one";
const PRIOR = "Want me to remember that?";
// A lesson that only restates the prior reply (the backstop refuses it) beside a fact the opinion supports.
const REFUSED_LESSON_WITH_FACT = JSON.stringify({ kind: "both", lesson: PRIOR, fact: "Paco prefers the south side noodle shop",
  evidence: { line: 1, quote: "south side noodle shop is better" } });
function seat(distill: string) {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const system = String(input.system ?? "");
    const answer = /durable/i.test(system) ? distill : system === FACT_RECONCILE_DISCIPLINE ? '{"verdict":"ADD"}' : '{"verdict":"ADD","theme":"format"}';
    return { ok: true, output: { answer } };
  };
}
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
/** `inSave` fires when the fact side is embedded: inside the save, after planOf, before the post-model-call guard (the reconcile LLM call does not run without a similar stored fact). */
function setup(distill: string, o: { inSave?: () => void } = {}) {
  const store = RunStore.openInMemory();
  const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hmwa-")), { llm: seat(distill), embed: async () => { o.inSave?.(); return new Float32Array([0.1, 0.2]); } });
  const earlier = createQueuedTurnRun(store, OPINION);
  store.recordChatTurn({ chat_id: CHAT, run_id: earlier, role: "user", text: OPINION, created_at: later(-60_000) });
  store.recordChatTurn({ chat_id: CHAT, run_id: earlier, role: "assistant", text: PRIOR, created_at: later(-59_000) });
  return { store, worker };
}
const admitRows = (store: RunStore, run_id: string) => store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "memory.lesson_admit").map((d) => [d.verdict, d.reason_code]);
const turnsOf = (w: unknown) => (w as { ompTurns: Map<string, { memorySavedThisTurn?: unknown }> }).ompTurns;
const dbOf = (s: RunStore) => (s as unknown as { db: { isTransaction: boolean } }).db;
function liveTurn(h: ReturnType<typeof setup>) {
  const run_id = createQueuedTurnRun(h.store, "记下来吧");
  const claim = h.store.claimRun(run_id, "w", 120)!;
  h.worker.buildOmpTools(claim, CHAT);
  return { run_id, claim };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("runMemoryWrite: memory.lesson_admit and the lost-turn rule", () => {
  it("a live turn with a refused lesson beside a saved fact writes one lesson_backstop row, and memory.kind's row lands inside the save transaction", async () => {
    const h = setup(REFUSED_LESSON_WITH_FACT);
    const { run_id, claim } = liveTurn(h);
    // Each insert's transaction state at the moment it runs: memory.kind's inside the save transaction, the admit row's outside it.
    const real = h.store.insertDecision.bind(h.store);
    const at: Array<[string, boolean]> = [];
    vi.spyOn(h.store, "insertDecision").mockImplementation((row) => { at.push([row.entry_id, dbOf(h.store).isTransaction]); return real(row); });
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    expect(w.saved?.fact).toBeDefined();
    expect(at).toEqual([["memory.kind", true], ["memory.lesson_admit", false]]);
    expect(admitRows(h.store, run_id)).toEqual([["refuse", "lesson_backstop"]]);
    h.store.close();
  });

  it("an abort inside the save (after planOf) writes no admit row", async () => {
    const ac = new AbortController();
    const h = setup(REFUSED_LESSON_WITH_FACT, { inSave: () => ac.abort() });
    const { run_id, claim } = liveTurn(h);
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop", signal: ac.signal });
    expect(ac.signal.aborted).toBe(true); // the hook really fired inside the save
    expect(w.result).toMatchObject({ ok: true, output: { saved: false, reason: "turn_ended" } });
    expect(admitRows(h.store, run_id)).toEqual([]);
    h.store.close();
  });

  it("a scheduled run with an already-aborted signal writes no admit row (pre seam)", async () => {
    const h = setup(REFUSED_LESSON_WITH_FACT);
    const { run_id, claim } = scheduleRun(h.store);
    h.worker.buildOmpTools(claim, CHAT);
    const ac = new AbortController(); ac.abort();
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop", signal: ac.signal });
    expect(w.result).toMatchObject({ ok: true, output: { reason: "scheduled-run" } }); // the pre seam did refuse; only the flush is withheld
    expect(admitRows(h.store, run_id)).toEqual([]);
    h.store.close();
  });

  it("the turn's state replaced inside the save writes no admit row", async () => {
    let swap: (() => void) | undefined;
    const h = setup(REFUSED_LESSON_WITH_FACT, { inSave: () => swap?.() });
    const { run_id, claim } = liveTurn(h);
    swap = () => { const m = turnsOf(h.worker); m.set(run_id, { ...m.get(run_id)! }); };
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    expect(w.result).toMatchObject({ ok: true, output: { saved: false, reason: "turn_ended" } });
    expect(admitRows(h.store, run_id)).toEqual([]);
    h.store.close();
  });

  it("a race inside the save keeps the backstop row on a live turn (row and result may differ, spec §4.1)", async () => {
    let race: (() => void) | undefined;
    const h = setup(REFUSED_LESSON_WITH_FACT, { inSave: () => race?.() });
    const { run_id, claim } = liveTurn(h);
    race = () => { turnsOf(h.worker).get(run_id)!.memorySavedThisTurn = { fact: { id: 99 } }; };
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    expect(w.result).toMatchObject({ ok: true, output: { saved: false, reason: "already_saved_this_turn" } });
    expect(admitRows(h.store, run_id)).toEqual([["refuse", "lesson_backstop"]]);
    h.store.close();
  });

  it("memory.kind's held write throwing past the recorder still writes the admit row on a live turn", async () => {
    // Why it matters: the two flushes are independent; one lost row must not take the other with it.
    const h = setup(REFUSED_LESSON_WITH_FACT);
    const { run_id, claim } = liveTurn(h);
    const recorder = (h.worker as unknown as { decisionRecorder: { record: (entry: { id: string }, ...rest: unknown[]) => unknown } }).decisionRecorder;
    const real = recorder.record.bind(recorder);
    vi.spyOn(recorder, "record").mockImplementation((entry, ...rest) => { if (entry.id === "memory.kind") throw new Error("kind write failed"); return real(entry, ...rest); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" }).catch(() => undefined);
    expect(admitRows(h.store, run_id)).toEqual([["refuse", "lesson_backstop"]]);
    h.store.close();
  });

  it("a store insert fault opens decision_record_failed and leaves the result unchanged", async () => {
    const base = setup(REFUSED_LESSON_WITH_FACT);
    const b = scheduleRun(base.store);
    base.worker.buildOmpTools(b.claim, CHAT);
    const expected = (await base.worker.runMemoryWrite(b.claim, CHAT, {}, { source: "loop" })).result;
    base.store.close();

    const h = setup(REFUSED_LESSON_WITH_FACT);
    const { run_id, claim } = scheduleRun(h.store);
    h.worker.buildOmpTools(claim, CHAT);
    vi.spyOn(h.store, "insertDecision").mockImplementationOnce(() => { throw new Error("disk full"); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    expect(w.result).toEqual(expected);
    expect(h.store.listOpenIncidents().filter((i) => i.kind === "decision_record_failed")).toHaveLength(1);
    expect(admitRows(h.store, run_id)).toEqual([]);
    h.store.close();
  });
});

/** A schedule-born turn: runSource is "schedule", so the adapter refuses at the pre seam. */
function scheduleRun(store: RunStore) {
  const sched = new Gateway(store).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "daily brief: synthetic goal",
    requested_by: { kind: "schedule", id: "sch_t" }, notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `sched:${Math.random()}`, source_reference: "scheduled_tasks.sch_t" }));
  if (!sched.ok) throw new Error("intake failed");
  return { run_id: sched.run_id, claim: store.claimRun(sched.run_id, "w", 120)! };
}
