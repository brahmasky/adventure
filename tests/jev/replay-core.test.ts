import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDone, runReplayCore, type ReplayCoreDeps, type ReplayRowBase } from "../../src/jev/replay-core.js";

type Row = ReplayRowBase & { n: number };
const DONE: ReadonlySet<string> = new Set(["ok", "skipped"]);

function deps(outPath: string, dispatch: (r: Row) => Promise<Row>, over: Partial<ReplayCoreDeps<Row>> = {}): ReplayCoreDeps<Row> {
  return {
    source: () => [{ key: "k1" }, { key: "k2" }, { key: "k3" }],
    prepare: async ({ key }) => ({ key, status: "ok", est_usd: 0, n: Number(key.slice(1)) }),
    dispatch, estimateUsd: () => 0.001, outPath, maxUsd: 1, dryRun: false, doneStatuses: DONE, ...over
  };
}

// Spec §3.6: the replay is resumable and append-only; a failure must re-open its key, or a transient 500 would
// silently drop a turn from the GO/STOP denominator forever.
describe("runReplayCore", () => {
  it("latest row wins: a key that failed is re-dispatched on the next run, done keys are left untouched", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "rc-")), "r.jsonl");
    const first: string[] = [];
    await runReplayCore(deps(out, async (r) => { first.push(r.key); return { ...r, status: r.key === "k2" ? "jev_failed" : "ok" }; }));
    expect(first).toEqual(["k1", "k2", "k3"]);
    expect(readDone(out, DONE).has("k2")).toBe(false);
    const second: string[] = [];
    const r = await runReplayCore(deps(out, async (row) => { second.push(row.key); return { ...row, status: "ok" }; }));
    expect(second).toEqual(["k2"]);
    expect(r.rows.map((x) => [x.key, x.status])).toEqual([["k1", "ok"], ["k2", "ok"], ["k3", "ok"]]);
    expect(r.rows.find((x) => x.key === "k2")!.attempt).toBe(2); // a resumed retry is visible in the row
    expect(r.alreadyDone).toBe(2);
  });

  it("a later failed row re-opens a key that was done before", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "rc-")), "r.jsonl");
    await runReplayCore(deps(out, async (r) => ({ ...r, status: "ok" })));
    await runReplayCore(deps(out, async (r) => ({ ...r, status: "jev_failed" }), { source: () => [{ key: "k1" }] , dryRun: false, doneStatuses: new Set() }));
    expect(readDone(out, DONE).has("k1")).toBe(false);
    expect(readDone(out, DONE).has("k3")).toBe(true);
  });

  it("a dry run reports the universe and writes nothing", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "rc-")), "r.jsonl");
    let calls = 0;
    const r = await runReplayCore(deps(out, async (row) => { calls++; return row; }, { dryRun: true }));
    expect(r).toMatchObject({ universe: 3, wouldDispatch: 3, alreadyDone: 0, skipped: 0, spentUsd: 0 });
    expect(r.rows.every((x) => x.status === "dry_run")).toBe(true);
    expect(calls).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it("a skip is written once and counted; a budget stop leaves the rest undispatched", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "rc-")), "r.jsonl");
    const r = await runReplayCore(deps(out, async (row) => ({ ...row, status: "ok" }), {
      prepare: async ({ key }) => (key === "k1" ? { skip: { key, status: "skipped", est_usd: 0, n: 1 } } : { key, status: "ok", est_usd: 0, n: 2 }),
      estimateUsd: () => 0.6
    }));
    expect(r.skipped).toBe(1);
    expect(r.stopped).toBe("budget");
    expect(readFileSync(out, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as Row).key)).toEqual(["k1", "k2"]);
  });

  it("stops on a row that carries `stop` (auth / fused)", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "rc-")), "r.jsonl");
    const r = await runReplayCore(deps(out, async (row) => ({ ...row, status: "jev_failed", stop: "auth" as const })));
    expect(r.stopped).toBe("auth");
    expect(r.rows).toHaveLength(1);
  });
});
