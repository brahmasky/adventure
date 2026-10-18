import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { handleMemLaneUndo, recordTriageOverride, TRIAGE_OVERRIDE_LIMIT } from "../../src/gateway/memlane-commands.js";
import { jevDisarmMarkerPath, readJevDisarmMarker } from "../../src/jev/jev-flags.js";
import { JEV_INCIDENT_SUBJECT, resolveQuietTriageOverrides } from "../../src/jev/jev-incidents.js";
import { isHandledIntakeDenial } from "../../src/telegram/telegram-poll-runner.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const NOW = "2026-10-04T10:00:00.000Z";
let seq = 0;
const tap = (type: "memlane_undo" | "memlane_ask", metadata: Record<string, unknown>, chat = "555", key = `k:${++seq}`, actor = "paco") => buildTypedTaskEvent({
  source: "telegram", type, requested_by: { kind: "user", id: actor }, notify: { kind: "telegram", chat_id: chat }, idempotency_key: key, source_reference: key,
  metadata: { telegram_update_id: 1, telegram_callback_id: key, ...metadata } });
const decision = (store: RunStore, run_id: string) => store.insertJevDecision({ run_id, point: "triage", question_id: "lane", criteria_hash: "h", model_reported: "jev-1.13.0", state_hash: "s", lang: "zh",
  answers_json: "{}", confidence: 0.9, top_prob: 0.9, margin: 0.8, threshold_version: "v", threshold_used: null, decision: "act", latency_ms: 1, input_tokens: 1, status: "answered", skip_reason: null });
const seedRun = (store: RunStore, text: string) => { const run = createQueuedTurnRun(store, text); store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text }); return run; };

/** A turn the given lane answered (its verdict row names the lane the tap corrects). */
const laneRun = (store: RunStore, text: string, lane: "answer" | "lookup") => {
  const run = seedRun(store, text);
  store.insertJevVerdict({ run_id: run, category: lane, breadth: 1, reasoning: 1, actions: 0, sets_rule: 0.05, rule_scope: null, lane, role: "fast",
    effort: "low", cascade: null, save_outcome: "none", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });
  return run;
};
const overridePages = (store: RunStore) =>
  store.listOpenIncidents().filter((i) => i.kind === "triage_overrides").map((i) => [i.subject, (JSON.parse(i.detail_json) as { lane?: string }).lane]);

