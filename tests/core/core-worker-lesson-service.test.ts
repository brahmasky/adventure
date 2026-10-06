import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { ompWorker } from "../helpers/omp-worker.js";

// Spec §5.5: ONE pipeline for the loop tool and the lane; the lane's save leaves a lesson_changes row and a
// lesson_saved ledger event in the same transaction as the lesson; a second write in the turn is refused by code.
// The stub tells the two seat calls apart by their system prompt: DISTILL_DISCIPLINE says "durable", RECONCILE does not.
const distillThenReconcile = (answers: { durable: string; reconcile: string }) => async (input: Record<string, unknown>) => {
  const answer = /durable/i.test(String(input.system ?? "")) ? answers.durable : answers.reconcile;
  return { ok: true as const, output: { answer } };
};
const SAVING = { durable: JSON.stringify({ durable: true, lesson: "Keep replies short.", avoid: "Long preambles" }),
  reconcile: JSON.stringify({ verdict: "ADD", theme: "format" }) };

describe("CoreWorker.runLessonWrite", () => {
  it("source 'lane' saves through reconcile, records lesson_changes + lesson_saved, and sets lessonSavedThisTurn", async () => {
    const store = RunStore.openInMemory();
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm: distillThenReconcile(SAVING) });
    const run_id = createQueuedTurnRun(store, "以后回复短一点");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555"); // creates the OmpTurnState the service reads
    const out = await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "lane" });
    expect(out.result.ok).toBe(true);
    expect(out.committed).toBe(true);
    expect(out.saved?.id).toBeDefined();
    expect(out.theme).toBe("format");
    expect(out.change_id).toMatch(/^lc_/);
    expect(store.getLessonChange(out.change_id!)).toMatchObject({ new_id: out.saved!.id, chat_id: "555", run_id });
    expect(store.getLedgerEvents().some((e) => e.event_type === "lesson_saved" && e.payload.change_id === out.change_id && e.payload.source === "lane")).toBe(true);
    expect(store.getLesson(out.saved!.id)?.source).toBe("lane");
    // second call in the same turn: the adapter-level guard, zero LLM calls
    const again = await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "loop" });
    expect(again.result).toEqual({ ok: true, output: { saved: false, reason: "already_saved_this_turn", lesson_id: out.saved!.id } });
    expect(again.committed).toBe(false);
    store.close();
  });

  // Final review (T7 minor): the guard was read once when the adapter was built, so two lesson_write calls in flight in
  // one turn both passed it and both saved. It is re-checked right before the save transaction.
  it("two parallel lesson_write calls in one turn save exactly once; the other gets the already-saved digest", async () => {
    const store = RunStore.openInMemory();
    const llm = async (input: Record<string, unknown>) => { await new Promise((r) => setTimeout(r, 5)); return distillThenReconcile(SAVING)(input); };
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm });
    const run_id = createQueuedTurnRun(store, "以后回复短一点");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555");
    const [a, b] = await Promise.all([1, 2].map(() => worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "loop" })));
    const won = [a!, b!].filter((o) => o.committed);
    expect(won).toHaveLength(1);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved")).toHaveLength(1);
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    const lost = [a!, b!].find((o) => !o.committed)!;
    expect(lost.result).toEqual({ ok: true, output: { saved: false, reason: "already_saved_this_turn", lesson_id: won[0]!.saved!.id } });
    store.close();
  });

  it("the loop tool path is unchanged for the planner (source 'loop', same gates)", async () => {
    const store = RunStore.openInMemory();
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm: distillThenReconcile({ durable: JSON.stringify({ durable: false }), reconcile: "{}" }) });
    const run_id = createQueuedTurnRun(store, "谢谢");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555");
    const out = await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "loop" });
    expect(out.result.ok && (out.result.output as { saved: boolean }).saved).toBe(false);
    expect(out.change_id).toBeUndefined();
    expect(out.committed).toBe(false);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    store.close();
  });

  it("the voice transcript, not the placeholder objective, is the feedback anchor (loop caller parity)", async () => {
    // resolveOmpMessage sets state.objective for voice; the service must read it like ompLoopExecute does.
    const seen: string[] = [];
    const llm = async (input: Record<string, unknown>) => { seen.push(String(input.question)); return { ok: true as const, output: { answer: JSON.stringify({ durable: false }) } }; };
    const store = RunStore.openInMemory(); const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm });
    const run_id = createQueuedTurnRun(store, "[voice]"); const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555"); worker.setOmpObjectiveForTest(run_id, "以后回复短一点");
    await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "loop" });
    expect(seen[0]).toContain("以后回复短一点"); expect(seen[0]).not.toContain("[voice]");
    store.close();
  });

  it("inTx runs inside the save transaction; a throwing hook rolls the lesson back and leaves no guard", async () => {
    const store = RunStore.openInMemory(); const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm: distillThenReconcile({
      durable: JSON.stringify({ durable: true, lesson: "Keep replies short." }), reconcile: JSON.stringify({ verdict: "ADD", theme: "format" }) }) });
    const run_id = createQueuedTurnRun(store, "以后回复短一点"); const claim = store.claimRun(run_id, "w", 120)!; worker.buildOmpTools(claim, "555");
    const out = await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "lane", inTx: () => { throw new Error("boom"); } });
    expect(out.result.ok).toBe(false); expect(out.committed).toBe(false);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    const again = await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "loop" });
    expect(again.result.ok && (again.result.output as { reason?: string }).reason).not.toBe("already_saved_this_turn"); // guard was never set
    store.close();
  });

  it("inTx sees the saved lesson and its change_id inside the transaction", async () => {
    const store = RunStore.openInMemory(); const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm: distillThenReconcile(SAVING) });
    const run_id = createQueuedTurnRun(store, "以后回复短一点"); const claim = store.claimRun(run_id, "w", 120)!; worker.buildOmpTools(claim, "555");
    const hook: Array<{ id: number | undefined; change_id: string; row: boolean }> = [];
    const out = await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "lane",
      inTx: (saved, change_id) => { hook.push({ id: saved.id, change_id, row: store.getLessonChange(change_id) !== undefined }); } });
    expect(hook).toEqual([{ id: out.saved!.id, change_id: out.change_id!, row: true }]);
    store.close();
  });

  it("no save after the turn is gone: an aborted signal or a replaced turn state yields drop and writes nothing", async () => {
    const store = RunStore.openInMemory(); const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm: distillThenReconcile({
      durable: JSON.stringify({ durable: true, lesson: "Keep replies short." }), reconcile: JSON.stringify({ verdict: "ADD", theme: "format" }) }) });
    const run_id = createQueuedTurnRun(store, "以后回复短一点"); const claim = store.claimRun(run_id, "w", 120)!; worker.buildOmpTools(claim, "555");
    const ac = new AbortController(); ac.abort();
    const out = await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "lane", signal: ac.signal });
    expect(out.saved).toBeUndefined(); expect(out.committed).toBe(false); expect(store.getActiveLessons("ask")).toHaveLength(0);
    // the turn state replaced mid-reconcile (a new buildOmpTools for the run): the old call no longer saves
    let rebuild = (): void => undefined;
    const racing = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm: async (input) => {
      if (!/durable/i.test(String(input.system ?? ""))) rebuild();
      return distillThenReconcile({ durable: JSON.stringify({ durable: true, lesson: "Keep replies short." }), reconcile: JSON.stringify({ verdict: "ADD", theme: "format" }) })(input);
    } });
    const run2 = createQueuedTurnRun(store, "以后回复短一点"); const claim2 = store.claimRun(run2, "w", 120)!; racing.buildOmpTools(claim2, "555");
    rebuild = () => { racing.buildOmpTools(claim2, "555"); };
    const raced = await racing.runLessonWrite(claim2, "555", { scope: "ask" }, { source: "lane" });
    expect(raced.saved).toBeUndefined(); expect(raced.committed).toBe(false); expect(store.getActiveLessons("ask")).toHaveLength(0);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    store.close();
  });
});
