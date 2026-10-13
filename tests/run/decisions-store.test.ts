import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OutcomeRejected } from "../../src/decisions/outcomes.js";
import { DecisionRejected, LadderMoveRefused, RunStore, type DecisionInsert, type LadderMoveInsert } from "../../src/run/run-store.js";

// Spec §5.2 / §4.3: the decision ledger holds ids, enums and numbers only (no state column), outcomes are closed values,
// a review label is one-shot per decision, and only approval.standing's code may write an automatic ladder move — for
// tool.policy only — while every other loosening row needs Paco's callback id and a locked entry refuses every move.
const D: DecisionInsert = { entry_id: "turn.handler", entry_version: 1, run_id: "run_1", tool_call_id: null, stage: "pre_model", rung: "system_one",
  verdict: "planner", p: 0.62, reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 12,
  created_at: "2026-10-12T10:00:00.000Z" };
interface RawDb { prepare(sql: string): { all<T = unknown>(...v: string[]): T[]; get<T = unknown>(...v: string[]): T | undefined } }
const raw = (store: RunStore) => (store as unknown as { db: RawDb }).db;
const MOVE: LadderMoveInsert = { entry_id: "tool.policy", scope: "fp:a0362e7ddf", from_rung: "paco", to_rung: "rule", evidence: ["dec_1", "dec_2", "dec_3"],
  granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true };

describe("decisions", () => {
  it("inserts and reads a row; the table has no state column and no text column beyond the closed values", () => {
    const store = RunStore.openInMemory();
    const id = store.insertDecision(D);
    expect(id).toMatch(/^dec_[0-9a-f-]{36}$/);
    expect(store.getDecision(id)).toMatchObject({ ...D, decision_id: id });
    const cols = raw(store).prepare("PRAGMA table_info(decisions)").all<{ name: string }>().map((c) => c.name);
    expect(cols).toEqual(["decision_id", "entry_id", "entry_version", "run_id", "tool_call_id", "stage", "rung", "verdict", "p", "reason_code",
      "fallback_reason", "fallback_rung", "armed_mode", "latency_ms", "created_at", "p_index", "reask", "p_first"]);
    store.close();
  });
  // Plan ruling 15 (senior W7): sets a later stage extends are checked in code, so extending one is a constant edit, not
  // the table rebuild stage B's lane widening needed (run-store.ts:7124); sets the spec fixes keep their CHECK.
  it("growing enums are refused in code (DecisionRejected), fixed ones by the schema; no CHECK freezes a growing set", () => {
    const store = RunStore.openInMemory();
    for (const bad of [{ stage: "lunch" }, { fallback_reason: "vibes" }]) {
      expect(() => store.insertDecision({ ...D, ...bad } as DecisionInsert)).toThrow(DecisionRejected);
    }
    for (const bad of [{ rung: "oracle" }, { armed_mode: "maybe" }, { fallback_rung: "oracle" }]) {
      expect(() => store.insertDecision({ ...D, ...bad } as DecisionInsert)).toThrow(/CHECK constraint failed/);
    }
    const sql = Object.fromEntries(raw(store).prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('decisions', 'decision_outcomes')")
      .all<{ name: string; sql: string }>().map((t) => [t.name, t.sql]));
    expect(sql.decisions).not.toMatch(/stage TEXT NOT NULL CHECK|fallback_reason TEXT CHECK/);
    expect(sql.decision_outcomes).not.toMatch(/signal TEXT NOT NULL CHECK/);
    store.close();
  });
  it("fallback and skip counts read fallback_reason and fallback_rung, per entry, in the window", () => {
    const store = RunStore.openInMemory();
    store.insertDecision({ ...D, rung: "fail", fallback_reason: "timeout", fallback_rung: "system_one", created_at: "2026-10-12T10:01:00.000Z" });
    store.insertDecision({ ...D, rung: "fail", fallback_reason: "outage", fallback_rung: "system_one", created_at: "2026-10-12T10:02:00.000Z" });
    store.insertDecision({ ...D, rung: "fail", fallback_reason: null, armed_mode: "shadow", created_at: "2026-10-12T10:03:00.000Z" });
    store.insertDecision({ ...D, rung: "rule", reason_code: "posture", created_at: "2026-10-12T10:04:00.000Z" });
    store.insertDecision({ ...D, rung: "fail", fallback_reason: "budget", fallback_rung: "system_one", created_at: "2026-10-12T10:05:00.000Z" });
    store.insertDecision({ ...D, rung: "fail", fallback_reason: "outage", fallback_rung: "model", reason_code: "cascade_failed", created_at: "2026-10-12T10:05:30.000Z" });
    store.insertDecision({ ...D, entry_id: "turn.gear", rung: "fail", fallback_reason: "timeout", fallback_rung: "system_one", created_at: "2026-10-12T10:06:00.000Z" });
    // named, non-budget fails: two on the Jev rung and one cascade failure; with the Jev rung paged elsewhere (ruling 9) only the cascade's
    expect(store.countDecisionFallbacks("turn.handler", "2026-10-12T09:59:00.000Z")).toBe(3);
    expect(store.countDecisionFallbacks("turn.handler", "2026-10-12T09:59:00.000Z", true)).toBe(1);
    // attempts: every non-rule row except a budget skip (state too large is not a Jev call); failed: the silent four, on the Jev rung only
    expect(store.countDecisionJevSkips("turn.handler", "2026-10-12T09:00:00.000Z", "2026-10-12T11:00:00.000Z")).toEqual({ attempts: 4, failed: 2 });
    expect(store.hasJevAnsweredDecisionSince("turn.handler", "2026-10-12T09:00:00.000Z")).toBe(false);
    store.insertDecision({ ...D, created_at: "2026-10-12T10:07:00.000Z" });
    expect(store.hasJevAnsweredDecisionSince("turn.handler", "2026-10-12T10:06:30.000Z")).toBe(true);
    expect(store.listDecisionsBetween("2026-10-12T10:03:30.000Z", "2026-10-12T10:05:00.000Z").map((r) => r.reason_code)).toEqual(["posture", "routed"]);
    store.close();
  });
});

