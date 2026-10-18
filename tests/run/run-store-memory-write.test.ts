import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Spec §11: an explicit fact save is an `add` memory change, so the card's Undo can revert it, and the run that saved is
// listed so the background pass skips it (§10). The CHECK rebuild must keep every existing Undo row identical: a lost
// row is a lost Undo button for Paco.
const CHAT = "555";
const NOW = "2026-10-17T00:00:00.000Z";
const VERSION = "2026-10-15-memory-write";

/** Put a migrated file back to the 2026-10-02 shape: the old CHECK, no trigger table, no version row. */
function downgrade(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`DELETE FROM schema_migrations WHERE version = '${VERSION}';
    DROP TABLE memory_save_triggers;
    ALTER TABLE memory_changes RENAME TO mc_new;
    CREATE TABLE memory_changes (change_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('fact', 'wiki')),
      action TEXT NOT NULL CHECK (action IN ('retire', 'correct')), old_ids TEXT NOT NULL, new_id INTEGER, run_id TEXT,
      chat_id TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT);
    INSERT INTO memory_changes SELECT change_id, kind, action, old_ids, new_id, run_id, chat_id, created_at, undone_at FROM mc_new;
    DROP TABLE mc_new;`);
  db.close();
}
const rows = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT change_id, kind, action, old_ids, new_id, run_id, chat_id, created_at, undone_at FROM memory_changes ORDER BY change_id").all(); } finally { db.close(); }
};

