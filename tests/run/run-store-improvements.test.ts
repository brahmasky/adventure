import { describe, expect, it } from "vitest";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Spec 2b-ii §5.1–5.2, §5.6: proposals have one open row per (target, scope), expire at 14 days, an accepted lesson or fact no longer blocks its pair (addendum Rev 2.3.1: the repeat check skips near-copies); taps are one row per Telegram callback
// id; a ladder move ends on Revoke.
const NOW = "2026-10-21T10:00:00.000Z";
const D: DecisionInsert = { entry_id: "improve.route", entry_version: 1, run_id: null, tool_call_id: null, stage: "after_turn", rung: "system_one", verdict: "lesson", p: 0.7,
  reason_code: "jev_choice", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: NOW };
const proposal = (s: RunStore, target: "lesson" | "fact" | "skill" | "schedule" = "lesson", scope = "answer", created_at = NOW) =>
  s.insertImprovementProposal({ decision_id: s.insertDecision(D), target, scope, chat_id: "555", draft_json: JSON.stringify({ scope: "ask", text: "Answer in one line." }), evidence: "correction on 2026-10-21, scope answer", created_at });

describe("improvement_proposals", () => {
  it("inserts open, one open per (target, scope), offered once, transitions fenced on the from states with an optional result", () => {
    const s = RunStore.openInMemory();
    const id = proposal(s);
    expect(id).toMatch(/^pr_/);
    expect(s.proposalBlocks("lesson", "answer", NOW)).toBe(true);
    expect(s.proposalBlocks("fact", "answer", NOW)).toBe(false);
    s.markProposalsOffered([id], NOW);
    s.markProposalsOffered([id], "2026-10-22T10:00:00.000Z");
    expect(s.getImprovementProposal(id)?.offered_at).toBe(NOW);
    expect(s.transitionProposal({ proposal_id: id, from: ["accepted"], to: "reverted", now: NOW })).toBe(false);
    expect(s.transitionProposal({ proposal_id: id, from: ["open"], to: "accepted", now: NOW, result_json: JSON.stringify({ change_id: "lc_1" }) })).toBe(true);
    expect(s.getImprovementProposal(id)).toMatchObject({ state: "accepted", resolved_at: NOW, result_json: JSON.stringify({ change_id: "lc_1" }) });
    expect(s.proposalBlocks("lesson", "answer", "2026-10-07T10:00:00.000Z")).toBe(false); // addendum Rev 2.3.1 A: an applied lesson no longer blocks its category
    expect(s.repeatCandidates("lesson", "answer", "2026-10-07T10:00:00.000Z").map((c) => c.proposal_id)).toEqual([id]); // its text is a repeat candidate instead
    expect(s.listProposalsResolvedSince("2026-10-21T00:00:00.000Z").map((p) => p.proposal_id)).toEqual([id]);
    expect(s.lastAcceptedImprovement("answer")).toEqual({ target: "lesson", at: NOW });
    expect(s.countProposalsByState("2026-10-01T00:00:00.000Z")).toMatchObject({ open: 0, accepted: 1, dismissed: 0, expired: 0, reverted: 0 });
  });
  it("expireProposals expires open rows older than the cut, silently; listOpenProposals is oldest first", () => {
    const s = RunStore.openInMemory();
    const old = proposal(s, "lesson", "answer", "2026-10-01T00:00:00.000Z");
    const fresh = proposal(s, "fact", "answer");
    expect(s.listOpenProposals().map((p) => p.proposal_id)).toEqual([old, fresh]);
    expect(s.expireProposals("2026-10-07T00:00:00.000Z", NOW)).toBe(1);
    expect(s.getImprovementProposal(old)?.state).toBe("expired");
    expect(s.listOpenProposals().map((p) => p.proposal_id)).toEqual([fresh]);
  });
});

describe("improvement_taps and ladder moves", () => {
  it("one tap row per Telegram callback id; a repeat is refused", () => {
    const s = RunStore.openInMemory();
    expect(s.insertImprovementTap({ subject_kind: "proposal", subject_id: "pr_1", action: "acc", telegram_callback_id: "cb1", result: "accepted", created_at: NOW })).toBe(true);
    expect(s.insertImprovementTap({ subject_kind: "proposal", subject_id: "pr_1", action: "acc", telegram_callback_id: "cb1", result: "accepted", created_at: NOW })).toBe(false);
  });
  it("endLadderMove ends an active move once; listLadderMovesCreatedSince reads the window", () => {
    const s = RunStore.openInMemory();
    const id = s.insertLadderMove({ entry_id: "turn.handler", scope: "turn.handler", from_rung: "system_one", to_rung: "model", evidence: ["pr_1"], granted_by: "paco",
      granted_via: "improve.route", paco_callback_id: "cb2", revocable: true, created_at: NOW });
    expect(s.listLadderMovesCreatedSince("2026-10-21T00:00:00.000Z").map((m) => [m.move_id, m.state])).toEqual([[id, "active"]]);
    expect(s.endLadderMove(id, NOW)).toBe(true);
    expect(s.endLadderMove(id, NOW)).toBe(false);
    expect(s.getLadderMove(id)).toMatchObject({ state: "ended", ended_at: NOW });
  });
});
