import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_BUDGET_CAPS } from "../../src/budget/global-budget-ledger.js";
import { buildTypedTaskEvent, type TypedTaskEvent } from "../../src/domain/types.js";
import { Gateway, RATE_LIMIT_EXEMPT } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Spec 2026-10-30 R1 §4.1, §4.3: the limiter and the fuse record what they refused; nothing they return changes.
const CHAT = "222";
const NOW = "2026-07-03T12:00:00.000Z";
let seq = 0;
// P1: kill writes a tombstone; HOUGE_TOMBSTONE_PATH/HOUGE_DISARM_PATH MUST point at a temp dir or the probe stops the live daemon.
const PINNED = ["HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH"] as const;
const saved: Partial<Record<(typeof PINNED)[number], string>> = {};
let dir = "";
beforeEach(() => {
  for (const k of PINNED) { if (process.env[k] !== undefined) saved[k] = process.env[k]; else delete saved[k]; }
  dir = mkdtempSync(join(tmpdir(), "hg-intake-"));
  delete process.env.HOUGE_TELEGRAM_CHAT_ID;
  process.env.HOUGE_TOMBSTONE_PATH = join(dir, "test.kill");
  process.env.HOUGE_DISARM_PATH = join(dir, "test.disarm");
});
afterEach(() => {
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function ev(type: string, extra: Record<string, unknown> = {}, source: "telegram" | "schedule" = "telegram"): TypedTaskEvent {
  seq += 1;
  return buildTypedTaskEvent({ source, type, program: "turn", goal: "synthetic", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `t:${seq}`, source_reference: `telegram:update:${seq}:message:${seq}`, ...extra } as never);
}
function saturate(store: RunStore, command = "turn", n = 5): void {
  for (let i = 0; i < n; i += 1) store.recordTelegramCommandAudit({ actor_id: "paco", chat_id: CHAT, command, source_reference: `s${i}`, decision: "accepted", occurred_at: NOW });
}
const intakeRows = (store: RunStore) => (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db
  .prepare("SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE entry_id LIKE 'intake.%' ORDER BY rowid").all();

type Db = { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } };
const q = (store: RunStore, sql: string) => (store as unknown as Db).db.prepare(sql).all();
const DENIED_AUDIT = (reason: string, command = "turn") => ({ actor_id: "paco", chat_id: CHAT, command, decision: "denied", reason_code: reason });
const deniedAudit = (store: RunStore) => q(store, "SELECT actor_id, chat_id, command, decision, reason_code FROM telegram_command_audit WHERE decision = 'denied'");
/** Records the order in which the named store methods are called (pass-through). */
function trace(store: RunStore, methods: string[]): string[] {
  const calls: string[] = [];
  for (const m of methods) {
    const orig = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!.bind(store);
    (vi.spyOn(store as never, m as never) as unknown as { mockImplementation(f: unknown): void }).mockImplementation(((...a: unknown[]) => { calls.push(m); return orig(...a); }) as never);
  }
  return calls;
}

describe("intake.rate_limit at Gateway.intake", () => {
  it("a sixth command in the window → TELEGRAM_RATE_LIMITED as before, one limit/command_window row with no run", () => {
    const store = RunStore.openInMemory();
    saturate(store);
    const r = new Gateway(store).intake(ev("turn"), NOW);
    expect(r).toEqual({ ok: false, error: { code: "TELEGRAM_RATE_LIMITED", message: "Telegram command rate limit exceeded" } });
    expect(intakeRows(store)).toEqual([{ entry_id: "intake.rate_limit", verdict: "limit", reason_code: "command_window", run_id: null, tool_call_id: null }]);
  });
  it("an admitted command writes no rate-limit row", () => {
    const store = RunStore.openInMemory();
    expect(new Gateway(store).intake(ev("turn"), NOW).ok).toBe(true);
    expect(intakeRows(store).filter((r) => r.entry_id === "intake.rate_limit")).toEqual([]);
  });
  it.each([...RATE_LIMIT_EXEMPT])("exempt %s on a saturated window never reaches the entry (Decision 3-A: no rung can delay it)", (type) => {
    const store = RunStore.openInMemory();
    saturate(store);
    const spy = vi.fn();
    const g = new Gateway(store);
    (g as unknown as { recorderCache: unknown }).recorderCache = { record: spy };
    g.intake(ev(type), NOW);
    expect(spy.mock.calls.filter(([e]) => (e as { id: string }).id === "intake.rate_limit")).toEqual([]);
    expect(intakeRows(store).filter((r) => r.entry_id === "intake.rate_limit")).toEqual([]);
  });
  it("the exempt set is exactly kill and the three digest taps (dropping one would silently rate-limit it)", () => {
    expect([...RATE_LIMIT_EXEMPT].sort()).toEqual(["decision_review", "improvement_tap", "jev_accept_tap", "kill"]);
  });
  it("the TS exemption and the SQL window exclusion agree: every exempt command except kill never counts toward the window", () => {
    for (const cmd of RATE_LIMIT_EXEMPT) {
      const store = RunStore.openInMemory();
      saturate(store, cmd);
      const limited = !new Gateway(store).intake(ev("turn"), NOW).ok;
      expect([cmd, limited]).toEqual([cmd, cmd === "kill"]); // kill is absent from the SQL NOT IN on purpose (run-store.ts checkTelegramRateLimit)
    }
  });
  it("a scheduled source is never limited and writes no row", () => {
    const store = RunStore.openInMemory();
    saturate(store);
    expect(new Gateway(store).intake(ev("turn", {}, "schedule"), NOW).ok).toBe(true);
    expect(intakeRows(store)).toEqual([]);
  });
  it("the denied audit row is still written, after the decision row, exactly as before", () => {
    const store = RunStore.openInMemory();
    saturate(store);
    const calls = trace(store, ["insertDecision", "recordTelegramCommandAudit"]);
    new Gateway(store).intake(ev("turn"), NOW);
    expect(calls).toEqual(["insertDecision", "recordTelegramCommandAudit"]);
    expect(deniedAudit(store)).toEqual([DENIED_AUDIT("command_window")]);
  });
});

describe("intake.budget_fuse at handleTaskIntake", () => {
  it("runs cap reached → GLOBAL_BUDGET_FUSE as before, one alert, one refuse/runs row; a second refusal → no second alert, a second row", () => {
    const store = RunStore.openInMemory();
    const g = new Gateway(store, { ...DEFAULT_GLOBAL_BUDGET_CAPS, runs: 0 });
    const calls = trace(store, ["insertDecision", "recordGlobalBudgetFuse", "armGlobalFuseIfNeeded", "recordTelegramCommandAudit"]);
    expect(g.intake(ev("turn"), NOW)).toEqual({ ok: false, error: { code: "GLOBAL_BUDGET_FUSE", message: "Global 24h budget reached; new runs are paused until the window clears" } });
    // order: decision row first, then the ledger event, the latch, the audit row
    expect(calls).toEqual(["insertDecision", "recordGlobalBudgetFuse", "armGlobalFuseIfNeeded", "recordTelegramCommandAudit"]);
    expect(q(store, "SELECT fused, since FROM global_budget_fuse_state WHERE id = 1")).toEqual([{ fused: 1, since: NOW }]);
    g.intake(ev("turn"), NOW);
    expect(q(store, "SELECT fused, since FROM global_budget_fuse_state WHERE id = 1")).toEqual([{ fused: 1, since: NOW }]);
    expect(intakeRows(store).map((r) => [r.entry_id, r.verdict, r.reason_code, r.run_id])).toEqual([["intake.budget_fuse", "refuse", "runs", null], ["intake.budget_fuse", "refuse", "runs", null]]);
    const alerts = q(store, "SELECT 1 FROM notification_outbox WHERE idempotency_key LIKE 'global-budget-fuse:%'");
    expect(alerts).toHaveLength(1);
    const events = q(store, "SELECT actor, payload_json FROM ledger_events WHERE event_type = 'global_budget_fuse' ORDER BY sequence");
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.actor).toBe("gateway");
      expect(JSON.parse(e.payload_json as string)).toMatchObject({ reason: "global_budget_fuse", breaches: [{ kind: "runs" }], window_hours: 24 });
    }
    expect(deniedAudit(store)).toEqual([DENIED_AUDIT("global_budget_fuse"), DENIED_AUDIT("global_budget_fuse")]);
  });
  it("two kinds breached → the first kind in GLOBAL_BUDGET_KINDS order", () => {
    const store = RunStore.openInMemory();
    new Gateway(store, { ...DEFAULT_GLOBAL_BUDGET_CAPS, tool_calls: 0, gated_attempts: 0 }).intake(ev("turn"), NOW);
    expect(intakeRows(store).map((r) => r.reason_code)).toEqual(["tool_calls"]);
  });
  it("a memory-lane Dig deeper under a tripped fuse writes the fuse row inside its transaction and returns the unchanged refusal (P12)", () => {
    const store = RunStore.openInMemory();
    const original = createQueuedTurnRun(store, "synthetic rule");
    store.recordChatTurn({ chat_id: "555", run_id: original, role: "user", text: "synthetic rule" }); // memLaneAskTurnEvent needs the turn's text (memlane-commands.ts:42)
    store.insertJevVerdict({ run_id: original, category: "memory", breadth: 1, reasoning: 1, actions: 0, sets_rule: 0.95, rule_scope: "ask",
      lane: "memory", role: "default", effort: null, cascade: null, save_outcome: "saved", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });
    const g = new Gateway(store, { ...DEFAULT_GLOBAL_BUDGET_CAPS, runs: 0 }, undefined, undefined, undefined, { dataDir: dir });
    const r = g.intake(buildTypedTaskEvent({ source: "telegram", type: "memlane_ask", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "mla:1", source_reference: "mla:1",
      metadata: { telegram_update_id: 1, telegram_callback_id: "mla:1", run_id: original } }), NOW);
    expect(r).toMatchObject({ ok: false, error: { code: "GLOBAL_BUDGET_FUSE" } });
    expect(intakeRows(store).map((x) => [x.entry_id, x.verdict, x.reason_code])).toEqual([["intake.budget_fuse", "refuse", "runs"]]);
  });
  it("under every cap → no fuse row", () => {
    const store = RunStore.openInMemory();
    new Gateway(store).intake(ev("turn"), NOW);
    expect(intakeRows(store).filter((r) => r.entry_id === "intake.budget_fuse")).toEqual([]);
  });
});