// Spec §5.6 + stage B §6: Undo is chat-bound compare-and-set; "Dig deeper" is ONE admission and the override label; three on one lane in seven days page Paco.
describe("memlane callbacks", () => {
  // Spec §6: "Ask Houge anyway" is the strongest correction label; it lands on the original turn's verdict row.
  it("ask: the tap marks the original turn's verdict ask_anyway", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const original = seedRun(store, "以后回复短一点");
    const vid = store.insertJevVerdict({ run_id: original, category: "memory", breadth: 1, reasoning: 1, actions: 0, sets_rule: 0.95, rule_scope: "ask",
      lane: "memory", role: "default", effort: null, cascade: null, save_outcome: "saved", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });
    store.updateJevVerdict(vid, { paco_correction: "think_harder" }); // an earlier, weaker label is overwritten by the tap
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    expect(gateway.intake(tap("memlane_ask", { run_id: original })).ok).toBe(true);
    expect(store.getJevVerdictForRun(original)).toMatchObject({ verdict_id: vid, paco_correction: "ask_anyway" });
    store.close();
  });

  it("undo: chat-bound, compare-and-set, event inside the transaction, second tap says already undone", () => {
    const store = RunStore.openInMemory();
    const id = store.addLesson({ scope: "ask", text: "rule", theme: "format", source: "lane", created_at: NOW });
    const change = store.insertLessonChange({ run_id: "run_x", chat_id: "555", new_id: id, superseded_id: null, pruned_ids: [] });
    expect(handleMemLaneUndo(store, tap("memlane_undo", { change_id: change.change_id }, "999")).ok).toBe(false);
    expect(store.getLesson(id)?.status).toBe("active");
    expect(handleMemLaneUndo(store, tap("memlane_undo", { change_id: change.change_id }))).toMatchObject({ ok: true, status: "lesson_change_undone" });
    expect(store.getLesson(id)?.status).toBe("pruned");
    const undone = () => store.getLedgerEvents().filter((e) => e.event_type === "lesson_change_undone" && e.payload.change_id === change.change_id);
    expect(undone()).toHaveLength(1);
    expect(handleMemLaneUndo(store, tap("memlane_undo", { change_id: change.change_id })).ok).toBe(true);
    expect(undone()).toHaveLength(1);
    store.close();
  });
  it("ask: one admission creates the planner turn, writes the override label and the outcome on the original decisions", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const original = seedRun(store, "以后回复短一点");
    const jd = decision(store, original);
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    const r = gateway.intake(tap("memlane_ask", { run_id: original }));
    expect(r.ok && r.status).toBe("created");
    const newRun = r.ok && "run_id" in r ? r.run_id : "";
    expect(newRun).not.toBe(original);
    expect(store.triageOverrideFor(newRun)).toBe(true);
    expect(store.userTurnTextForRun(original)).toBe("以后回复短一点");
    expect(store.listJevDecisions(original).find((x) => x.decision_id === jd)).toMatchObject({ outcome_source: "paco_correction", outcome_value: "override" });
    store.close();
  });
  it("ask from another chat, or for an unknown run, is refused and creates nothing", () => {
    const store = RunStore.openInMemory();
    const original = seedRun(store, "以后回复短一点");
    const gateway = new Gateway(store);
    expect(gateway.intake(tap("memlane_ask", { run_id: original }, "999")).ok).toBe(false);
    expect(gateway.intake(tap("memlane_ask", { run_id: "run_00000000-0000-0000-0000-000000000000" })).ok).toBe(false);
    expect(store.countRecentLedgerEvents("triage_override", "2026-01-01T00:00:00.000Z")).toBe(0);
    store.close();
  });
  it("a redelivered callback returns the same run with no second triage_override row", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const original = seedRun(store, "msg");
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    const first = gateway.intake(tap("memlane_ask", { run_id: original }, "555", "same-key"));
    const again = gateway.intake(tap("memlane_ask", { run_id: original }, "555", "same-key"));
    expect(first.ok && again.ok && again.run_id).toBe(first.ok && first.run_id);
    expect(store.countRecentLedgerEvents("triage_override", "2026-01-01T00:00:00.000Z")).toBe(1);
    store.close();
  });
  it("a label-write failure leaves no new run", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const original = seedRun(store, "msg");
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    const spy = vi.spyOn(store, "recordMemoryEvent").mockImplementationOnce(() => { throw new Error("boom"); });
    expect(() => gateway.intake(tap("memlane_ask", { run_id: original }, "555", "fail-key"))).toThrow("boom");
    spy.mockRestore();
    expect(store.runIdForIdempotencyKey("telegram", "fail-key:ask")).toBeUndefined(); // the run rolled back with the label
    const retry = gateway.intake(tap("memlane_ask", { run_id: original }, "555", "fail-key"));
    expect(retry.ok && retry.status).toBe("created");
    expect(store.countRecentLedgerEvents("triage_override", "2026-01-01T00:00:00.000Z")).toBe(1);
    store.close();
  });
  // Stage B §6 (ruling 4): a tap says Jev sorted THIS message wrongly, or Paco wants more; it is not a lane fault. Three on
  // one lane in seven days page Paco for that lane; nothing is disarmed (he raises a bar or switches the lane off).
  it("three taps on the answer lane in seven days open triage_overrides for that lane, and write no disarm marker", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    for (let i = 0; i < TRIAGE_OVERRIDE_LIMIT; i++) {
      const run = laneRun(store, `msg ${i}`, "answer");
      expect(gateway.intake(tap("memlane_ask", { run_id: run }, "555", `k:${i}`, `actor${i}`)).ok).toBe(true);
    }
    expect(overridePages(store)).toEqual([[`${JEV_INCIDENT_SUBJECT}:lane:answer`, "answer"]]);
    expect(readJevDisarmMarker(jevDisarmMarkerPath({}, dir))).toBeNull();
    store.close();
  });
  it("two taps on answer and one on lookup open nothing (the count is per lane)", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    for (const [i, lane] of (["answer", "answer", "lookup"] as const).entries()) {
      expect(gateway.intake(tap("memlane_ask", { run_id: laneRun(store, `m${i}`, lane) }, "555", `p:${i}`, `b${i}`)).ok).toBe(true);
    }
    expect(overridePages(store)).toEqual([]);
    store.close();
  });
  it("the quiet resolver closes a lane's page once its taps age out of the window, so the next episode pages again", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    for (let i = 0; i < TRIAGE_OVERRIDE_LIMIT; i++) gateway.intake(tap("memlane_ask", { run_id: laneRun(store, `q${i}`, "lookup") }, "555", `r:${i}`, `c${i}`));
    expect(resolveQuietTriageOverrides(store)).toBe(0);
    expect(overridePages(store)).toHaveLength(1);
    (store as unknown as { db: { exec(s: string): void } }).db.exec(`UPDATE ledger_events SET occurred_at = '2026-01-01T00:00:00.000Z' WHERE event_type = 'triage_override'`);
    expect(resolveQuietTriageOverrides(store)).toBe(1);
    expect(overridePages(store)).toEqual([]);
    store.close();
  });
  it("refusals are handled intake denials, so a stale tap never wedges the poll offset", () => {
    const store = RunStore.openInMemory();
    const gateway = new Gateway(store);
    const undo = gateway.intake(tap("memlane_undo", { change_id: "lc_00000000-0000-0000-0000-000000000000" }));
    const ask = gateway.intake(tap("memlane_ask", { run_id: "run_00000000-0000-0000-0000-000000000000" }));
    for (const r of [undo, ask]) { expect(r.ok).toBe(false); if (!r.ok) expect(isHandledIntakeDenial(r.error.code)).toBe(true); }
    store.close();
  });
  it("an override older than seven days (by the injected clock) does not count toward the limit", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    const t0 = "2026-10-01T00:00:00.000Z"; const later = "2026-10-09T00:00:00.000Z"; // 8 days
    for (let i = 0; i < TRIAGE_OVERRIDE_LIMIT - 1; i++) {
      const run = laneRun(store, `old ${i}`, "answer");
      gateway.intake(tap("memlane_ask", { run_id: run }, "555", `old:${i}`, `a${i}`), t0);
    }
    // ledger rows are stamped by the store clock; age them so the window comparison is what is under test
    (store as unknown as { db: { exec(s: string): void } }).db.exec(`UPDATE ledger_events SET occurred_at = '${t0}' WHERE event_type = 'triage_override'`);
    const run = laneRun(store, "fresh", "answer");
    gateway.intake(tap("memlane_ask", { run_id: run }, "555", "fresh", "af"), later);
    expect(overridePages(store)).toEqual([]);
    store.close();
  });
  // Stage B §6: the override event names the lane the tap corrected (read from the verdict row); a run with no verdict
  // writes null and is still re-admitted, so Paco's tap always gets an answer.
  it("ask: triage_override.lane is the original verdict's lane, or null when the run has no verdict", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    const withVerdict = seedRun(store, "你觉得 NAS 放在客厅还是书房更好？");
    store.insertJevVerdict({ run_id: withVerdict, category: "answer", breadth: 1, reasoning: 1, actions: 0, sets_rule: 0.05, rule_scope: null,
      lane: "answer", role: "fast", effort: "low", cascade: null, save_outcome: "none", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });
    const bare = seedRun(store, "an old card");
    expect(gateway.intake(tap("memlane_ask", { run_id: withVerdict })).ok).toBe(true);
    expect(gateway.intake(tap("memlane_ask", { run_id: bare })).ok).toBe(true);
    const lanes = store.getLedgerEvents().filter((e) => e.event_type === "triage_override").map((e) => [e.payload.run_id, e.payload.lane]);
    expect(lanes).toEqual([[withVerdict, "answer"], [bare, null]]);
    store.close();
  });
});

