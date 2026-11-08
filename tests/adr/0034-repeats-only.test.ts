/**
 * Rule: ADR 0034 rule 10.5 as amended by the auto-apply addendum Rev 2.3.1 (Paco 2026-11-08, Q1-B): for a lesson or fact the
 * 14-day block covers repeats, not the category — only `open`, `dismissed` and `expired` block the pair; a draft whose
 * text embeds at or above LESSON_REPEAT_COSINE against one Paco reverted within 14 days is `already_proposed`, against a
 * lesson accepted within LESSON_REWRITE_DAYS the 'lesson did not hold' card (ruling R1'), against an accepted fact `already_proposed`. Skill, schedule, tool gap and ladder keep the accepted/reverted block. Changing this rule changes this test.
 */
import { describe, expect, it } from "vitest";
import { LESSON_REPEAT_COSINE } from "../../src/improve/repeat.js";
import { PROPOSAL_TTL_DAYS } from "../../src/improve/proposals.js";
import { RunStore, type DecisionInsert, type ProposalTarget } from "../../src/run/run-store.js";

const NOW = "2026-10-21T10:00:00.000Z";
const SINCE = "2026-10-07T10:00:00.000Z";
const D: DecisionInsert = { entry_id: "improve.route", entry_version: 1, run_id: null, tool_call_id: null, stage: "after_turn", rung: "system_one", verdict: "lesson", p: 0.7, reason_code: "jev_choice",
  fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: NOW };
const accepted = (s: RunStore, target: ProposalTarget): void => {
  const id = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target, scope: "answer", chat_id: "555", draft_json: JSON.stringify({ text: "Answer in one line." }), evidence: "e", created_at: NOW });
  s.transitionProposal({ proposal_id: id, from: ["open"], to: "accepted", now: NOW });
};

describe("ADR 0034 rule 10.5: block only repeats", () => {
  it("pins the repeat threshold and the 14-day window", () => {
    expect(LESSON_REPEAT_COSINE).toBe(0.6); // controller ruling 2026-11-08 from the threshold probe (plan 2026-11-08 Task 2 Step 1)
    expect(PROPOSAL_TTL_DAYS).toBe(14);
  });
  it("an applied lesson or fact leaves its pair open (a repeat candidate instead); every other target stays blocked", () => {
    for (const target of ["lesson", "fact", "skill", "schedule", "tool_gap", "ladder"] as const) {
      const s = RunStore.openInMemory();
      accepted(s, target);
      expect([target, s.proposalBlocks(target, "answer", SINCE)]).toEqual([target, target !== "lesson" && target !== "fact"]);
    }
  });
});
