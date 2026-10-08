import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { ompWorker } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// The calibration report blocks ROWS TO ADD on any state-parity mismatch between a live shadow decision and its replay
// (triage-report parityCheck). That is only safe if a turn with no real difference replays to the SAME state_hash: live
// cuts the thread when the turn is claimed and computes `last_houge_turn.age_s` when it builds the state, and the replay
// must use those two recorded instants, not the row's write time. Otherwise benign timing drift stalls arming forever.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const liveFetch = vi.fn(async () => json(200, {}));

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

// The live ↔ replay state-hash case moves to Task 12 (replay over the tree's state).
describe("triage state parity: live shadow decision ↔ replay", () => {
  it("skipped rows carry no instants (they have no state)", async () => {
    vi.stubEnv("HOUGE_JEV_ENABLED", "0");
    const store = RunStore.openInMemory();
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hpar-")), { jevFetch: liveFetch as unknown as typeof fetch });
    const run_id = createQueuedTurnRun(store, "hi");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555");
    await worker.triageTurn({ claim, text: "hi", userText: "hi", modality: "text", posture: null, signal: new AbortController().signal });
    expect(store.listJevDecisions(run_id)).toMatchObject([{ status: "skipped", thread_cut_at: null, state_built_at: null }]);
    store.close();
  });
});
