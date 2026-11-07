import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent, type Identity } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore, STANDING_DIGEST_TEXT } from "../../src/run/run-store.js";

// Spec 2026-11-07 §8: the digest's standing line becomes a change-log row written in the one central end transition, so
// every path (settle, sweep, schedule cancel, mismatch, denial) writes it exactly once, and Paco's own acts write none.
const FP = "fp_alishan_post"; const WORKER = "planner:555:w";
const FUTURE = new Date(Date.now() + 90 * 86_400_000).toISOString();
const LEASE_S = 86_400 * 400;
const PACO: Identity = { kind: "user", id: "paco" };
let n = 0;
function scheduledRun(s: RunStore, schedule_id: string, chat_id = "555"): string {
  const r = new Gateway(s).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "post it", requested_by: { kind: "schedule", id: schedule_id },
    notify: { kind: "telegram", chat_id }, idempotency_key: `schedule:${schedule_id}:${++n}`, source_reference: `scheduled_tasks.${schedule_id}` }));
  if (!r.ok) throw new Error(JSON.stringify(r));
  s.claimRun(r.run_id, WORKER, LEASE_S);
  return r.run_id;
}
function userRun(s: RunStore, chat_id = "555"): string {
  const r = new Gateway(s).intake(buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: "post it", requested_by: PACO, notify: { kind: "telegram", chat_id },
    idempotency_key: `telegram:${++n}`, source_reference: `telegram:update:${n}:message:1` }));
  if (!r.ok) throw new Error(JSON.stringify(r));
  s.claimRun(r.run_id, WORKER, LEASE_S);
  return r.run_id;
}
function pending(s: RunStore, run_id: string): { approval_id: string } {
  const row = s.createToolApproval({ run_id, worker_id: WORKER, tool_call_id: `tc_${++n}`, capability: "shell_external", input_hash: "ih", action_fingerprint: FP, requester: PACO, summary: "HTTP write",
    side_effect_level: "external_write", expires_at: FUTURE });
  return { approval_id: row.approval_id };
}
const NOW = "2026-10-21T10:00:00.000Z";
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const rows = (s: RunStore, standing_id: string) => db(s).prepare("SELECT topic, text FROM change_log WHERE idempotency_key = ?").all(`standing_end:${standing_id}`) as Array<{ topic: string; text: string }>;
function standing(s: RunStore, fp = "fp_1") {
  const sched = s.addScheduledTask({ chat_id: "555", goal: "check the mailbox and summarise it", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z" });
  return s.insertStandingApprovalForTest({ schedule_id: sched.schedule_id, chat_id: "555", action_fingerprint: fp, state: "standing", label: "HTTP write", created_at: NOW });
}

describe("endStandingTx writes the /changes row", () => {
  it.each(Object.keys(STANDING_DIGEST_TEXT) as Array<keyof typeof STANDING_DIGEST_TEXT>)("%s: one standing_log row with the label, the schedule name and the reason text; a second end writes none", (reason) => {
    const s = RunStore.openInMemory();
    const row = standing(s);
    expect(s.endStandingApproval({ standing_id: row.standing_id, reason, now: NOW })).toBe(true);
    expect(rows(s, row.standing_id)).toEqual([{ topic: "standing_log", text: `🔏 HTTP write · check the mailbox and summarise it — ${STANDING_DIGEST_TEXT[reason]}` }]);
    expect(s.endStandingApproval({ standing_id: row.standing_id, reason, now: NOW })).toBe(false);
    expect(rows(s, row.standing_id)).toHaveLength(1);
  });
  it.each(["revoked", "schedule_ended", "tampered_use", "unverified_use"] as const)("%s (Paco's act, or already an urgent card) writes no row", (reason) => {
    const s = RunStore.openInMemory();
    const row = standing(s);
    expect(s.endStandingApproval({ standing_id: row.standing_id, reason, now: NOW })).toBe(true);
    expect(rows(s, row.standing_id)).toEqual([]);
  });
  it("the row rides the end's transaction: a cancelled schedule ends its grant (schedule_ended, no row) and nothing else is logged", () => {
    const s = RunStore.openInMemory();
    const row = standing(s);
    expect(s.cancelScheduledTask(row.schedule_id, NOW)).toBe(true);
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "schedule_ended" });
    expect(db(s).prepare("SELECT COUNT(*) AS n FROM change_log").get()).toEqual({ n: 0 });
  });
  it("the deny hook: a user turn's denial on (chat, fingerprint) ends the live grant denied with its row; a scheduled run's denial with no row inserts the ended row AND writes the same row (P18)", () => {
    const s = RunStore.openInMemory();
    const row = standing(s, FP);
    const u = userRun(s); const p = pending(s, u);
    expect(s.resolveToolApprovalForTest(p.approval_id, "denied")).toMatchObject({ ok: true });
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "denied" });
    expect(rows(s, row.standing_id).map((r) => r.text.endsWith(STANDING_DIGEST_TEXT.denied))).toEqual([true]);
    const s2 = RunStore.openInMemory();
    const sched = s2.addScheduledTask({ chat_id: "555", goal: "post it", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z" });
    const r = scheduledRun(s2, sched.schedule_id); const pr = pending(s2, r);
    expect(s2.resolveToolApprovalForTest(pr.approval_id, "denied")).toMatchObject({ ok: true });
    const [ended] = s2.listStandingApprovals();
    expect(ended).toMatchObject({ state: "ended", ended_reason: "denied", schedule_id: sched.schedule_id });
    expect(rows(s2, ended!.standing_id)).toEqual([{ topic: "standing_log", text: `🔏 HTTP write · post it — ${STANDING_DIGEST_TEXT.denied}` }]);
  });
  it("a refused log write never blocks the end (ending a grant is safety-relevant): the row ends, stderr names the id", () => {
    const s = RunStore.openInMemory();
    const row = standing(s);
    db(s).prepare("INSERT INTO change_log (change_id, topic, idempotency_key, correlation_id, text, created_at) VALUES ('chg_x', 'standing_log', ?, 'c', 'another text', ?)").run(`standing_end:${row.standing_id}`, NOW);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let logged: string[] = [];
    try { expect(s.endStandingApproval({ standing_id: row.standing_id, reason: "expired", now: NOW })).toBe(true); logged = err.mock.calls.map(([m]) => String(m)); } finally { err.mockRestore(); }
    expect(s.getStandingApproval(row.standing_id)?.state).toBe("ended");
    expect(logged.some((m) => m.includes(row.standing_id))).toBe(true);
  });
});
