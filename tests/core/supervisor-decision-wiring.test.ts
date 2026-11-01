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
});
