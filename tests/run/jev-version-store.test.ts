import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

// Jev version check, Task 1: the anchor Paco approved, and the per-model check state. A model is only ever credited
// from rows of its own current generation, and a state change is fenced so two writers cannot both move it.
const VERSION = "2026-10-22-jev-version-check";
const NOW = "2026-10-22T00:00:00.000Z";
const fresh = () => join(mkdtempSync(join(tmpdir(), "hjv-")), "h.sqlite");
const row = (turn_id: string, question_id: string, run: "A" | "B", model = "jev-x") =>
  ({ turn_id, lang: "zh", question_id, criteria_hash: "h1", run, answer_json: '{"a":1}', model });

function ledgerAttempt(path: string, id: string, provider: string, model: string): void {
  const db = new DatabaseSync(path);
  db.prepare(`INSERT INTO ledger_events (event_id, run_id, correlation_id, event_type, occurred_at, actor, sequence, payload_json)
    VALUES (?, NULL, 'c', 'llm_attempt', ?, 'capability_runner', 1, ?)`).run(id, NOW, JSON.stringify({ provider, model, outcome: "ok" }));
  db.close();
}

describe("migration 2026-10-22-jev-version-check", () => {
  it("is additive on a DB that already has the 2b-ii tables, applies once, and leaves them intact", () => {
    const path = fresh();
    const s1 = RunStore.open(path);
    s1.close();
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TABLE jev_check_runs; DROP TABLE jev_models; DROP TABLE jev_model_cursor; DROP TABLE jev_anchor_meta;
      DROP TABLE jev_anchor_labels; DROP TABLE jev_anchor_states; DROP TABLE jev_anchor;
      DELETE FROM schema_migrations WHERE version = '${VERSION}'`);
    raw.close();
    RunStore.open(path).close();
    const s3 = RunStore.open(path);
    s3.close();
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(VERSION)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'improve_ticks'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT dflt_value FROM pragma_table_info('jev_models') WHERE name = 'generation'").get()).toEqual({ dflt_value: "0" });
    db.close();
  });
});

describe("anchor storage", () => {
  it("starts empty, stores rows in one transaction, and rejects a bad run letter without a partial write", () => {
    const s = RunStore.open(fresh());
    expect(s.anchorEmpty()).toBe(true);
    expect(() => s.insertAnchorRows([row("t1", "q1", "A"), { ...row("t1", "q1", "B"), run: "C" as "A" }])).toThrow();
    expect(s.anchorEmpty()).toBe(true);
    s.insertAnchorRows([row("t1", "q1", "A"), row("t1", "q1", "B"), row("t2", "q1", "A")]);
    expect(s.anchorEmpty()).toBe(false);
    expect(s.listAnchorTurns().sort()).toEqual(["t1", "t2"]);
    expect(s.listAnchorTurns("en")).toEqual([]);
    expect(s.anchorAnswers("A").map((r) => r.turn_id).sort()).toEqual(["t1", "t2"]);
    expect(s.anchorAnswers("B")).toHaveLength(1);
    s.close();
  });

  it("round-trips states, labels and meta", () => {
    const s = RunStore.open(fresh());
    s.insertAnchorStates([{ turn_id: "t1", lang: "zh", state_json: "{}", state_hash: "sh" }]);
    s.insertAnchorLabels([{ turn_id: "t1", category: "lesson", by: "paco", at: NOW }]);
    expect(s.anchorStates()).toEqual([{ turn_id: "t1", lang: "zh", state_json: "{}", state_hash: "sh" }]);
    expect(s.anchorLabels()).toEqual([{ turn_id: "t1", category: "lesson", by: "paco", at: NOW }]);
    expect(s.getAnchorMeta("k")).toBeUndefined();
    s.setAnchorMeta("k", '{"v":1}');
    s.setAnchorMeta("k", '{"v":2}');
    expect(s.getAnchorMeta("k")).toBe('{"v":2}');
    s.close();
  });
});

describe("jev models", () => {
  it("notes a new model as checking once, keeping the first-seen time", () => {
    const s = RunStore.open(fresh());
    s.noteJevModel("m1", NOW);
    s.noteJevModel("m1", "2026-10-23T00:00:00.000Z");
    expect(s.getJevModel("m1")).toMatchObject({ model: "m1", first_seen_at: NOW, state: "checking", attempts: 0, generation: 0, checked_at: null });
    expect(s.listJevModels()).toHaveLength(1);
    s.close();
  });

  it("fences a state change on the previous state: the second writer loses", () => {
    const s = RunStore.open(fresh());
    s.noteJevModel("m1", NOW);
    expect(s.setJevModelState("m1", "checking", "trusted", '{"ok":1}', NOW)).toBe(true);
    expect(s.setJevModelState("m1", "checking", "drifted", "{}", NOW)).toBe(false);
    expect(s.getJevModel("m1")).toMatchObject({ state: "trusted", detail_json: '{"ok":1}', checked_at: NOW });
    expect(s.setJevModelState("m1", "trusted", "checking", "{}", "2026-10-23T00:00:00.000Z")).toBe(true);
    expect(s.getJevModel("m1")?.checked_at).toBe(NOW); // checked_at moves only on a terminal state, never on checking
    expect(() => s.setJevModelState("m1", "checking", "bogus" as "trusted", "{}", NOW)).toThrow();
    s.close();
  });

  it("bumps attempts and the check generation", () => {
    const s = RunStore.open(fresh());
    s.noteJevModel("m1", NOW);
    s.bumpJevModelAttempts("m1");
    s.bumpJevModelAttempts("m1");
    expect(s.getJevModel("m1")?.attempts).toBe(2);
    expect(s.bumpJevModelGeneration("m1")).toBe(1);
    expect(s.bumpJevModelGeneration("m1")).toBe(2);
    expect(s.getJevModel("m1")?.generation).toBe(2);
    s.close();
  });

  it("discovers jev models from llm_attempt rows after the cursor only, ignoring other providers", () => {
    const path = fresh();
    const s = RunStore.open(path);
    expect(s.getJevModelCursor()).toBe(0);
    s.close();
    ledgerAttempt(path, "e1", "jev", "m1");
    ledgerAttempt(path, "e2", "omp", "other");
    const s2 = RunStore.open(path);
    const first = s2.jevAttemptModelsSince(s2.getJevModelCursor());
    expect(first.map((r) => r.model)).toEqual(["m1"]);
    s2.setJevModelCursor(first[0]!.rowid);
    s2.close();
    ledgerAttempt(path, "e3", "jev", "m2");
    const s3 = RunStore.open(path);
    expect(s3.jevAttemptModelsSince(s3.getJevModelCursor()).map((r) => r.model)).toEqual(["m2"]);
    s3.close();
  });
});

describe("model-keyed check runs", () => {
  it("keys by (model, generation, entry, run): one generation's result is never read as another's", () => {
    const s = RunStore.open(fresh());
    s.recordJevCheckRun({ model: "m1", generation: 1, entry_id: "memory.kind", run: "golden", outcome: "ok", detail_json: "{}", created_at: NOW });
    expect(s.getJevCheckRun("m1", 1, "memory.kind", "golden")?.outcome).toBe("ok");
    expect(s.getJevCheckRun("m1", 2, "memory.kind", "golden")).toBeUndefined();
    expect(s.getJevCheckRun("m2", 1, "memory.kind", "golden")).toBeUndefined();
    s.recordJevCheckRun({ model: "m1", generation: 1, entry_id: "memory.kind", run: "golden", outcome: "drift", detail_json: "{}", created_at: NOW });
    expect(s.getJevCheckRun("m1", 1, "memory.kind", "golden")?.outcome).toBe("ok"); // first write wins: a replay cannot rewrite a recorded run
    s.close();
  });
});
