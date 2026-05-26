import { describe, expect, it } from "vitest";
import { createLedgerEvent, validateLedgerEvent } from "../../src/run/run-ledger.js";

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
});
