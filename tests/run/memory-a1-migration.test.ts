import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigration,
  describeMigration,
  embedRestoredCore,
  snapshotForDryRun,
  MIGRATION_CORRELATION,
  migrationStatus,
  parseMigrationPlan,
  revertMigration,
  type MigrationPlan
} from "../../src/run/memory-a1-migration.js";
import { RunStore } from "../../src/run/run-store.js";

const CHAT = "42";
const NOW = "2026-10-02T09:00:00.000Z";
let store: RunStore;
let ids: { bigA: number; bigB: number; other: number; wrongFact: number; coreOld1: number; coreOld2: number };

beforeEach(() => {
  store = RunStore.openInMemory();
  const bigA = store.addLesson({ scope: "ask", text: "rule one; rule two; rule three", source: "loop" });
  const bigB = store.addLesson({ scope: "research", text: "rule four; rule five", source: "loop" });
  const other = store.addLesson({ scope: "ask", text: "answer briefly", source: "loop" });
  const wrongFact = store.addEpisodicFact({ chat_id: CHAT, fact: "a fact minted from a question", is_core: true });
  const coreOld1 = store.addEpisodicFact({ chat_id: CHAT, fact: "lives in city A", is_core: true, source_turn_ids: ["turn_a"] });
  const coreOld2 = store.addEpisodicFact({ chat_id: CHAT, fact: "lives in city A (north)", is_core: true, source_turn_ids: ["turn_b"] });
  const merged = store.addEpisodicFact({ chat_id: CHAT, fact: "lives somewhere", source_turn_ids: [] });
  store.supersedeEpisodicFact(coreOld1, merged, NOW);
  store.supersedeEpisodicFact(coreOld2, merged, NOW);
  ids = { bigA, bigB, other, wrongFact, coreOld1, coreOld2 };
});
afterEach(() => { store.close(); });

function plan(over: Record<string, unknown> = {}): MigrationPlan {
  return parseMigrationPlan({
    [`replace_${ids.bigA}`]: [
      { scope: "ask", theme: "format", text: "rule one", avoid: "rambling" },
      { scope: "ask", theme: "time", text: "rule two", avoid: null },
      { scope: "research", theme: "tasks", text: "rule three", avoid: null }
    ],
    [`replace_${ids.bigB}`]: [{ scope: "research", theme: "sources", text: "rule four", avoid: null }, { scope: "research", theme: "format", text: "rule five", avoid: null }],
    themes: { [String(ids.other)]: "format" },
    retire_facts: [ids.wrongFact],
    restore_core: { fact: "lives in city A", evidence_from_fact_ids: [ids.coreOld1, ids.coreOld2] },
    ...over
  });
}
const migrationRows = () => store.getLedgerEventsByCorrelation(MIGRATION_CORRELATION).filter((e) => e.event_type === "memory_migration");

describe("parseMigrationPlan — refuses a plan it cannot apply whole", () => {
  it("rejects an unknown theme, an over-cap text and an over-cap avoid", () => {
    expect(() => plan({ themes: { "1": "poetry" } })).toThrow("plan: themes.1");
    expect(() => parseMigrationPlan({ replace_9: [{ scope: "ask", theme: "format", text: "x".repeat(241), avoid: null }] })).toThrow("plan: replace_9[0].text");
    expect(() => parseMigrationPlan({ replace_9: [{ scope: "ask", theme: "format", text: "x", avoid: "a".repeat(121) }] })).toThrow("plan: replace_9[0].avoid");
  });
});

describe("parseMigrationPlan — strict shape", () => {
  const ok = { scope: "ask", theme: "format", text: "x", avoid: null };
  it("refuses an unknown top-level key (a typo would silently skip a step)", () => {
    expect(() => parseMigrationPlan({ replace_9: [ok], retire_fact: [1] })).toThrow("plan: unknown key retire_fact");
  });
  it("refuses an avoid that is neither string nor null", () => {
    expect(() => parseMigrationPlan({ replace_9: [{ ...ok, avoid: 5 }] })).toThrow("plan: replace_9[0].avoid");
    expect(() => parseMigrationPlan({ replace_9: [{ scope: "ask", theme: "format", text: "x" }] })).toThrow("plan: replace_9[0].avoid");
  });
  it("refuses an empty replacement list", () => {
    expect(() => parseMigrationPlan({ replace_9: [] })).toThrow("plan: replace_9 is empty");
  });
  it("refuses an empty restore_core evidence list", () => {
    expect(() => parseMigrationPlan({ replace_9: [ok], restore_core: { fact: "f", evidence_from_fact_ids: [] } })).toThrow("evidence_from_fact_ids is empty");
  });
});

