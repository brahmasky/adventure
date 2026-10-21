import { describe, expect, it } from "vitest";
import { medianLocalHour, scheduleDraft, scheduleHints, shiftSpec } from "../../src/improve/schedule-shift.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { createTelegramTurn } from "../helpers/runs.js";

// Spec 2b-ii §5.5 (P3: three shell_external expiries at local hour 11): two expiries of one capability on schedule-born
// runs of one schedule at the same local hour in 14 days are the hint; H2 is the median local hour of Paco's own turns
// (ties → later); the shift keeps the minute; a `once` spec cannot be shifted.
const TZ = "Australia/Sydney";
describe("medianLocalHour and shiftSpec", () => {
  it("median local hour in the display zone; ties take the later hour; none when empty", () => {
    // 2026-10-21T08:00Z = 19:00 AEDT; 09:00Z = 20:00; 11:00Z = 22:00
    expect(medianLocalHour(["2026-10-21T08:00:00.000Z", "2026-10-21T09:00:00.000Z", "2026-10-21T11:00:00.000Z"], TZ)).toBe(20);
    expect(medianLocalHour(["2026-10-21T08:00:00.000Z", "2026-10-21T11:00:00.000Z"], TZ)).toBe(22);
    expect(medianLocalHour([], TZ)).toBeNull();
  });
  it("shifts daily and weekly specs to the hour, keeping the minute; once specs are null", () => {
    expect(shiftSpec({ kind: "daily", at: "11:30" }, 20)).toEqual({ kind: "daily", at: "20:30" });
    expect(shiftSpec({ kind: "weekly", day: "mon", at: "11:05" }, 9)).toEqual({ kind: "weekly", day: "mon", at: "09:05" });
    expect(shiftSpec({ kind: "once", at_iso: "2026-10-22T00:00:00.000Z" }, 9)).toBeNull();
  });
});
let seq = 0;
/** A schedule-born run (source schedule, requested_by the schedule), as schedule-tick.ts intakes it. */
function scheduleRun(store: RunStore, schedule_id: string): string {
  seq += 1;
  const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: `digest ${seq}`,
    requested_by: { kind: "schedule", id: schedule_id }, notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `schedule:${schedule_id}:${seq}`,
    source_reference: `scheduled_tasks.${schedule_id}` }));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}
function fixture(o: { at?: string; expiries?: string[]; userTurnAt?: string[] } = {}): { s: RunStore; hint: { schedule_id: string; hour: number; dates: string[] } | undefined } {
  const s = RunStore.openInMemory();
  const row = s.addScheduledTask({ chat_id: "555", goal: "check the mailbox", spec_json: JSON.stringify({ kind: "daily", at: o.at ?? "11:00" }), tz: TZ, next_run_at: "2026-10-22T00:00:00.000Z", now: "2026-10-01T00:00:00.000Z" });
  for (const at of o.expiries ?? ["2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z"]) {   // 00:00Z = 11:00 AEDT
    const run_id = scheduleRun(s, row.schedule_id);
    const id = s.createToolApproval({ run_id, worker_id: "planner:555", tool_call_id: `c-${at}`, capability: "shell_external", input_hash: "h", action_fingerprint: "f",
      requester: { kind: "schedule", id: row.schedule_id }, summary: "ls", side_effect_level: "external_write", expires_at: at }).approval_id;
    s.expireToolApproval(id, at);
  }
  for (const t of o.userTurnAt ?? []) createTelegramTurn(s, "good evening", t);
  return { s, hint: scheduleHints(s, "2026-10-21T10:00:00.000Z", TZ).get("shell_external") };
}
describe("scheduleHints and scheduleDraft", () => {
  it("two expiries of one capability on one schedule at one local hour in 14 days are a hint; one is not; the draft holds before and after and the evidence names the dates", () => {
    const { s, hint } = fixture();
    const hints = scheduleHints(s, "2026-10-21T10:00:00.000Z", TZ);
    expect([...hints.entries()]).toEqual([["shell_external", { schedule_id: expect.any(String), hour: 11, dates: ["2026-10-19", "2026-10-20"] }]]);
    expect(scheduleHints(s, "2026-11-30T10:00:00.000Z", TZ).size).toBe(0);   // both expiries older than 14 days: no hint
    const d = scheduleDraft(s, hint!, "2026-10-21T10:00:00.000Z", TZ);
    expect(d).not.toBeNull();
    expect(JSON.parse(d!.draft_json)).toMatchObject({ schedule_id: expect.any(String), hour_from: 11, hour_to: 12, before: { spec_json: expect.any(String), tz: TZ, next_run_at: expect.any(String) }, after: { spec_json: JSON.stringify({ kind: "daily", at: "12:00" }), tz: TZ, next_run_at: expect.any(String) } });
    expect(d!.evidence).toBe("2 expiries at 11:00 (2026-10-19, 2026-10-20)");
  });
  it("with Paco's turns at 20:00 local the shift lands on hour 20", () => {
    const { s, hint } = fixture({ userTurnAt: ["2026-10-20T09:00:00.000Z"] });   // 20:00 AEDT
    const d = scheduleDraft(s, hint!, "2026-10-21T10:00:00.000Z", TZ);
    expect(JSON.parse(d!.draft_json)).toMatchObject({ hour_from: 11, hour_to: 20, after: { spec_json: JSON.stringify({ kind: "daily", at: "20:00" }) } });
  });
  it("a schedule that no longer exists gives no draft", () => {
    const { s, hint } = fixture();
    expect(scheduleDraft(s, { ...hint!, schedule_id: "sch_gone" }, "2026-10-21T10:00:00.000Z", TZ)).toBeNull();
  });
  it("hour_from is the spec's own hour, not the expiry hour: a no-op shift is null, a real one starts from the spec", () => {
    // daily 11:40, approvals expire 12:10 local (01:10Z) after the 11:40 fire; Paco's turns at 11:xx local (00:30Z) give median 11
    const expiries = ["2026-10-19T01:10:00.000Z", "2026-10-20T01:10:00.000Z"];
    const noop = fixture({ at: "11:40", expiries, userTurnAt: ["2026-10-20T00:30:00.000Z"] });
    expect(noop.hint!.hour).toBe(12);
    expect(scheduleDraft(noop.s, noop.hint!, "2026-10-21T10:00:00.000Z", TZ)).toBeNull();
    const real = fixture({ at: "11:40", expiries, userTurnAt: ["2026-10-20T09:00:00.000Z"] });   // 20:00 local
    const d = scheduleDraft(real.s, real.hint!, "2026-10-21T10:00:00.000Z", TZ);
    expect(JSON.parse(d!.draft_json)).toMatchObject({ hour_from: 11, hour_to: 20, after: { spec_json: JSON.stringify({ kind: "daily", at: "20:40" }) } });
  });
  it("SCHEDULE_HINT_MIN: one expiry alone, or two at different local hours, is no hint", () => {
    expect(fixture({ expiries: ["2026-10-19T00:00:00.000Z"] }).hint).toBeUndefined();
    expect(fixture({ expiries: ["2026-10-19T00:00:00.000Z", "2026-10-20T03:00:00.000Z"] }).hint).toBeUndefined();   // 11:00 vs 14:00 local
  });
});
