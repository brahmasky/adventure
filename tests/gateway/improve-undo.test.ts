import { describe, expect, it } from "vitest";
import { applyProposal } from "../../src/improve/apply.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { createTelegramTurn } from "../helpers/runs.js";

// Spec 2026-11-07 §6: the undo commands Paco already has are the undo of an auto-applied proposal. Each moves it
// accepted → reverted in the removal's own transaction; its text stays a repeat candidate for 14 days, so a near-copy is never re-learned.
const NOW = "2026-10-21T10:00:00.000Z";
const SINCE = "2026-10-07T10:00:00.000Z";
const D: DecisionInsert = { entry_id: "improve.route", entry_version: 1, run_id: null, tool_call_id: null, stage: "after_turn", rung: "system_one", verdict: "lesson", p: 0.7, reason_code: "jev_choice",
  fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: NOW };
let seq = 0;
const cmd = (type: "forget" | "forget_memory", program: string) => buildTypedTaskEvent({ source: "telegram", type, program, requested_by: { kind: "user", id: "paco" },
  notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `telegram:undo-${++seq}`, source_reference: `telegram:update:${seq}:message:1` });
function applied(s: RunStore, target: "lesson" | "fact", draft: unknown, scope = "answer") {
  const run_id = createTelegramTurn(s, "x").run_id;
  const proposal_id = s.insertImprovementProposal({ decision_id: s.insertDecision({ ...D, run_id }), target, scope, chat_id: "555", draft_json: JSON.stringify(draft), evidence: "e", created_at: NOW });
  const r = s.inTransaction(() => applyProposal(s, { proposal_id, target, draft_json: JSON.stringify(draft), run_id, chat_id: "555", now: NOW }));
  if (!r || "capped" in r) throw new Error("fixture proposal was not applied");
  return { proposal_id, id: "lesson_id" in r ? r.lesson_id : r.fact_id };
}

describe("undo of an applied proposal", () => {
  it("/forget <id> prunes the lesson and reverts its proposal; its text stays a repeat candidate for 14 days", () => {
    const s = RunStore.openInMemory();
    const { proposal_id, id } = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });
    expect(new Gateway(s).intake(cmd("forget", String(id)))).toMatchObject({ ok: true, status: "forgotten" });
    expect(s.getLesson(id)?.status).toBe("pruned");
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("reverted");
    expect(s.repeatCandidates("lesson", "answer", SINCE).map((c) => c.proposal_id)).toEqual([proposal_id]);
  });
  it("/forget <scope> reverts the proposal of every lesson it prunes and leaves a lesson with no proposal alone", () => {
    const s = RunStore.openInMemory();
    const a = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });
    const b = applied(s, "lesson", { scope: "ask", text: "Name the source." }, "lookup");
    const plain = s.addLesson({ scope: "ask", text: "prefer primary sources", source: "user_feedback", created_at: NOW });
    expect(new Gateway(s).intake(cmd("forget", "ask"))).toMatchObject({ ok: true, status: "forgotten" });
    expect([a.proposal_id, b.proposal_id].map((p) => s.getImprovementProposal(p)?.state)).toEqual(["reverted", "reverted"]);
    expect([a.id, b.id, plain].map((id) => s.getLesson(id)?.status)).toEqual(["pruned", "pruned", "pruned"]);
  });
  it("/forget_memory <id> retires the fact and reverts its proposal in one transaction; a refused id reverts nothing", () => {
    const s = RunStore.openInMemory();
    const { proposal_id, id } = applied(s, "fact", { text: "Paco's sister lives in Lima.", evidence: { line: 1, quote: "sister lives in lima" }, source_turn_ids: [] });
    expect(new Gateway(s).intake(cmd("forget_memory", String(id)))).toMatchObject({ ok: true, status: "memory_forgotten" });
    expect(s.getEpisodicFact(id)?.status).toBe("pruned");
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("reverted");
    expect(s.repeatCandidates("fact", "answer", SINCE).map((c) => c.proposal_id)).toEqual([proposal_id]);
    const s2 = RunStore.openInMemory();
    const other = applied(s2, "fact", { text: "Paco's sister lives in Lima.", evidence: { line: 1, quote: "sister lives in lima" }, source_turn_ids: [] });
    expect(new Gateway(s2).intake(cmd("forget_memory", String(other.id + 100))).ok).toBe(false);
    expect(s2.getImprovementProposal(other.proposal_id)?.state).toBe("accepted");
  });
  it("a lesson that was not an applied proposal: /forget works as before and no proposal changes", () => {
    const s = RunStore.openInMemory();
    const { proposal_id } = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });
    const plain = s.addLesson({ scope: "research", text: "prefer primary sources", source: "user_feedback", created_at: NOW });
    expect(new Gateway(s).intake(cmd("forget", String(plain)))).toMatchObject({ ok: true, status: "forgotten" });
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("accepted");
  });
});
