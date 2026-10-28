import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateLedgerEvent } from "../../src/run/run-ledger.js";
import { buildTypedTaskEvent, type Identity } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore, STANDING_STALE_MS, STANDING_STREAK } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Stage 4A spec §5: one live row per (schedule, chat, fingerprint) — the partial unique index is what makes two concurrent
// consumes of one key agree on one row; ended rows stay because the 30-day deny block is read over them.
const NOW = "2026-10-28T10:00:00.000Z";
const KEY = { schedule_id: "sch_1", chat_id: "555", action_fingerprint: "fp_alishan_post" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("standing_approvals migration", () => {
  it("is additive and idempotent: a second open records no second version row and keeps the seeded row", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-sa-")); dirs.push(dir);
    const path = join(dir, "houge.sqlite");
    const first = RunStore.open(path);
    const row = first.insertStandingApprovalForTest({ ...KEY, state: "streak", created_at: NOW });
    first.close();
    const second = RunStore.open(path);
    try {
      expect(second.getStandingApproval(row.standing_id)).toMatchObject({ ...KEY, state: "streak", credited_runs_json: "[]" });
      const db = (second as unknown as { db: { prepare(sql: string): { get(...a: unknown[]): unknown } } }).db;
      expect(db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?`).get("2026-10-28-standing-approval")).toEqual({ n: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM standing_uses`).get()).toEqual({ n: 0 });
    } finally { second.close(); }
  });
  it("one live row per key: a second live row throws, an ended row and a live row coexist, a state outside the set is refused", () => {
    const s = RunStore.openInMemory();
    s.insertStandingApprovalForTest({ ...KEY, state: "ended", ended_reason: "denied", ended_at: NOW });
    const live = s.insertStandingApprovalForTest({ ...KEY, state: "candidate" });
    expect(() => s.insertStandingApprovalForTest({ ...KEY, state: "streak" })).toThrow(/UNIQUE/);
    expect(s.standingFor(KEY)?.standing_id).toBe(live.standing_id);
    expect(() => s.insertStandingApprovalForTest({ ...KEY, chat_id: "556", state: "bogus" as "streak" })).toThrow(/CHECK/);
    expect(s.listStandingApprovals({ chat_id: "555" })).toHaveLength(2);
    expect(s.listStandingApprovals({ state: "candidate", schedule_id: "sch_1" }).map((r) => r.standing_id)).toEqual([live.standing_id]);
  });
});

describe("endStandingApproval", () => {
  it("ends a live row once, ends its move with it, keeps the row, writes standing_ended; the block survives the end", () => {
    const s = RunStore.openInMemory();
    const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "sa_x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
    const row = s.insertStandingApprovalForTest({ ...KEY, state: "standing", move_id, expires_at: "2027-01-01T00:00:00.000Z" });
    const until = "2026-11-27T10:00:00.000Z";
    expect(s.endStandingApproval({ standing_id: row.standing_id, reason: "denied", now: NOW, denied_until: until })).toBe(true);
    expect(s.endStandingApproval({ standing_id: row.standing_id, reason: "revoked", now: NOW })).toBe(false); // one-shot: the second tap/sweep changes nothing
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "denied", ended_at: NOW, denied_until: until });
    expect(s.getLadderMove(move_id)?.state).toBe("ended");
    expect(s.standingFor(KEY)).toBeUndefined();
    expect(s.standingDenied(KEY.chat_id, KEY.action_fingerprint, NOW)).toBe(true);
    expect(s.standingDenied(KEY.chat_id, KEY.action_fingerprint, "2026-11-28T00:00:00.000Z")).toBe(false); // the block has an end
    expect(s.standingDenied("556", KEY.action_fingerprint, NOW)).toBe(false); // another chat's bytes are not blocked
    expect(s.getLedgerEvents().filter((e) => e.event_type === "standing_ended").map((e) => e.payload)).toEqual([{ standing_id: row.standing_id, reason: "denied" }]);
  });
  it("finalReportState reads the run's terminal notice by its shared key, undefined when none was queued", () => {
    const s = RunStore.openInMemory();
    expect(s.finalReportState("run_none")).toBeUndefined();
    s.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "final_report", idempotency_key: "run_a:final_report", run_id: "run_a", correlation_id: "run_a", payload: { text: "I hit an error" } });
    expect(s.finalReportState("run_a")).toBe("queued");
  });
});

