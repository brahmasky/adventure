import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retrieveEpisodicFacts } from "../../src/run/episodic-retrieval.js";
import { RunStore } from "../../src/run/run-store.js";

// Self-service memory correction (2026-10-02): live fact #108 (ASML in the daily brief) was wrong and Houge had no
// way to retire it. Every change is a reversible status flip recorded in memory_changes, so Undo can put it back.

const CHAT = "555";
const NOW = "2026-10-02T09:00:00.000Z";
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

const fact = (text: string, chat = CHAT, extra: { is_core?: boolean } = {}) =>
  store.addEpisodicFact({ chat_id: chat, fact: text, created_at: "2026-09-30T00:00:00.000Z", ...extra });

describe("memory_changes: retire", () => {
  it("prunes the active facts and records one change row", () => {
    const a = fact("Paco's daily brief needs ASML earnings");
    const change = store.retireMemoryRows({ kind: "fact", ids: [a], chat_id: CHAT, run_id: "run_1", now: NOW });
    expect(change).toMatchObject({ kind: "fact", action: "retire", old_ids: [a], new_id: null, run_id: "run_1", chat_id: CHAT, undone_at: null });
    expect(store.getEpisodicFact(a)?.status).toBe("pruned");
    expect(store.getMemoryChange(change!.change_id)).toEqual(change);
  });

  it("changes nothing when any id is not active, or belongs to another chat", () => {
    const a = fact("one");
    const other = fact("other chat", "999");
    const gone = fact("gone");
    store.retireMemoryRows({ kind: "fact", ids: [gone], chat_id: CHAT, run_id: null, now: NOW });
    expect(store.retireMemoryRows({ kind: "fact", ids: [a, gone], chat_id: CHAT, run_id: null, now: NOW })).toBeNull();
    expect(store.retireMemoryRows({ kind: "fact", ids: [other], chat_id: CHAT, run_id: null, now: NOW })).toBeNull();
    expect(store.retireMemoryRows({ kind: "fact", ids: [424242], chat_id: CHAT, run_id: null, now: NOW })).toBeNull();
    expect(store.getEpisodicFact(a)?.status).toBe("active");
    expect(store.getEpisodicFact(other)?.status).toBe("active");
  });

  it("retires an active wiki page (pages are global)", () => {
    const page = store.addWikiPage({ topic_slug: "asml", title: "ASML", summary: "litho" });
    const change = store.retireMemoryRows({ kind: "wiki", ids: [page], chat_id: CHAT, run_id: null, now: NOW });
    expect(change?.kind).toBe("wiki");
    expect(store.getWikiPage(page)?.status).toBe("pruned");
  });
});

describe("memory_changes: correct", () => {
  it("adds one active fact with Paco's wording and supersedes every old row, linked both ways", () => {
    const a = fact("Paco's daily brief needs ASML earnings and analyst opinions");
    const b = fact("The daily brief covers ASML");
    const change = store.correctEpisodicFacts({
      ids: [a, b], correction: "The daily brief covers AI news only; ASML was a one-off request", chat_id: CHAT,
      run_id: "run_1", source_turn_id: "turn_x", now: NOW
    });
    const created = store.getEpisodicFact(change!.new_id!);
    expect(created).toMatchObject({ status: "active", chat_id: CHAT, supersedes: a, fact: "The daily brief covers AI news only; ASML was a one-off request" });
    expect(JSON.parse(created!.source_turn_ids)).toEqual(["turn_x"]);
    for (const old of [a, b]) expect(store.getEpisodicFact(old)).toMatchObject({ status: "superseded", superseded_by: created!.id });
    expect(change).toMatchObject({ action: "correct", old_ids: [a, b], new_id: created!.id });
  });

  it("retrieval no longer returns the old text, and does return the correction", () => {
    const a = fact("Paco's daily brief needs ASML earnings");
    store.correctEpisodicFacts({ ids: [a], correction: "The daily brief never includes ASML", chat_id: CHAT, run_id: null, now: NOW });
    const got = retrieveEpisodicFacts({ store, chat_id: CHAT, queryText: "daily brief ASML", queryEmbedding: null, now: NOW }).map((f) => f.fact);
    expect(got).toEqual(["The daily brief never includes ASML"]);
  });

  it("a correction is a normal fact, never core (M-H1: a steered write must not mint always-on biography), and refuses when any id is not active in this chat", () => {
    const core = fact("Paco lives in Sydney", CHAT, { is_core: true });
    const change = store.correctEpisodicFacts({ ids: [core], correction: "Paco lives in Melbourne", chat_id: CHAT, run_id: null, now: NOW });
    expect(store.getEpisodicFact(change!.new_id!)?.is_core).toBe(0);
    expect(store.getCoreEpisodicFacts(CHAT, 10).map((f) => f.id)).toEqual([]);
    expect(store.correctEpisodicFacts({ ids: [core], correction: "x", chat_id: CHAT, run_id: null, now: NOW })).toBeNull();
    const before = store.getActiveEpisodicFacts(CHAT).length;
    expect(store.correctEpisodicFacts({ ids: [fact("x", "999")], correction: "y", chat_id: CHAT, run_id: null, now: NOW })).toBeNull();
    expect(store.getActiveEpisodicFacts(CHAT)).toHaveLength(before);
  });
});

