import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FACT_RECONCILE_DISCIPLINE } from "../../src/capabilities/episodic-extract.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { MEMORY_INSTRUCTION_CHARS } from "../../src/core/core-worker.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { drainOutbox, ompWorker } from "../helpers/omp-worker.js";
import { choiceAns } from "../helpers/jev-tree-answers.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Spec §4-§7, §12: the explicit save writes what Paco asked for from his own turns — the incident's "记下来吧" after an
// opinion saves the opinion as a fact, with an Undo row, its event and a trigger row, in ONE transaction with the lesson
// side; a steered message is the instruction; a schedule goal is never content; one save per turn across kinds.
// Synthetic texts only (the repo is public).
const CHAT = "555";
const OPINION = "I think the south side noodle shop is better than the north one";
type Seat = { distill: string; fact?: string; lesson?: string };
function seat(s: Seat, seen: Array<{ system: string; question: string }> = []) {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const system = String(input.system ?? ""); seen.push({ system, question: String(input.question ?? "") });
    const answer = /durable/i.test(system) ? s.distill : system === FACT_RECONCILE_DISCIPLINE ? s.fact ?? '{"verdict":"ADD"}' : s.lesson ?? '{"verdict":"ADD","theme":"format"}';
    return { ok: true, output: { answer } };
  };
}
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
/** `s` may read the store first (a test that needs a stored fact's id in the reconcile answer). */
function setup(s: Seat | ((store: RunStore) => Seat), o: { embed?: (t: string) => Promise<Float32Array | null> } = {}) {
  const store = RunStore.openInMemory();
  const seen: Array<{ system: string; question: string }> = [];
  const script = typeof s === "function" ? s(store) : s;
  const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hmw-")), { llm: seat(script, seen), ...(o.embed ? { embed: o.embed } : {}) });
  const earlier = createQueuedTurnRun(store, OPINION);
  store.recordChatTurn({ chat_id: CHAT, run_id: earlier, role: "user", text: OPINION, created_at: later(-60_000) });
  store.recordChatTurn({ chat_id: CHAT, run_id: earlier, role: "assistant", text: "Want me to remember that?", created_at: later(-59_000) });
  return { store, worker, seen, earlierTurn: store.getRecentChatTurns(CHAT, 5).find((t) => t.role === "user")!.turn_id };
}
const FACT = JSON.stringify({ kind: "fact", fact: "Paco prefers the south side noodle shop", evidence: { line: 1, quote: "south side noodle shop is better" } });
const out = (r: ToolAdapterResult) => (r.ok ? r.output : {}) as Record<string, unknown>;

describe("runMemoryWrite: the incident shape", () => {
  it("'记下来吧' after an opinion saves the opinion as a fact, with its Undo row, fact_saved, a trigger row and the memory.kind row", async () => {
    const h = setup({ distill: FACT }, { embed: async () => new Float32Array([0.1, 0.2]) });
    const run_id = createQueuedTurnRun(h.store, "记下来吧");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    const w = await h.worker.runMemoryWrite(claim, CHAT, { scope: "ask" }, { source: "loop" });
    expect(out(w.result)).toMatchObject({ saved: true, kinds: ["fact"] });
    const fact = h.store.getEpisodicFact(w.saved!.fact!.id)!;
    expect([fact.status, fact.fact, fact.is_core, fact.embedding !== null]).toEqual(["active", "Paco prefers the south side noodle shop", 0, true]);
    expect(JSON.parse(fact.source_turn_ids)).toEqual([h.earlierTurn]);
    expect(h.store.getMemoryChangeByRun(run_id)).toMatchObject({ action: "add", old_ids: [], new_id: fact.id, change_id: w.saved!.fact!.change_id });
    expect(h.store.getLedgerEvents(run_id).filter((e) => e.event_type === "fact_saved").map((e) => e.payload))
      .toEqual([{ fact_id: fact.id, verb: "add", change_id: w.saved!.fact!.change_id }]);
    expect(h.store.memorySaveTriggered(run_id)).toBe(true);
    expect(h.store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "memory.kind").map((d) => [d.rung, d.verdict])).toEqual([["model", "fact"]]);
    expect(h.store.getLedgerEvents(run_id).some((e) => e.event_type === "lesson_saved")).toBe(false);
    h.store.close();
  });
  it("a SUPERSEDE keeps the replaced fact in the Undo row, so Undo restores it", async () => {
    let old = 0;
    const h = setup((store) => {
      old = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco prefers the north side noodle shop", created_at: later(-90_000) });
      return { distill: FACT, fact: JSON.stringify({ verdict: "SUPERSEDE", id: old }) };
    });
    const run_id = createQueuedTurnRun(h.store, "记下来吧");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    expect(h.store.getMemoryChangeByRun(run_id)?.old_ids).toEqual([old]);
    expect(h.store.undoMemoryChange(w.saved!.fact!.change_id)).toMatchObject({ status: "undone", restored: [old] });
    h.store.close();
  });
});