describe("the migration (spec §8)", () => {
  it("dry run writes nothing", () => {
    const before = { lessons: store.listLessons().length, ledger: store.getLedgerEvents().length };
    expect(describeMigration(store, plan()).length).toBeGreaterThan(0);
    expect({ lessons: store.listLessons().length, ledger: store.getLedgerEvents().length }).toEqual(before);
  });

  it("apply: each replacement supersedes its old lesson with linked, themed rows; themes, the retire and the core restore land", () => {
    applyMigration({ store, plan: plan(), chat_id: CHAT, now: NOW });
    const a = store.getLesson(ids.bigA)!;
    const newA = store.listLessons().filter((l) => l.supersedes === ids.bigA).map((l) => l.id).sort((x, y) => x - y);
    expect(a.status).toBe("superseded");
    expect(newA).toHaveLength(3);
    expect(a.superseded_by).toBe(newA[0]); // the FIRST new row, so lineage walks to it
    for (const id of newA) expect(store.lessonLineage(id).map((l) => l.id)).toContain(ids.bigA);
    expect(store.getLesson(newA[0]!)).toMatchObject({ theme: "format", avoid: "rambling", source: "migration" });
    expect(store.getLesson(ids.bigB)!.status).toBe("superseded");
    expect(store.getLesson(ids.other)!.theme).toBe("format");
    expect(store.getEpisodicFact(ids.wrongFact)!.status).toBe("pruned");
    const restored = store.getCoreEpisodicFacts(CHAT).find((f) => f.fact === "lives in city A")!;
    expect(JSON.parse(restored.source_turn_ids).sort()).toEqual(["turn_a", "turn_b"]);
    expect(migrationRows().map((e) => e.payload.step)).toEqual([`replace_${ids.bigA}`, `replace_${ids.bigB}`, "themes", "retire_facts", "restore_core"]);
  });

  it("is atomic: a failing last step writes nothing at all", () => {
    const before = { lessons: store.listLessons().map((l) => l.id), events: store.getLedgerEvents().length };
    expect(() => applyMigration({ store, plan: plan({ restore_core: { fact: "x", evidence_from_fact_ids: [99999] } }), chat_id: CHAT, now: NOW })).toThrow();
    expect(store.listLessons().map((l) => l.id)).toEqual(before.lessons);
    expect(store.getLesson(ids.bigA)!.status).toBe("active");
    expect(store.getEpisodicFact(ids.wrongFact)!.status).toBe("active");
    expect(store.getLesson(ids.other)!.theme).toBe("unthemed");
    expect(store.getLedgerEvents()).toHaveLength(before.events);
  });

  it("re-running after success is a no-op (status reads applied)", () => {
    expect(migrationStatus(store, plan())).toBe("pending");
    applyMigration({ store, plan: plan(), chat_id: CHAT, now: NOW });
    expect(migrationStatus(store, plan())).toBe("applied");
  });

  it("revert restores the prior state in one transaction", () => {
    applyMigration({ store, plan: plan(), chat_id: CHAT, now: NOW });
    expect(revertMigration({ store, now: NOW })).toBe(5);
    expect(store.getLesson(ids.bigA)).toMatchObject({ status: "active", superseded_by: null });
    expect(store.getLesson(ids.bigB)!.status).toBe("active");
    expect(store.listLessons().map((l) => l.id).sort((x, y) => x - y)).toEqual([ids.bigA, ids.bigB, ids.other].sort((x, y) => x - y));
    expect(store.getEpisodicFact(ids.wrongFact)!.status).toBe("active");
    expect(store.getCoreEpisodicFacts(CHAT).map((f) => f.id)).toEqual([ids.wrongFact]);
    expect(migrationStatus(store, plan())).toBe("pending");
  });

  it("refuses a partial prior state (a target changed by hand, no migration recorded) and writes nothing", () => {
    store.forgetLesson(ids.bigA);
    const events = store.getLedgerEvents().length;
    expect(() => migrationStatus(store, plan(), CHAT)).toThrow("partial state, refusing");
    expect(store.getLedgerEvents()).toHaveLength(events);
    expect(store.getLesson(ids.bigB)!.status).toBe("active");
  });

  it("revert restores the previous themes and marks the retire change undone", () => {
    store.setLessonTheme(ids.other, "honesty");
    applyMigration({ store, plan: plan(), chat_id: CHAT, now: NOW });
    const change = store.getLedgerEventsByCorrelation(MIGRATION_CORRELATION).find((e) => e.payload.step === "retire_facts")!.payload.change_id as string;
    revertMigration({ store, now: NOW });
    expect(store.getLesson(ids.other)!.theme).toBe("honesty");
    expect(store.getMemoryChange(change)!.undone_at).not.toBeNull();
  });

  it("revert is refused, writing nothing, when a new row was changed after apply", () => {
    applyMigration({ store, plan: plan(), chat_id: CHAT, now: NOW });
    const newB = store.listLessons().find((l) => l.supersedes === ids.bigB)!.id;
    store.forgetLesson(newB);
    const events = store.getLedgerEvents().length;
    expect(() => revertMigration({ store, now: NOW })).toThrow("revert refused");
    expect(store.getLesson(ids.bigA)!.status).toBe("superseded");
    expect(store.getEpisodicFact(ids.wrongFact)!.status).toBe("pruned");
    expect(store.getLedgerEvents()).toHaveLength(events);
  });

  it("a second revert has nothing to revert", () => {
    applyMigration({ store, plan: plan(), chat_id: CHAT, now: NOW });
    revertMigration({ store, now: NOW });
    expect(() => revertMigration({ store, now: NOW })).toThrow("nothing to revert");
  });
});

