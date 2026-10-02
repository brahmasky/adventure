import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInvariantSweep, SWEEP_INCIDENT_KINDS } from "../../src/run/invariant-sweep.js";
import { RunStore } from "../../src/run/run-store.js";

// Memory A1 sweep invariants: each opens on the transition into violation and resolves on the first clean sweep.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

const ARMED: NodeJS.ProcessEnv = { HOUGE_INVARIANT_SWEEP_ENABLED: "1", HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "5" };
const open = (kind: string) => store.listOpenIncidents().filter((i) => i.kind === kind);
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe("lesson_dropped — an active ask/research lesson the omp prompt cannot fit (spec §1)", () => {
  it("is one of the sweep's own kinds, so the sweep may resolve it", () => {
    expect(SWEEP_INCIDENT_KINDS).toContain("lesson_dropped");
  });

  it("opens one incident per dropped lesson and resolves it once the lesson no longer drops", () => {
    const env = { ...ARMED, HOUGE_LESSON_CHAR_CAP: "60" };
    store.addLesson({ scope: "ask", text: "answer briefly", source: "loop" });
    const big = store.addLesson({ scope: "research", text: "y".repeat(80), source: "loop" });
    runInvariantSweep({ store, now: at(0), env });
    expect(open("lesson_dropped")).toEqual([expect.objectContaining({ subject: `lesson:${big}` })]);
    expect(JSON.parse(open("lesson_dropped")[0]!.detail_json)).toMatchObject({ lesson_id: big, cap: 60 });
    store.forgetLesson(big);
    runInvariantSweep({ store, now: at(10), env });
    expect(open("lesson_dropped")).toEqual([]);
  });
});
