import { describe, expect, it } from "vitest";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Spec 2026-11-07 §3.4 and §6: an applied (accepted) or undone (reverted) proposal blocks the same (target, scope) for 14 days —
// without it the next tick would re-learn the lesson Paco just undid; the undo commands find the proposal by the saved id.
const NOW = "2026-10-21T10:00:00.000Z";
const SINCE = "2026-10-07T10:00:00.000Z"; // now − 14 d
const D: DecisionInsert = { entry_id: "improve.route", entry_version: 1, run_id: null, tool_call_id: null, stage: "after_turn", rung: "system_one", verdict: "lesson", p: 0.7, reason_code: "jev_choice",
  fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: NOW };
function proposal(s: RunStore, state: "accepted" | "reverted" | "dismissed", resolved_at: string, result_json?: string, target: "lesson" | "fact" = "lesson"): string {
  const id = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target, scope: "answer", chat_id: "555", draft_json: "{}", evidence: "e", created_at: "2026-09-01T00:00:00.000Z" });
  s.transitionProposal({ proposal_id: id, from: ["open"], to: "accepted", now: resolved_at, ...(result_json ? { result_json } : {}) });
  if (state !== "accepted") s.transitionProposal({ proposal_id: id, from: ["accepted"], to: state === "reverted" ? "reverted" : "dismissed", now: resolved_at });
  return id;
}

describe("proposalBlocks", () => {
  it("an accepted or reverted proposal within 14 days blocks its (target, scope); one older than 14 days, or another scope or target, does not", () => {
    const s = RunStore.openInMemory();
    proposal(s, "accepted", "2026-10-20T00:00:00.000Z");
    expect(s.proposalBlocks("lesson", "answer", SINCE)).toBe(true);
    expect(s.proposalBlocks("lesson", "lookup", SINCE)).toBe(false);
    expect(s.proposalBlocks("fact", "answer", SINCE)).toBe(false);
    const s2 = RunStore.openInMemory();
    proposal(s2, "reverted", "2026-10-15T00:00:00.000Z");
    expect(s2.proposalBlocks("lesson", "answer", SINCE)).toBe(true);
    const s3 = RunStore.openInMemory();
    proposal(s3, "accepted", "2026-10-01T00:00:00.000Z"); proposal(s3, "reverted", "2026-10-02T00:00:00.000Z");
    expect(s3.proposalBlocks("lesson", "answer", SINCE)).toBe(false);
    const s4 = RunStore.openInMemory();
    proposal(s4, "accepted", SINCE); // resolved exactly at the cut: strict >, so it no longer blocks
    expect(s4.proposalBlocks("lesson", "answer", SINCE)).toBe(false);
  });
});

describe("proposalBySaved", () => {
  it("finds the accepted proposal by the lesson or fact id it saved; a reverted one, another id or the change id finds nothing", () => {
    const s = RunStore.openInMemory();
    const lesson = proposal(s, "accepted", NOW, JSON.stringify({ change_id: "lc_1", lesson_id: 57 }));
    const fact = proposal(s, "accepted", NOW, JSON.stringify({ change_id: "mc_1", fact_id: 214 }), "fact");
    proposal(s, "reverted", NOW, JSON.stringify({ change_id: "lc_2", lesson_id: 58 }));
    expect(s.proposalBySaved("lesson", 57)?.proposal_id).toBe(lesson);
    expect(s.proposalBySaved("fact", 214)?.proposal_id).toBe(fact);
    expect(s.proposalBySaved("lesson", 58)).toBeUndefined();
    expect(s.proposalBySaved("fact", 57)).toBeUndefined();
    expect(s.proposalBySaved("lesson", 214)).toBeUndefined();
  });
});