describe("standing_* ledger events", () => {
  it("every type requires its code-owned keys, so a payload that forgot the move or run id never lands", () => {
    const ev = (event_type: "standing_used" | "standing_granted" | "standing_streak" | "standing_sealing" | "standing_sealed" | "standing_ended", payload: Record<string, unknown>) =>
      validateLedgerEvent({ event_id: "e", correlation_id: "c", event_type, occurred_at: NOW, actor: "core", sequence: 1, payload });
    expect(ev("standing_used", { standing_id: "sa_1", run_id: "r", tool_call_id: "t", action_fingerprint: "f" })).toEqual({ ok: false, error: "standing_used missing required payload field: move_id" });
    expect(ev("standing_granted", { standing_id: "sa_1" })).toEqual({ ok: false, error: "standing_granted missing required payload field: move_id" });
    expect(ev("standing_streak", { standing_id: "sa_1", run_id: "r", approval_id: "a" })).toEqual({ ok: false, error: "standing_streak missing required payload field: streak" });
    expect(ev("standing_sealing", { standing_id: "sa_1", run_id: "r", tool_call_id: "t", approval_id: "a" })).toEqual({ ok: true });
    expect(ev("standing_sealed", { standing_id: "sa_1", run_id: "r", tool_call_id: "t" })).toEqual({ ok: true });
    expect(ev("standing_ended", { standing_id: "sa_1" })).toEqual({ ok: false, error: "standing_ended missing required payload field: reason" });
  });
});