// Spec §9: a lesson Undo now labels memory.kind too, and Dig deeper on a turn that saved only a fact names that change.
const dec = (run_id: string, entry_id: string, verdict: string): DecisionInsert => ({ entry_id, entry_version: 1, run_id, tool_call_id: null, stage: "pre_model",
  rung: "system_one", verdict, p: 0.95, reason_code: null, fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1 });
describe("memory.kind outcomes on the lane taps", () => {
  it("a lesson Undo records lesson_undone on memory.kind as well as turn.handler", () => {
    const store = RunStore.openInMemory();
    const run_id = seedRun(store, "以后先给结论");
    const handler = store.insertDecision(dec(run_id, "turn.handler", "memory"));
    const kind = store.insertDecision(dec(run_id, "memory.kind", "rule"));
    const id = store.addLesson({ scope: "ask", text: "Lead with the result", theme: "format", source: "lane", created_at: NOW });
    const change = store.insertLessonChange({ run_id, chat_id: "555", new_id: id, superseded_id: null, pruned_ids: [] });
    expect(handleMemLaneUndo(store, tap("memlane_undo", { change_id: change.change_id })).ok).toBe(true);
    expect(store.listDecisionOutcomes(handler).map((o) => [o.signal, o.value])).toEqual([["lesson_undone", "memory"]]);
    expect(store.listDecisionOutcomes(kind).map((o) => [o.signal, o.value])).toEqual([["lesson_undone", "memory"]]);
    store.close();
  });
  it("Dig deeper names the fact change when the run saved no lesson", () => {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store, "记下来吧");
    const id = store.addEpisodicFact({ chat_id: "555", fact: "Paco is vegetarian" });
    const change = store.inTransaction(() => store.insertFactAddChange({ new_id: id, superseded_id: null, pruned_ids: [], run_id, chat_id: "555", now: new Date().toISOString() }));
    recordTriageOverride(store, run_id, "run_new", "555");
    expect(store.getLedgerEvents().find((e) => e.event_type === "triage_override")?.payload.change_id).toBe(change.change_id);
    store.close();
  });
});
