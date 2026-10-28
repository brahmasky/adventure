import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateLedgerEvent } from "../../src/run/run-ledger.js";
import { RunStore } from "../../src/run/run-store.js";

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