describe("a failing decision write never changes the intake result (spec §4.4)", () => {
  it("insert fault → decision_record_failed opened, result and audit row unchanged", () => {
    const store = RunStore.openInMemory();
    saturate(store);
    vi.spyOn(store, "insertDecision").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(new Gateway(store).intake(ev("turn"), NOW)).toMatchObject({ ok: false, error: { code: "TELEGRAM_RATE_LIMITED" } });
    const kinds = (store as unknown as { db: { prepare(s: string): { all(): Array<{ kind: string }> } } }).db.prepare("SELECT kind FROM incidents").all().map((r) => r.kind);
    expect(kinds).toContain("decision_record_failed");
    expect(deniedAudit(store)).toEqual([DENIED_AUDIT("command_window")]);
  });
  it("a recorder that throws past itself → logged, no incident, result unchanged", () => {
    const store = RunStore.openInMemory();
    saturate(store);
    const g = new Gateway(store);
    (g as unknown as { recorderCache: unknown }).recorderCache = { record: () => { throw new Error("boom"); } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(g.intake(ev("turn"), NOW)).toMatchObject({ ok: false, error: { code: "TELEGRAM_RATE_LIMITED" } });
    expect(err).toHaveBeenCalled();
    const n = (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db.prepare("SELECT 1 FROM incidents").all();
    expect(n).toEqual([]);
  });
});