const PACO: Identity = { kind: "user", id: "paco" };
const FP = KEY.action_fingerprint; const WORKER = "planner:555:w";
// real-clock paths (resolveToolApprovalForTest, the lease) compare against Date.now(): fixtures are relative, never a literal year
const FUTURE = new Date(Date.now() + 90 * 86_400_000).toISOString();
const LEASE_S = 86_400 * 400; // the consume CAS checks lease_expires_at > the fixed NOW and > NOW + 30 d
const dropStanding = (s: RunStore) => (s as unknown as { db: { exec(sql: string): void } }).db.exec("DROP INDEX standing_deny_idx; DROP TABLE standing_approvals");
let n = 0;
/** A scheduled turn born through the real gateway, claimed so the consume CAS sees a live lease. */
function scheduledRun(s: RunStore, schedule_id = "sch_1", chat_id = "555"): string {
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
type ApprovalOverrides = Partial<Parameters<RunStore["createToolApproval"]>[0]>;
function pending(s: RunStore, run_id: string, o: ApprovalOverrides = {}): { approval_id: string; tool_call_id: string } {
  const tool_call_id = `tc_${++n}`;
  const row = s.createToolApproval({ run_id, worker_id: WORKER, tool_call_id, capability: "shell_external", input_hash: "ih", action_fingerprint: FP, requester: PACO, summary: "HTTP write",
    side_effect_level: "external_write", expires_at: FUTURE, ...o });
  return { approval_id: row.approval_id, tool_call_id };
}
function approved(s: RunStore, run_id: string, o: ApprovalOverrides = {}) { const p = pending(s, run_id, o); s.resolveToolApprovalForTest(p.approval_id, "approved"); return p; }
const consume = (s: RunStore, run_id: string, approval_id: string, x: { standing_trial?: { standing_id: string }; now?: string; capability?: string; action_fingerprint?: string } = {}) =>
  s.consumeToolApproval({ approval_id, run_id, worker_id: WORKER, capability: x.capability ?? "shell_external", action_fingerprint: x.action_fingerprint ?? FP, requester: PACO, now: x.now ?? NOW,
    ...(x.standing_trial ? { standing_trial: x.standing_trial } : {}) });
const streakEvents = (s: RunStore) => s.getLedgerEvents().filter((e) => e.event_type === "standing_streak").map((e) => e.payload.streak);

describe("consume hook (§6, §7): credits by distinct scheduled run", () => {
  it("three distinct runs: streak 1, 2, then candidate; a second consumed approval in the same run adds nothing; the approval ids are kept in order", () => {
    const s = RunStore.openInMemory();
    const ids: string[] = [];
    for (let i = 0; i < STANDING_STREAK; i++) {
      const run = scheduledRun(s); const a = approved(s, run); ids.push(a.approval_id);
      expect(consume(s, run, a.approval_id)).toEqual({ ok: true, sealing: false });
      if (i === 0) { const twice = approved(s, run, { action_fingerprint: FP }); expect(consume(s, run, twice.approval_id)).toEqual({ ok: true, sealing: false }); }
      expect(s.standingFor(KEY)).toMatchObject({ state: i + 1 < STANDING_STREAK ? "streak" : "candidate", capability: "shell_external", label: "HTTP write" });
      expect(JSON.parse(s.standingFor(KEY)!.credited_runs_json)).toHaveLength(i + 1);
    }
    expect(JSON.parse(s.standingFor(KEY)!.approval_ids_json)).toEqual(ids);
    expect(streakEvents(s)).toEqual([1, 2, 3]);
  });
  it("neutral consumes create no row: an expired approval, a user turn, shell_destructive, an unseen shell script, a different chat's bytes stay their own key", () => {
    const s = RunStore.openInMemory();
    const r1 = scheduledRun(s); const late = approved(s, r1);
    expect(consume(s, r1, late.approval_id, { now: new Date(Date.now() + 400 * 86_400_000).toISOString() })).toEqual({ ok: false, code: "expired" });
    const u = userRun(s); const ua = approved(s, u); expect(consume(s, u, ua.approval_id)).toEqual({ ok: true, sealing: false });
    const r2 = scheduledRun(s); const d = approved(s, r2, { capability: "shell_destructive", side_effect_level: "destructive" });
    expect(consume(s, r2, d.approval_id, { capability: "shell_destructive" })).toEqual({ ok: true, sealing: false });
    const r3 = scheduledRun(s); const un = approved(s, r3, { summary: "HTTP write, unseen shell script" });
    expect(consume(s, r3, un.approval_id)).toEqual({ ok: true, sealing: false });
    expect(s.listStandingApprovals()).toEqual([]);
    const r4 = scheduledRun(s, "sch_1", "556"); const other = approved(s, r4); consume(s, r4, other.approval_id);
    expect(s.listStandingApprovals().map((r) => r.chat_id)).toEqual(["556"]);
    expect(s.standingFor(KEY)).toBeUndefined();
  });
  it("a different fingerprint on the same schedule is a different key and does not touch this one", () => {
    const s = RunStore.openInMemory();
    const r = scheduledRun(s); const a = approved(s, r); consume(s, r, a.approval_id);
    const r2 = scheduledRun(s); const b = approved(s, r2, { action_fingerprint: "fp_other" }); consume(s, r2, b.approval_id, { action_fingerprint: "fp_other" });
    expect(JSON.parse(s.standingFor(KEY)!.credited_runs_json)).toEqual([r]);
    expect(s.standingFor({ ...KEY, action_fingerprint: "fp_other" })?.state).toBe("streak");
  });
  it("a streak idle 30 days is ended stale inside the consume, before any sweep, and the approval starts a fresh streak", () => {
    // after downtime no sweep has run: a consume must not refresh a dead streak into a candidate
    const s = RunStore.openInMemory();
    const r1 = scheduledRun(s); const a1 = approved(s, r1); consume(s, r1, a1.approval_id);
    const old = s.standingFor(KEY)!;
    const r2 = scheduledRun(s); const a2 = approved(s, r2);
    expect(consume(s, r2, a2.approval_id, { now: new Date(Date.parse(NOW) + STANDING_STALE_MS).toISOString() })).toEqual({ ok: true, sealing: false });
    expect(s.getStandingApproval(old.standing_id)).toMatchObject({ state: "ended", ended_reason: "stale" });
    const fresh = s.standingFor(KEY)!;
    expect(fresh.standing_id).not.toBe(old.standing_id);
    expect(JSON.parse(fresh.credited_runs_json)).toEqual([r2]);
  });
  it("a credit fault never blocks the approved command: the consume still wins, standing_credit_failed opens, nothing is credited", () => {
    const s = RunStore.openInMemory();
    const r = scheduledRun(s); const a = approved(s, r);
    dropStanding(s);
    expect(consume(s, r, a.approval_id)).toEqual({ ok: true, sealing: false });
    expect(s.getToolApproval(a.approval_id)?.state).toBe("consumed");
    expect(s.findOpenIncident(s.incidentFingerprint("standing_credit_failed", `approval:${a.approval_id}`))).toBeDefined();
    expect(s.getLedgerEvents(r).filter((e) => e.event_type === "standing_streak")).toEqual([]);
  });
});

describe("consume hook: candidate → sealing rides the fourth CAS", () => {
  function candidate(s: RunStore) { return s.insertStandingApprovalForTest({ ...KEY, state: "candidate", credited_runs_json: JSON.stringify(["r1", "r2", "r3"]), approval_ids_json: JSON.stringify(["a1", "a2", "a3"]) }); }
  it("with the bridge's trial selector the row becomes sealing, named by the approval row's tool_call_id, and the consume reports it", () => {
    const s = RunStore.openInMemory(); const c = candidate(s);
    const run = scheduledRun(s); const a = approved(s, run);
    expect(consume(s, run, a.approval_id, { standing_trial: { standing_id: c.standing_id } })).toEqual({ ok: true, sealing: true });
    expect(s.getStandingApproval(c.standing_id)).toMatchObject({ state: "sealing", sealing_approval_id: a.approval_id, sealed_run_id: run, sealed_tool_call_id: a.tool_call_id, sealing_started_at: NOW,
      approval_ids_json: JSON.stringify(["a1", "a2", "a3", a.approval_id]) });
    expect(s.getLedgerEvents(run).filter((e) => e.event_type === "standing_sealing").map((e) => e.payload)).toEqual([{ standing_id: c.standing_id, run_id: run, tool_call_id: a.tool_call_id, approval_id: a.approval_id }]);
  });
  it("without the selector (the bridge saw no clean room) or with a stale standing_id the candidate stays a candidate", () => {
    const s = RunStore.openInMemory(); const c = candidate(s);
    const run = scheduledRun(s); const a = approved(s, run);
    expect(consume(s, run, a.approval_id)).toEqual({ ok: true, sealing: false });
    const run2 = scheduledRun(s); const b = approved(s, run2);
    expect(consume(s, run2, b.approval_id, { standing_trial: { standing_id: "sa_stale" } })).toEqual({ ok: true, sealing: false });
    expect(s.getStandingApproval(c.standing_id)?.state).toBe("candidate");
  });
  it("a failed consume (lease lost) leaves the row candidate: sealing exists only behind a won CAS", () => {
    const s = RunStore.openInMemory(); const c = candidate(s);
    const run = scheduledRun(s); const a = approved(s, run);
    s.finishRun({ run_id: run, expected_worker_id: WORKER, next: "completed", report_ref: "r", duration_ms: 1, tool_calls: 0 }); // the lease is gone
    expect(consume(s, run, a.approval_id, { standing_trial: { standing_id: c.standing_id } })).toEqual({ ok: false, code: "lease_lost" });
    expect(s.getStandingApproval(c.standing_id)?.state).toBe("candidate");
  });
  it("sealing, standing: a consume is a no-op on the row", () => {
    const s = RunStore.openInMemory();
    for (const state of ["sealing", "standing"] as const) {
      const row = s.insertStandingApprovalForTest({ ...KEY, schedule_id: `sch_${state}`, state });
      const run = scheduledRun(s, `sch_${state}`); const a = approved(s, run);
      expect(consume(s, run, a.approval_id, { standing_trial: { standing_id: row.standing_id } })).toEqual({ ok: true, sealing: false });
      expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state, updated_at: row.updated_at });
    }
  });
});

