import { describe, expect, it } from "vitest";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Spec 2b-ii §5.1–5.2, §5.6: proposals have one open row per (target, scope) and expire at 14 days; a job's transitions are
// fenced on state and attempt (the race winner's ending is the only one that writes); taps are one row per Telegram callback
// id; a ladder move ends on Revoke. Every transition leaves an improvement_job ledger event (gate case 9).
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
    expect(s.proposalBlocks("lesson", "answer", NOW)).toBe(false);
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

describe("improvement_jobs", () => {
  const origin = JSON.stringify({ turn_ids: ["turn_1", "turn_2", "turn_3"], run_ids: ["run_1", "run_2", "run_3"], category: "answer", text_hashes: ["a", "b", "c"] });
  it("insert is unique on the idempotency key; overlap finds a job sharing any turn id younger than the cut", () => {
    const s = RunStore.openInMemory();
    const id = s.insertImprovementJob({ decision_id: s.insertDecision(D), proposal_id: null, chat_id: "555", origin_json: origin, idempotency_key: "answer:turn_1", created_at: NOW });
    expect(id).toMatch(/^job_/);
    expect(s.insertImprovementJob({ decision_id: s.insertDecision(D), proposal_id: null, chat_id: "555", origin_json: origin, idempotency_key: "answer:turn_1" })).toBeNull();
    expect(s.jobOverlapsTurns(["turn_9", "turn_2"], "2026-09-21T00:00:00.000Z")).toBe(true);
    expect(s.jobOverlapsTurns(["turn_9"], "2026-09-21T00:00:00.000Z")).toBe(false);
    expect(s.jobOverlapsTurns(["turn_2"], "2026-10-22T00:00:00.000Z")).toBe(false);
    expect(s.countJobsCreatedSince("2026-10-21T00:00:00.000Z")).toBe(1);
  });
  it("transitions are fenced on state and attempt, stamp started/finished/resolved, and each writes an improvement_job event", () => {
    const s = RunStore.openInMemory();
    const id = s.insertImprovementJob({ decision_id: s.insertDecision(D), proposal_id: null, chat_id: "555", origin_json: origin, idempotency_key: "k", created_at: NOW })!;
    expect(s.transitionJob({ job_id: id, from: ["queued"], to: "running", now: NOW, bumpAttempt: true })).toBe(true);
    expect(s.getImprovementJob(id)).toMatchObject({ state: "running", attempt: 1, started_at: NOW });
    // the timeout ending lost the race to a committed success: the fence on attempt 1 + state running admits only one writer
    expect(s.transitionJob({ job_id: id, from: ["running"], to: "pending_review", now: NOW, attempt: 1, patch: { pending_scope: "ask", pending_name: "weekly-report" } })).toBe(true);
    expect(s.transitionJob({ job_id: id, from: ["running"], to: "failed", now: NOW, attempt: 1, patch: { result_code: "timeout" } })).toBe(false);
    expect(s.getImprovementJob(id)).toMatchObject({ state: "pending_review", finished_at: NOW, pending_scope: "ask", pending_name: "weekly-report", result_code: null });
    expect(s.transitionJob({ job_id: id, from: ["pending_review"], to: "promoting", now: NOW, patch: { promote_mode: "refuse" } })).toBe(true);
    expect(s.transitionJob({ job_id: id, from: ["promoting"], to: "collision", now: NOW })).toBe(true);
    s.markJobsOffered([id], NOW);
    expect(s.getImprovementJob(id)?.offered_at).toBe(NOW);
    expect(s.transitionJob({ job_id: id, from: ["collision"], to: "promoting", now: NOW, patch: { promote_mode: "replace" } })).toBe(true);
    expect(s.getImprovementJob(id)?.offered_at).toBeNull(); // §5.2: offered_at reset when the card changes
    expect(s.transitionJob({ job_id: id, from: ["promoting"], to: "promoted", now: NOW })).toBe(true);
    expect(s.getImprovementJob(id)?.resolved_at).toBe(NOW);
    const events = s.listLedgerEventsByTypeSince("improvement_job", "2026-01-01T00:00:00.000Z").map((e) => e.payload);
    expect(events.map((p) => `${p.from}>${p.to}`)).toEqual(["queued>running", "running>pending_review", "pending_review>promoting", "promoting>collision", "collision>promoting", "promoting>promoted"]);
    expect(events[0]).toMatchObject({ job_id: id, attempt: 1 });
    expect(s.listJobsByState(["promoted"]).map((j) => j.job_id)).toEqual([id]);
    expect(s.listJobsFinishedSince("2026-10-21T00:00:00.000Z").map((j) => j.job_id)).toEqual([id]);
    expect(s.lastAcceptedImprovement("answer")).toEqual({ target: "skill", at: NOW }); // a promoted job counts as the scope's newest improvement
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
