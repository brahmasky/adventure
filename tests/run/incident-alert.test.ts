import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import type { TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
import { openAlertedIncident, resolveOmpCheckIncidents } from "../../src/run/incident-alert.js";
import { buildIncidentOpenedText, runInvariantSweep } from "../../src/run/invariant-sweep.js";
import { RunStore } from "../../src/run/run-store.js";

// I1 (Task 14 fix round 1): incidents opened outside the sweep must page Paco once, and the sweep
// must never resolve them — it never re-detects them, so "not seen" says nothing about them.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

const ARMED: NodeJS.ProcessEnv = { HOUGE_INVARIANT_SWEEP_ENABLED: "1", HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "5" };
const notes = () => {
  const out: Array<Record<string, unknown>> = [];
  for (let n = store.claimNextNotification(`t${out.length}`, 30); n; n = store.claimNextNotification(`t${out.length}`, 30)) out.push(n.payload);
  return out;
};

describe("the sweep resolves only its own incident kinds", () => {
  for (const kind of ["omp_version_mismatch", "omp_unavailable", "turn_outside_planner"]) {
    it(`an open ${kind} survives a clean sweep and no "resolved" ping is sent`, () => {
      store.openIncident({ kind, subject: "omp:9.9.9", detail: {}, now: "2026-01-01T00:00:00.000Z" });
      const r = runInvariantSweep({ store, now: "2026-01-01T05:00:00.000Z", env: ARMED, chat_id: "555" });
      expect(r.resolved).toBe(0);
      expect(store.listOpenIncidents().map((i) => i.kind)).toEqual([kind]);
      expect(notes()).toEqual([]);
    });
  }

  it("a sweep kind that clears is still resolved (the lifecycle is unchanged for its own kinds)", () => {
    store.openIncident({ kind: "heartbeat_gap", subject: "daemon", detail: {}, now: "2026-01-01T00:00:00.000Z" });
    expect(runInvariantSweep({ store, now: "2026-01-01T05:00:00.000Z", env: ARMED }).resolved).toBe(1);
  });
});

describe("openAlertedIncident — one alert on open, throttled by the open incident", () => {
  it("opens once and enqueues ONE telegram alert with the incident text; a repeat is a no-op", () => {
    const input = { kind: "omp_version_mismatch", subject: "omp:9.9.9", detail: { version: "9.9.9" }, chat_id: "555" };
    expect(openAlertedIncident(store, input)).toBe(true);
    expect(openAlertedIncident(store, input)).toBe(false);
    expect(store.listOpenIncidents()).toHaveLength(1);
    expect(notes()).toEqual([expect.objectContaining({ text: buildIncidentOpenedText("omp_version_mismatch", "omp:9.9.9", { version: "9.9.9" }) })]);
  });

  it("with no chat given, pages the operator chat from HOUGE_TELEGRAM_CHAT_ID; with none, records the row only", () => {
    openAlertedIncident(store, { kind: "omp_unavailable", subject: "omp", detail: {}, env: { HOUGE_TELEGRAM_CHAT_ID: "777" } });
    openAlertedIncident(store, { kind: "turn_outside_planner", subject: "run:x", detail: {}, env: {} });
    expect(store.listOpenIncidents()).toHaveLength(2);
    expect(notes()).toHaveLength(1);
  });
});

describe("clearable omp-check incidents (fix round 2)", () => {
  it("resolveOmpCheckIncidents clears open omp_version_mismatch/omp_unavailable rows (any subject) and nothing else", () => {
    store.openIncident({ kind: "omp_version_mismatch", subject: "omp:9.9.9", detail: {} });
    store.openIncident({ kind: "omp_unavailable", subject: "chat:555", detail: {} });
    store.openIncident({ kind: "heartbeat_gap", subject: "daemon", detail: {} });
    expect(resolveOmpCheckIncidents(store)).toBe(2);
    expect(store.listOpenIncidents().map((i) => i.kind)).toEqual(["heartbeat_gap"]);
  });

  it("the worker's supervisor sink clears them when a planner start passes its version check", () => {
    store.openIncident({ kind: "omp_unavailable", subject: "chat:555", detail: {} });
    const worker = new CoreWorker(store, "/nonexistent/project", async () => ({ ok: true, output: { answer: "x" } }));
    (worker as unknown as { ompOutcomeSink(chat: string): TurnOutcomeSink }).ompOutcomeSink("555").versionOk?.();
    expect(store.listOpenIncidents()).toEqual([]);
  });

  it("an event incident is resolved right after its alert is queued", () => {
    expect(openAlertedIncident(store, { kind: "turn_outside_planner", subject: "run:x", detail: {}, chat_id: "555", event: true })).toBe(true);
    expect(store.listOpenIncidents()).toEqual([]);
    expect(notes()).toHaveLength(1);
  });
});
