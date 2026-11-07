import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyProposal, appliedLine, APPLIED_EXCERPT_CHARS } from "../../src/improve/apply.js";
import { proposalCardButtons, proposalCardText, queueProposalCard } from "../../src/improve/proposal-card.js";
import { parseImprovementCallback } from "../../src/triggers/telegram-command-parser.js";
import { RunStore, type DecisionInsert, type ProposalTarget } from "../../src/run/run-store.js";
import { createTelegramTurn } from "../helpers/runs.js";

// Spec 2026-11-07 §5: inside the group's transaction an applied proposal is the memory lane's own save, `accepted` with the
// ids, and one /changes row naming the undo command; a capped lesson applies nothing (its card follows); the card of every
// other proposal is keyed by proposal with Accept/Dismiss and starts the 14-day tap window (offered_at).
const NOW = "2026-10-21T10:00:00.000Z";
const D: DecisionInsert = { entry_id: "improve.route", entry_version: 1, run_id: null, tool_call_id: null, stage: "after_turn", rung: "system_one", verdict: "lesson", p: 0.7, reason_code: "jev_choice",
  fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: NOW };
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const logRow = (s: RunStore, key: string) => db(s).prepare("SELECT topic, text FROM change_log WHERE idempotency_key = ?").get(key) as { topic: string; text: string } | undefined;
const outboxRows = (s: RunStore, key: string) => (db(s).prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE idempotency_key = ?").get(key) as { n: number }).n;
function open(s: RunStore, target: ProposalTarget, draft: unknown) {
  const run_id = createTelegramTurn(s, "please always answer in one line").run_id;
  const proposal_id = s.insertImprovementProposal({ decision_id: s.insertDecision({ ...D, run_id }), target, scope: "answer", chat_id: "555", draft_json: JSON.stringify(draft), evidence: "correction on 2026-10-21, scope answer", created_at: NOW });
  return { proposal_id, run_id, draft_json: JSON.stringify(draft) };
}

describe("applyProposal", () => {
  it("saves the lesson with source improve under the about run, marks the proposal accepted with the ids, and writes the /changes row with /forget <id>", () => {
    const s = RunStore.openInMemory();
    const p = open(s, "lesson", { scope: "ask", text: "Answer in one line.", avoid: "long stories" });
    const r = s.inTransaction(() => applyProposal(s, { ...p, target: "lesson", chat_id: "555", now: NOW }));
    expect(r).toMatchObject({ change_id: expect.stringMatching(/^lc_/), lesson_id: expect.any(Number) });
    const id = (r as { lesson_id: number }).lesson_id;
    expect(s.getLesson(id)).toMatchObject({ source: "improve", status: "active", scope: "ask" });
    expect(s.getLessonChange((r as { change_id: string }).change_id)).toMatchObject({ run_id: p.run_id, chat_id: "555", new_id: id });
    expect(s.getImprovementProposal(p.proposal_id)).toMatchObject({ state: "accepted", result_json: JSON.stringify(r) });
    expect(logRow(s, `improve_applied:${p.proposal_id}`)).toEqual({ topic: "improve_log", text: `📒 Lesson #${id} learned from your correction (ask): Answer in one line. — undo: /forget ${id}` });
    expect(outboxRows(s, `improve_applied:${p.proposal_id}`)).toBe(0); // improve_log routes to the change log, never to chat
    expect(outboxRows(s, `improve_proposal:${p.proposal_id}`)).toBe(0); // no card for an applied proposal
  });
  it("a fact: the /changes row names /forget_memory <id>; the excerpt is 60 code points after redaction", () => {
    const s = RunStore.openInMemory();
    const long = "我".repeat(70);
    const p = open(s, "fact", { text: long, evidence: { line: 1, quote: "x" }, source_turn_ids: [] });
    const r = s.inTransaction(() => applyProposal(s, { ...p, target: "fact", chat_id: "555", now: NOW }));
    expect(r).toMatchObject({ change_id: expect.stringMatching(/^mc_/), fact_id: expect.any(Number) });
    const id = (r as { fact_id: number }).fact_id;
    expect(logRow(s, `improve_applied:${p.proposal_id}`)?.text).toBe(`🧠 Fact #${id} learned from your correction: ${"我".repeat(APPLIED_EXCERPT_CHARS)} — undo: /forget_memory ${id}`);
    const secret = "token=Zx9Qw7Lm3Kp5Vb2Nc8Rt4Yh6Jd1Fs0G";
    expect(appliedLine(s, "fact", { change_id: "mc_x", fact_id: 7 }, { text: `my ${secret} is old` })).not.toContain("Zx9Qw7Lm3Kp5Vb2Nc8Rt4Yh6Jd1Fs0G");
  });
  it("a capped lesson applies nothing: null, the proposal stays open, no row, no change (the caller queues the card)", () => {
    const s = RunStore.openInMemory();
    const p = open(s, "lesson", { scope: "ask", text: "x".repeat(300) });
    expect(s.inTransaction(() => applyProposal(s, { ...p, target: "lesson", chat_id: "555", now: NOW }))).toBeNull();
    expect(s.getImprovementProposal(p.proposal_id)?.state).toBe("open");
    expect(logRow(s, `improve_applied:${p.proposal_id}`)).toBeUndefined();
    expect(s.listLessons("ask")).toHaveLength(0);
  });
  it("a proposal no longer open throws apply_lost (the save must not outlive a lost transition)", () => {
    const s = RunStore.openInMemory();
    const p = open(s, "lesson", { scope: "ask", text: "Answer in one line." });
    s.transitionProposal({ proposal_id: p.proposal_id, from: ["open"], to: "dismissed", now: NOW });
    expect(() => s.inTransaction(() => applyProposal(s, { ...p, target: "lesson", chat_id: "555", now: NOW }))).toThrow("apply_lost");
    expect(s.listLessons("ask")).toHaveLength(0); // rolled back with the transaction
  });
});

describe("queueProposalCard", () => {
  it("one improve_card outbox row keyed by proposal with Accept/Dismiss that parse back, and offered_at set; a second call is a duplicate, not a second card", () => {
    const s = RunStore.openInMemory();
    const p = open(s, "schedule", { schedule_id: "sch_1", hour_from: 11, hour_to: 20, before: {}, after: {} });
    const card = { proposal_id: p.proposal_id, target: "schedule" as const, draft_json: p.draft_json, evidence: "2 approval_expired on shell_external in 14 days" };
    s.inTransaction(() => queueProposalCard(s, card, "555", NOW));
    s.inTransaction(() => queueProposalCard(s, card, "555", NOW));
    expect(outboxRows(s, `improve_proposal:${p.proposal_id}`)).toBe(1); // improve_card is a chat topic: an outbox row, no change_log row
    expect(logRow(s, `improve_proposal:${p.proposal_id}`)).toBeUndefined();
    expect(s.getImprovementProposal(p.proposal_id)?.offered_at).toBe(NOW);
    const note = s.claimNextNotification("t", 30)!;
    expect(note.idempotency_key).toBe(`improve_proposal:${p.proposal_id}`);
    expect(note.target).toEqual({ kind: "telegram", chat_id: "555" });
    expect(note.payload.text).toBe(proposalCardText(s, card));
    expect(String(note.payload.text)).toContain("move sch_1 to 20:00");
    const buttons = proposalCardButtons(p.proposal_id);
    expect(note.payload.buttons).toEqual(buttons);
    expect(buttons.map((b) => parseImprovementCallback(b.data))).toEqual([{ kind: "pr", id: p.proposal_id, action: "acc" }, { kind: "pr", id: p.proposal_id, action: "dis" }]);
  });
  it("a lesson card shows the redacted text and its AVOID, clipped at 120 code points", () => {
    const s = RunStore.openInMemory();
    const text = proposalCardText(s, { proposal_id: "pr_x", target: "lesson", draft_json: JSON.stringify({ scope: "ask", text: "abcd ".repeat(30), avoid: "long stories" }), evidence: "e" });
    expect(text).toBe(`📒 Lesson proposal · ${"abcd ".repeat(30).trim().slice(0, 120)} · AVOID: long stories · e`);
  });
});
