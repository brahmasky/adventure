import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { GATE_B_DISCIPLINE } from "../../src/capabilities/anchor-verify.js";
import { GATE_A_DISCIPLINE } from "../../src/capabilities/skill-router.js";
import { compileSkillAuthorContract } from "../../src/contracts/task-contract.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { SKILL_AUTHOR_DISCIPLINE } from "../../src/prompt/composer.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv } from "../helpers/omp-env.js";
import { bridgeTurn, drainOutbox, ompWorker } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { cat, HEAVY, LIGHT, picks, scriptedLlm, sinkOf, treeSays, triageHarness, webOk, type Llm, type Says } from "../helpers/triage-harness.js";

// Paco 2026-10-12 (Q1 → "Add the card"): every automatic lesson save is announced on a card with ↩️ Undo, whatever route
// the turn took, exactly once, and the Undo really retires the lesson. R12: an effect over Paco's message must be
// reversible and announced; a save the planner may or may not mention is not announced.
pinOmpEnv();
pinEnabledFlags();
const RULE: Says = { category: cat({ memory: 0.9 }), sets_rule: 0.95 };
const UNDO = /^memlane:undo:(.+)$/;
const memcards = (store: RunStore) => [...drainOutbox(store).entries()].filter(([k]) => k.startsWith("memcard:")).map(([, p]) => p);
const undoOf = (buttons: unknown): string | undefined =>
  (buttons as Array<{ data: string }> | undefined)?.map((b) => UNDO.exec(b.data)?.[1]).find((x) => x !== undefined);

function tapUndo(store: RunStore, change_id: string) {
  return new Gateway(store).intake(buildTypedTaskEvent({ source: "telegram", type: "memlane_undo", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `undo:${change_id}`, source_reference: `undo:${change_id}`,
    metadata: { telegram_update_id: 1, telegram_callback_id: `cb_${change_id}`, change_id } }));
}

afterEach(async () => { await evolutionLaneSettled(); resetEvolutionLaneForTests(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const fail = (h: { worker: Parameters<typeof sinkOf>[0] }, run_id: string) =>
  sinkOf(h.worker).fail({ run_id, worker_id: "w", error_type: "planner_exit", error_ref: "x" });

describe("the planner path queues one Undo-only memory card", () => {
  it("two_request: inform to the planner, one memcard with ↩️ Undo only, and the Undo retires the lesson", async () => {
    const h = triageHarness(treeSays({ ...RULE, actions: HEAVY }));
    const t = h.turn("以后用摄氏度。顺便帮我订明天的会议室");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("inform");
    const cards = memcards(h.store);
    expect(cards).toHaveLength(1);
    expect(String(cards[0]?.text)).toMatch(/^📒 Saved lesson #\d+ · /);
    expect((cards[0]?.buttons as Array<{ data: string }>).map((b) => b.data)).toEqual([expect.stringMatching(UNDO)]);
    expect(tapUndo(h.store, undoOf(cards[0]?.buttons)!)).toMatchObject({ ok: true, status: "lesson_change_undone" });
    expect(h.store.getActiveLessons("ask")).toHaveLength(0);
    h.store.close();
  });
  it("a cascade pick with a rule: one memcard", async () => {
    const h = triageHarness(treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }), sets_rule: 0.95 }), { llm: scriptedLlm({ cascade: picks("answer") }) });
    const t = h.turn("以后都用摄氏度，这周末去哪");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("inform");
    expect(memcards(h.store)).toHaveLength(1);
    h.store.close();
  });
});

describe("the lanes", () => {
  it("a lookup lane that saved: the lane card itself carries ↩️ Undo (and Dig deeper); no separate card", async () => {
    const h = triageHarness(treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.95, actions: LIGHT }), { web: webOk() });
    const t = h.turn("以后温度都用摄氏度。明天悉尼天气怎么样？");
    const out = await h.worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    const change_id = undoOf(out.kind === "lane_reply" ? out.buttons : undefined);
    expect(change_id).toBeDefined();
    expect(memcards(h.store)).toEqual([]);
    expect(tapUndo(h.store, change_id!)).toMatchObject({ ok: true, status: "lesson_change_undone" });
    h.store.close();
  });
  it("an answer lane that saved and then fell through: inform plus one memcard", async () => {
    const h = triageHarness(treeSays({ category: cat({ answer: 0.9 }), sets_rule: 0.95 }),
      { llm: scriptedLlm({ compose: async () => ({ ok: false, error: "all lane legs failed" }) }) });
    const t = h.turn("以后回复短一点。你觉得呢？");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("inform");
    expect(memcards(h.store)).toHaveLength(1);
    h.store.close();
  });
  it("the memory lane: its reply is the card (Undo + Dig deeper); nothing extra is queued", async () => {
    const h = triageHarness(treeSays(RULE));
    const t = h.turn("从现在起，回复请控制在三句话以内。");
    const out = await h.worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    expect(undoOf(out.kind === "lane_reply" ? out.buttons : undefined)).toBeDefined();
    expect(memcards(h.store)).toEqual([]);
    h.store.close();
  });
  it("the memory card fails to render after the save: the save is still announced, once", async () => {
    const h = triageHarness(treeSays(RULE));
    h.worker.breakMemoryLaneCardForTest();
    const t = h.turn("从现在起，回复请控制在三句话以内。");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("inform");
    expect(memcards(h.store)).toHaveLength(1);
    h.store.close();
  });
});

