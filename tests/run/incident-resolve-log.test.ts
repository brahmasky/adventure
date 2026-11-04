import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-11-03 §5.4: a log kind's fix is logged where the incident was, by the one place every resolve passes through.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); vi.restoreAllMocks(); });
const logs = () => store.listChangeLog("1970-01-01T00:00:00.000Z", 50);
const outboxCount = () => ((store as unknown as { db: DatabaseSync }).db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get() as { n: number }).n;
const NOW = "2026-11-03T05:00:00.000Z";

describe("RunStore.resolveIncident logs a fixed log kind", () => {
  it("static_list_stale -> one incident_log row 'Fixed: ...'", () => {
    const o = store.openIncident({ kind: "static_list_stale", subject: "kimi-code/k3", detail: {}, now: "2026-11-03T04:00:00.000Z" });
    expect(store.resolveIncident(o.incident_id, NOW)).toBe(true);
    expect(logs().map((r) => [r.topic, r.text])).toEqual([["incident_log", "✅ Fixed: A model in my fallback list left the catalog. — open 60 min"]]);
  });
  it("a page kind keeps its own notices: no row; and silent suppresses the row", () => {
    const p = store.openIncident({ kind: "omp_unavailable", subject: "omp:x", detail: {}, now: NOW });
    store.resolveIncident(p.incident_id, NOW);
    const l = store.openIncident({ kind: "static_list_stale", subject: "kimi-code/k3", detail: {}, now: NOW });
    store.resolveIncident(l.incident_id, NOW, { silent: true });
    expect(logs()).toEqual([]);
    expect(outboxCount()).toBe(0);
  });
  it("a row-only or legacy kind resolves with no row and nothing on stderr", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const kind of ["omp_version_mismatch", "planner_turn_refused", "shell_denied_x"]) {
      const o = store.openIncident({ kind, subject: "s", detail: {}, now: NOW });
      expect(store.resolveIncident(o.incident_id, NOW)).toBe(true);
    }
    expect(logs()).toEqual([]);
    expect(err).not.toHaveBeenCalled();
  });
});