describe("decision_outcomes", () => {
  it("a review label is one-shot per decision; a second (either label) is not inserted", () => {
    const store = RunStore.openInMemory();
    const id = store.insertDecision(D);
    expect(store.insertDecisionOutcome({ decision_id: id, signal: "review_bad", value: "turn.handler", source: "paco" }).inserted).toBe(true);
    expect(store.insertDecisionOutcome({ decision_id: id, signal: "review_ok", value: "turn.handler", source: "paco" })).toEqual({ inserted: false, outcome_id: null });
    expect(store.listDecisionOutcomes(id).map((o) => [o.signal, o.value, o.source])).toEqual([["review_bad", "turn.handler", "paco"]]);
    store.close();
  });
  it("the insert rejects a value outside the signal's closed set and an unknown decision", () => {
    const store = RunStore.openInMemory();
    const id = store.insertDecision(D);
    expect(() => store.insertDecisionOutcome({ decision_id: id, signal: "review_bad", value: "free text", source: "paco" })).toThrow(OutcomeRejected);
    expect(() => store.insertDecisionOutcome({ decision_id: "dec_missing", signal: "review_bad", value: "turn.handler", source: "paco" })).toThrow(/decision_not_found/);
    store.close();
  });
});

describe("ladder_moves (spec §4.3)", () => {
  it("approval.standing may insert an automatic move for tool.policy", () => {
    const store = RunStore.openInMemory();
    expect(store.insertLadderMove(MOVE)).toMatch(/^lm_/);
    store.close();
  });
  it("refuses an automatic move from any other code, for any other entry, a Paco move without a callback id, and every locked entry", () => {
    const store = RunStore.openInMemory();
    const refused = (m: LadderMoveInsert) => { try { store.insertLadderMove(m); return "inserted"; } catch (e) { return e instanceof LadderMoveRefused ? e.code : "other"; } };
    expect(refused({ ...MOVE, granted_via: "improve.route" })).toBe("auto_not_standing");
    expect(refused({ ...MOVE, entry_id: "tool.shell_class" })).toBe("auto_not_standing");
    expect(refused({ ...MOVE, granted_by: "paco", granted_via: null, paco_callback_id: null, entry_id: "tool.injection" })).toBe("paco_needs_callback");
    expect(refused({ ...MOVE, granted_by: "paco", granted_via: null, paco_callback_id: "cb_1", entry_id: "tool.path" })).toBe("locked_entry");
    expect(refused({ ...MOVE, granted_by: "paco", granted_via: null, paco_callback_id: "cb_1", entry_id: "tool.injection" })).toBe("inserted");
    store.close();
  });
  it("one Paco callback authorises one move only (spec §4.3 one-shot, in the schema)", () => {
    const store = RunStore.openInMemory();
    const m: LadderMoveInsert = { ...MOVE, granted_by: "paco", granted_via: null, paco_callback_id: "cb_7", entry_id: "tool.injection" };
    store.insertLadderMove(m);
    expect(() => store.insertLadderMove({ ...m, scope: "fp:other" })).toThrow(/UNIQUE constraint failed/);
    store.close();
  });
});

