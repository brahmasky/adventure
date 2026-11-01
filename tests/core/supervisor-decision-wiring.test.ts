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
});
