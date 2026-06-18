import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { queryStatus } from "../../src/status/status-query.js";
import {
  resolveGlobalBudgetCaps,
  DEFAULT_GLOBAL_BUDGET_CAPS,
  type GlobalBudgetCaps
} from "../../src/budget/global-budget-ledger.js";

const CAPS: GlobalBudgetCaps = { runs: 2, tool_calls: 1000, gated_attempts: 100 };

function askEvent(n: number, now: string) {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "ask",
    goal: `question ${n}`,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "chat-1" },
    idempotency_key: `tg:ask-${n}`,
    source_reference: `update-${n}`,
    created_at: now
  });
}

describe("global budget circuit-breaker", () => {
  it("admits runs up to the cap, then refuses the (N+1)th with a fuse event", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store, CAPS);
      const now = "2026-06-18T12:00:00.000Z";

      // First two admissions succeed (cap = 2).
      expect(gateway.intake(askEvent(1, now), now).ok).toBe(true);
      expect(gateway.intake(askEvent(2, now), now).ok).toBe(true);

      // The third is refused by the breaker.
      const third = gateway.intake(askEvent(3, now), now);
      expect(third.ok).toBe(false);
      if (!third.ok) expect(third.error.code).toBe("GLOBAL_BUDGET_FUSE");

      // A global_budget_fuse ledger event was written for the refusal.
      const fuseEvents = store
        .getLedgerEvents()
        .filter((e) => e.event_type === "global_budget_fuse");
      expect(fuseEvents.length).toBeGreaterThanOrEqual(1);
      expect(fuseEvents[0]?.payload.window_hours).toBe(24);
    } finally {
      store.close();
    }
  });

  it("enqueues EXACTLY ONE alert per fuse episode (deduped across refusals)", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store, CAPS);
      const t0 = "2026-06-18T12:00:00.000Z";
      gateway.intake(askEvent(1, t0), t0);
      gateway.intake(askEvent(2, t0), t0);

      // First over-cap refusal arms the latch at t1 and alerts.
      const t1 = "2026-06-18T12:01:00.000Z";
      gateway.intake(askEvent(3, t1), t1);
      // Two more refusals in the same episode must NOT alert again.
      gateway.intake(askEvent(4, "2026-06-18T12:02:00.000Z"), "2026-06-18T12:02:00.000Z");
      gateway.intake(askEvent(5, "2026-06-18T12:03:00.000Z"), "2026-06-18T12:03:00.000Z");

      expect(store.countNotificationsByIdempotencyKey(`global-budget-fuse:${t1}`)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("re-arms after admissions drop back under cap (a later breach alerts again)", () => {
    const store = RunStore.openInMemory();
    try {
      // cap = 1: admit one, breach, then the window clears, admit again, breach again.
      const gateway = new Gateway(store, { ...CAPS, runs: 1 });
      const admit = "2026-06-18T00:00:00.000Z";
      expect(gateway.intake(askEvent(1, admit), admit).ok).toBe(true);

      const breach1 = "2026-06-18T01:00:00.000Z";
      expect(gateway.intake(askEvent(2, breach1), breach1).ok).toBe(false);
      expect(store.countNotificationsByIdempotencyKey(`global-budget-fuse:${breach1}`)).toBe(1);

      // 26h later the first admission has aged out → a new admission succeeds,
      // which disarms the latch.
      const later = "2026-06-19T02:00:00.000Z";
      expect(gateway.intake(askEvent(3, later), later).ok).toBe(true);

      // Another over-cap run now is a fresh episode and alerts again.
      const breach2 = "2026-06-19T03:00:00.000Z";
      expect(gateway.intake(askEvent(4, breach2), breach2).ok).toBe(false);
      expect(store.countNotificationsByIdempotencyKey(`global-budget-fuse:${breach2}`)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("ages out admissions older than the 24h window", () => {
    const store = RunStore.openInMemory();
    try {
      // Record three admissions, one of them 25h before 'now'.
      store.recordGlobalBudgetRun({ now: "2026-06-17T11:00:00.000Z" }); // 25h old
      store.recordGlobalBudgetRun({ now: "2026-06-18T11:30:00.000Z" });
      store.recordGlobalBudgetRun({ now: "2026-06-18T11:45:00.000Z" });
      const now = "2026-06-18T12:00:00.000Z";

      // With cap=3 and only 2 admissions inside the window, admitting is allowed.
      expect(store.checkGlobalBudget({ ...CAPS, runs: 3 }, now).ok).toBe(true);
      // With cap=2, the two in-window admissions already hit the cap.
      const breached = store.checkGlobalBudget({ ...CAPS, runs: 2 }, now);
      expect(breached.ok).toBe(false);
      if (!breached.ok) expect(breached.breaches[0]).toMatchObject({ kind: "runs", used: 2, limit: 2 });
    } finally {
      store.close();
    }
  });

  it("does NOT gate /status or approval control commands", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store, { ...CAPS, runs: 0 }); // breaker fully tripped
      const now = "2026-06-18T12:00:00.000Z";
      const status = gateway.intake(
        buildTypedTaskEvent({
          source: "telegram",
          type: "status",
          requested_by: { kind: "user", id: "paco" },
          notify: { kind: "telegram", chat_id: "chat-1" },
          idempotency_key: "tg:status-1",
          source_reference: "update-status",
          created_at: now
        }),
        now
      );
      // Even with runs cap at 0, a status command is served, not fused.
      expect(status.ok).toBe(true);
      if (status.ok) expect(status.status).toBe("status_returned");
    } finally {
      store.close();
    }
  });

  it("surfaces per-cap headroom, run counts by state, and last error in /status", () => {
    const store = RunStore.openInMemory();
    try {
      const now = "2026-06-18T12:00:00.000Z";
      new Gateway(store, CAPS).intake(askEvent(1, now), now);

      const status = queryStatus(store, undefined, { now, caps: CAPS });
      expect(status.ok).toBe(true);
      if (status.ok && "runs" in status.status) {
        const overview = status.status.overview;
        expect(overview.window_hours).toBe(24);
        // One admitted ask run, currently queued.
        expect(overview.runs_by_state).toMatchObject({ queued: 1 });
        expect(overview.last_error).toBeNull();
        expect(overview.budget).toContainEqual({
          kind: "runs",
          used: 1,
          limit: 2,
          remaining: 1
        });
      }
    } finally {
      store.close();
    }
  });
});

describe("resolveGlobalBudgetCaps", () => {
  it("falls back to documented defaults when env is unset", () => {
    expect(resolveGlobalBudgetCaps({})).toEqual(DEFAULT_GLOBAL_BUDGET_CAPS);
  });

  it("reads caps from the environment", () => {
    expect(
      resolveGlobalBudgetCaps({
        HOUGE_GLOBAL_MAX_RUNS_24H: "10",
        HOUGE_GLOBAL_MAX_TOOL_CALLS_24H: "20",
        HOUGE_GLOBAL_MAX_GATED_ATTEMPTS_24H: "5"
      })
    ).toEqual({ runs: 10, tool_calls: 20, gated_attempts: 5 });
  });

  it("ignores non-numeric or negative overrides", () => {
    expect(
      resolveGlobalBudgetCaps({ HOUGE_GLOBAL_MAX_RUNS_24H: "nope", HOUGE_GLOBAL_MAX_TOOL_CALLS_24H: "-3" })
    ).toEqual(DEFAULT_GLOBAL_BUDGET_CAPS);
  });
});
