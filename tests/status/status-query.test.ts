import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { queryStatus } from "../../src/status/status-query.js";

describe("queryStatus", () => {
  it("returns a single run status with ledger event count", () => {
    const store = RunStore.openInMemory();
    try {
      const intake = new Gateway(store).intake(buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "compare gateway designs",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:status-one",
        source_reference: "argv"
      }));
      if (!intake.ok) throw new Error("expected intake");

      expect(queryStatus(store, intake.run_id)).toMatchObject({
        ok: true,
        status: { run_id: intake.run_id, state: "queued", program: "research-brief", event_count: 2 }
      });
    } finally {
      store.close();
    }
  });

  it("returns recent runs plus a budget/error overview when no run id is supplied", () => {
    const store = RunStore.openInMemory();
    try {
      const caps = { runs: 5, tool_calls: 10, gated_attempts: 3 };
      expect(
        queryStatus(store, undefined, { now: "2026-06-18T00:00:00.000Z", caps })
      ).toEqual({
        ok: true,
        status: {
          runs: [],
          overview: {
            window_hours: 24,
            runs_by_state: {},
            last_error: null,
            budget: [
              { kind: "runs", used: 0, limit: 5, remaining: 5 },
              { kind: "tool_calls", used: 0, limit: 10, remaining: 10 },
              { kind: "gated_attempts", used: 0, limit: 3, remaining: 3 }
            ],
            poller: null,
            rating: { pending_since: null, last_rating: null, last_rating_at: null },
            sweep: { last_swept_at: null, open_incidents: 0 }
          }
        }
      });
    } finally {
      store.close();
    }
  });

  it("surfaces the invariant-sweep self-check state: last sweep instant + open incident count", () => {
    // Why: /status HEALTH renders the self-check line from these two fields — a never-swept
    // system must read null (→ "never"), and open incidents must be counted, not listed.
    const store = RunStore.openInMemory();
    try {
      store.claimInvariantSweep("2026-06-18T00:00:00.000Z", 60_000);
      store.openIncident({
        kind: "stuck_run",
        subject: "run_abc",
        detail: { run_id: "run_abc" },
        now: "2026-06-18T00:00:00.000Z"
      });

      const result = queryStatus(store, undefined, { now: "2026-06-18T00:05:00.000Z" });
      if (!result.ok || !("runs" in result.status)) throw new Error("expected overview");
      expect(result.status.overview.sweep).toEqual({
        last_swept_at: "2026-06-18T00:00:00.000Z",
        open_incidents: 1
      });
    } finally {
      store.close();
    }
  });

  it("returns non-empty recent runs when runs exist", () => {
    const store = RunStore.openInMemory();
    try {
      const intake = new Gateway(store).intake(buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "summarize status projection",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:status-recent",
        source_reference: "argv"
      }));
      if (!intake.ok) throw new Error("expected intake");

      expect(queryStatus(store)).toMatchObject({
        ok: true,
        status: {
          runs: [
            {
              run_id: intake.run_id,
              state: "queued",
              program: "research-brief",
              event_count: 2
            }
          ]
        }
      });
    } finally {
      store.close();
    }
  });
});