describe("deny hook (§7): a denial anywhere on (chat, fingerprint)", () => {
  it("from a USER turn ends the schedule's standing row and its move with a 30-day block; a scheduled consume under the block creates no row; after it, a new streak", () => {
    const s = RunStore.openInMemory();
    const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
    const row = s.insertStandingApprovalForTest({ ...KEY, state: "standing", move_id, expires_at: "2027-01-01T00:00:00.000Z" });
    const u = userRun(s); const p = pending(s, u);
    expect(s.resolveToolApprovalForTest(p.approval_id, "denied")).toMatchObject({ ok: true });
    const ended = s.getStandingApproval(row.standing_id)!;
    expect(ended).toMatchObject({ state: "ended", ended_reason: "denied" });
    expect(Date.parse(ended.denied_until!) - Date.parse(ended.ended_at!)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(s.getLadderMove(move_id)?.state).toBe("ended");
    const r = scheduledRun(s); const a = approved(s, r); consume(s, r, a.approval_id, { now: ended.ended_at! });
    expect(s.standingFor(KEY)).toBeUndefined();
    const r2 = scheduledRun(s); const b = approved(s, r2); consume(s, r2, b.approval_id, { now: new Date(Date.parse(ended.denied_until!) + 1_000).toISOString() });
    expect(s.standingFor(KEY)?.state).toBe("streak");
  });
  it("with no row: a scheduled run's denial inserts the ended row carrying the block; a user turn's denial inserts nothing", () => {
    const s = RunStore.openInMemory();
    const u = userRun(s); const pu = pending(s, u); s.resolveToolApprovalForTest(pu.approval_id, "denied");
    expect(s.listStandingApprovals()).toEqual([]);
    const r = scheduledRun(s); const pr = pending(s, r); s.resolveToolApprovalForTest(pr.approval_id, "denied");
    expect(s.listStandingApprovals()).toEqual([expect.objectContaining({ ...KEY, state: "ended", ended_reason: "denied", denied_until: expect.any(String) })]);
    expect(s.standingDenied("555", FP, NOW)).toBe(true);
  });
  it("a SQL error in the hook never throws out of intake: the resolution rolls back whole (still pending), standing_hook_failed opens, Paco is told to Revoke from /schedule", () => {
    // a throw here would leave the Telegram offset unadvanced: the same update redelivered forever, the kill switch behind it
    const s = RunStore.openInMemory();
    const r = scheduledRun(s); const p = pending(s, r);
    dropStanding(s);
    const deny = (k: number) => buildTypedTaskEvent({ source: "telegram", type: "deny", approval_id: p.approval_id, requested_by: PACO, notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: `telegram:deny:${p.approval_id}:${k}`, source_reference: `telegram:update:${k}:message:1` });
    expect(s.processApprovalTrigger({ event: deny(9), decision: "denied", resolved_at: NOW })).toMatchObject({ ok: false, error: { code: "STANDING_HOOK_FAILED" } });
    expect(s.getToolApproval(p.approval_id)?.state).toBe("pending");
    expect(s.findOpenIncident(s.incidentFingerprint("standing_hook_failed", `approval:${p.approval_id}`))).toBeDefined();
    expect(s.resolveToolApprovalForTest(p.approval_id, "denied")).toMatchObject({ ok: false, error: { code: "STANDING_HOOK_FAILED" } });
    // through the gateway: a refusal, not a throw, and its reply reaches Paco through the outbox (rich renderer)
    expect(new Gateway(s).intake(deny(10))).toMatchObject({ ok: false, error: { code: "STANDING_HOOK_FAILED" } });
    expect([...drainOutbox(s).values()].map((x) => String(x.text)).some((t) => t.includes("/schedule") && t.includes("Revoke"))).toBe(true);
    expect(s.getToolApproval(p.approval_id)?.state).toBe("pending");
  });
});

describe("tap chat binding (§7): a scheduled run's approval answers only from its notify chat", () => {
  const tap = (approval_id: string, notify: { kind: "telegram"; chat_id: string } | { kind: "local" }, type: "approve" | "deny" = "approve") => buildTypedTaskEvent({ source: "telegram", type, approval_id, requested_by: PACO, notify,
    idempotency_key: `telegram:${type}:${approval_id}:${JSON.stringify(notify)}`, source_reference: "telegram:update:1:message:1" });
  it("another chat or a local target resolves nothing and leaves the row pending; the run's chat resolves it", () => {
    const s = RunStore.openInMemory();
    const r = scheduledRun(s); const p = pending(s, r);
    expect(s.processApprovalTrigger({ event: tap(p.approval_id, { kind: "telegram", chat_id: "999" }), decision: "approved", resolved_at: NOW })).toMatchObject({ ok: false, error: { code: "APPROVAL_CHAT_MISMATCH" } });
    expect(s.processApprovalTrigger({ event: tap(p.approval_id, { kind: "local" }), decision: "approved", resolved_at: NOW })).toMatchObject({ ok: false, error: { code: "APPROVAL_CHAT_MISMATCH" } });
    expect(s.getToolApproval(p.approval_id)?.state).toBe("pending");
    expect(s.processApprovalTrigger({ event: tap(p.approval_id, { kind: "telegram", chat_id: "555" }), decision: "approved", resolved_at: NOW })).toMatchObject({ ok: true, run_id: r });
  });
  it("a user turn's approval keeps today's rule (identity only): a local target still resolves it", () => {
    const s = RunStore.openInMemory();
    const u = userRun(s); const p = pending(s, u);
    expect(s.processApprovalTrigger({ event: tap(p.approval_id, { kind: "local" }), decision: "approved", resolved_at: NOW })).toMatchObject({ ok: true });
  });
});