describe("the digest latch and offers", () => {
  it("one row per local date; offered ids are found within the window only", () => {
    const store = RunStore.openInMemory();
    expect(store.recordDecisionDigest({ local_date: "2026-10-12", sent: true, offered: ["dec_a", "dec_b"], created_at: "2026-10-12T10:00:00.000Z" })).toBe(true);
    expect(store.recordDecisionDigest({ local_date: "2026-10-12", sent: false, offered: [], created_at: "2026-10-12T11:00:00.000Z" })).toBe(false);
    expect(store.getDecisionDigest("2026-10-12")).toMatchObject({ local_date: "2026-10-12", sent: 1, offered: ["dec_a", "dec_b"] });
    expect(store.wasDecisionOffered("dec_b", "2026-10-11T00:00:00.000Z")).toBe(true);
    expect(store.wasDecisionOffered("dec_b", "2026-10-12T10:00:00.000Z")).toBe(false);
    expect(store.wasDecisionOffered("dec_z", "2026-10-11T00:00:00.000Z")).toBe(false);
    store.close();
  });
});

describe("the link columns and the migration", () => {
  it("jev_decisions.ladder_decision_id and jev_verdicts.decision_id are written and indexed", () => {
    const store = RunStore.openInMemory();
    const dec = store.insertDecision(D);
    store.insertJevDecision({ run_id: "run_1", point: "triage", question_id: null, criteria_hash: null, model_reported: null, state_hash: null, lang: "zh",
      answers_json: null, confidence: null, top_prob: null, margin: null, threshold_version: null, threshold_used: null, decision: null, latency_ms: null,
      input_tokens: null, status: "skipped", skip_reason: "transport", ladder_decision_id: dec });
    store.insertJevVerdict({ run_id: "run_1", category: null, breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "planner",
      role: "default", effort: null, cascade: null, save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: "transport",
      quoted_turn_id: null, decision_id: dec });
    expect(store.listJevDecisions("run_1")[0]?.ladder_decision_id).toBe(dec);
    expect(store.getJevVerdictForRun("run_1")?.decision_id).toBe(dec);
    const idx = raw(store).prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('jev_decisions_ladder_idx', 'jev_verdicts_decision_idx')").all();
    expect(idx).toHaveLength(2);
    store.close();
  });
  // The stage B rebuild (2026-10-10-jev-verdicts-lanes) recreates jev_verdicts without the new column when it runs late
  // (tests/run/jev-verdicts-store.test.ts:126 does exactly this): the ladder migration must put the column back on that open.
  it("re-adds the link column after the stage B rebuild recreated jev_verdicts, and one schema_migrations row survives reopen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hdec-")), "h.sqlite");
    RunStore.open(path).close();
    const db = new DatabaseSync(path);
    db.exec(`
      DROP INDEX jev_verdicts_decision_idx;
      DROP TABLE jev_verdicts;
      DELETE FROM schema_migrations WHERE version = '2026-10-10-jev-verdicts-lanes';
      CREATE TABLE jev_verdicts (
        verdict_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, category TEXT, breadth REAL, reasoning REAL, actions REAL, sets_rule REAL, rule_scope TEXT,
        lane TEXT NOT NULL, role TEXT NOT NULL, effort TEXT, model TEXT, cascade TEXT, save_outcome TEXT NOT NULL, route_outcome TEXT NOT NULL,
        handler_outcome TEXT NOT NULL, reason TEXT NOT NULL, skip_reason TEXT, fast_used_tool INTEGER NOT NULL DEFAULT 0, paco_correction TEXT,
        quoted_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );`);
    db.close();
    const store = RunStore.open(path);
    expect(raw(store).prepare("PRAGMA table_info(jev_verdicts)").all<{ name: string }>().some((c) => c.name === "decision_id")).toBe(true);
    expect(raw(store).prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '2026-10-12-decision-ladder'").get<{ n: number }>()?.n).toBe(1);
    store.close();
  });
});
