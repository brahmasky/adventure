import { describe, expect, it } from "vitest";
import { buildToolApprovalPromptText, DecisionRejected, RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Stage 2a's ledger: the re-ask (noise band) and the max-over-passages index must be on the decision row, or the digest
// cannot count re-asks and calibration cannot tell which passage a p came from; the trust-tap budget and the golden-set
// latch are one row per local date. Every addition is a nullable column or a new table (R13: the stage 1 build must
// still boot on a migrated DB).
const row = (o: Partial<DecisionInsert> = {}): DecisionInsert => ({ entry_id: "tool.injection", entry_version: 1, run_id: null, tool_call_id: "tc1",
  stage: "post_tool", rung: "system_one", verdict: "withhold", p: 0.81, reason_code: "jev_withheld", fallback_reason: null, fallback_rung: null,
  armed_mode: "on", latency_ms: 900, ...o });

describe("decisions: p_index, reask, p_first", () => {
  it("round-trips the three columns, and a stage 1 literal without them stores nulls", () => {
    const s = RunStore.openInMemory();
    const a = s.getDecision(s.insertDecision(row({ p_index: 3, reask: "mean", p_first: 0.77 })));
    expect(a).toMatchObject({ p_index: 3, reask: "mean", p_first: 0.77 });
    const b = s.getDecision(s.insertDecision(row()));
    expect(b).toMatchObject({ p_index: null, reask: null, p_first: null });
    s.close();
  });
  it("refuses a reask value outside the closed set (the ledger holds closed enums only)", () => {
    const s = RunStore.openInMemory();
    expect(() => s.insertDecision(row({ reask: "twice" as never }))).toThrow(DecisionRejected);
    s.close();
  });
  it("the migration is additive and idempotent: 35 migrations, the columns once", () => {
    const s = RunStore.openInMemory();
    const db = (s as unknown as { db: { prepare(q: string): { all(): Array<{ name: string }> ; get(): { n: number } } } }).db;
    const cols = db.prepare(`PRAGMA table_info(decisions)`).all().map((c) => c.name);
    expect(cols.filter((c) => ["p_index", "reask", "p_first"].includes(c))).toEqual(["p_index", "reask", "p_first"]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '2026-10-13-decision-ladder-2a'`).get().n).toBe(1);
    s.close();
  });
});

describe("trust tap budget (spec §7.2)", () => {
  it("counts per local date and starts a new date at zero", () => {
    const s = RunStore.openInMemory();
    expect(s.bumpTrustTapBudget("2026-10-13", "2026-10-13T01:00:00.000Z")).toBe(1);
    expect(s.bumpTrustTapBudget("2026-10-13", "2026-10-13T02:00:00.000Z")).toBe(2);
    expect(s.trustTapCount("2026-10-13")).toBe(2);
    expect(s.trustTapCount("2026-10-14")).toBe(0);
    expect(s.bumpTrustTapBudget("2026-10-14", "2026-10-14T01:00:00.000Z")).toBe(1);
    s.close();
  });
});

describe("tap outcomes for the calibration report", () => {
  it("joins each outcome to its decision, filtered by entry and time", () => {
    const s = RunStore.openInMemory();
    const d = s.insertDecision(row({ entry_id: "turn.handler", stage: "pre_model", verdict: "lookup", run_id: "run_a", tool_call_id: null, created_at: "2026-10-13T00:00:00.000Z" }));
    const other = s.insertDecision(row({ created_at: "2026-10-13T00:00:00.000Z" }));
    s.insertDecisionOutcome({ decision_id: d, signal: "dig_deeper", value: "lookup", source: "paco", created_at: "2026-10-13T01:00:00.000Z" });
    s.insertDecisionOutcome({ decision_id: other, signal: "review_bad", value: "turn.gear", source: "paco", created_at: "2026-10-13T01:00:00.000Z" });
    expect(s.listTapOutcomes("2026-10-12T00:00:00.000Z", ["turn.handler"])).toEqual([expect.objectContaining({ signal: "dig_deeper", value: "lookup",
      entry_id: "turn.handler", run_id: "run_a", verdict: "lookup" })]);
    expect(s.listTapOutcomes("2026-10-13T02:00:00.000Z", ["turn.handler"])).toEqual([]);
    s.close();
  });
});

describe("golden-set latch, redactor seam, card reason", () => {
  it("one golden run per local date and entry", () => {
    const s = RunStore.openInMemory();
    expect(s.recordGoldenRun({ local_date: "2026-10-13", entry_id: "tool.injection", outcome: "ok" })).toBe(true);
    expect(s.recordGoldenRun({ local_date: "2026-10-13", entry_id: "tool.injection", outcome: "drift" })).toBe(false);
    expect(s.getGoldenRun("2026-10-13", "tool.injection")?.outcome).toBe("ok");
    s.close();
  });
  it("redactSecretValues is the broker's redactor (identity without one)", () => {
    const masked = RunStore.openInMemory({ redact: (t) => t.replaceAll("hunter2-secret", "‹secret›") });
    expect(masked.redactSecretValues("pw hunter2-secret")).toBe("pw ‹secret›");
    expect(RunStore.openInMemory().redactSecretValues("pw hunter2-secret")).toBe("pw hunter2-secret");
  });
  it("a trust card states why it asks", () => {
    const text = buildToolApprovalPromptText("appr_1", { run_id: "r", worker_id: "w", tool_call_id: "t", capability: "lesson_write", input_hash: "h",
      action_fingerprint: "f", requester: { kind: "user", id: "1" }, summary: "lesson_write", side_effect_level: "none", expires_at: "2026-10-13T00:05:00.000Z",
      reason: "this turn read text aimed at the assistant" });
    expect(text).toContain("Why: this turn read text aimed at the assistant");
  });
  it("turn_trust and turn_trust_final are ledger types with their required fields", () => {
    const s = RunStore.openInMemory(); const run_id = createQueuedTurnRun(s);
    s.appendRunLedgerEvent(run_id, "turn_trust", "core", { level: "hostile", cause: "injection_withheld" });
    s.appendRunLedgerEvent(run_id, "turn_trust_final", "core", { max_level: "hostile" });
    expect(() => s.appendRunLedgerEvent(run_id, "turn_trust_final", "core", {})).toThrow();
    expect(s.getLedgerEvents(run_id).filter((e) => e.event_type.startsWith("turn_trust")).map((e) => e.event_type)).toEqual(["turn_trust", "turn_trust_final"]);
    s.close();
  });
});
