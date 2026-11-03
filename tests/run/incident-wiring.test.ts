import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { ALERT_REOPEN_QUIET_MS, openAlertedIncident } from "../../src/run/incident-alert.js";
import { INCIDENT_ALERTS_PER_SWEEP_MAX, runInvariantSweep } from "../../src/run/invariant-sweep.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-11-03 §5: the route table decides where an incident goes before any chat is looked up. A log kind needs no
// chat and ignores flap damping; a page kind keeps today's chat path; a card kind sends no generic text.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
const db = () => (store as unknown as { db: DatabaseSync }).db;
const outbox = () => db().prepare("SELECT idempotency_key, payload_json FROM notification_outbox ORDER BY rowid").all() as Array<{ idempotency_key: string; payload_json: string }>;
const logs = () => store.listChangeLog("1970-01-01T00:00:00.000Z", 100);
const at = (min: number) => new Date(Date.parse("2026-10-01T00:00:00.000Z") + min * 60_000).toISOString();

describe("openAlertedIncident routes by kind", () => {
  it("a log kind writes one masked change_log row with no chat and no outbox row", () => {
    openAlertedIncident(store, { kind: "decision_record_failed", subject: "chat:-1001234567890", detail: { secret: "x" }, env: {} });
    expect(logs().map((r) => [r.topic, r.text])).toEqual([["incident_log",
      "A decision record failed to save; the decision itself ran. (`decision_record_failed` · a chat)"]]);
    expect(outbox()).toEqual([]);
  });
  it("a log kind reopened inside the quiet window logs again (log rows ignore flap damping)", () => {
    const input = { kind: "decision_record_failed" as const, subject: "turn.settle", detail: {}, chat_id: "555" };
    openAlertedIncident(store, { ...input, now: at(0) });
    for (const r of store.listOpenIncidents()) store.resolveIncident(r.incident_id, at(1));
    expect(openAlertedIncident(store, { ...input, now: at(2) })).toBe(true);
    expect(2 * 60_000).toBeLessThan(ALERT_REOPEN_QUIET_MS);
    expect(logs().filter((r) => r.topic === "incident_log" && r.text.startsWith("A decision record failed"))).toHaveLength(2);
    expect(outbox()).toEqual([]);
  });
  it("a page kind with an env chat is one outbox page in plain words and no change_log row", () => {
    openAlertedIncident(store, { kind: "omp_unavailable", subject: "omp:no_version", detail: { version: null }, env: { HOUGE_TELEGRAM_CHAT_ID: "777" } });
    const rows = outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotency_key).toMatch(/^incident_opened:/);
    const text = (JSON.parse(rows[0]!.payload_json) as { text: string }).text;
    expect(text).toContain("My planner can't start");
    expect(text).not.toContain("{");
    expect(logs()).toEqual([]);
  });
});

describe("the sweep routes by kind", () => {
  const ARMED: NodeJS.ProcessEnv = { HOUGE_INVARIANT_SWEEP_ENABLED: "1" };
  const NOW = "2026-07-20T00:00:00.000Z";
  const failedSchedules = (n: number) => {
    for (let i = 0; i < n; i += 1) {
      const row = store.addScheduledTask({ chat_id: "555", goal: `g${i}`, spec_json: '{"kind":"daily","at":"08:00"}', tz: "Australia/Sydney", next_run_at: "2099-01-01T00:00:00.000Z", now: NOW });
      store.recordScheduleFailure(row.schedule_id, NOW, 1);
    }
  };
  const twoLogViolations = () => {
    vi.spyOn(store, "findHeartbeatGap").mockReturnValue({ subject: "daemon", gap_minutes: 90 } as never);
    vi.spyOn(store, "listCoreOverflow").mockReturnValue([{ chat_id: "555", core_count: 99 }] as never);
  };

  it("5 page + 2 log violations: log rows skip the cap, 3 pages go out, one summary, 2 held back", () => {
    failedSchedules(5); twoLogViolations();
    const r = runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    expect(r).toMatchObject({ opened: 7, alerts_suppressed: 5 - INCIDENT_ALERTS_PER_SWEEP_MAX });
    expect(r.alerts_suppressed).toBe(2);
    const rows = outbox();
    expect(rows.filter((x) => x.idempotency_key.startsWith("incident_opened:"))).toHaveLength(INCIDENT_ALERTS_PER_SWEEP_MAX);
    const summary = rows.filter((x) => x.idempotency_key.startsWith("incident_sweep_summary:"));
    expect(summary.map((x) => (JSON.parse(x.payload_json) as { text: string }).text)).toEqual(
      ["⚠️ 2 more alerts were held back this round (storm cap or flap damping). /status shows what is open."]);
    expect(logs().filter((x) => x.topic === "incident_log")).toHaveLength(2);
  });
  it("with no chat the log violations still write rows and the page violations write nothing", () => {
    failedSchedules(2); twoLogViolations();
    runInvariantSweep({ store, now: NOW, env: ARMED });
    expect(logs().map((x) => x.topic)).toEqual(["incident_log", "incident_log"]);
    expect(outbox()).toEqual([]);
  });
  it("a cleared log sweep kind logs its fix once (resolveIncident), never a second time from the sweep loop", () => {
    store.openIncident({ kind: "heartbeat_gap", subject: "daemon", detail: {}, now: "2026-07-19T19:00:00.000Z" });
    runInvariantSweep({ store, now: NOW, env: ARMED, chat_id: "555" });
    expect(logs().map((x) => x.text)).toEqual(["✅ Fixed: I was offline for a while and came back. — open 300 min"]);
    expect(outbox()).toEqual([]);
  });
});
