import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreWorker } from "../../src/core/core-worker.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp, useFakeOmp } from "../helpers/omp-env.js";
import { ompWorker, until } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { ARM, calibrationFile, cat, treeSays } from "../helpers/triage-harness.js";

// Consumer 11 (spec §5.3): a routed turn's first planner llm_attempt carries routed_by = its jev_verdicts row id — the join
// every precision report reads. The pin sees the route's verdict id; this drives the real supervisor over triageTurn
// (core-worker.ts:2226) so the join itself is checked, before (Task 2) and after (Task 8b) the ladder moves the decision.
pinOmpEnv();
pinEnabledFlags();
let worker: CoreWorker | undefined;
let store: RunStore | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await worker?.shutdownPlanners();
  store?.close();
  cleanup?.();
  worker = undefined; store = undefined; cleanup = undefined;
  vi.unstubAllEnvs();
});

describe("routed_by joins the planner's first model call to the verdict row", () => {
  it("a routed planner turn: the first compose attempt's routed_by is the verdict id; later attempts carry none", async () => {
    const tmp = shortTmp("hrb-");
    cleanup = tmp.cleanup;
    vi.stubEnv("HOUGE_TOMBSTONE_PATH", join(tmp.dir, "houge.kill"));
    vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", calibrationFile()); vi.stubEnv("HOUGE_JEV_GATE", "1"); vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    for (const [k, v] of Object.entries(ARM)) vi.stubEnv(k, v);
    useFakeOmp({ "*": { rpcText: "好的，已整理。" } }, tmp.dir);
    store = RunStore.openInMemory();
    const s = store;
    worker = ompWorker(s, tmp.dir, { jevFetch: treeSays({ category: cat({ other: 0.9 }) }) as unknown as typeof fetch });
    const run = createQueuedTurnRun(s, "帮我整理一下这周的待办");
    worker.submitTurn(run);
    await until(() => s.getRunState(run) === "completed");
    const v = s.getJevVerdictForRun(run);
    expect(v).toMatchObject({ lane: "planner", reason: "routed" });
    const compose = s.getLedgerEvents(run).filter((e) => e.event_type === "llm_attempt" && (e.payload as { role?: string }).role === "compose")
      .map((e) => (e.payload as { routed_by?: string }).routed_by ?? null);
    expect(compose.length).toBeGreaterThan(0);
    expect(compose[0]).toBe(v!.verdict_id);
    expect(compose.slice(1).every((r) => r === null)).toBe(true);
  });
});
