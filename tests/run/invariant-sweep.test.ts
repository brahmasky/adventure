import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import {
  INCIDENT_ALERTS_PER_SWEEP_MAX,
  DEFAULT_INVARIANT_SWEEP_INTERVAL_MS,
  buildIncidentOpenedText,
  resolveInvariantSweepIntervalMs,
  runInvariantSweep
} from "../../src/run/invariant-sweep.js";

/**
 * The invariant sweep tick (introspection slice A, ADR 0024). Harness mirrors
 * tests/run/schedule-tick.test.ts: a real RunStore, a fixture clock passed as `now`, and the
 * feature flag passed explicitly as `env` (production defaults to process.env).
 */

let store: RunStore;
beforeEach(() => {
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
});

const NOW = "2026-07-20T00:00:00.000Z";
const ARMED: NodeJS.ProcessEnv = { HOUGE_INVARIANT_SWEEP_ENABLED: "1" };
/**
 * Flap damping only has meaning when the cadence is faster than the 30-min quiet window; at
 * the 12h default a "reopen" half a day later is a genuinely new episode and SHOULD alert.
 */
const ARMED_FAST: NodeJS.ProcessEnv = {
  HOUGE_INVARIANT_SWEEP_ENABLED: "1",
  HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "5"
};
const FAST_INTERVAL_MS = 5 * 60 * 1000;

/** Private-db accessor, same shape tests/budget/metered-ceiling.test.ts uses for the outbox. */
function outboxDb(): {
  prepare(sql: string): { all<T>(...v: unknown[]): T[]; get<T>(...v: unknown[]): T | undefined };
} {
  return (
    store as unknown as {
      db: { prepare(sql: string): { all<T>(...v: unknown[]): T[]; get<T>(...v: unknown[]): T | undefined } };
    }
  ).db;
}

function openedAlertKeys(): string[] {
  return outboxDb()
    .prepare("SELECT idempotency_key FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'")
    .all<{ idempotency_key: string }>()
    .map((r) => r.idempotency_key);
}

function addDuplicatePair() {
  const base = {
    chat_id: "555",
    goal: "AI周报",
    spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
    tz: "Australia/Sydney",
    next_run_at: "2099-01-01T00:00:00.000Z",
    now: NOW
  };
  return [store.addScheduledTask(base), store.addScheduledTask(base)];
}