describe("runMemoryWrite: one transaction, one save per turn", () => {
  const BOTH = JSON.stringify({ kind: "both", lesson: "Suggest only vegetarian recipes", fact: "Paco is vegetarian", evidence: { line: 2, quote: "I am vegetarian" } });
  it("both sides, the triggers, the events and inTx commit together; a throwing inTx leaves none of them and no guard", async () => {
    const h = setup({ distill: BOTH });
    const run_id = createQueuedTurnRun(h.store, "Remember that I am vegetarian, and only suggest vegetarian recipes from now on");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    const failed = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "lane", inTx: () => { throw new Error("boom"); } });
    expect(out(failed.result)).toMatchObject({ saved: false, reason: "save_failed" });
    expect([h.store.getActiveLessons("ask").length, h.store.getActiveEpisodicFacts(CHAT).length, h.store.memorySaveTriggered(run_id)]).toEqual([0, 0, false]);
    expect(h.store.getLedgerEvents(run_id).filter((e) => e.event_type === "lesson_saved" || e.event_type === "fact_saved")).toEqual([]);
    expect(h.store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "memory.kind")).toHaveLength(1); // written once, after the rollback
    const seenInTx: string[] = [];
    const ok = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "lane", inTx: (s) => { seenInTx.push(Object.keys(s).sort().join(",")); } });
    expect(out(ok.result)).toMatchObject({ saved: true, kinds: ["rule", "fact"] });
    expect(seenInTx).toEqual(["fact,lesson"]);
    expect(h.store.getLedgerEvents(run_id).filter((e) => e.event_type === "lesson_saved" || e.event_type === "fact_saved")).toHaveLength(2);
    h.store.close();
  });
  it("after a fact save, a second lesson_write in the turn gets already_saved_this_turn and spends no LLM call", async () => {
    const h = setup({ distill: FACT });
    const run_id = createQueuedTurnRun(h.store, "记下来吧");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    const first = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "lane" });
    const calls = h.seen.length;
    const again = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    expect(out(again.result)).toMatchObject({ saved: false, reason: "already_saved_this_turn", fact_id: first.saved!.fact!.id });
    expect(h.seen).toHaveLength(calls);
    h.store.close();
  });
});