// Codex Rev 3 #5: "whatever route the turn took" includes the planner calling lesson_write itself (source "loop").
describe("the planner's own lesson_write tool", () => {
  it("a committed loop save queues one Undo-only card; the refused second write in the turn sends nothing more; Undo works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hlsc-"));
    vi.stubEnv("HOUGE_TOMBSTONE_PATH", join(dir, "houge.kill"));
    const store = RunStore.openInMemory();
    const worker = ompWorker(store, dir, { llm: scriptedLlm() }); // distill: durable "Keep replies short."; reconcile: ADD
    const t = bridgeTurn(store, worker, createQueuedTurnRun(store, "以后回复短一点"), dir);
    expect((await t.call("lesson_write", {})).isError).toBe(false);
    await t.call("lesson_write", {}); // already_saved_this_turn: code allows one lesson per turn
    const cards = memcards(store);
    expect(cards).toHaveLength(1);
    expect(String(cards[0]?.text)).toMatch(/^📒 Saved lesson #\d+ · /);
    expect((cards[0]?.buttons as Array<{ data: string }>).map((b) => b.data)).toEqual([expect.stringMatching(UNDO)]);
    expect(tapUndo(store, undoOf(cards[0]?.buttons)!)).toMatchObject({ ok: true, status: "lesson_change_undone" });
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
});

// Fix round 1 (review Important 2, Minor 3-4): a lane reply that never reaches Paco, two paths for one save, and a card
// that names what Undo will bring back.
describe("a save that reaches more than one path, or a reply that never arrives", () => {
  it("a lookup lane saved, then the run failed before the reply reached Paco: ompFail queues exactly one Undo card", async () => {
    const h = triageHarness(treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.95, actions: LIGHT }), { web: webOk() });
    const t = h.turn("以后温度都用摄氏度。明天悉尼天气怎么样？");
    const out = await h.worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply"); // its Undo rode the reply, which the failure means Paco never saw
    fail(h, t.run_id);
    const cards = memcards(h.store);
    expect(cards).toHaveLength(1);
    expect(undoOf(cards[0]?.buttons)).toBe(undoOf(out.kind === "lane_reply" ? out.buttons : undefined));
    h.store.close();
  });
  it("the save's own announce, then a throw caught in triageTurn: the catch announces again and one card goes out", async () => {
    const h = triageHarness(treeSays({ ...RULE, actions: HEAVY }));
    const w = h.worker as unknown as { announceSave: (...a: unknown[]) => void };
    const real = w.announceSave.bind(h.worker);
    vi.spyOn(w, "announceSave").mockImplementationOnce((...a: unknown[]) => { real(...a); throw new Error("after the announce (test)"); });
    const t = h.turn("以后用摄氏度。顺便帮我订明天的会议室");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("inform");
    expect(w.announceSave).toHaveBeenCalledTimes(2);
    expect(memcards(h.store)).toHaveLength(1);
    h.store.close();
  });
  it("a memory-lane turn killed after the save (laneLost), then failed: two announce paths, one card", async () => {
    const h = triageHarness(treeSays(RULE));
    const ctl = new AbortController();
    const insert = h.store.insertLessonChange.bind(h.store);
    vi.spyOn(h.store, "insertLessonChange").mockImplementation((c) => { const r = insert(c); ctl.abort(); return r; });
    const t = h.turn("从现在起，回复请控制在三句话以内。", { signal: ctl.signal });
    expect((await h.worker.triageTurn(t.input)).kind).toBe("inform");
    fail(h, t.run_id);
    expect(memcards(h.store)).toHaveLength(1);
    h.store.close();
  });
  it("a superseding loop save: the card names the lesson Undo will bring back, as the memory lane's own card does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hlsc-"));
    vi.stubEnv("HOUGE_TOMBSTONE_PATH", join(dir, "houge.kill"));
    const store = RunStore.openInMemory();
    const prior = store.addLesson({ scope: "ask", text: "Keep replies under ten lines.", source: "migration" });
    const base = scriptedLlm();
    const llm: Llm = async (input) => {
      const r = await base(input);
      return r.ok && String(r.output.answer).includes('"ADD"') ? { ok: true, output: { answer: JSON.stringify({ verdict: "SUPERSEDE", id: prior, theme: "format" }) } } : r;
    };
    const worker = ompWorker(store, dir, { llm });
    const t = bridgeTurn(store, worker, createQueuedTurnRun(store, "以后回复短一点"), dir);
    expect((await t.call("lesson_write", {})).isError).toBe(false);
    const cards = memcards(store);
    expect(cards).toHaveLength(1);
    expect(String(cards[0]?.text)).toMatch(new RegExp(`^📒 Saved lesson #\\d+ · format \\(replaced #${prior}\\)`));
    store.close();
  });
});