describe("runInvariantSweep (introspection slice A)", () => {
  it("disarmed by default: no queries, no incidents, no latch", () => {
    addDuplicatePair();
    const result = runInvariantSweep({ store, now: NOW, env: {} });
    expect(result).toEqual({
      swept: false,
      opened: 0,
      resolved: 0,
      recurring: 0,
      alerts_suppressed: 0
    });
    expect(store.listOpenIncidents()).toEqual([]);
  });

  it("armed: opens ONE incident per violation and alerts exactly once", () => {
    const [a, b] = addDuplicatePair();
    const result = runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    expect(result.swept).toBe(true);
    expect(result.opened).toBe(1);

    const open = store.listOpenIncidents();
    expect(open.length).toBe(1);
    expect(open[0]!.kind).toBe("duplicate_schedule");
    // The subject is MIN(schedule_id) over the duplicate group — stable, but which of the
    // pair wins depends on uuid ordering, so assert membership rather than a specific row.
    expect([a!.schedule_id, b!.schedule_id]).toContain(open[0]!.subject);

    const events = store.getLedgerEvents().filter((e) => e.event_type === "incident_opened");
    expect(events.length).toBe(1);
    expect(events[0]!.actor).toBe("system");

    const note = outboxDb()
      .prepare("SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?")
      .get<{ payload_json: string }>(`incident_opened:${open[0]!.incident_id}`);
    expect(note).toBeDefined();
    expect((JSON.parse(note!.payload_json) as { text: string }).text).toBe(
      buildIncidentOpenedText(open[0]!.kind, open[0]!.subject, JSON.parse(open[0]!.detail_json))
    );
  });

  it("throttles: a second sweep inside the interval is a no-op", () => {
    addDuplicatePair();
    runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    const soon = new Date(Date.parse(NOW) + DEFAULT_INVARIANT_SWEEP_INTERVAL_MS - 1000).toISOString();
    expect(runInvariantSweep({ store, now: soon, env: ARMED, chat_id: "555" })).toMatchObject({
      swept: false
    });
  });

  it("recurrence is silent: a later sweep bumps seen_count without a second incident or alert", () => {
    addDuplicatePair();
    runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    const later = new Date(Date.parse(NOW) + DEFAULT_INVARIANT_SWEEP_INTERVAL_MS + 1000).toISOString();
    const second = runInvariantSweep({ store, now: later, env: ARMED, chat_id: "555" });

    expect(second).toMatchObject({ swept: true, opened: 0, recurring: 1 });
    const open = store.listOpenIncidents();
    expect(open.length).toBe(1);
    expect(open[0]!.seen_count).toBe(2);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "incident_opened").length).toBe(1);
    expect(openedAlertKeys().length).toBe(1);
  });

  it("resolves when the condition clears, and records the resolve event", () => {
    const [, b] = addDuplicatePair();
    runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    store.cancelScheduledTask(b!.schedule_id, NOW); // the human fixed it

    const later = new Date(Date.parse(NOW) + DEFAULT_INVARIANT_SWEEP_INTERVAL_MS + 1000).toISOString();
    const second = runInvariantSweep({ store, now: later, env: ARMED, chat_id: "555" });
    expect(second).toMatchObject({ swept: true, resolved: 1 });
    expect(store.listOpenIncidents()).toEqual([]);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "incident_resolved").length).toBe(1);
  });

  it("a clean database opens nothing (the sweep ships silent)", () => {
    const result = runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    expect(result).toMatchObject({ swept: true, opened: 0, resolved: 0 });
    expect(store.listOpenIncidents()).toEqual([]);
    expect(openedAlertKeys()).toEqual([]);
  });

  it("storm cap: many simultaneous violations open every incident but alert at most the cap + a summary", () => {
    for (let i = 0; i < 6; i += 1) {
      const row = store.addScheduledTask({
        chat_id: "555",
        goal: `g${i}`,
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2099-01-01T00:00:00.000Z",
        now: NOW
      });
      store.recordScheduleFailure(row.schedule_id, NOW, 1); // → state 'failed'
    }
    const result = runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });

    // Every incident is recorded — the durable record is never truncated…
    expect(result.opened).toBe(6);
    expect(store.listOpenIncidents().length).toBe(6);
    // …but only the cap is alerted, and the remainder is counted.
    expect(result.alerts_suppressed).toBe(6 - INCIDENT_ALERTS_PER_SWEEP_MAX);
    expect(openedAlertKeys().length).toBe(INCIDENT_ALERTS_PER_SWEEP_MAX);
    // …plus exactly one summary line so a storm is never silent.
    const summary = outboxDb()
      .prepare("SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?")
      .get<{ payload_json: string }>(`incident_sweep_summary:${NOW}`);
    expect(summary).toBeDefined();
  });

  it("flap damping: a reopen inside the quiet window records the incident but sends no alert", () => {
    // Uses failed_schedule, whose subject IS the schedule_id — a stable fingerprint across
    // the flap. (duplicate_schedule's subject is MIN over the group, so changing the group's
    // membership legitimately changes the fingerprint and is a different incident.)
    const row = store.addScheduledTask({
      chat_id: "555",
      goal: "flapper",
      spec_json: '{"kind":"daily","at":"08:00"}',
      tz: "Australia/Sydney",
      next_run_at: "2099-01-01T00:00:00.000Z",
      now: NOW
    });
    store.recordScheduleFailure(row.schedule_id, NOW, 1); // → failed
    runInvariantSweep({ store, now: NOW, env: ARMED_FAST, chat_id: "555" });
    expect(openedAlertKeys().length).toBe(1);

    // Repaired (an update re-enables a failed row) → next sweep resolves it.
    store.updateScheduledTask({ schedule_id: row.schedule_id, goal: "flapper fixed" });
    const t1 = new Date(Date.parse(NOW) + FAST_INTERVAL_MS + 1000).toISOString();
    runInvariantSweep({ store, now: t1, env: ARMED_FAST, chat_id: "555" });
    expect(store.listOpenIncidents()).toEqual([]);

    // Fails again immediately (inside the quiet window) → row reopens, alert suppressed.
    store.recordScheduleFailure(row.schedule_id, t1, 1);
    const t2 = new Date(Date.parse(t1) + FAST_INTERVAL_MS + 1000).toISOString();
    const third = runInvariantSweep({ store, now: t2, env: ARMED_FAST, chat_id: "555" });

    expect(third.opened).toBe(1);
    expect(third.alerts_suppressed).toBe(1);
    expect(store.listOpenIncidents().length).toBe(1);
    // Still only the FIRST open's alert exists — the reopen added none.
    expect(openedAlertKeys().length).toBe(1);
  });

  it("cadence: defaults to twice a day and honours the minutes override", () => {
    expect(DEFAULT_INVARIANT_SWEEP_INTERVAL_MS).toBe(12 * 60 * 60 * 1000);
    expect(resolveInvariantSweepIntervalMs({})).toBe(DEFAULT_INVARIANT_SWEEP_INTERVAL_MS);
    expect(resolveInvariantSweepIntervalMs({ HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "30" })).toBe(
      30 * 60 * 1000
    );
    // Garbage and non-positive values fall back to the default rather than sweeping every tick.
    expect(resolveInvariantSweepIntervalMs({ HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "nope" })).toBe(
      DEFAULT_INVARIANT_SWEEP_INTERVAL_MS
    );
    expect(resolveInvariantSweepIntervalMs({ HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "0" })).toBe(
      DEFAULT_INVARIANT_SWEEP_INTERVAL_MS
    );
    expect(resolveInvariantSweepIntervalMs({ HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "-5" })).toBe(
      DEFAULT_INVARIANT_SWEEP_INTERVAL_MS
    );
  });

  it("at the default cadence a sweep 6h later is still throttled; 12h+ later runs", () => {
    addDuplicatePair();
    runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    const sixHours = new Date(Date.parse(NOW) + 6 * 60 * 60 * 1000).toISOString();
    expect(runInvariantSweep({ store, now: sixHours, env: ARMED })).toMatchObject({ swept: false });
    const halfDay = new Date(Date.parse(NOW) + 12 * 60 * 60 * 1000 + 1000).toISOString();
    expect(runInvariantSweep({ store, now: halfDay, env: ARMED })).toMatchObject({ swept: true });
  });

  it("never observes its OWN alerts — a delivery outage must not self-amplify", () => {
    addDuplicatePair();
    // Sweep 1 opens an incident and enqueues an alert. Nothing delivers it (no dispatcher).
    expect(runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" }).opened).toBe(1);
    expect(openedAlertKeys().length).toBe(1);

    // Sweep 2, twelve hours later: that alert is long past the undelivered grace window. If
    // the sweep counted its own output, it would open an incident about its own alert — and
    // the alert about THAT would also sit undelivered, growing the pile every cycle forever.
    const later = new Date(Date.parse(NOW) + DEFAULT_INVARIANT_SWEEP_INTERVAL_MS + 1000).toISOString();
    const second = runInvariantSweep({ store, now: later, env: ARMED, chat_id: "555" });
    expect(second).toMatchObject({ swept: true, opened: 0, recurring: 1 });
    expect(store.listOpenIncidents().length).toBe(1); // still just the duplicate-schedule one

    // A NON-sweep notification stuck in the outbox is still reported — the exclusion is
    // narrow (own alerts only), not a blanket blindness to delivery failure.
    store.enqueueNotification({
      target: { kind: "telegram", chat_id: "555" },
      intent_type: "progress",
      idempotency_key: "some-run-report",
      correlation_id: "run_x",
      payload: { text: "a real report" }
    });
    const third = new Date(Date.parse(later) + DEFAULT_INVARIANT_SWEEP_INTERVAL_MS + 1000).toISOString();
    runInvariantSweep({ store, now: third, env: ARMED, chat_id: "555" });
    expect(
      store.listOpenIncidents().filter((r) => r.kind === "undelivered_notification").length
    ).toBe(1);
  });

  it("without a chat_id the sweep still records incidents, silently", () => {
    addDuplicatePair();
    const result = runInvariantSweep({ store, now: NOW, env: ARMED });
    expect(result.opened).toBe(1);
    expect(store.listOpenIncidents().length).toBe(1);
    expect(openedAlertKeys()).toEqual([]);
  });
});
