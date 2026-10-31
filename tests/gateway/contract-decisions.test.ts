import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_BUDGET_CAPS } from "../../src/budget/global-budget-ledger.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import { buildTypedTaskEvent, type TypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Spec 2026-11-01 R2 §4.2 (Decision 1-B): a refusal and a schedule-born turn's narrowed envelope leave a row; a plain
// compile is consulted and writes none; fuse cycles, duplicates and failed attaches write nothing.
const NOW = "2026-07-03T12:00:00.000Z";
const PINNED = ["HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH"] as const;
const saved: Partial<Record<(typeof PINNED)[number], string>> = {};
let dir = ""; let seq = 0;
beforeEach(() => {
  for (const k of PINNED) { if (process.env[k] !== undefined) saved[k] = process.env[k]; else delete saved[k]; }
  dir = mkdtempSync(join(tmpdir(), "hg-contract-"));
  delete process.env.HOUGE_TELEGRAM_CHAT_ID;
  process.env.HOUGE_TOMBSTONE_PATH = join(dir, "t.kill"); process.env.HOUGE_DISARM_PATH = join(dir, "t.disarm");
});
afterEach(() => { for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } rmSync(dir, { recursive: true, force: true }); });

function ev(o: { source?: "telegram" | "schedule"; type?: string; program?: string; goal?: string; key?: string } = {}): TypedTaskEvent {
  seq += 1;
  const source = o.source ?? "telegram";
  return buildTypedTaskEvent({ source, type: o.type ?? "turn", program: o.program ?? "turn", goal: o.goal ?? "synthetic",
    requested_by: source === "schedule" ? { kind: "schedule", id: "sch_1" } : { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" }, idempotency_key: o.key ?? `k:${seq}`, source_reference: `ref:${seq}` } as never);
}
function rig(caps = DEFAULT_GLOBAL_BUDGET_CAPS) {
  const store = RunStore.openInMemory(); const calls: string[] = [];
  const inner = storeRecorder(store);
  const recorder: DecisionRecorder = { record: (e, r, c) => { calls.push(e.id); return inner.record(e, r, c); } };
  return { store, calls, g: new Gateway(store, caps, undefined, undefined, undefined, { decisionRecorder: recorder }),
    contractCalls: () => calls.filter((id) => id === "turn.contract").length };
}
const rows = (store: RunStore) => (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db
  .prepare("SELECT verdict, reason_code, run_id, stage FROM decisions WHERE entry_id = 'turn.contract' ORDER BY rowid").all();

describe("turn.contract at handleTaskIntake", () => {
  it("a Telegram turn → consulted once, no row (compile is the default)", () => {
    const r = rig(); const out = r.g.intake(ev(), NOW);
    expect(out.ok).toBe(true);
    expect(r.contractCalls()).toBe(1);
    expect(rows(r.store)).toEqual([]);
  });
  it("a scheduled turn → one restrict/schedule_born row carrying the new run's id; the contract still lacks schedule_task", () => {
    const r = rig(); const out = r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:1" }), NOW);
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(rows(r.store)).toEqual([{ verdict: "restrict", reason_code: "schedule_born", run_id: out.run_id, stage: "pre_model" }]);
    const contract = (r.store as unknown as { db: { prepare(s: string): { get(id: string): { contract_json: string } } } }).db
      .prepare("SELECT contract_json FROM runs WHERE run_id = ?").get(out.run_id).contract_json;
    expect(JSON.parse(contract).allowed_actions).not.toContain("schedule_task");
  });
  it("the same scheduled occurrence replayed (duplicate) → still one row, one call", () => {
    const r = rig();
    r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:2" }), NOW);
    r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:2" }), NOW);
    expect(rows(r.store)).toHaveLength(1);
    expect(r.contractCalls()).toBe(1);
  });
  it("a scheduled turn under a tripped fuse, two cycles → zero turn.contract calls and rows (only the fuse records)", () => {
    const r = rig({ ...DEFAULT_GLOBAL_BUDGET_CAPS, runs: 0 });
    for (let i = 0; i < 2; i += 1) expect(r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:3" }), NOW)).toMatchObject({ ok: false, error: { code: "GLOBAL_BUDGET_FUSE" } });
    expect(r.contractCalls()).toBe(0);
    expect(rows(r.store)).toEqual([]);
    expect(r.calls.filter((id) => id === "intake.budget_fuse")).toHaveLength(2);
  });
  it.each([
    ["/run nosuch", { type: "run", program: "nosuch" }, "unknown_program"],
    ["an empty Telegram turn", { goal: " " }, "goal_missing"],
    ["an empty scheduled turn", { source: "schedule" as const, goal: " " }, "goal_missing"],
    ["an unsupported type", { type: "bogus" }, "unsupported_type"]
  ])("%s → refuse with no run; the intake result is the unchanged error", (_l, o, reason) => {
    const r = rig(); const out = r.g.intake(ev(o), NOW);
    expect(out).toMatchObject({ ok: false, error: { code: "TASK_CONTRACT_INVALID" } });
    expect(Object.keys((out as { error: object }).error).sort()).toEqual(["code", "message"]);
    expect(out).not.toHaveProperty("reason");
    expect(rows(r.store)).toEqual([{ verdict: "refuse", reason_code: reason, run_id: null, stage: "pre_model" }]);
  });
  it("the row is the first write of the queued block: a later throw there cannot cost it", () => {
    const r = rig();
    (r.store as unknown as { recordGlobalBudgetRun: () => never }).recordGlobalBudgetRun = () => { throw new Error("planted"); };
    expect(() => r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:4" }), NOW)).toThrow("planted");
    expect(rows(r.store)).toHaveLength(1);
  });
  it("order (codex W): the decision row precedes recordGlobalBudgetRun, disarmGlobalFuse and recordTelegramAccepted", () => {
    const r = rig(); const order: string[] = [];
    const s = r.store as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ["insertDecision", "recordGlobalBudgetRun", "disarmGlobalFuse", "recordTelegramCommandAudit"]) {
      const orig = s[m]!.bind(r.store); s[m] = (...a: unknown[]) => { order.push(m); return orig(...a); };
    }
    r.g.intake(ev({ source: "schedule", key: "schedule:sch_1:6" }), NOW);
    expect(order.slice(0, 3)).toEqual(["insertDecision", "recordGlobalBudgetRun", "disarmGlobalFuse"]);
  });
  it("no injected recorder → the lazy store recorder as before (rows still written)", () => {
    const store = RunStore.openInMemory();
    new Gateway(store).intake(ev({ source: "schedule", key: "schedule:sch_1:5" }), NOW);
    expect(rows(store).map((x) => x.verdict)).toEqual(["restrict"]);
  });
  it("a rating forward (digit + comment) re-enters handleTaskIntake → consulted once, no row", () => {
    const r = rig();
    const ago = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
    r.store.writePendingRating({ chat_id: "222", asked_at: ago(40), window_start: ago(120) }); // as tests/gateway/rating-reply-decisions.test.ts:36
    const out = r.g.intake(ev({ goal: "2 synthetic comment" }), NOW);
    expect(out).toMatchObject({ ok: true, status: "created" });
    expect(r.contractCalls()).toBe(1);
    expect(rows(r.store)).toEqual([]);
  });
  it("a memory-lane Ask runs handleTaskIntake inside admitMemLaneAsk's transaction → consulted once, no row", () => {
    const r = rig();
    const original = createQueuedTurnRun(r.store, "synthetic rule"); // setup as tests/gateway/intake-decisions.test.ts:136–143
    r.store.recordChatTurn({ chat_id: "555", run_id: original, role: "user", text: "synthetic rule" });
    r.store.insertJevVerdict({ run_id: original, category: "memory", breadth: 1, reasoning: 1, actions: 0, sets_rule: 0.95, rule_scope: "ask",
      lane: "memory", role: "default", effort: null, cascade: null, save_outcome: "saved", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });
    let n = 0;
    const g = new Gateway(r.store, DEFAULT_GLOBAL_BUDGET_CAPS, undefined, undefined, undefined, { dataDir: dir, decisionRecorder: { record: (e, x, c) => { if (e.id === "turn.contract") n += 1; return storeRecorder(r.store).record(e, x, c); } } });
    const out = g.intake(buildTypedTaskEvent({ source: "telegram", type: "memlane_ask", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "mla:1", source_reference: "mla:1",
      metadata: { telegram_update_id: 1, telegram_callback_id: "mla:1", run_id: original } } as never), NOW);
    expect(out.ok).toBe(true);
    expect(n).toBe(1);
    expect(rows(r.store)).toEqual([]);
  });
});
