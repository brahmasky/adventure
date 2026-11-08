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

describe("proposalBlocks — already_known", () => {
  const dismissOpen = (s: RunStore, result_json?: string): void => {
    const id = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "fact", scope: "answer", chat_id: "555", draft_json: "{}", evidence: "e", created_at: "2026-10-20T00:00:00.000Z" });
    s.transitionProposal({ proposal_id: id, from: ["open"], to: "dismissed", now: "2026-10-20T01:00:00.000Z", ...(result_json ? { result_json } : {}) });
  };
  it("an already_known dismissal does not block its pair (a repeated known fact must not stop new facts for 14 days); a Paco-dismissed one still does", () => {
    const s = RunStore.openInMemory();
    dismissOpen(s, JSON.stringify({ reason: "already_known" }));
    expect(s.proposalBlocks("fact", "answer", SINCE)).toBe(false);
    const s2 = RunStore.openInMemory();
    dismissOpen(s2);
    expect(s2.proposalBlocks("fact", "answer", SINCE)).toBe(true);
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

// Addendum Rev 2.3.1 A: the repeat check compares a new draft with the text of every lesson or fact Houge applied (accepted) or
// Paco undid (reverted) on the same pair within 14 days — read from draft_json, so it works after the saved row is gone.
describe("repeatCandidates", () => {
  const withText = (s: RunStore, target: "lesson" | "fact", scope: string, text: string, state: "accepted" | "reverted" | "dismissed", resolved_at: string): string => {
    const id = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target, scope, chat_id: "555", draft_json: JSON.stringify({ scope: "ask", text }), evidence: "e", created_at: "2026-09-01T00:00:00.000Z" });
    s.transitionProposal({ proposal_id: id, from: ["open"], to: state === "dismissed" ? "dismissed" : "accepted", now: resolved_at });
    if (state === "reverted") s.transitionProposal({ proposal_id: id, from: ["accepted"], to: "reverted", now: resolved_at });
    return id;
  };
  it("lists accepted and reverted proposals of the pair resolved inside the window with their draft text and state, ordered by id; nothing else", () => {
    const s = RunStore.openInMemory();
    const a = withText(s, "lesson", "answer", "Answer in one line.", "accepted", "2026-10-20T00:00:00.000Z");
    const r = withText(s, "lesson", "answer", "Name the source.", "reverted", "2026-10-15T00:00:00.000Z");
    withText(s, "lesson", "answer", "Too old.", "accepted", SINCE);                           // resolved exactly at the cut: outside (strict >)
    withText(s, "lesson", "answer", "Paco said no.", "dismissed", "2026-10-20T00:00:00.000Z"); // dismissed is proposalBlocks' business, not a repeat
    withText(s, "lesson", "lookup", "Other scope.", "accepted", "2026-10-20T00:00:00.000Z");
    withText(s, "fact", "answer", "Other target.", "accepted", "2026-10-20T00:00:00.000Z");
    expect(s.repeatCandidates("lesson", "answer", SINCE)).toEqual([a, r].sort().map((id) => id === a
      ? { proposal_id: a, text: "Answer in one line.", state: "accepted", resolved_at: "2026-10-20T00:00:00.000Z" }
      : { proposal_id: r, text: "Name the source.", state: "reverted", resolved_at: "2026-10-15T00:00:00.000Z" }));
    expect(s.repeatCandidates("fact", "answer", SINCE).map((c) => c.text)).toEqual(["Other target."]);
  });
  it("R1': an accepted lesson stays a candidate over the longer rewrite window (30 d); a reverted one only over 14 d", () => {
    const s = RunStore.openInMemory();
    const old = withText(s, "lesson", "answer", "Answer in one line.", "accepted", "2026-10-01T00:00:00.000Z");   // 20 days before NOW
    withText(s, "lesson", "answer", "Name the source.", "reverted", "2026-10-01T00:00:00.000Z");                   // 20 days: past the 14-day window
    const THIRTY = "2026-09-21T10:00:00.000Z";
    expect(s.repeatCandidates("lesson", "answer", SINCE, THIRTY).map((c) => [c.proposal_id, c.state])).toEqual([[old, "accepted"]]);
    expect(s.repeatCandidates("lesson", "answer", SINCE)).toEqual([]); // the default accepted window is the 14-day one
  });
  it("still lists a reverted proposal after its lesson row was pruned (the text lives on the proposal)", () => {
    const s = RunStore.openInMemory();
    const id = withText(s, "lesson", "answer", "Answer in one line.", "reverted", "2026-10-20T00:00:00.000Z");
    expect(s.repeatCandidates("lesson", "answer", SINCE)).toEqual([{ proposal_id: id, text: "Answer in one line.", state: "reverted", resolved_at: "2026-10-20T00:00:00.000Z" }]);
  });
});

// Addendum Rev 2.3.1 B: /forget <scope> undoes each improvement-saved lesson newest first; this is the list it walks.
describe("improvementLessonsInScope", () => {
  it("names active lessons of the lesson scope with an accepted lesson proposal, newest first; pruned, plain and reverted ones are not listed", () => {
    const s = RunStore.openInMemory();
    const save = (text: string, state: "accepted" | "reverted"): { lesson_id: number; proposal_id: string } => {
      const lesson_id = s.addLesson({ scope: "ask", text, source: "improve", created_at: NOW });
      const proposal_id = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "lesson", scope: "answer", chat_id: "555", draft_json: JSON.stringify({ scope: "ask", text }), evidence: "e", created_at: NOW });
      s.transitionProposal({ proposal_id, from: ["open"], to: "accepted", now: NOW, result_json: JSON.stringify({ change_id: `lc_${text}`, lesson_id }) });
      if (state === "reverted") s.transitionProposal({ proposal_id, from: ["accepted"], to: "reverted", now: NOW });
      return { lesson_id, proposal_id };
    };
    const older = save("Answer in one line.", "accepted");
    const newer = save("Name the source.", "accepted");
    save("Undone already.", "reverted");
    const gone = save("Pruned since.", "accepted"); s.forgetLesson(gone.lesson_id);
    s.addLesson({ scope: "ask", text: "plain rule", source: "user_feedback", created_at: NOW });
    s.addLesson({ scope: "research", text: "other scope", source: "improve", created_at: NOW });
    expect(s.improvementLessonsInScope("ask")).toEqual([newer, older]);
    expect(s.improvementLessonsInScope("research")).toEqual([]);
  });
});
