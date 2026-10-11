import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore, type JevVerdictInsert } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Stage B §7 and §9: a lane answers outside the planner's omp session, so the planner never sees it. The catch-up block is
// built from these readers: the lane line stored at lane end, the boundary of the planner's last answer, and Paco's previous
// Telegram lines for the lookup rewrite. A wrong boundary drops what the planner missed or repeats what it already answered.
const V: Omit<JevVerdictInsert, "run_id"> = { category: "answer", breadth: 1, reasoning: 1, actions: 0, sets_rule: 0.05, rule_scope: null,
  lane: "answer", role: "fast", effort: "low", cascade: null, save_outcome: "none", route_outcome: "act", reason: "routed", skip_reason: null,
  quoted_turn_id: null };
const CHAT = "555";
const t = (m: number): string => new Date(Date.parse("2026-10-10T08:00:00.000Z") + m * 60_000).toISOString();
let seq = 0;

function scheduleRun(store: RunStore): string {
  seq += 1;
  const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: `digest ${seq}`,
    requested_by: { kind: "schedule", id: "sch_t" }, notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `schedule:sch_t:${seq}`,
    source_reference: "scheduled_tasks.sch_t" }));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}
/** A lane turn as Task 7 leaves it: Paco's line, the lane's assistant line, the lane_reply verdict, the lane_replies row. */
function laneTurn(store: RunStore, text: string, catch_up: string, at: string): string {
  const run_id = createQueuedTurnRun(store, text);
  store.recordChatTurn({ chat_id: CHAT, run_id, role: "user", text, created_at: at });
  store.recordChatTurn({ chat_id: CHAT, run_id, role: "assistant", text: "lane reply", intent: "loop", created_at: at });
  const vid = store.insertJevVerdict({ ...V, run_id, created_at: at });
  store.updateJevVerdict(vid, { handler_outcome: "lane_reply" });
  store.recordLaneReply({ run_id, chat_id: CHAT, lane: "answer", verdict_id: vid, catch_up, created_at: at });
  return run_id;
}
function plannerTurn(store: RunStore, text: string, at: string, intent = "loop"): string {
  const run_id = createQueuedTurnRun(store, text);
  store.recordChatTurn({ chat_id: CHAT, run_id, role: "user", text, created_at: at });
  store.recordChatTurn({ chat_id: CHAT, run_id, role: "assistant", text: `answer to ${text}`, intent, created_at: at });
  return run_id;
}

