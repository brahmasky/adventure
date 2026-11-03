import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoreWorker } from "../../src/core/core-worker.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp, useFakeOmp } from "../helpers/omp-env.js";
import { fakeLog, ompWorker, until } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

pinOmpEnv();
pinEnabledFlags();
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
let worker: CoreWorker | undefined;
beforeEach(() => {
  tmp = shortTmp("hcw-");
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  process.env.FAKE_OMP_ARGV_LOG = join(tmp.dir, "argv.log");
  process.env.HOUGE_TELEGRAM_CHAT_ID = "";
  store = RunStore.openInMemory();
});
afterEach(async () => { await worker?.shutdownPlanners(); worker = undefined; store.close(); tmp.cleanup(); delete process.env.HOUGE_TOMBSTONE_PATH; delete process.env.HOUGE_TELEGRAM_CHAT_ID; });

describe("production wiring: CoreWorker passes its recorder to the supervisor", () => {
  it("a steer through CoreWorker.submitTurn writes the intake.steer_or_queue row", async () => {
    useFakeOmp({ "*": { rpcText: "both", rpcFinishOnSteer: true } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const parent = createQueuedTurnRun(store, "first"); worker.submitTurn(parent);
    await until(() => fakeLog(join(tmp.dir, "argv.log")).some((l) => (l.cmd as { type?: string } | undefined)?.type === "prompt"));
    const child = createQueuedTurnRun(store, "second"); worker.submitTurn(child);
    await until(() => store.getRunState(parent) === "completed" && store.getRunState(child) === "completed");
    expect(store.listDecisionsForRun(child).filter((r) => r.entry_id === "intake.steer_or_queue").map((r) => [r.verdict, r.reason_code])).toEqual([["steer", "live_turn"]]);
  });
  it("R4 (a): a first leg erroring quota then succeeding writes the turn.retry retry/quota row on the run", async () => {
    // the fake omp keys its scenario by the model it was pinned to: Default's head errors, the next candidate answers
    useFakeOmp({ "anthropic/claude-opus-5-5": { rpcErrorText: "429 usage limit reached" }, "*": { rpcText: "ok" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "first"); worker.submitTurn(run);
    await until(() => store.getRunState(run) === "completed");
    expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "turn.retry").map((r) => [r.verdict, r.reason_code])).toEqual([["retry", "quota"]]);
    expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "planner.crash_guard")).toEqual([]);
  });
  it("R4 (b): three failed starts then a turn writes the planner.crash_guard halt/limit_reached row on that run", async () => {
    useFakeOmp({ rpcStderrAtStart: "synthetic start failure", "*": { rpcText: "ok" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const runs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const run = createQueuedTurnRun(store, `t${i}`); runs.push(run); worker.submitTurn(run);
      await until(() => store.getRunState(run) === "failed");
    }
    const r4 = runs[3] as string;
    expect(store.getLedgerEvents(r4).find((e) => e.event_type === "run_failed")?.payload).toMatchObject({ error_type: "planner_exit", error_ref: "crash_loop" });
    expect(store.listDecisionsForRun(r4).filter((r) => r.entry_id === "planner.crash_guard").map((r) => [r.verdict, r.reason_code])).toEqual([["halt", "limit_reached"]]);
    for (const run of runs.slice(0, 3)) expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "planner.crash_guard")).toEqual([]);
  });
  it("R5 (a): a seeded clarify streak then a turn writes the turn.clarify_cap cap/cap_reached row on the run (ompTurnContext passes the recorder)", async () => {
    useFakeOmp({ "*": { rpcText: "ok" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    store.recordChatTurn({ chat_id: "555", run_id: "r0", role: "assistant", text: "Which file do you mean?", intent: "clarify" });
    const run = createQueuedTurnRun(store, "the pdf one"); worker.submitTurn(run);
    await until(() => store.getRunState(run) === "completed");
    expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "turn.clarify_cap").map((r) => [r.verdict, r.reason_code])).toEqual([["cap", "cap_reached"]]);
  });
  it("R5 (b): lessons over a lowered HOUGE_LESSON_CHAR_CAP write the context.lessons capped/char_cap row on the first turn's run (the spawn)", async () => {
    const prior = process.env.HOUGE_LESSON_CHAR_CAP;
    process.env.HOUGE_LESSON_CHAR_CAP = "40"; // the supervisor's turnContext.env is process.env in production
    try {
      useFakeOmp({ "*": { rpcText: "ok" } }, tmp.dir);
      worker = ompWorker(store, tmp.dir);
      store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
      store.addLesson({ scope: "ask", text: "z".repeat(60), source: "user_feedback" });
      const run = createQueuedTurnRun(store, "first"); worker.submitTurn(run);
      await until(() => store.getRunState(run) === "completed");
      expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "context.lessons").map((r) => [r.verdict, r.reason_code])).toEqual([["capped", "char_cap"]]);
    } finally { if (prior === undefined) delete process.env.HOUGE_LESSON_CHAR_CAP; else process.env.HOUGE_LESSON_CHAR_CAP = prior; }
  });
  it("R5 (c): recall whose embed fails writes the context.recall none/embed_failed row on the run (ompTurnContext passes the recorder)", async () => {
    process.env.HOUGE_EPISODIC_ENABLED = "1"; // after pinEnabledFlags(); resolveEpisodicEnabled reads it
    try {
      useFakeOmp({ "*": { rpcText: "ok" } }, tmp.dir);
      worker = ompWorker(store, tmp.dir, { embed: async () => null });
      const run = createQueuedTurnRun(store, "the pdf one"); worker.submitTurn(run);
      await until(() => store.getRunState(run) === "completed");
      expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "context.recall").map((r) => [r.verdict, r.reason_code, r.run_id, r.tool_call_id ?? null])).toEqual([["none", "embed_failed", run, null]]);
    } finally { delete process.env.HOUGE_EPISODIC_ENABLED; }
  });
  it("R6 (a): the fake omp refusing Default's head writes turn.model fallback/refused and the child is pinned to the next candidate (P14-10)", async () => {
    // rpcSetModelRefuse is top-level in the scenario (the fake reads `scen`, not the per-model bucket); omp's `Model not found` text classifies as a refusal
    useFakeOmp({ rpcSetModelRefuse: ["anthropic/claude-opus-5-5"], "*": { rpcText: "ok" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "first"); worker.submitTurn(run);
    await until(() => store.getRunState(run) === "completed");
    expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "turn.model").map((r) => [r.verdict, r.reason_code])).toEqual([["fallback", "refused"]]);
    const pinned = fakeLog(join(tmp.dir, "argv.log")).map((l) => l.cmd as { type?: string; provider?: string; modelId?: string } | undefined)
      .filter((c) => c?.type === "set_model").map((c) => `${c!.provider}/${c!.modelId}`);
    expect(pinned).toHaveLength(2);
    expect(pinned[0]).toBe("anthropic/claude-opus-5-5");
    expect(pinned[1]).not.toBe("anthropic/claude-opus-5-5");
  });
  it("R6 (b): R4 (a)'s quota scenario also writes turn.model fallback/next_leg on the run", async () => {
    useFakeOmp({ "anthropic/claude-opus-5-5": { rpcErrorText: "429 usage limit reached" }, "*": { rpcText: "ok" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "first"); worker.submitTurn(run);
    await until(() => store.getRunState(run) === "completed");
    expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "turn.model").map((r) => [r.verdict, r.reason_code])).toEqual([["fallback", "next_leg"]]);
  });
});
