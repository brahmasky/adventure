import { describe, expect, it } from "vitest";
import { buildDecisionDigest, REVIEW_PREFIX, resolveDigestAt, reviewButtons, runDecisionDigestTick, unsureOf, UNSURE_MAX } from "../../src/decisions/digest.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec §8.1: one message a day, rich-rendered, skipped when empty: up to 8 unsure verdicts (p within 0.15 of the entry's
// bar) with ✅/❌ taps, counts per entry by rung, per-entry health. The line shows Paco's own words for front-door entries
// and never tool text. The latch makes it one message per local date, whatever the poll cadence. Plan ruling 14: a
// front-door row whose verdict does not link it (a turn that never settled) is neither counted nor offered.
// Ruling R1: only System One judgements are offered; an `uncalibrated` fallback carries an arbitrary p and is not one.
// turn.handler's System One rung decides only at p >= 0.6 (below is the cascade), so fixtures use p in [0.6, 0.75].
const ENV = { HOUGE_DISPLAY_TZ: "Australia/Sydney" };
const NOW = "2026-10-12T11:00:00.000Z"; // 22:00 in Sydney (AEDT, UTC+11)
const D = (o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id: "turn.handler", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_model",
  rung: "system_one", verdict: "planner", p: 0.9, reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1,
  created_at: "2026-10-12T05:00:00.000Z", ...o });
/** A turn.handler decision as settleTriage writes it: its run's verdict links it. */
function settled(store: RunStore, o: Partial<DecisionInsert>, text = "x"): { id: string; run_id: string } {
  const run_id = createQueuedTurnRun(store, text);
  const id = store.insertDecision(D({ run_id, ...o }));
  store.insertJevVerdict({ run_id, category: null, breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "planner",
    role: "default", effort: null, cascade: null, save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null,
    quoted_turn_id: null, decision_id: id });
  return { id, run_id };
}

describe("unsureOf", () => {
  it("keeps applied System One judgements within 0.15 of the entry's bar (turn.handler: 0.6), newest first, at most 8", () => {
    const store = RunStore.openInMemory();
    store.insertDecision(D({ p: 0.9 }));                                     // sure
    store.insertDecision(D({ p: 0.65, armed_mode: "shadow" }));              // shadow: not applied, not offered
    store.insertDecision(D({ p: 0.65, rung: "rule" }));                      // a rule decided
    store.insertDecision(D({ p: 0.65, rung: "model", reason_code: "cascade" })); // the cascade decided
    store.insertDecision(D({ p: 0.65, reason_code: "uncalibrated" }));       // a fallback route, not a judgement (R1)
    store.insertDecision(D({ entry_id: "turn.gear", p: 0.65 }));             // turn.gear has no single bar
    for (let k = 0; k < 10; k += 1) store.insertDecision(D({ p: 0.6 + k * 0.01, created_at: `2026-10-12T06:0${k}:00.000Z` }));
    const rows = unsureOf(store.listDecisionsBetween("2026-10-11T11:00:00.000Z", NOW));
    expect(rows).toHaveLength(UNSURE_MAX);
    expect(rows[0]?.p).toBeCloseTo(0.69);
    expect(rows[UNSURE_MAX - 1]?.p).toBeCloseTo(0.62);
    expect(rows.every((r) => r.entry_id === "turn.handler" && r.rung === "system_one" && r.armed_mode === "on" && r.reason_code === "routed")).toBe(true);
    store.close();
  });
});