describe("lane_replies and the catch-up readers (stage B §7, §9)", () => {
  it("laneTurnsSince: rows after the boundary only, oldest first, each joined to its user text; a second write for a run is ignored", () => {
    const store = RunStore.openInMemory();
    const early = laneTurn(store, "early", "Houge replied: early", t(1));
    const a = laneTurn(store, "第一个", "Houge replied: one", t(3));
    const b = laneTurn(store, "第二个", "Houge reported its status", t(4));
    store.recordLaneReply({ run_id: a, chat_id: CHAT, lane: "answer", verdict_id: null, catch_up: "a second write", created_at: t(5) });
    expect(store.laneTurnsSince(CHAT, t(2)).map((r) => [r.run_id, r.user_text, r.catch_up])).toEqual([
      [a, "第一个", "Houge replied: one"], [b, "第二个", "Houge reported its status"]
    ]);
    expect(store.laneTurnsSince(CHAT, null).map((r) => r.run_id)).toEqual([early, a, b]);
    expect(store.laneTurnsSince("777", null)).toEqual([]);
    store.close();
  });
  // The planner must never be told a reply reached Paco when it did not: a lane run that later failed leaves its verdict at
  // fallthrough:run_failed, and its catch-up line would make the planner assume Paco saw an answer he never got.
  it("laneTurnsSince excludes a lane reply whose run later failed (verdict fallthrough:run_failed)", () => {
    const store = RunStore.openInMemory();
    const ok = laneTurn(store, "delivered", "Houge replied: ok", t(1));
    const failed = laneTurn(store, "undelivered", "Houge replied: lost", t(2));
    store.updateJevVerdict(store.getJevVerdictForRun(failed)!.verdict_id, { handler_outcome: "fallthrough:run_failed" });
    expect(store.laneTurnsSince(CHAT, null).map((r) => r.run_id)).toEqual([ok]);
    store.close();
  });
  // A status/memory row written by a path with no verdict has nothing to say it failed, so it is still caught up. The row
  // needs its own run_id: recordLaneReply is INSERT OR IGNORE, so reusing one would silently test nothing.
  it("laneTurnsSince keeps a lane reply that has no verdict", () => {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store, "status?");
    store.recordChatTurn({ chat_id: CHAT, run_id, role: "user", text: "status?", created_at: t(1) });
    store.recordLaneReply({ run_id, chat_id: CHAT, lane: "status", verdict_id: null, catch_up: "Houge reported its status", created_at: t(1) });
    expect(store.laneTurnsSince(CHAT, null).map((r) => [r.run_id, r.verdict_id])).toEqual([[run_id, null]]);
    store.close();
  });
  it("plannerLastAnsweredAt: the planner's newest Telegram reply; lane replies, evolution reports and schedule replies never move it", () => {
    const store = RunStore.openInMemory();
    expect(store.plannerLastAnsweredAt(CHAT)).toBeNull();
    plannerTurn(store, "q1", t(1));
    laneTurn(store, "lane q", "Houge replied: x", t(2));
    plannerTurn(store, "evo", t(3), "evolution_report");
    const sched = scheduleRun(store);
    store.recordChatTurn({ chat_id: CHAT, run_id: sched, role: "assistant", text: "digest", intent: "loop", created_at: t(4) });
    expect(store.plannerLastAnsweredAt(CHAT)).toBe(t(1));
    store.close();
  });
  it("previousTelegramTurns: Telegram rows of this chat before the instant, the last n, oldest first; schedule rows never count", () => {
    const store = RunStore.openInMemory();
    plannerTurn(store, "one", t(1));
    plannerTurn(store, "two", t(2));
    const sched = scheduleRun(store);
    store.recordChatTurn({ chat_id: CHAT, run_id: sched, role: "user", text: "scheduled goal", created_at: t(3) });
    plannerTurn(store, "later", t(9));
    expect(store.previousTelegramTurns(CHAT, t(5), 3).map((r) => r.text)).toEqual(["answer to one", "two", "answer to two"]);
    store.close();
  });
  it("countLaneTurns drops fallthrough:aborted from both counts (a /kill is not a lane failure)", () => {
    const store = RunStore.openInMemory();
    for (const [i, outcome] of ["lane_reply", "fallthrough:compose_failed", "fallthrough:aborted"].entries()) {
      const id = store.insertJevVerdict({ ...V, run_id: `run_c${i}`, created_at: t(i + 1) });
      store.updateJevVerdict(id, { handler_outcome: outcome });
    }
    expect(store.countLaneTurns(t(0), t(10))).toEqual([{ lane: "answer", turns: 2, fallthroughs: 1 }]);
    store.close();
  });
  it("countRecentTriageOverrides counts one lane's taps in the window by the payload's lane", () => {
    const store = RunStore.openInMemory();
    for (const lane of ["answer", "answer", "lookup", null]) store.recordMemoryEvent("triage_override", { run_id: "run_o", new_run_id: `run_n${++seq}`, change_id: null, lane });
    expect(store.countRecentTriageOverrides("answer", "2026-01-01T00:00:00.000Z")).toBe(2);
    expect(store.countRecentTriageOverrides("lookup", "2026-01-01T00:00:00.000Z")).toBe(1);
    expect(store.countRecentTriageOverrides("answer", "2999-01-01T00:00:00.000Z")).toBe(0);
    store.close();
  });
  it("insertJevVerdict takes a caller-minted id (the lane's compose attempts carry it before the row exists)", () => {
    const store = RunStore.openInMemory();
    expect(store.insertJevVerdict({ ...V, run_id: "run_m" }, "jv_minted")).toBe("jv_minted");
    expect(store.getJevVerdictForRun("run_m")?.verdict_id).toBe("jv_minted");
    store.close();
  });
  it("route_outcome accepts the lane patch value fallback", () => {
    const store = RunStore.openInMemory();
    const id = store.insertJevVerdict({ ...V, run_id: "run_f" });
    store.updateJevVerdict(id, { route_outcome: "fallback", handler_outcome: "fallthrough:compose_failed" });
    expect(store.getJevVerdictForRun("run_f")).toMatchObject({ route_outcome: "fallback", handler_outcome: "fallthrough:compose_failed" });
    store.close();
  });
});
