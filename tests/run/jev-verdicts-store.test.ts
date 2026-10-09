import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore, type JevVerdictInsert } from "../../src/run/run-store.js";

// Spec §6: one per-turn verdict row joins Jev's routing to the model that answered and to Paco's corrections. Without
// it the stage A PASS criterion (every routed turn's first planner attempt, keyed by routed_by, joins a verdict) cannot be checked, and the
// correction labels (ask anyway, think harder, escalation, low rating) have nowhere to land.
const V: Omit<JevVerdictInsert, "run_id"> = { category: "lookup", breadth: 1, reasoning: 0.9, actions: 1, sets_rule: 0.05, rule_scope: null,
  lane: "planner", role: "fast", effort: "low", cascade: null, save_outcome: "none", route_outcome: "act", reason: "routed", skip_reason: null,
  quoted_turn_id: null };
let seq = 0;
/** A real run notifying `chat`: the chat lookup joins on runs.notify_json, so a bare run id would prove nothing. */
function runIn(store: RunStore, chat: string): string {
  seq += 1;
  const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: `m${seq}`,
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: chat }, idempotency_key: `jv:${seq}`,
    source_reference: `telegram:update:${seq}:message:${seq}` }));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}

describe("jev_verdicts", () => {
  it("inserts one row per decision point call with handler_outcome pending and no correction", () => {
    const store = RunStore.openInMemory();
    const run_id = runIn(store, "555");
    const id = store.insertJevVerdict({ ...V, run_id, created_at: "2026-10-07T10:00:00.000Z" });
    expect(id).toMatch(/^jv_/);
    expect(store.getJevVerdictForRun(run_id)).toMatchObject({ verdict_id: id, category: "lookup", lane: "planner", role: "fast", effort: "low",
      handler_outcome: "pending", fast_used_tool: 0, paco_correction: null, model: null, created_at: "2026-10-07T10:00:00.000Z",
      updated_at: "2026-10-07T10:00:00.000Z" });
    store.close();
  });
  it("updates only the given fields; a boolean lands as 0/1; updated_at moves", () => {
    const store = RunStore.openInMemory();
    const run_id = runIn(store, "555");
    const id = store.insertJevVerdict({ ...V, run_id, created_at: "2026-01-01T00:00:00.000Z" }); // before any real clock the suite runs on
    store.updateJevVerdict(id, { handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: true });
    store.updateJevVerdict(id, { route_outcome: "pin_failed" });
    store.updateJevVerdict(id, {}); // nothing to set: a no-op, not an SQL error
    const row = store.getJevVerdictForRun(run_id)!;
    expect(row).toMatchObject({ handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: 1, route_outcome: "pin_failed",
      category: "lookup", paco_correction: null });
    expect(row.updated_at > row.created_at).toBe(true);
    store.close();
  });
  it("the CHECKs reject values outside the enums; a fallthrough reason is accepted", () => {
    const store = RunStore.openInMemory();
    const run_id = runIn(store, "555");
    expect(() => store.insertJevVerdict({ ...V, run_id, save_outcome: "maybe" as never })).toThrow();
    expect(() => store.insertJevVerdict({ ...V, run_id, lane: "answer" as never })).toThrow();
    const id = store.insertJevVerdict({ ...V, run_id });
    expect(() => store.updateJevVerdict(id, { handler_outcome: "done" })).toThrow();
    expect(() => store.updateJevVerdict(id, { paco_correction: "nope" as never })).toThrow();
    store.updateJevVerdict(id, { handler_outcome: "fallthrough:not_durable" });
    expect(store.getJevVerdictForRun(run_id)?.handler_outcome).toBe("fallthrough:not_durable");
    // Decision 14 (Rev 4): `tiny` marks a turn whose cascade call ran; Rev 2's `deferred` (no call) is retired, so a writer
    // that still sends it, or anything else, is a bug the CHECK must catch
    expect(() => store.insertJevVerdict({ ...V, run_id, cascade: "maybe" as never })).toThrow();
    expect(() => store.insertJevVerdict({ ...V, run_id, cascade: "deferred" as never })).toThrow();
    store.insertJevVerdict({ ...V, run_id, category: null, cascade: "tiny", reason: "cascade_failed", route_outcome: "fallback" });
    expect(store.getJevVerdictForRun(run_id)?.cascade).toBe("tiny");
    store.close();
  });
  // F12: a verdict that stays 'pending' skews the §7/§9 evidence and the lane_fallthrough_rate sweep forever, so every
  // terminal path closes it; the guard keeps a second terminal (or a lane's own outcome) from rewriting the first.
  it("closePendingJevVerdict moves only a pending row, once", () => {
    const store = RunStore.openInMemory();
    const run_id = runIn(store, "555");
    store.insertJevVerdict({ ...V, run_id });
    expect(store.closePendingJevVerdict(run_id, "planner_failed")).toBe(1);
    expect(store.closePendingJevVerdict(run_id, "planner_done")).toBe(0);
    expect(store.getJevVerdictForRun(run_id)?.handler_outcome).toBe("planner_failed");
    const lane = runIn(store, "555");
    const lid = store.insertJevVerdict({ ...V, run_id: lane, lane: "memory" });
    store.updateJevVerdict(lid, { handler_outcome: "fallthrough:not_durable" });
    expect(store.closePendingJevVerdict(lane, "planner_done")).toBe(0);
    expect(store.getJevVerdictForRun(lane)?.handler_outcome).toBe("fallthrough:not_durable");
    expect(store.closePendingJevVerdict("run_without_verdict", "planner_done")).toBe(0);
    store.close();
  });
  // F1: a lane reply on a run that later failed never reached Paco; only lane_reply moves, once, and nothing else.
  it("failLaneReplyVerdict moves only a lane_reply row to fallthrough:run_failed", () => {
    const store = RunStore.openInMemory();
    const lane = runIn(store, "555");
    const id = store.insertJevVerdict({ ...V, run_id: lane, lane: "status" });
    store.updateJevVerdict(id, { handler_outcome: "lane_reply" });
    expect(store.failLaneReplyVerdict(lane)).toBe(1);
    expect(store.failLaneReplyVerdict(lane)).toBe(0);
    expect(store.getJevVerdictForRun(lane)?.handler_outcome).toBe("fallthrough:run_failed");
    const planner = runIn(store, "555");
    store.insertJevVerdict({ ...V, run_id: planner });
    expect(store.failLaneReplyVerdict(planner)).toBe(0);
    expect(store.getJevVerdictForRun(planner)?.handler_outcome).toBe("pending");
    store.close();
  });
  it("latestJevVerdictForChat: this chat only, at or before the instant, newest first", () => {
    const store = RunStore.openInMemory();
    const a = runIn(store, "555"); const b = runIn(store, "555"); const other = runIn(store, "777");
    store.insertJevVerdict({ ...V, run_id: a, created_at: "2026-10-07T10:00:00.000Z" });
    const second = store.insertJevVerdict({ ...V, run_id: b, created_at: "2026-10-07T10:05:00.000Z" });
    store.insertJevVerdict({ ...V, run_id: other, created_at: "2026-10-07T10:06:00.000Z" });
    expect(store.latestJevVerdictForChat("555", "2026-10-07T10:10:00.000Z")?.verdict_id).toBe(second);
    expect(store.latestJevVerdictForChat("555", "2026-10-07T10:05:00.000Z")?.verdict_id).toBe(second); // same instant counts
    expect(store.latestJevVerdictForChat("555", "2026-10-07T10:04:59.999Z")?.run_id).toBe(a);
    expect(store.latestJevVerdictForChat("888", "2026-10-07T11:00:00.000Z")).toBeUndefined();
    store.close();
  });
  it("the migration is idempotent across reopen (one schema_migrations row)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hjv-")), "h.sqlite");
    RunStore.open(path).close();
    const store = RunStore.open(path);
    const db = (store as unknown as { db: { prepare(s: string): { get<T>(...v: unknown[]): T | undefined } } }).db;
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get<{ n: number }>("2026-10-07-jev-verdicts")?.n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'jev_verdicts_run_idx'").get<{ n: number }>()?.n).toBe(1);
    store.close();
  });
});
