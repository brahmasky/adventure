import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkEmbeddingsAvailable, runInvariantSweep, SWEEP_INCIDENT_KINDS } from "../../src/run/invariant-sweep.js";
import { RunStore } from "../../src/run/run-store.js";

// `embeddings_unavailable`: a failed embed degrades silently to keyword-only recall, so a sustained outage must be loud.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

const ARMED: NodeJS.ProcessEnv = { HOUGE_INVARIANT_SWEEP_ENABLED: "1", HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "5" };
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const open = () => store.listOpenIncidents().filter((i) => i.kind === "embeddings_unavailable");
let seq = 0;
const BASE = { manifest: [], hint: "loop", applied_artifacts: {} };

/** A `loop_started` row; `embedding: undefined` models a row with no `retrieval` key (gate 0 / pre-A1). */
function turn(minutesAgo: number, embedding: boolean | undefined): void {
  seq += 1;
  store.appendLedgerEvent({
    event_id: `ev-${seq}`, correlation_id: `c-${seq}`, event_type: "loop_started", occurred_at: iso(minutesAgo), actor: "system", sequence: seq,
    payload: embedding === undefined ? BASE : {
      ...BASE, retrieval: { facts: { admitted: 0, best_admitted: null, best_rejected: null, embedding, fts_only: !embedding }, pages: {} }
    }
  });
}
const nowIso = (plusMin = 0) => new Date(NOW + plusMin * 60_000).toISOString();
const sweep = (plusMin = 0) => runInvariantSweep({ store, now: nowIso(plusMin), env: ARMED, chat_id: "555" });
const alerts = () => (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
  .prepare("SELECT idempotency_key FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'").all().length;

describe("embeddings_unavailable", () => {
  it("is one of the sweep's own kinds, so the sweep may resolve it", () => {
    expect(SWEEP_INCIDENT_KINDS).toContain("embeddings_unavailable");
  });

  it("3 turns in the window all without an embedding open one incident, alerted once across sweeps", () => {
    turn(30, false); turn(20, false); turn(10, false);
    expect(checkEmbeddingsAvailable(store, nowIso())).toEqual({ open: true, turns: 3, without: 3 });
    sweep(0);
    sweep(10);
    expect(open()).toHaveLength(1);
    expect(alerts()).toBe(1);
  });

  it("resolves once any turn in the window obtained an embedding", () => {
    turn(30, false); turn(20, false); turn(10, false);
    sweep(0);
    turn(-5, true);
    sweep(10);
    expect(open()).toEqual([]);
    expect(checkEmbeddingsAvailable(store, nowIso(10))).toMatchObject({ open: false, without: 3 });
  });

  it("2 turns is no evidence: nothing opens", () => {
    turn(20, false); turn(10, false);
    expect(checkEmbeddingsAvailable(store, nowIso())).toEqual({ open: false, turns: 2, without: 2 });
    sweep();
    expect(open()).toEqual([]);
  });

  it("rows without retrieval telemetry are ignored, not counted as outage turns", () => {
    turn(30, false); turn(20, false); turn(15, undefined); turn(12, undefined); turn(10, undefined);
    expect(checkEmbeddingsAvailable(store, nowIso())).toEqual({ open: false, turns: 2, without: 2 });
  });

  it("turns older than the window are not evidence", () => {
    turn(13 * 60, false); turn(13 * 60 + 1, false); turn(13 * 60 + 2, false);
    expect(checkEmbeddingsAvailable(store, nowIso())).toMatchObject({ open: false, turns: 0 });
  });
});
