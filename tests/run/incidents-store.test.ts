import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

/**
 * Incident store + invariant detection (introspection slice A, ADR 0024). The incident
 * lifecycle is open → (touch)* → resolved, rows are never deleted, and a recurrence after
 * resolution opens a NEW row so recurrence stays countable.
 */

let store: RunStore;
beforeEach(() => {
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
});

const NOW = "2026-07-20T00:00:00.000Z";

describe("incidents store (introspection slice A)", () => {
  it("openIncident inserts an open row with seen_count 1 and records the ledger transition", () => {
    const row = store.openIncident({
      kind: "duplicate_schedule",
      subject: "sch_abc",
      detail: { count: 2 },
      now: NOW
    });
    expect(row.incident_id).toMatch(/^inc_/);
    expect(row.fingerprint).toBe("duplicate_schedule:sch_abc");
    expect(row.state).toBe("open");
    expect(row.seen_count).toBe(1);
    expect(row.first_seen_at).toBe(NOW);
    expect(row.last_seen_at).toBe(NOW);
    expect(row.resolved_at).toBeNull();
    expect(JSON.parse(row.detail_json)).toEqual({ count: 2 });

    const events = store.getLedgerEvents().filter((e) => e.event_type === "incident_opened");
    expect(events.length).toBe(1);
    expect(events[0]!.actor).toBe("system");
    expect(events[0]!.payload).toMatchObject({
      incident_id: row.incident_id,
      kind: "duplicate_schedule",
      subject: "sch_abc"
    });
  });

  it("findOpenIncident locates by fingerprint; touchIncident bumps recency and the counter only", () => {
    const opened = store.openIncident({
      kind: "stuck_run",
      subject: "run_1",
      detail: { state: "running" },
      now: NOW
    });
    expect(store.findOpenIncident("stuck_run:run_1")?.incident_id).toBe(opened.incident_id);

    store.touchIncident(opened.incident_id, "2026-07-20T00:05:00.000Z");
    const after = store.getIncident(opened.incident_id)!;
    expect(after.seen_count).toBe(2);
    expect(after.last_seen_at).toBe("2026-07-20T00:05:00.000Z");
    expect(after.first_seen_at).toBe(NOW); // unchanged
    expect(after.state).toBe("open");
    // A repeat detection is silent on the ledger too — only transitions are events.
    expect(store.getLedgerEvents().filter((e) => e.event_type === "incident_opened").length).toBe(1);
  });

  it("resolveIncident stamps resolved_at, emits the resolve event, and never deletes the row", () => {
    const opened = store.openIncident({
      kind: "heartbeat_gap",
      subject: "daemon",
      detail: { gap_minutes: 42 },
      now: NOW
    });
    expect(store.resolveIncident(opened.incident_id, "2026-07-20T01:00:00.000Z")).toBe(true);
    expect(store.findOpenIncident("heartbeat_gap:daemon")).toBeUndefined();

    const row = store.getIncident(opened.incident_id)!;
    expect(row.state).toBe("resolved");
    expect(row.resolved_at).toBe("2026-07-20T01:00:00.000Z");

    const resolved = store.getLedgerEvents().filter((e) => e.event_type === "incident_resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.payload).toMatchObject({ incident_id: opened.incident_id, open_minutes: 60 });

    // Resolving twice is a no-op, never a throw and never a second event.
    expect(store.resolveIncident(opened.incident_id, "2026-07-20T02:00:00.000Z")).toBe(false);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "incident_resolved").length).toBe(1);
  });

  it("a resolved fingerprint that violates again opens a NEW row — recurrence stays countable", () => {
    const first = store.openIncident({ kind: "failed_schedule", subject: "sch_x", detail: {}, now: NOW });
    store.resolveIncident(first.incident_id, "2026-07-20T01:00:00.000Z");
    const second = store.openIncident({
      kind: "failed_schedule",
      subject: "sch_x",
      detail: {},
      now: "2026-07-20T02:00:00.000Z"
    });
    expect(second.incident_id).not.toBe(first.incident_id);
    expect(store.listOpenIncidents().map((r) => r.incident_id)).toEqual([second.incident_id]);
  });

  it("findRecentlyResolvedIncident is the flap detector — window-scoped, resolved-only", () => {
    const opened = store.openIncident({ kind: "overdue_schedule", subject: "sch_f", detail: {}, now: NOW });
    // While still open it must not read as recently-resolved.
    expect(store.findRecentlyResolvedIncident("overdue_schedule:sch_f", NOW)).toBeUndefined();

    store.resolveIncident(opened.incident_id, "2026-07-20T01:00:00.000Z");
    expect(
      store.findRecentlyResolvedIncident("overdue_schedule:sch_f", "2026-07-20T00:30:00.000Z")?.incident_id
    ).toBe(opened.incident_id);
    // Outside the window the flap detector goes quiet again.
    expect(
      store.findRecentlyResolvedIncident("overdue_schedule:sch_f", "2026-07-20T01:30:00.000Z")
    ).toBeUndefined();
  });

  it("listOpenIncidents returns only open rows, oldest first", () => {
    const a = store.openIncident({ kind: "stuck_run", subject: "run_a", detail: {}, now: NOW });
    const b = store.openIncident({
      kind: "stuck_run",
      subject: "run_b",
      detail: {},
      now: "2026-07-20T00:01:00.000Z"
    });
    store.resolveIncident(a.incident_id, "2026-07-20T00:02:00.000Z");
    expect(store.listOpenIncidents().map((r) => r.incident_id)).toEqual([b.incident_id]);
  });

  it("claimInvariantSweep latches: one claim per interval, persisted across calls", () => {
    expect(store.claimInvariantSweep(NOW, 5 * 60 * 1000)).toBe(true);
    expect(store.claimInvariantSweep("2026-07-20T00:04:00.000Z", 5 * 60 * 1000)).toBe(false);
    expect(store.claimInvariantSweep("2026-07-20T00:05:01.000Z", 5 * 60 * 1000)).toBe(true);
  });
});

