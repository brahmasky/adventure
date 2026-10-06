import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { handleMemLaneUndo, TRIAGE_OVERRIDE_LIMIT } from "../../src/gateway/memlane-commands.js";
import { jevDisarmMarkerPath, readJevDisarmMarker } from "../../src/jev/jev-flags.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const NOW = "2026-10-04T10:00:00.000Z";
let seq = 0;
const tap = (type: "memlane_undo" | "memlane_ask", metadata: Record<string, unknown>, chat = "555", key = `k:${++seq}`, actor = "paco") => buildTypedTaskEvent({
  source: "telegram", type, requested_by: { kind: "user", id: actor }, notify: { kind: "telegram", chat_id: chat }, idempotency_key: key, source_reference: key,
  metadata: { telegram_update_id: 1, telegram_callback_id: key, ...metadata } });
const decision = (store: RunStore, run_id: string) => store.insertJevDecision({ run_id, point: "triage", question_id: "lane", criteria_hash: "h", model_reported: "jev-1.13.0", state_hash: "s", lang: "zh",
  answers_json: "{}", confidence: 0.9, top_prob: 0.9, margin: 0.8, threshold_version: "v", threshold_used: null, decision: "act", latency_ms: 1, input_tokens: 1, status: "answered", skip_reason: null });
const seedRun = (store: RunStore, text: string) => { const run = createQueuedTurnRun(store, text); store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text }); return run; };

// Spec §5.6: Undo is chat-bound compare-and-set; "Ask Houge anyway" is ONE admission, the override label, and three in seven days cap the lane.
describe("memlane callbacks", () => {
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
  it("three overrides in seven days write the disarm marker and open triage_overrides", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    for (let i = 0; i < TRIAGE_OVERRIDE_LIMIT; i++) {
      const run = seedRun(store, `msg ${i}`);
      expect(gateway.intake(tap("memlane_ask", { run_id: run }, "555", `k:${i}`, `actor${i}`)).ok).toBe(true);
    }
    expect(readJevDisarmMarker(jevDisarmMarkerPath({}, dir))?.reason).toBe("triage_overrides");
    expect(store.listOpenIncidents().some((i) => i.kind === "triage_overrides")).toBe(true);
    store.close();
  });
});
