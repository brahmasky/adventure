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

  it("returns recent runs when no run id is supplied", () => {
    const store = RunStore.openInMemory();
    try {
      expect(queryStatus(store)).toEqual({ ok: true, status: { runs: [] } });
    } finally {
      store.close();
    }
  });
});