describe("invariant detection queries", () => {
  function addSchedule(overrides: Record<string, unknown> = {}) {
    return store.addScheduledTask({
      chat_id: "555",
      goal: "AI周报",
      spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
      tz: "Australia/Sydney",
      next_run_at: "2099-01-01T00:00:00.000Z",
      now: NOW,
      ...overrides
    } as Parameters<RunStore["addScheduledTask"]>[0]);
  }

  it("findDuplicateEnabledSchedules groups identical enabled rows and ignores history", () => {
    const a = addSchedule();
    const b = addSchedule();
    const found = store.findDuplicateEnabledSchedules();
    expect(found.length).toBe(1);
    expect(found[0]).toMatchObject({ chat_id: "555", duplicate_count: 2 });
    expect(found[0]!.schedule_ids.sort()).toEqual([a.schedule_id, b.schedule_id].sort());

    // Disabling one clears the violation — history rows never count.
    store.cancelScheduledTask(b.schedule_id, NOW);
    expect(store.findDuplicateEnabledSchedules()).toEqual([]);

    // A different goal is not a duplicate.
    addSchedule({ goal: "different" });
    expect(store.findDuplicateEnabledSchedules()).toEqual([]);
  });

  it("findOverdueSchedules respects the grace window and ignores disabled rows", () => {
    const overdue = addSchedule({ next_run_at: "2026-07-19T00:00:00.000Z" });
    addSchedule({ goal: "future", next_run_at: "2099-01-01T00:00:00.000Z" });
    const found = store.findOverdueSchedules(NOW, 15 * 60 * 1000);
    expect(found.map((r) => r.subject)).toEqual([overdue.schedule_id]);
    expect(found[0]!.overdue_minutes).toBe(24 * 60);

    store.cancelScheduledTask(overdue.schedule_id, NOW);
    expect(store.findOverdueSchedules(NOW, 15 * 60 * 1000)).toEqual([]);
  });

  it("findFailedSchedules surfaces rows parked as failed", () => {
    const row = addSchedule();
    store.recordScheduleFailure(row.schedule_id, NOW, 1); // maxConsecutive 1 → flips to failed
    expect(store.findFailedSchedules().map((r) => r.subject)).toEqual([row.schedule_id]);
  });

  it("findHeartbeatGap fires only past the grace window", () => {
    store.recordPollHeartbeat({ now: "2026-07-19T23:00:00.000Z", ok: true });
    expect(store.findHeartbeatGap(NOW, 10 * 60 * 1000)?.gap_minutes).toBe(60);
    store.recordPollHeartbeat({ now: "2026-07-19T23:59:00.000Z", ok: true });
    expect(store.findHeartbeatGap(NOW, 10 * 60 * 1000)).toBeUndefined();
  });

  it("findUndeliveredNotifications flags only rows older than the grace window", () => {
    store.enqueueNotification({
      target: { kind: "telegram", chat_id: "555" },
      intent_type: "progress",
      idempotency_key: "stale-note",
      correlation_id: "test",
      payload: { text: "hi" }
    });
    // enqueueNotification stamps created_at from the real clock, so this case is anchored
    // to Date.now() rather than the fixture NOW.
    const realNow = new Date().toISOString();
    // Fresh: inside the grace window, not yet an incident.
    expect(store.findUndeliveredNotifications(realNow, 15 * 60 * 1000)).toEqual([]);
    // An hour later the same undelivered row is a delivery failure.
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const found = store.findUndeliveredNotifications(later, 15 * 60 * 1000);
    expect(found.length).toBe(1);
    expect(found[0]!.intent_type).toBe("progress");
  });
});