// Fix round 1 (review Important 1): skill_author's Gate A down-routes and the blocked-skill park save a lesson the planner's
// tool chose, not Paco's tap: an automatic save, so it writes a lesson_changes row in the save's transaction and gets the card.
describe("skill_author's automatic lesson saves", () => {
  const skillLlm = (gateA: string, authored?: string, gateB?: string): Llm => async (input) => {
    const system = String(input.system ?? ""); const question = String(input.question ?? "");
    let out = `ANSWER: ${question}`;
    if (system.includes(GATE_A_DISCIPLINE)) out = gateA;
    else if (system.includes(GATE_B_DISCIPLINE) && gateB !== undefined) out = gateB;
    else if (system.includes(SKILL_AUTHOR_DISCIPLINE) && authored !== undefined) out = authored;
    return { ok: true, output: { question, answer: out, model: "f", provider: "f" } };
  };
  const setup = (llm: Llm, message: string) => {
    const dir = mkdtempSync(join(tmpdir(), "hlsk-"));
    vi.stubEnv("HOUGE_TOMBSTONE_PATH", join(dir, "houge.kill"));
    const store = RunStore.openInMemory();
    const worker = ompWorker(store, dir, { llm, project: join(dir, "project") });
    const run_id = createQueuedTurnRun(store, message);
    return { store, worker, run_id, t: bridgeTurn(store, worker, run_id, dir) };
  };
  const expectOneUndoCard = (store: RunStore, lesson: string) => {
    const cards = memcards(store);
    expect(cards).toHaveLength(1);
    expect(String(cards[0]?.text)).toContain(lesson);
    expect((cards[0]?.buttons as Array<{ data: string }>).map((b) => b.data)).toEqual([expect.stringMatching(UNDO)]);
    expect(tapUndo(store, undoOf(cards[0]?.buttons)!)).toMatchObject({ ok: true, status: "lesson_change_undone" });
    expect(store.getActiveLessons("ask").map((l) => l.text)).not.toContain(lesson);
  };
  for (const verdict of ["lesson", "unsure"] as const) {
    it(`Gate A = ${verdict}: the down-routed lesson is saved with a change row and one Undo card; Undo retires it`, async () => {
      const gateA = JSON.stringify({ verdict, scope: "ask", lesson: "answer with the conclusion first", reason: "a tweak" });
      const { store, t } = setup(skillLlm(gateA), "以后回答要先给结论再给理由");
      await t.call("skill_author", {});
      await evolutionLaneSettled();
      expect(store.getActiveLessons("ask").map((l) => l.text)).toContain("answer with the conclusion first");
      expectOneUndoCard(store, "answer with the conclusion first");
      store.close();
    });
  }
  it("an auto-authored skill Gate B blocks is parked with a lesson: one Undo card; Undo retires it", async () => {
    const weak = ["---", "name: weak-skill", "scope: ask", "when: something", "anchors:", "  - a part never exceeds its whole", "version: 1",
      "origin: auto", "---", "", "1. Do a vague thing."].join("\n");
    const { store, worker, run_id } = setup(skillLlm("", weak, '{"criteria":[{"text":"a","ok":0},{"text":"b","ok":0}]}'), "learned procedure");
    const contract = compileSkillAuthorContract("learned procedure");
    const author = (worker as unknown as { authorAndWriteSkill: (...a: unknown[]) => Promise<unknown> }).authorAndWriteSkill.bind(worker);
    await author({ run_id, contract }, "learned procedure", new BudgetLedger(contract.budget),
      { verdict: "skill", scope: "ask", lesson: "verify a procedure before relying on it", reason: "recurring" }, "auto");
    expectOneUndoCard(store, "verify a procedure before relying on it");
    store.close();
  });
});
