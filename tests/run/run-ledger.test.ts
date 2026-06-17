import { describe, expect, it } from "vitest";
import { createLedgerEvent, validateLedgerEvent } from "../../src/run/run-ledger.js";
import { RunStore } from "../../src/run/run-store.js";

describe("Run Ledger events", () => {
  it("creates event envelopes with correlation ids", () => {
    const event = createLedgerEvent({
      run_id: "run_1",
      correlation_id: "cli_1",
      event_type: "run_created",
      actor: "gateway",
      sequence: 1,
      payload: {
        source: "cli",
        idempotency_key: "cli:1",
        program: "research-brief",
        goal_hash: "abc",
        requester: { kind: "user", id: "paco" }
      }
    });

    expect(event.event_id).toMatch(/^evt_/);
    expect(validateLedgerEvent(event).ok).toBe(true);
  });

  it("rejects missing required payload fields", () => {
    const event = createLedgerEvent({
      run_id: "run_1",
      correlation_id: "cli_1",
      event_type: "policy_decision",
      actor: "capability_runner",
      sequence: 2,
      payload: { decision: "allow" }
    });

    expect(validateLedgerEvent(event)).toEqual({
      ok: false,
      error: "policy_decision missing required payload field: tool_call_id"
    });
  });

  if (false) {
    // @ts-expect-error ledger event envelopes require correlation ids.
    createLedgerEvent({
      run_id: "run_1",
      event_type: "run_created",
      actor: "gateway",
      sequence: 1,
      payload: {
        source: "cli",
        idempotency_key: "cli:1",
        program: "research-brief",
        goal_hash: "abc",
        requester: { kind: "user", id: "paco" }
      }
    });
  }

  it("persists validated events in append-only order", () => {
    const store = RunStore.openInMemory();
    try {
      const first = createLedgerEvent({
        run_id: "run_1",
        correlation_id: "cli_1",
        event_type: "run_created",
        actor: "gateway",
        sequence: 1,
        payload: {
          source: "cli",
          idempotency_key: "cli:1",
          program: "research-brief",
          goal_hash: "abc",
          requester: { kind: "user", id: "paco" }
        }
      });
      const second = createLedgerEvent({
        run_id: "run_1",
        correlation_id: "cli_1",
        event_type: "report_written",
        actor: "core",
        sequence: 2,
        payload: {
          report_ref: "runs/run_1/report.md",
          report_hash: "hash",
          partial: false
        }
      });

      store.appendLedgerEvent(first);
      store.appendLedgerEvent(second);

      expect(store.getLedgerEvents("run_1").map((event) => event.event_type)).toEqual([
        "run_created",
        "report_written"
      ]);
    } finally {
      store.close();
    }
  });

  it("rejects invalid events before ledger persistence", () => {
    const store = RunStore.openInMemory();
    try {
      const event = createLedgerEvent({
        run_id: "run_1",
        correlation_id: "cli_1",
        event_type: "policy_decision",
        actor: "capability_runner",
        sequence: 1,
        payload: { decision: "allow" }
      });

      expect(() => store.appendLedgerEvent(event)).toThrow(
        "policy_decision missing required payload field: tool_call_id"
      );
      expect(store.getLedgerEvents("run_1")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