describe("buildDecisionDigest", () => {
  it("null on a day with no decisions (skipped when empty)", () => {
    const store = RunStore.openInMemory();
    expect(buildDecisionDigest(store, NOW, ENV)).toBeNull();
    store.close();
  });
  it("renders unsure, counts and health; the line carries Paco's own words (markdown stripped, 40 code points), no tool text", () => {
    const store = RunStore.openInMemory();
    const { id, run_id } = settled(store, { p: 0.62 });
    store.recordChatTurn({ chat_id: "555", run_id, role: "user", text: "**明天** 悉尼 [天气] 怎么样？ 顺便 看看 后天 的 风 和 湿度 还有 紫外线 指数 多少" });
    settled(store, { rung: "fail", fallback_reason: "outage", fallback_rung: "system_one", reason_code: "transport", p: null });
    settled(store, { rung: "rule", reason_code: "ack_rule", p: null });
    const g = buildDecisionDigest(store, NOW, ENV)!;
    expect(g.text).toContain("🪜 *Decisions — 2026-10-12*");
    expect(g.text).toContain("1. turn.handler → planner · p 0.62 · 16:00 · «明天 悉尼 天气 怎么样？ 顺便 看看 后天 的 风 和 湿度 还有 紫外线 指»");
    expect(g.text).toContain("· turn.handler 3 — rule 1 · system_one 1 · fail 1");
    expect(g.text).toContain("· turn.handler: 1 Jev skip · 1 fallback");
    expect(g.offered).toEqual([id]);
    expect(g.button_rows).toEqual([reviewButtons(id, 1)]);
    store.close();
  });
  it("health counts Jev skips by the store's rule (M1): stale_bar and budget are not skips, a cascade failure is not a Jev skip", () => {
    const store = RunStore.openInMemory();
    settled(store, { rung: "fail", fallback_reason: "stale_bar", fallback_rung: "system_one", reason_code: "jev_skipped", p: null });
    settled(store, { rung: "fail", fallback_reason: "budget", fallback_rung: "system_one", reason_code: "jev_skipped", p: null });
    settled(store, { rung: "fail", fallback_reason: "timeout", fallback_rung: "model", reason_code: "cascade_failed", p: null });
    const g = buildDecisionDigest(store, NOW, ENV)!;
    expect(g.text).toContain("· turn.handler: 0 Jev skips · 2 fallbacks");
    store.close();
  });
  it("a day with only routine rows has no health section", () => {
    const store = RunStore.openInMemory();
    settled(store, { p: 0.95 });
    const g = buildDecisionDigest(store, NOW, ENV)!;
    expect(g.text).not.toContain("*Health*");
    expect(g.button_rows).toEqual([]);
    store.close();
  });
  it("a front-door row no verdict links (a turn that never settled) is neither counted nor offered", () => {
    const store = RunStore.openInMemory();
    const orphan = store.insertDecision(D({ run_id: createQueuedTurnRun(store, "x"), p: 0.6 }));
    const { id } = settled(store, { p: 0.62 });
    const g = buildDecisionDigest(store, NOW, ENV)!;
    expect(g.offered).toEqual([id]);
    expect(g.offered).not.toContain(orphan);
    expect(g.text).toContain("· turn.handler 1 — system_one 1");
    store.close();
  });
  it("a snippet never splits an emoji (code points, not UTF-16 units)", () => {
    const store = RunStore.openInMemory();
    const { run_id } = settled(store, { p: 0.6 });
    store.recordChatTurn({ chat_id: "555", run_id, role: "user", text: `${"a".repeat(39)}😀tail` });
    expect(buildDecisionDigest(store, NOW, ENV)!.text).toContain(`«${"a".repeat(39)}😀»`);
    store.close();
  });
  it("review buttons carry dec:rv:<id>:<ok|bad> within Telegram's 64-byte callback limit", () => {
    const id = "dec_00000000-0000-0000-0000-000000000000";
    expect(REVIEW_PREFIX).toBe("dec:rv:");
    expect(reviewButtons(id, 3)).toEqual([{ text: "✅ 3", data: `dec:rv:${id}:ok` }, { text: "❌ 3", data: `dec:rv:${id}:bad` }]);
    expect(Buffer.byteLength(`dec:rv:${id}:bad`)).toBeLessThanOrEqual(64);
  });
});

describe("runDecisionDigestTick", () => {
  it("before HOUGE_DECISION_DIGEST_AT nothing runs; after it, one message per local date with the offered ids latched", () => {
    const store = RunStore.openInMemory();
    const { id } = settled(store, { p: 0.6 });
    const env = { ...ENV, HOUGE_DECISION_DIGEST_AT: "22:30" };
    expect(runDecisionDigestTick({ store, chatId: "555", now: NOW, env })).toEqual({ ran: false });          // 22:00 < 22:30
    const later = "2026-10-12T11:40:00.000Z";                                                                 // 22:40
    expect(runDecisionDigestTick({ store, chatId: "555", now: later, env })).toEqual({ ran: true, sent: true });
    expect(runDecisionDigestTick({ store, chatId: "555", now: "2026-10-12T12:00:00.000Z", env })).toEqual({ ran: false });
    const sent = [...drainOutbox(store).values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]?.button_rows).toEqual([reviewButtons(id, 1)]);
    expect(store.getDecisionDigest("2026-10-12")).toMatchObject({ sent: 1, offered: [id] });
    store.close();
  });
  it("an empty day latches with sent 0 and sends nothing; no operator chat: nothing runs", () => {
    const store = RunStore.openInMemory();
    expect(runDecisionDigestTick({ store, chatId: null, now: NOW, env: ENV })).toEqual({ ran: false });
    expect(runDecisionDigestTick({ store, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: false });
    expect(drainOutbox(store).size).toBe(0);
    expect(store.getDecisionDigest("2026-10-12")).toMatchObject({ sent: 0, offered: [] });
    store.close();
  });
  it("an outbox conflict on today's key latches sent 0 with nothing offered (never a silent 'sent')", () => {
    const store = RunStore.openInMemory();
    settled(store, { p: 0.6 });
    store.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: "decision_digest:2026-10-12",
      correlation_id: "decision-digest", payload: { text: "an older digest" } });
    expect(runDecisionDigestTick({ store, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: false });
    expect(store.getDecisionDigest("2026-10-12")).toMatchObject({ sent: 0, offered: [] });
    store.close();
  });
  it("a malformed HOUGE_DECISION_DIGEST_AT falls back to 21:00", () => {
    expect([resolveDigestAt({}), resolveDigestAt({ HOUGE_DECISION_DIGEST_AT: "9pm" }), resolveDigestAt({ HOUGE_DECISION_DIGEST_AT: "07:05" })]).toEqual(["21:00", "21:00", "07:05"]);
  });
});