describe("memory_changes: undo", () => {
  it("undoes a correct: old rows active again with no successor, the new row pruned; a second undo is a no-op", () => {
    const a = fact("old one");
    const b = fact("old two");
    const change = store.correctEpisodicFacts({ ids: [a, b], correction: "new", chat_id: CHAT, run_id: null, now: NOW })!;
    const first = store.undoMemoryChange(change.change_id, "2026-10-02T09:05:00.000Z");
    expect(first.status).toBe("undone");
    for (const old of [a, b]) expect(store.getEpisodicFact(old)).toMatchObject({ status: "active", superseded_by: null, valid_until: null });
    expect(store.getEpisodicFact(change.new_id!)?.status).toBe("pruned");
    expect(store.undoMemoryChange(change.change_id).status).toBe("already_undone");
    expect(store.getMemoryChange(change.change_id)?.undone_at).toBe("2026-10-02T09:05:00.000Z");
  });

  it("undoes a retire of facts and of a wiki page; an unknown change id is not_found", () => {
    const a = fact("retired");
    const page = store.addWikiPage({ topic_slug: "t", title: "T" });
    const c1 = store.retireMemoryRows({ kind: "fact", ids: [a], chat_id: CHAT, run_id: null, now: NOW })!;
    const c2 = store.retireMemoryRows({ kind: "wiki", ids: [page], chat_id: CHAT, run_id: null, now: NOW })!;
    expect(store.undoMemoryChange(c1.change_id).status).toBe("undone");
    expect(store.undoMemoryChange(c2.change_id).status).toBe("undone");
    expect(store.getEpisodicFact(a)?.status).toBe("active");
    expect(store.getWikiPage(page)?.status).toBe("active");
    expect(store.undoMemoryChange("mc_nope").status).toBe("not_found");
  });

  it("L1: a correct whose new row has moved on (consolidation superseded it) is NOT undone, and nothing changes", () => {
    const one = fact("one");
    const change = store.correctEpisodicFacts({ ids: [one], correction: "two", chat_id: CHAT, run_id: null, now: NOW })!;
    const two = change.new_id!;
    const three = fact("three");
    store.supersedeEpisodicFact(two, three, NOW);
    expect(store.undoMemoryChange(change.change_id)).toEqual({ status: "changed_since", change });
    expect(store.getEpisodicFact(one)).toMatchObject({ status: "superseded", superseded_by: two });
    expect(store.getEpisodicFact(two)).toMatchObject({ status: "superseded", superseded_by: three });
    expect(store.getEpisodicFact(three)?.status).toBe("active");
    expect(store.getMemoryChange(change.change_id)?.undone_at).toBeNull();
  });

  it("an undo reports exactly the rows it restored and retired", () => {
    const a = fact("a");
    const b = fact("b");
    const c1 = store.retireMemoryRows({ kind: "fact", ids: [a, b], chat_id: CHAT, run_id: null, now: NOW })!;
    expect(store.undoMemoryChange(c1.change_id)).toMatchObject({ status: "undone", restored: [a, b], retired: null });
    const c2 = store.correctEpisodicFacts({ ids: [a], correction: "a2", chat_id: CHAT, run_id: null, now: NOW })!;
    expect(store.undoMemoryChange(c2.change_id)).toMatchObject({ status: "undone", restored: [a], retired: c2.new_id });
  });

  it("a change id fits a Telegram callback: memory:undo:<id> is at most 64 bytes", () => {
    const change = store.retireMemoryRows({ kind: "fact", ids: [fact("x")], chat_id: CHAT, run_id: null, now: NOW })!;
    expect(Buffer.byteLength(`memory:undo:${change.change_id}`, "utf8")).toBeLessThanOrEqual(64);
  });
});