describe("migration 2026-10-15-memory-write", () => {
  it("rebuilds memory_changes so 'add' is accepted, every existing row identical, once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hmw-")), "h.sqlite");
    const s1 = RunStore.open(path);
    const id = s1.addEpisodicFact({ chat_id: CHAT, fact: "Paco keeps a sourdough starter", created_at: NOW });
    s1.retireMemoryRows({ kind: "fact", ids: [id], chat_id: CHAT, run_id: null, now: NOW });
    s1.close();
    downgrade(path);
    const before = rows(path);
    const old = new DatabaseSync(path);
    expect(() => old.prepare(`INSERT INTO memory_changes (change_id, kind, action, old_ids, new_id, run_id, chat_id, created_at)
      VALUES ('mc_x', 'fact', 'add', '[]', 1, NULL, '${CHAT}', '${NOW}')`).run()).toThrow(/CHECK/);
    old.close();
    const s2 = RunStore.open(path);
    s2.close();
    expect(rows(path)).toEqual(before);
    const s3 = RunStore.open(path); // idempotent: a second open neither rebuilds nor re-inserts the version row
    const fresh = s3.addEpisodicFact({ chat_id: CHAT, fact: "Paco's bike is blue", created_at: NOW });
    expect(s3.inTransaction(() => s3.insertFactAddChange({ new_id: fresh, superseded_id: null, pruned_ids: [], run_id: "run_a", chat_id: CHAT, now: NOW })).action).toBe("add");
    s3.close();
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '${VERSION}'`).get()).toEqual({ n: 1 });
    db.close();
  });
});

describe("fact add changes and their Undo (spec §9)", () => {
  it("an ADD undo prunes the new fact; a second tap is already_undone", () => {
    const s = RunStore.openInMemory();
    const id = s.addEpisodicFact({ chat_id: CHAT, fact: "Paco's sister lives in Hobart", created_at: NOW });
    const c = s.inTransaction(() => s.insertFactAddChange({ new_id: id, superseded_id: null, pruned_ids: [], run_id: "run_a", chat_id: CHAT, now: NOW }));
    expect(c).toMatchObject({ kind: "fact", action: "add", old_ids: [], new_id: id, run_id: "run_a" });
    expect(s.undoMemoryChange(c.change_id)).toMatchObject({ status: "undone", restored: [], retired: id });
    expect(s.getEpisodicFact(id)?.status).toBe("pruned");
    expect(s.undoMemoryChange(c.change_id).status).toBe("already_undone");
    s.close();
  });
  it("a SUPERSEDE undo prunes the new fact and restores the one it replaced (the incident's lost-fact risk)", () => {
    const s = RunStore.openInMemory();
    const old = s.addEpisodicFact({ chat_id: CHAT, fact: "Paco works from the city office", created_at: NOW });
    const saved = s.saveReconciledFact({ chat_id: CHAT, fact: "Paco works from home", source_turn_ids: [] }, { verdict: "SUPERSEDE", id: old }, NOW);
    const c = s.inTransaction(() => s.insertFactAddChange({ new_id: saved.id!, superseded_id: saved.supersededId ?? null, pruned_ids: [], run_id: "run_a", chat_id: CHAT, now: NOW }));
    expect(c.old_ids).toEqual([old]);
    expect(s.undoMemoryChange(c.change_id)).toMatchObject({ status: "undone", restored: [old], retired: saved.id });
    expect(s.getEpisodicFact(old)?.status).toBe("active");
    s.close();
  });
  it("an add whose fact has moved on is not undone at all (changed_since), and writes nothing", () => {
    const s = RunStore.openInMemory();
    const id = s.addEpisodicFact({ chat_id: CHAT, fact: "Paco drives a hatchback", created_at: NOW });
    const c = s.inTransaction(() => s.insertFactAddChange({ new_id: id, superseded_id: null, pruned_ids: [], run_id: "run_a", chat_id: CHAT, now: NOW }));
    s.retireMemoryRows({ kind: "fact", ids: [id], chat_id: CHAT, run_id: null, now: NOW });
    expect(s.undoMemoryChange(c.change_id).status).toBe("changed_since");
    expect(s.getMemoryChange(c.change_id)?.undone_at).toBeNull();
    s.close();
  });
});

describe("cap-pruned facts, the steered read, memory_not_saved (plan Rev 2 items 4, 6, 9)", () => {
  it("an add undo also restores the facts the per-chat cap pruned during that save", () => {
    const s = RunStore.openInMemory();
    const older = s.addEpisodicFact({ chat_id: CHAT, fact: "an older low-value fact", created_at: NOW });
    const saved = s.saveReconciledFact({ chat_id: CHAT, fact: "Paco's new fact", source_turn_ids: [] }, { verdict: "ADD" }, NOW, 1);
    expect(saved.prunedIds).toEqual([older]);
    const c = s.inTransaction(() => s.insertFactAddChange({ new_id: saved.id!, superseded_id: null, pruned_ids: saved.prunedIds, run_id: "run_a", chat_id: CHAT, now: NOW }));
    expect(s.getMemoryChange(c.change_id)?.pruned_ids).toEqual([older]);
    expect(s.undoMemoryChange(c.change_id)).toMatchObject({ status: "undone", restored: [older], retired: saved.id });
    expect(s.getEpisodicFact(older)?.status).toBe("active");
    s.close();
  });
  const at = (sec: number) => new Date(Date.parse("2026-10-17T00:00:00.000Z") + sec * 1000).toISOString();
  it("steeredUserTurns: this run's and its worker's user turns after the cut, newest first, never an assistant row", () => {
    const s = RunStore.openInMemory();
    const parent = createQueuedTurnRun(s); s.claimRun(parent, "planner:555:p", 120);
    const steer = createQueuedTurnRun(s); s.claimRun(steer, "planner:555:p", 120);
    s.recordChatTurn({ chat_id: CHAT, run_id: parent, role: "user", text: "before the cut", created_at: at(0) });
    s.recordChatTurn({ chat_id: CHAT, run_id: parent, role: "user", text: "own message", created_at: at(2) });
    s.recordChatTurn({ chat_id: CHAT, run_id: parent, role: "assistant", text: "a reply", created_at: at(3) });
    s.recordChatTurn({ chat_id: CHAT, run_id: steer, role: "user", text: "the steer", created_at: at(4) });
    expect(s.steeredUserTurns(CHAT, at(1), parent, "planner:555:p", 10).map((t) => t.text)).toEqual(["the steer", "own message"]);
    expect(s.steeredUserTurns(CHAT, at(1), parent, "planner:555:p", 1).map((t) => t.text)).toEqual(["the steer"]);
    s.close();
  });
  // Rev 2.1 item 2: the eligibility filter runs in SQL before the LIMIT, so a burst of other turns cannot hide the steer.
  it("finds a valid steer behind 25 ineligible newer turns (another worker's, a run with no row)", () => {
    const s = RunStore.openInMemory();
    const parent = createQueuedTurnRun(s); s.claimRun(parent, "planner:555:p", 120);
    const steer = createQueuedTurnRun(s); s.claimRun(steer, "planner:555:p", 120);
    s.recordChatTurn({ chat_id: CHAT, run_id: steer, role: "user", text: "the steer", created_at: at(2) });
    // One foreign-worker run carries the burst (gateway intake allows 5 commands a minute, so 25 runs cannot be born in a test).
    const other = createQueuedTurnRun(s, "other"); s.claimRun(other, "planner:555:other", 120);
    for (let k = 0; k < 25; k += 1) s.recordChatTurn({ chat_id: CHAT, run_id: other, role: "user", text: `other ${k}`, created_at: at(10 + k) });
    s.recordChatTurn({ chat_id: CHAT, run_id: "run_not_telegram", role: "user", text: "no run row", created_at: at(60) });
    expect(s.steeredUserTurns(CHAT, at(1), parent, "planner:555:p", 20).map((t) => t.text)).toEqual(["the steer"]);
    s.close();
  });
  // Security: the telegram-source filter is what keeps a non-Paco run (cli) leased to the same worker out of the save's evidence.
  it("excludes a non-telegram run leased to the same worker, even with a newer user turn", () => {
    const s = RunStore.openInMemory();
    const parent = createQueuedTurnRun(s); s.claimRun(parent, "planner:555:p", 120);
    const cli = s.createOrGet(buildTypedTaskEvent({ source: "cli", type: "turn", program: "turn", goal: "cli run",
      requested_by: { kind: "user", id: "paco" }, notify: { kind: "local" }, idempotency_key: "cli-1", source_reference: "cli:1", created_at: NOW }));
    if (cli.status !== "created") throw new Error(`expected created, got ${cli.status}`);
    // A cli run is born unqueued, so lease it to the telegram run's worker directly (the store's own column, as claimRun would).
    (s as unknown as { db: DatabaseSync }).db.prepare("UPDATE runs SET worker_id = ? WHERE run_id = ?").run("planner:555:p", cli.run_id);
    expect(s.runSource(cli.run_id)).toBe("cli");
    s.recordChatTurn({ chat_id: CHAT, run_id: parent, role: "user", text: "own message", created_at: at(2) });
    s.recordChatTurn({ chat_id: CHAT, run_id: cli.run_id, role: "user", text: "cli text", created_at: at(5) });
    expect(s.steeredUserTurns(CHAT, at(1), parent, "planner:555:p", 10).map((t) => t.text)).toEqual(["own message"]);
    s.close();
  });
  it("memory_not_saved carries a reason and the caller, nothing else, and refuses a payload without its source", () => {
    const s = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(s);
    s.appendRunLedgerEvent(run_id, "memory_not_saved", "core", { reason: "no_evidence", source: "lane" });
    expect(() => s.appendRunLedgerEvent(run_id, "memory_not_saved", "core", { reason: "no_evidence" })).toThrow(/source/);
    s.close();
  });
});

describe("save triggers, the run's change, fact_saved", () => {
  it("a trigger row per run, idempotent; unknown runs are not triggered", () => {
    const s = RunStore.openInMemory();
    s.insertMemorySaveTrigger("run_a", ["rule", "fact"], NOW);
    s.insertMemorySaveTrigger("run_a", ["fact"], NOW);
    expect(s.memorySaveTriggered("run_a")).toBe(true);
    expect(s.memorySaveTriggered("run_b")).toBe(false);
    s.close();
  });
  // Codex #4: the background pass skips only a run whose save stored a fact; a rule-only save left its facts unread.
  it("memoryFactSaveTriggered is true only for a trigger whose kinds include fact", () => {
    const s = RunStore.openInMemory();
    s.insertMemorySaveTrigger("run_f", ["fact"], NOW);
    s.insertMemorySaveTrigger("run_b", ["rule", "fact"], NOW);
    s.insertMemorySaveTrigger("run_r", ["rule"], NOW);
    expect(["run_f", "run_b", "run_r", "run_x"].map((r) => s.memoryFactSaveTriggered(r))).toEqual([true, true, false, false]);
    s.close();
  });
  it("getMemoryChangeByRun finds the run's add (Dig deeper names it), never a retire", () => {
    const s = RunStore.openInMemory();
    const a = s.addEpisodicFact({ chat_id: CHAT, fact: "fact a", created_at: NOW });
    const b = s.addEpisodicFact({ chat_id: CHAT, fact: "fact b", created_at: NOW });
    s.retireMemoryRows({ kind: "fact", ids: [a], chat_id: CHAT, run_id: "run_a", now: NOW });
    const add = s.inTransaction(() => s.insertFactAddChange({ new_id: b, superseded_id: null, pruned_ids: [], run_id: "run_a", chat_id: CHAT, now: NOW }));
    expect(s.getMemoryChangeByRun("run_a")?.change_id).toBe(add.change_id);
    expect(s.getMemoryChangeByRun("run_x")).toBeUndefined();
    s.close();
  });
  it("fact_saved is a ledger type with ids only, and refuses a payload missing one", () => {
    const s = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(s);
    s.appendRunLedgerEvent(run_id, "fact_saved", "core", { fact_id: 7, verb: "add", change_id: "mc_1" });
    expect(() => s.appendRunLedgerEvent(run_id, "fact_saved", "core", { fact_id: 7, verb: "add" })).toThrow(/change_id/);
    expect(s.getLedgerEvents(run_id).filter((e) => e.event_type === "fact_saved")).toHaveLength(1);
    s.close();
  });
});
