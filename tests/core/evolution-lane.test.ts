import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVOLUTION_LANE_BUSY_DIGEST,
  evolutionLaneSettled,
  evolutionLaneSnapshot,
  resetEvolutionLaneForTests,
  tryStartEvolutionPipeline
} from "../../src/core/evolution-lane.js";
import type { EvolutionLaneOutcome } from "../../src/core/evolution-lane.js";

/**
 * ⓪·3g lane-wrapper semantics: single occupancy, wall-clock cap = the sub-contract
 * budget, exactly ONE delivered outcome (success / failure / timeout), and the lane
 * ALWAYS released in finally. These pin the wrapper directly (tiny caps + fake
 * pipelines); the integration path rides core-worker-selfwrite.test.ts.
 */

const CURRENT = { run_id: "run_x", tool: "self_write_propose", started_at: "2026-07-04T00:00:00Z" };

beforeEach(() => resetEvolutionLaneForTests());
afterEach(async () => {
  await evolutionLaneSettled();
  resetEvolutionLaneForTests();
});

function start(opts: {
  capMs?: number;
  run: () => Promise<EvolutionLaneOutcome>;
  delivered: EvolutionLaneOutcome[];
  deliver?: (outcome: EvolutionLaneOutcome) => void;
}): boolean {
  return tryStartEvolutionPipeline({
    current: CURRENT,
    capMs: opts.capMs ?? 60_000,
    run: opts.run,
    onTimeout: () => ({ text: "TIMEOUT-OUTCOME" }),
    onError: (detail) => ({ text: `ERROR-OUTCOME: ${detail}` }),
    deliver: opts.deliver ?? ((o) => opts.delivered.push(o))
  });
}

describe("tryStartEvolutionPipeline", () => {
  it("busy digest is the pinned user-facing refusal text", () => {
    expect(EVOLUTION_LANE_BUSY_DIGEST).toContain("已有一个自我修改在进行中");
  });

  it("claims the lane, delivers the pipeline outcome ONCE, and releases in finally", async () => {
    const delivered: EvolutionLaneOutcome[] = [];
    const buttons = [{ text: "🔀 Merge & reload", data: "selfwrite:merge:run_x" }];
    expect(start({ run: async () => ({ text: "published", buttons }), delivered })).toBe(true);
    expect(evolutionLaneSnapshot()).toMatchObject({ busy: true, current: { tool: "self_write_propose", run_id: "run_x" } });
    await evolutionLaneSettled();
    expect(delivered).toEqual([{ text: "published", buttons }]);
    expect(evolutionLaneSnapshot().busy).toBe(false);
  });

  it("refuses a second start while busy (returns false, launches nothing)", async () => {
    const delivered: EvolutionLaneOutcome[] = [];
    let release!: () => void;
    const gate = new Promise<EvolutionLaneOutcome>((resolve) => { release = () => resolve({ text: "first" }); });
    expect(start({ run: () => gate, delivered })).toBe(true);
    let secondRan = false;
    expect(
      start({
        run: async () => {
          secondRan = true;
          return { text: "second" };
        },
        delivered
      })
    ).toBe(false);
    release();
    await evolutionLaneSettled();
    expect(secondRan).toBe(false);
    expect(delivered).toEqual([{ text: "first" }]);
    // Released → a new pipeline can start.
    expect(start({ run: async () => ({ text: "third" }), delivered })).toBe(true);
    await evolutionLaneSettled();
    expect(delivered).toEqual([{ text: "first" }, { text: "third" }]);
  });

  it("a pipeline THROW delivers the code-owned error outcome and releases the lane", async () => {
    const delivered: EvolutionLaneOutcome[] = [];
    expect(start({ run: async () => { throw new Error("gate exploded"); }, delivered })).toBe(true);
    await evolutionLaneSettled();
    expect(delivered).toEqual([{ text: "ERROR-OUTCOME: gate exploded" }]);
    expect(evolutionLaneSnapshot().busy).toBe(false);
  });

  it("the wall-clock cap fires: a hanging pipeline delivers the timeout outcome and releases the lane", async () => {
    const delivered: EvolutionLaneOutcome[] = [];
    let releaseOrphan!: () => void;
    const hang = new Promise<EvolutionLaneOutcome>((resolve) => {
      releaseOrphan = () => resolve({ text: "LATE-ORPHAN" });
    });
    expect(start({ capMs: 20, run: () => hang, delivered })).toBe(true);
    await evolutionLaneSettled();
    expect(delivered).toEqual([{ text: "TIMEOUT-OUTCOME" }]);
    expect(evolutionLaneSnapshot().busy).toBe(false);
    // The orphan's LATE completion delivers NOTHING (once-only guard).
    releaseOrphan();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(delivered).toEqual([{ text: "TIMEOUT-OUTCOME" }]);
  });

  it("a deliver() throw is swallowed — the lane still comes free", async () => {
    const delivered: EvolutionLaneOutcome[] = [];
    expect(
      start({
        run: async () => ({ text: "ok" }),
        delivered,
        deliver: () => { throw new Error("outbox closed"); }
      })
    ).toBe(true);
    await evolutionLaneSettled();
    expect(evolutionLaneSnapshot().busy).toBe(false);
    // And a fresh start works afterwards.
    expect(start({ run: async () => ({ text: "next" }), delivered })).toBe(true);
    await evolutionLaneSettled();
    expect(delivered).toEqual([{ text: "next" }]);
  });

  it("evolutionLaneSettled resolves immediately when idle", async () => {
    await expect(evolutionLaneSettled()).resolves.toBeUndefined();
  });
});
