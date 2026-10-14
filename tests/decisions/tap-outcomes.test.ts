import { describe, expect, it } from "vitest";
import { decisionOf, recordTapOutcome } from "../../src/decisions/tap-outcomes.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { handleMemLaneUndo, recordTriageOverride } from "../../src/gateway/memlane-commands.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Addition A: Dig deeper, Undo and 认真想 already land somewhere (jev_verdicts.paco_correction, lesson_changes); none was a
// decision_outcomes row, so the ladder's outcome trail (and the calibration report) could not see them. Each tap now writes
// exactly one closed-enum row on the decision it judges; a missing decision or a refused value is logged, never thrown at Paco.
const D = (o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id: "turn.handler", entry_version: 2, run_id: "run_a", tool_call_id: null, stage: "pre_model",
  rung: "system_one", verdict: "lookup", p: 0.7, reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 5, ...o });

describe("tap outcomes", () => {
  it("recordTapOutcome writes one row and swallows a refusal with a log", () => {
    const s = RunStore.openInMemory(); const id = s.insertDecision(D({}));
    expect(recordTapOutcome(s, id, "dig_deeper", "lookup")).toBe(true);
    expect(recordTapOutcome(s, id, "dig_deeper", "not-a-lane")).toBe(false);
    expect(recordTapOutcome(s, "dec_missing", "dig_deeper", "lookup")).toBe(false);
    expect(s.listDecisionOutcomes(id).map((o) => `${o.signal}:${o.value}:${o.source}`)).toEqual(["dig_deeper:lookup:paco"]);
  });
  it("Dig deeper on a lane reply writes dig_deeper with the lane, on the verdict's decision", () => {
    const s = RunStore.openInMemory(); const id = s.insertDecision(D({}));
    s.insertJevVerdict({ run_id: "run_a", category: "lookup", breadth: 0, reasoning: 0, actions: 0, sets_rule: 0.1, rule_scope: null, lane: "lookup", role: "fast",
      effort: "low", cascade: null, save_outcome: "none", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null, decision_id: id });
    recordTriageOverride(s, "run_a", "run_b", "555");
    expect(s.listDecisionOutcomes(id).map((o) => `${o.signal}:${o.value}`)).toEqual(["dig_deeper:lookup"]);
  });
  it("decisionOf finds an entry's row for a run", () => {
    const s = RunStore.openInMemory(); s.insertDecision(D({})); s.insertDecision(D({ entry_id: "turn.gear", verdict: "fast" }));
    expect(decisionOf(s, "run_a", "turn.gear")?.verdict).toBe("fast");
    expect(decisionOf(s, "run_x", "turn.gear")).toBeUndefined();
  });
  it("handleMemLaneUndo of an automatic save writes lesson_undone with the turn's handler verdict", () => {
    const s = RunStore.openInMemory(); const id = s.insertDecision(D({ verdict: "memory" }));
    const lesson = s.addLesson({ scope: "ask", text: "Keep replies short.", source: "user_feedback" });
    const change = s.insertLessonChange({ run_id: "run_a", chat_id: "555", new_id: lesson, superseded_id: null, pruned_ids: [] });
    // the event shape buildMemLaneTapEvent builds (telegram-trigger-adapter.ts:333-347)
    handleMemLaneUndo(s, buildTypedTaskEvent({ source: "telegram", type: "memlane_undo", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "telegram:1:callback:cb1", source_reference: "telegram:update:1:callback:cb1",
      metadata: { telegram_update_id: 1, telegram_callback_id: "cb1", change_id: change.change_id } }));
    expect(s.listDecisionOutcomes(id).map((o) => `${o.signal}:${o.value}`)).toEqual(["lesson_undone:memory"]);
  });
});
