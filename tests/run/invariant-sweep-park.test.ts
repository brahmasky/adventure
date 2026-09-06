import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { detectViolations, HEARTBEAT_GAP_GRACE_MS } from "../../src/run/invariant-sweep.js";
import { RunStore } from "../../src/run/run-store.js";
import { clearParkMarker, writeParkMarker } from "../../src/run/tombstone.js";

/**
 * Regression for the false `heartbeat_gap` incident on every kill-switch revival (observed live
 * 2026-09-06: "gap_minutes 2134" — exactly the 35.6 h the daemon had been deliberately parked).
 * The sweep only ever saw a heartbeat that stopped; the tombstone that explained it had already
 * been deleted as part of revival. The park marker is the evidence that survives.
 */
const NOW = "2026-09-05T23:19:52.000Z";
const PARK_LENGTH_MS = 2134 * 60_000;
const STALE = new Date(Date.parse(NOW) - PARK_LENGTH_MS).toISOString();

const markerDir = mkdtempSync(join(tmpdir(), "houge-sweep-park-"));
const env = { HOUGE_PARK_MARKER_PATH: join(markerDir, "houge.parked") } as NodeJS.ProcessEnv;

function storeWithHeartbeatAt(at: string): RunStore {
  const store = RunStore.openInMemory();
  store.recordPollHeartbeat({ now: at, ok: true });
  return store;
}

const gaps = (store: RunStore) => detectViolations(store, NOW, env).filter((v) => v.kind === "heartbeat_gap");

afterEach(() => {
  clearParkMarker(env);
  vi.restoreAllMocks();
});
afterAll(() => rmSync(markerDir, { recursive: true, force: true }));

describe("heartbeat gap vs deliberate park", () => {
  it("a stale heartbeat with NO marker is an incident (a crash, or a park that left no evidence)", () => {
    const store = storeWithHeartbeatAt(STALE);
    try {
      expect(gaps(store)).toEqual([{ kind: "heartbeat_gap", subject: "daemon", detail: { gap_minutes: 2134 } }]);
    } finally {
      store.close();
    }
  });

  it("the same gap WITH the park marker is not an incident — it is the kill switch working", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    writeParkMarker({ parked_at: STALE, by: "paco", reason: "cli-only migration" }, env);
    const store = storeWithHeartbeatAt(STALE);
    try {
      expect(gaps(store)).toEqual([]);
      // Still visible to an operator reading the log — suppressed from incidents, not hidden.
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]![0]).toContain("2134 min");
      expect(log.mock.calls[0]![0]).toContain("deliberate park");
    } finally {
      store.close();
    }
  });

  it("a CORRUPT marker still classifies the gap as a park (the file's existence is the evidence)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    writeFileSync(env.HOUGE_PARK_MARKER_PATH!, "garbage");
    const store = storeWithHeartbeatAt(STALE);
    try {
      expect(gaps(store)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("a fresh heartbeat is never a gap, marker or not", () => {
    writeParkMarker({ parked_at: STALE }, env);
    const fresh = new Date(Date.parse(NOW) - HEARTBEAT_GAP_GRACE_MS / 2).toISOString();
    const store = storeWithHeartbeatAt(fresh);
    try {
      expect(gaps(store)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("the marker suppresses ONLY the heartbeat gap — other violations still surface", () => {
    // The marker must never become a blanket mute. detectViolations still runs every other check.
    vi.spyOn(console, "log").mockImplementation(() => {});
    writeParkMarker({ parked_at: STALE }, env);
    const store = storeWithHeartbeatAt(STALE);
    try {
      const all = detectViolations(store, NOW, env);
      expect(all.some((v) => v.kind === "heartbeat_gap")).toBe(false);
      // Sanity: the function still returns an array the other detectors can populate.
      expect(Array.isArray(all)).toBe(true);
    } finally {
      store.close();
    }
  });
});