describe("runMemoryWrite: whose words", () => {
  it("a steered message is the instruction; the parent's objective is thread content; both runs are triggers", async () => {
    const steered = JSON.stringify({ kind: "fact", fact: "Paco travels to Melbourne next Wednesday", evidence: { line: 3, quote: "next Wednesday" } });
    const h = setup({ distill: steered });
    const parent = createQueuedTurnRun(h.store, "compare three NAS boxes for home use");
    const claim = h.store.claimRun(parent, "planner:555:x", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    h.store.recordChatTurn({ chat_id: CHAT, run_id: parent, role: "user", text: "compare three NAS boxes for home use", created_at: later(5) });
    const child = createQueuedTurnRun(h.store, "remember: I fly to Melbourne next Wednesday");
    h.store.claimRun(child, "planner:555:x", 120);
    h.store.recordChatTurn({ chat_id: CHAT, run_id: child, role: "user", text: "remember: I fly to Melbourne next Wednesday", created_at: later(10) });
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    const q = h.seen.find((c) => /durable/i.test(c.system))!.question;
    expect(q).toContain("PACO'S INSTRUCTION:\n[3] remember: I fly to Melbourne next Wednesday");
    expect(q).toContain("[2] compare three NAS boxes for home use");
    expect(q).toContain(`[1] ${OPINION}`);
    expect(out(w.result)).toMatchObject({ saved: true, kinds: ["fact"] });
    expect([h.store.memorySaveTriggered(parent), h.store.memorySaveTriggered(child)]).toEqual([true, true]);
    h.store.close();
  });
  it("a newest steer wins over an earlier one; a user turn from a run leased to another worker is never taken (Rev 2 item 4)", async () => {
    const h = setup({ distill: '{"kind":"none"}' });
    const parent = createQueuedTurnRun(h.store, "compare three NAS boxes");
    const claim = h.store.claimRun(parent, "planner:555:p", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    for (const [k, text, worker] of [[10, "first steer", "planner:555:p"], [20, "second steer", "planner:555:p"], [30, "another worker's message", "planner:555:other"]] as const) {
      const r = createQueuedTurnRun(h.store, text);
      h.store.claimRun(r, worker, 120);
      h.store.recordChatTurn({ chat_id: CHAT, run_id: r, role: "user", text, created_at: later(k) });
    }
    await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    const q = h.seen.find((c) => /durable/i.test(c.system))!.question;
    expect(q).toMatch(/PACO'S INSTRUCTION:\n\[\d+\] second steer/);
    expect(q).toContain("first steer");
    expect(q).not.toContain("another worker's message");
    h.store.close();
  });
  it("a cli run's user turn in the same chat is not Paco's thread (Rev 2 item 3)", async () => {
    const h = setup({ distill: '{"kind":"none"}' });
    const cli = new Gateway(h.store).intake(buildTypedTaskEvent({ source: "cli", type: "run", program: "research-brief", goal: "a cli brief about ASML",
      requested_by: { kind: "user", id: "paco" }, notify: { kind: "local" }, idempotency_key: "cli:1", source_reference: "argv" }));
    if (!cli.ok) throw new Error("intake failed");
    h.store.recordChatTurn({ chat_id: CHAT, run_id: cli.run_id, role: "user", text: "a cli brief about ASML", created_at: later(-30_000) });
    const run_id = createQueuedTurnRun(h.store, "记下来");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    expect(h.seen.find((c) => /durable/i.test(c.system))!.question).not.toContain("ASML");
    expect(h.store.getLedgerEvents(run_id).filter((e) => e.event_type === "memory_not_saved").map((e) => e.payload))
      .toEqual([{ reason: "nothing_to_save", source: "loop" }]); // Rev 2 item 9: the refusal is ledgered, ids-only
    h.store.close();
  });
  it("a schedule-born turn is neither instruction nor thread", async () => {
    const h = setup({ distill: '{"kind":"none"}' });
    const sched = new Gateway(h.store).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "daily brief: always include ASML",
      requested_by: { kind: "schedule", id: "sch_t" }, notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: "sched:1", source_reference: "scheduled_tasks.sch_t" }));
    if (!sched.ok) throw new Error("intake failed");
    h.store.recordChatTurn({ chat_id: CHAT, run_id: sched.run_id, role: "user", text: "daily brief: always include ASML", created_at: later(-30_000) });
    const run_id = createQueuedTurnRun(h.store, "记下来");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    expect(h.seen.find((c) => /durable/i.test(c.system))!.question).not.toContain("ASML");
    h.store.close();
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** A turn born from a Telegram reply to Paco's message `replyTo` (the adapter puts reply_to_message_id in the metadata). */
function quotingRun(store: RunStore, text: string, replyTo: number): string {
  const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `q:${replyTo}:${text}`, source_reference: `telegram:update:9:message:${replyTo + 1}`,
    metadata: { telegram_update_id: 9, telegram_message_id: replyTo + 1, reply_to_message_id: replyTo } }));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}
const distillQuestion = (seen: Array<{ system: string; question: string }>): string => seen.find((c) => /durable/i.test(c.system))!.question;
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe("runMemoryWrite: the sources the worker hands memory-sources (Task 3 carry: the module trusts its inputs)", () => {
  // A quoted message is the thread's first line; listed again from `recent` it would take a second of the four slots.
  it("a quoted message of Paco's appears once in the thread, first", async () => {
    const h = setup({ distill: '{"kind":"none"}' });
    const run_id = quotingRun(h.store, "记下来", 1); // the setup's earlier turn is telegram message 1
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    const q = distillQuestion(h.seen);
    expect(q).toContain(`[1] ${OPINION}`);
    expect(count(q, OPINION)).toBe(1);
    h.store.close();
  });
  // The turn's own message is the instruction: when it was stored before the claim it is in the recent window too, and
  // listing it as thread content as well would let the distill cite the instruction as an "earlier" message.
  it("the turn's own stored message is the instruction only, never also a thread line", async () => {
    const h = setup({ distill: '{"kind":"none"}' });
    const own = "remember the south side place, please";
    const run_id = createQueuedTurnRun(h.store, own);
    h.store.recordChatTurn({ chat_id: CHAT, run_id, role: "user", text: own, created_at: later(-1_000) });
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    const q = distillQuestion(h.seen);
    expect(count(q, own)).toBe(1);
    expect(q).toContain(`PACO'S INSTRUCTION:\n[2] ${own}`);
    h.store.close();
  });
  // A pasted wall of text is not an instruction the distill can be handed whole: the prompt stays bounded.
  it("the instruction is cut to MEMORY_INSTRUCTION_CHARS", async () => {
    const h = setup({ distill: '{"kind":"none"}' });
    const run_id = createQueuedTurnRun(h.store, `remember ${"x".repeat(6000)}`);
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    const instruction = distillQuestion(h.seen).split("PACO'S INSTRUCTION:\n")[1]!.split("\n")[0]!;
    expect(instruction.length).toBeLessThanOrEqual(MEMORY_INSTRUCTION_CHARS + 4); // "[n] " prefix
    expect(instruction.length).toBeGreaterThan(MEMORY_INSTRUCTION_CHARS / 2);
    h.store.close();
  });
  // An event-born turn (a webhook, a watcher) in the chat is not Paco speaking either.
  it("an event run's user turn in the same chat is not Paco's thread", async () => {
    const h = setup({ distill: '{"kind":"none"}' });
    const ev = new Gateway(h.store).intake(buildTypedTaskEvent({ source: "event", type: "turn", program: "turn", goal: "event says: always include ASML",
      requested_by: { kind: "system", id: "watcher" }, notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: "ev:1", source_reference: "event:1" }));
    if (!ev.ok) throw new Error("intake failed");
    h.store.recordChatTurn({ chat_id: CHAT, run_id: ev.run_id, role: "user", text: "event says: always include ASML", created_at: later(-30_000) });
    const run_id = createQueuedTurnRun(h.store, "记下来");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" });
    expect(distillQuestion(h.seen)).not.toContain("ASML");
    h.store.close();
  });
});

describe("runMemoryWrite: a fact is a save like a rule (controller rulings 4-6)", () => {
  // A fact-only save that a parallel call raced must name the fact, never `lesson_id: undefined`.
  it("two parallel calls: one fact saved, the other's digest names fact_id and no lesson_id", async () => {
    const h = setup({ distill: FACT });
    const run_id = createQueuedTurnRun(h.store, "记下来吧");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    const [a, b] = await Promise.all([1, 2].map(() => h.worker.runMemoryWrite(claim, CHAT, {}, { source: "loop" })));
    const won = [a!, b!].filter((w) => w.committed);
    expect(won).toHaveLength(1);
    const lost = out([a!, b!].find((w) => !w.committed)!.result);
    expect(lost).toMatchObject({ saved: false, reason: "already_saved_this_turn", fact_id: won[0]!.saved!.fact!.id });
    expect("lesson_id" in lost).toBe(false);
    expect(h.store.getActiveEpisodicFacts(CHAT)).toHaveLength(1);
    h.store.close();
  });
  // Paco 2026-10-12: every save is announced with Undo, whatever saved it — a fact from the planner's own tool too.
  it("the loop tool announces a fact save on the Undo card (the SavedMemory carries the fact)", async () => {
    const h = setup({ distill: FACT });
    const run_id = createQueuedTurnRun(h.store, "记下来吧");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    const tool = h.worker.buildOmpTools(claim, CHAT).registry.get("lesson_write")!;
    const r = await tool.execute!({ scope: "ask" });
    expect(out(r)).toMatchObject({ saved: true, kinds: ["fact"] });
    const change = h.store.getMemoryChangeByRun(run_id)!;
    const card = drainOutbox(h.store).get(`memcard:${change.change_id}`);
    expect(String(card?.text)).toContain("Paco prefers the south side noodle shop");
    h.store.close();
  });
  // Jev may fix the kind and the distill still find nothing: the memory.kind row is Jev's verdict, never a save.
  it("Jev fixed 'fact' but nothing was saved: the row is Jev's, no trigger, no fact, the refusal ledgered", async () => {
    const h = setup({ distill: '{"kind":"none"}' });
    const run_id = createQueuedTurnRun(h.store, "记下来吧");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    const askJev = async () => ({ answer: choiceAns(["other", "fix", "rule", "fact", "both"], "fact", 0.95) });
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "lane", askJev });
    expect([w.committed, w.saved]).toEqual([false, undefined]);
    expect(h.store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "memory.kind").map((d) => [d.rung, d.verdict])).toEqual([["system_one", "fact"]]);
    expect([h.store.memorySaveTriggered(run_id), h.store.getActiveEpisodicFacts(CHAT).length]).toEqual([false, 0]);
    expect(h.store.getLedgerEvents(run_id).filter((e) => e.event_type === "memory_not_saved").map((e) => e.payload)).toEqual([{ reason: "nothing_to_save", source: "lane" }]);
    h.store.close();
  });
  // Ruling 14 (codex B1): a turn killed mid-call writes no decisions row and nothing durable, memory.kind's included.
  it("an aborted turn saves nothing and writes no memory.kind row", async () => {
    const h = setup({ distill: FACT });
    const run_id = createQueuedTurnRun(h.store, "记下来吧");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    const ac = new AbortController(); ac.abort();
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "lane", signal: ac.signal });
    expect(out(w.result)).toMatchObject({ saved: false, reason: "turn_ended" });
    expect([h.store.listDecisionsForRun(run_id).length, h.store.getActiveEpisodicFacts(CHAT).length, h.store.memorySaveTriggered(run_id)]).toEqual([0, 0, false]);
    h.store.close();
  });
  // No silent failure: a rolled-back save is logged with its reason before the typed save_failed goes back.
  it("a thrown save is logged before save_failed is returned", async () => {
    const h = setup({ distill: FACT });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run_id = createQueuedTurnRun(h.store, "记下来吧");
    const claim = h.store.claimRun(run_id, "w", 120)!;
    h.worker.buildOmpTools(claim, CHAT);
    const w = await h.worker.runMemoryWrite(claim, CHAT, {}, { source: "lane", inTx: () => { throw new Error("boom"); } });
    expect(out(w.result)).toMatchObject({ saved: false, reason: "save_failed" });
    expect(errors.mock.calls.some((c) => /memory write: save failed/.test(String(c[0])))).toBe(true);
    h.store.close();
  });
});

describe("runMemoryWrite: the tool's runner bound (spec §9)", () => {
  // The runner cuts a slow tool: the bound must cover every call the save makes, or a slow embed loses a committed fact's reply.
  it("lesson_write's timeout covers the distill, two reconciles and one embed", () => {
    vi.stubEnv("HOUGE_EMBED_TIMEOUT_MS", "7000");
    const h = setup({ distill: '{"kind":"none"}' });
    const claim = h.store.claimRun(createQueuedTurnRun(h.store, "x"), "w", 120)!;
    const seat = (r: string): number => (h.worker as unknown as { llmTimeoutMs(role: string): number }).llmTimeoutMs(r);
    const t = h.worker.buildOmpTools(claim, CHAT).registry.get("lesson_write")!.timeout_ms;
    expect(t).toBe(seat("distill") + 2 * seat("consolidate") + 7000);
    h.store.close();
  });
});
