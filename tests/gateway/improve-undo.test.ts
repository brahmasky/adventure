import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { applyProposal } from "../../src/improve/apply.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { forgetImprovementFact } from "../../src/gateway/improve-undo.js";
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

const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const changeOf = (s: RunStore, proposal_id: string): string => (JSON.parse(s.getImprovementProposal(proposal_id)!.result_json!) as { change_id: string }).change_id;
/** The reply the command queued in the outbox (topic reply), by its key. */
const reply = (s: RunStore, key: string): { text: string; buttons?: unknown[] } | undefined => {
  const r = db(s).prepare("SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?").get(key) as { payload_json: string } | undefined;
  return r ? JSON.parse(r.payload_json) as { text: string; buttons?: unknown[] } : undefined;
};
const FACT = { text: "Paco's sister lives in Lima.", evidence: { line: 1, quote: "sister lives in lima" }, source_turn_ids: [] };

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

// Addendum Rev 2.3.1 B (Paco 2026-11-08, Q2-A): undoing a lesson or fact the improvement check saved reverses its whole change,
// as the card's Undo does — what the save pruned at the cap comes back — in one transaction with the proposal's revert.
describe("undo of an applied proposal reverses the whole change", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("/forget <id> on a lesson saved at the cap: the lesson goes, the lesson its save pruned comes back, the change is undone, the reply counts it", () => {
    const s = RunStore.openInMemory();
    vi.stubEnv("HOUGE_LESSON_CAP_PER_SCOPE", "1");
    const victim = s.addLesson({ scope: "ask", text: "prefer primary sources", source: "user_feedback", created_at: NOW });
    const { proposal_id, id } = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });
    expect(s.getLesson(victim)?.status).toBe("pruned"); // the save made room at the cap
    const e = cmd("forget", String(id));
    expect(new Gateway(s).intake(e)).toMatchObject({ ok: true, status: "forgotten" });
    expect([s.getLesson(id)?.status, s.getLesson(victim)?.status]).toEqual(["pruned", "active"]);
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("reverted");
    expect(s.getLessonChange(changeOf(s, proposal_id))?.undone_at).not.toBeNull();
    expect(reply(s, `${e.idempotency_key}:forget`)?.text).toBe(`Forgotten ✓ — undid lesson #${id}; restored 1 of 1 lesson its save had pruned.`);
  });
  it("/forget <id> whose change cannot be undone falls back to the status flip, still reverts the proposal, and says nothing was restored", () => {
    const s = RunStore.openInMemory();
    vi.stubEnv("HOUGE_LESSON_CAP_PER_SCOPE", "1");
    const victim = s.addLesson({ scope: "ask", text: "prefer primary sources", source: "user_feedback", created_at: NOW });
    const { proposal_id, id } = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });
    db(s).prepare("UPDATE lesson_changes SET undone_at = ? WHERE change_id = ?").run(NOW, changeOf(s, proposal_id)); // tests-only: the change reads already_undone while the lesson is active
    const e = cmd("forget", String(id));
    expect(new Gateway(s).intake(e)).toMatchObject({ ok: true, status: "forgotten" });
    expect([s.getLesson(id)?.status, s.getLesson(victim)?.status]).toEqual(["pruned", "pruned"]);
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("reverted");
    expect(reply(s, `${e.idempotency_key}:forget`)?.text).toBe(`Forgotten ✓ — pruned lesson #${id}; what its save had pruned was not restored (already_undone).`);
  });
  it("/forget <scope>: undoing the newest improvement lesson restores an older one, which is undone with its own proposal; both end reverted and the scope ends empty", () => {
    const s = RunStore.openInMemory();
    vi.stubEnv("HOUGE_LESSON_CAP_PER_SCOPE", "1");
    const plain = s.addLesson({ scope: "ask", text: "prefer primary sources", source: "user_feedback", created_at: NOW });
    const a = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });          // prunes plain at the cap
    const b = applied(s, "lesson", { scope: "ask", text: "Name the source." }, "lookup");    // prunes a at the cap
    expect([plain, a.id, b.id].map((x) => s.getLesson(x)?.status)).toEqual(["pruned", "pruned", "active"]);
    const e = cmd("forget", "ask");
    expect(new Gateway(s).intake(e)).toMatchObject({ ok: true, status: "forgotten" });
    expect([a.proposal_id, b.proposal_id].map((p) => s.getImprovementProposal(p)?.state)).toEqual(["reverted", "reverted"]);
    expect(s.listLessons("ask")).toEqual([]); // "/forget <scope> means the scope ends empty", the restored plain lesson included
    expect([a, b].map((x) => s.getLessonChange(changeOf(s, x.proposal_id))?.undone_at !== null)).toEqual([true, true]); // whole changes, not flips
    expect(reply(s, `${e.idempotency_key}:forget`)?.text).toBe(`Forgotten ✓ — cleared lessons for "ask" (2 learned from your corrections, their changes undone)`);
  });
  it("/forget_memory <id> on a fact saved at the cap undoes the whole change (the pruned fact returns) with a plain reply and no Undo button", () => {
    const s = RunStore.openInMemory();
    vi.stubEnv("HOUGE_EPISODIC_FACT_CAP_PER_CHAT", "1");
    const old = s.addEpisodicFact({ chat_id: "555", fact: "Paco drinks green tea.", created_at: NOW });
    const { proposal_id, id } = applied(s, "fact", FACT);
    expect(s.getEpisodicFact(old)?.status).toBe("pruned");
    const e = cmd("forget_memory", String(id));
    expect(new Gateway(s).intake(e)).toMatchObject({ ok: true, status: "memory_forgotten" });
    expect([s.getEpisodicFact(id)?.status, s.getEpisodicFact(old)?.status]).toEqual(["pruned", "active"]);
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("reverted");
    expect(s.getMemoryChange(changeOf(s, proposal_id))?.undone_at).not.toBeNull();
    const r = reply(s, `${e.idempotency_key}:forget_memory`);
    expect([r?.text, r?.buttons]).toEqual([`Forgotten ✓ — undid memory #${id}; restored 1 of 1 memory its save had pruned.`, undefined]); // undoing an undo is not offered
    expect(reply(s, `${e.idempotency_key}:memory`)).toBeUndefined(); // no change card
  });
  it("/forget_memory whose change cannot be undone falls back to the retire, reverts the proposal and says so — plain, no Undo button", () => {
    const s = RunStore.openInMemory();
    const { proposal_id, id } = applied(s, "fact", FACT);
    db(s).prepare("UPDATE memory_changes SET undone_at = ? WHERE change_id = ?").run(NOW, changeOf(s, proposal_id)); // tests-only: already_undone while the fact is active
    const e = cmd("forget_memory", String(id));
    expect(new Gateway(s).intake(e)).toMatchObject({ ok: true, status: "memory_forgotten" });
    expect(s.getEpisodicFact(id)?.status).toBe("pruned");
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("reverted");
    const r = reply(s, `${e.idempotency_key}:forget_memory`);
    expect([r?.text, r?.buttons]).toEqual([`Forgotten ✓ — retired memory #${id}; what its save had pruned was not restored (already_undone).`, undefined]);
  });
  it("an improvement fact whose proposal names no change still takes the improvement path: retired, proposal reverted, plain reply saying nothing was restored, no Undo card", () => {
    const s = RunStore.openInMemory();
    const { proposal_id, id } = applied(s, "fact", FACT);
    db(s).prepare("UPDATE improvement_proposals SET result_json = json_remove(result_json, '$.change_id') WHERE proposal_id = ?").run(proposal_id); // tests-only: an older or damaged row
    const e = cmd("forget_memory", String(id));
    expect(new Gateway(s).intake(e)).toMatchObject({ ok: true, status: "memory_forgotten" });
    expect([s.getEpisodicFact(id)?.status, s.getImprovementProposal(proposal_id)?.state]).toEqual(["pruned", "reverted"]);
    const r = reply(s, `${e.idempotency_key}:forget_memory`);
    expect([r?.text, r?.buttons]).toEqual([`Forgotten ✓ — retired memory #${id}; what its save had pruned was not restored (not_found).`, undefined]);
    expect(reply(s, `${e.idempotency_key}:memory`)).toBeUndefined();
  });
  it("a partial restore says so: a cap victim that changed since stays as it is — restored 1 of 2", () => {
    const s = RunStore.openInMemory();
    vi.stubEnv("HOUGE_LESSON_CAP_PER_SCOPE", "1");
    const v1 = s.addLesson({ scope: "ask", text: "prefer primary sources", source: "user_feedback", created_at: NOW });
    const v2 = s.addLesson({ scope: "ask", text: "use metric units", source: "user_feedback", created_at: NOW });
    const { id } = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });
    expect([v1, v2].map((x) => s.getLesson(x)?.status)).toEqual(["pruned", "pruned"]); // both made room at the cap
    db(s).prepare("UPDATE lessons SET status = 'superseded' WHERE id = ?").run(v1); // tests-only: v1 moved on since; an undo never touches it
    const e = cmd("forget", String(id));
    expect(new Gateway(s).intake(e)).toMatchObject({ ok: true, status: "forgotten" });
    expect([s.getLesson(v1)?.status, s.getLesson(v2)?.status]).toEqual(["superseded", "active"]);
    expect(reply(s, `${e.idempotency_key}:forget`)?.text).toBe(`Forgotten ✓ — undid lesson #${id}; restored 1 of 2 lessons its save had pruned.`);
  });
  it("R7: another chat's improvement fact is not undone through this path (undoMemoryChangeTx checks no chat): nothing changes", () => {
    const s = RunStore.openInMemory();
    const { proposal_id, id } = applied(s, "fact", FACT);
    expect(s.inTransaction(() => forgetImprovementFact(s, id, "777", NOW))).toBeUndefined();
    expect([s.getEpisodicFact(id)?.status, s.getImprovementProposal(proposal_id)?.state]).toEqual(["active", "accepted"]);
  });
  it("R8: a fact no longer active is today's refusal: the whole command rolls back and the proposal stays accepted", () => {
    const s = RunStore.openInMemory();
    const { proposal_id, id } = applied(s, "fact", FACT);
    db(s).prepare("UPDATE episodic_facts SET status = 'pruned' WHERE id = ?").run(id); // tests-only: pruned by something else since
    const e = cmd("forget_memory", String(id));
    expect(new Gateway(s).intake(e).ok).toBe(false);
    expect(s.getImprovementProposal(proposal_id)?.state).toBe("accepted");
    expect(reply(s, `${e.idempotency_key}:forget_memory_refused`)?.text).toBe(`No active memory #${id} here. /memories lists them.`);
  });
  it("/forget <scope> tolerates a lesson listed twice by the join (two accepted proposals name it): handled once, no error", () => {
    const s = RunStore.openInMemory();
    const a = applied(s, "lesson", { scope: "ask", text: "Answer in one line." });
    const dup = s.insertImprovementProposal({ decision_id: s.getImprovementProposal(a.proposal_id)!.decision_id, target: "lesson", scope: "answer", chat_id: "555", draft_json: "{}", evidence: "e", created_at: NOW });
    s.transitionProposal({ proposal_id: dup, from: ["open"], to: "accepted", now: NOW, result_json: JSON.stringify({ lesson_id: a.id }) });
    expect(new Gateway(s).intake(cmd("forget", "ask"))).toMatchObject({ ok: true, status: "forgotten" });
    expect(s.listLessons("ask")).toEqual([]);
  });
});