describe("the restored core row is embedded (final-review C3)", () => {
  it("apply stores the pre-computed embedding on the restored core row", () => {
    applyMigration({ store, plan: plan(), chat_id: CHAT, now: NOW, coreEmbedding: { vector: Float32Array.from([0.6, 0.8]), model: "m1" } });
    const restored = store.getCoreEpisodicFacts(CHAT).find((f) => f.fact === "lives in city A")!;
    expect(restored.embedding).not.toBeNull();
    expect(restored.embedding_model).toBe("m1");
  });

  it("embedRestoredCore is best-effort: the fact's own text, and undefined (never a throw) when the embed fails or there is no core step", async () => {
    const seen: string[] = [];
    expect(await embedRestoredCore(plan(), async (t) => { seen.push(t); return Float32Array.from([1, 0]); }, "m1")).toMatchObject({ model: "m1" });
    expect(seen).toEqual(["lives in city A"]);
    expect(await embedRestoredCore(plan(), async () => { throw new Error("ollama down"); }, "m1")).toBeUndefined();
    expect(await embedRestoredCore(plan(), async () => null, "m1")).toBeUndefined();
    expect(await embedRestoredCore(plan({ restore_core: undefined }), async () => Float32Array.from([1, 0]), "m1")).toBeUndefined();
  });
});

describe("the dry run reads a copy, never the live DB (final-review E1)", () => {
  const sqlite = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { get(...a: unknown[]): unknown }; close(): void } };
  it("RunStore.open would migrate the live file; the snapshot leaves it byte-for-byte unmigrated and is removed after", () => {
    const dir = mkdtempSync(join(tmpdir(), "hmig-"));
    try {
      const live = join(dir, "houge.sqlite");
      RunStore.open(live).close();
      const raw = new sqlite.DatabaseSync(live); // an older DB: one migration not yet applied
      raw.exec("DROP TABLE planner_session_state; DELETE FROM schema_migrations WHERE version = '2026-10-02-planner-session-state'");
      raw.close();
      const tmpRoot = join(dir, "tmp");
      const snap = snapshotForDryRun(live, tmpRoot);
      expect(snap.path.startsWith(join(tmpRoot, "memory-a1"))).toBe(true);
      const copy = RunStore.open(snap.path); // describe runs here: migrate() touches only the copy
      copy.close();
      snap.cleanup();
      expect(existsSync(snap.path)).toBe(false);
      const check = new sqlite.DatabaseSync(live);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'planner_session_state'").get()).toBeUndefined();
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

