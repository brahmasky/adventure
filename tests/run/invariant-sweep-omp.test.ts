import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { DISK_FREE_LOW_BYTES, runInvariantSweep } from "../../src/run/invariant-sweep.js";

// The omp-runtime sweep invariants (spec §8): each opens an incident on the transition into
// violation and resolves on the first clean sweep — alerts are transition-only, like every incident.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

const ARMED: NodeJS.ProcessEnv = { HOUGE_INVARIANT_SWEEP_ENABLED: "1", HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "5" };
const open = (kind: string) => store.listOpenIncidents().filter((i) => i.kind === kind);
/** Sweep instants around the REAL clock: ledger rows carry real `occurred_at`, so "since the last sweep" must too. */
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe("disk_free_low — free bytes on the data volume under 2 GB", () => {
  const disk = { free: DISK_FREE_LOW_BYTES - 1 };
  const statfs = () => ({ bavail: disk.free, bsize: 1 });

  it("opens one incident with the free MB when violated and resolves when space comes back", () => {
    runInvariantSweep({ store, now: at(0), env: ARMED, dataDir: "/data", statfs });
    expect(open("disk_free_low")).toEqual([expect.objectContaining({ subject: "data_volume" })]);
    expect(JSON.parse(open("disk_free_low")[0]!.detail_json)).toEqual({ free_mb: 2047 });
    runInvariantSweep({ store, now: at(10), env: ARMED, dataDir: "/data", statfs });
    expect(open("disk_free_low")).toHaveLength(1); // recurring, not reopened
    disk.free = DISK_FREE_LOW_BYTES;
    runInvariantSweep({ store, now: at(20), env: ARMED, dataDir: "/data", statfs });
    expect(open("disk_free_low")).toEqual([]);
  });

  it("is not evaluated without a data dir, and a statfs failure is never a violation", () => {
    runInvariantSweep({ store, now: at(0), env: ARMED, statfs });
    runInvariantSweep({ store, now: at(10), env: ARMED, dataDir: "/gone", statfs: () => { throw new Error("ENOENT"); } });
    expect(open("disk_free_low")).toEqual([]);
  });
});

describe("wall_collapsed — any wall_collapse row since the previous sweep (D10)", () => {
  const collapse = (n: number) =>
    store.llmAuditSink({ correlation_id: `tick:r${n}`, role: "reader" })
      .record({ provider: "google-antigravity", role: "", outcome: "ok", model: "gemini-3.8-flash", family: "gemini", family_collapse: true, request_key: `tick:r${n}:0` });

  it("opens while reads collapse onto the planner's family and resolves on the first sweep with none", () => {
    runInvariantSweep({ store, now: at(-60), env: ARMED });
    expect(open("wall_collapsed")).toEqual([]);
    collapse(1);
    collapse(2);
    runInvariantSweep({ store, now: at(1), env: ARMED });
    expect(open("wall_collapsed")).toEqual([expect.objectContaining({ subject: "reader" })]);
    expect(JSON.parse(open("wall_collapsed")[0]!.detail_json)).toEqual({ collapses: 2 });
    runInvariantSweep({ store, now: at(20), env: ARMED });
    expect(open("wall_collapsed")).toEqual([]);
  });

  it("counts every collapse row on the very first sweep (no previous instant)", () => {
    collapse(3);
    runInvariantSweep({ store, now: at(0), env: ARMED });
    expect(open("wall_collapsed")).toHaveLength(1);
  });
});
