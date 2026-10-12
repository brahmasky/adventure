import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv } from "../helpers/omp-env.js";
import { bridgeTurn, drainOutbox, ompWorker } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { cat, HEAVY, LIGHT, picks, scriptedLlm, treeSays, triageHarness, webOk, type Says } from "../helpers/triage-harness.js";

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

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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
