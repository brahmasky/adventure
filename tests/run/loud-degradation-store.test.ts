import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_HEADS, TIER_IDS } from "../../src/omp/model-tiers.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.2 bootstrap (W4): the first boot of this build must resolve exactly today's working models, never an empty table
// (an empty table would run every role on its static fallback for a day). The tier rows are state the tick owns, so a reopen
// must never reseed over a tick's write. Probe outcomes are ledgered with codes only, never model output.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const fileStore = () => { const d = mkdtempSync(join(tmpdir(), "hld-")); dirs.push(d); return join(d, "h.sqlite"); };

describe("model_tiers migration", () => {
  it("seeds exactly one row per tier with the known-good head, no previous, no rejection", () => {
    const s = RunStore.openInMemory();
    const rows = s.listModelTiers();
    expect(rows.map((r) => [r.tier, r.adopted, r.previous, r.rejected_selector, r.rejected_at])).toEqual(
      [...TIER_IDS].sort().map((t) => [t, SEED_HEADS[t], null, null, null]));
    expect(rows.filter((r) => r.adopted_at === null).map((r) => r.tier)).toEqual(["gemini-pro"]);
    s.close();
  });
  it("a reopen never reseeds over a tick's write", () => {
    const path = fileStore();
    const a = RunStore.open(path);
    a.writeModelTier({ tier: "kimi", adopted: "k3.1-pro", previous: "k3", adopted_at: "2026-11-03T00:00:00.000Z", rejected_selector: null, rejected_at: null }, "2026-11-03T00:00:00.000Z");
    a.close();
    const b = RunStore.open(path);
    expect(b.getModelTier("kimi")).toEqual({ tier: "kimi", adopted: "k3.1-pro", previous: "k3", adopted_at: "2026-11-03T00:00:00.000Z",
      rejected_selector: null, rejected_at: null, updated_at: "2026-11-03T00:00:00.000Z" });
    expect(b.listModelTiers()).toHaveLength(TIER_IDS.length);
    b.close();
  });
  it("adds the two nullable planner_session_state columns", () => {
    const s = RunStore.openInMemory();
    const cols = db(s).prepare("PRAGMA table_info(planner_session_state)").all() as Array<{ name: string; notnull: number }>;
    expect(cols.filter((c) => c.name === "fresh_requested_at" || c.name === "transcript_trust_at").map((c) => [c.name, c.notnull]))
      .toEqual([["fresh_requested_at", 0], ["transcript_trust_at", 0]]);
    s.close();
  });
});

describe("model_probe", () => {
  it("is one run-less event with exactly the five code fields", () => {
    const s = RunStore.openInMemory();
    s.recordModelProbe({ tier: "kimi", selector: "kimi-code/k3.1-pro", purpose: "head", result: "pass", kind: "ok" });
    const rows = s.getLedgerEvents().filter((e) => e.event_type === "model_probe");
    expect(rows.map((e) => [e.run_id ?? null, e.correlation_id, e.payload])).toEqual([[null, "model-roles",
      { tier: "kimi", selector: "kimi-code/k3.1-pro", purpose: "head", result: "pass", kind: "ok" }]]);
    s.close();
  });
  it("refuses a free-text kind, result or purpose: the event is codes only, so error text can never enter the ledger", () => {
    const s = RunStore.openInMemory();
    const base = { tier: "kimi", selector: "kimi-code/k3.1-pro", purpose: "head", result: "pass", kind: "ok" } as const;
    const bad = (o: Record<string, string>) => () => s.recordModelProbe({ ...base, ...o } as never);
    expect(bad({ kind: "spawn ENOENT: /Users/x/.omp: secret" })).toThrow(/kind is not a closed code/);
    expect(bad({ result: "sort of" })).toThrow(/result is not a closed code/);
    expect(bad({ purpose: "whim" })).toThrow(/purpose is not a closed code/);
    expect(s.getLedgerEvents().filter((e) => e.event_type === "model_probe")).toEqual([]);
    s.close();
  });
  it("a probe's attempt is audited under role `probe`", () => {
    const s = RunStore.openInMemory();
    s.llmAuditSink({ correlation_id: "probe:x", role: "probe" }).record({ provider: "kimi-code", role: "", outcome: "ok", model: "k3.1-pro" });
    expect(s.getLedgerEvents().filter((e) => e.event_type === "llm_attempt").map((e) => [e.correlation_id, (e.payload as { role: string }).role])).toEqual([["probe:x", "probe"]]);
    s.close();
  });
});

describe("hostile_schedule_turn event migration", () => {
  // Why: rows a previous build left open would otherwise never close (the kind is an event now); the resolve is once only,
  // so a later open row of that kind is not touched by a reopen.
  it("resolves the old open rows once, with one incident_resolved event each", () => {
    const path = fileStore();
    const a = RunStore.open(path);
    for (const n of ["r1", "r2", "r3"]) a.openIncident({ kind: "hostile_schedule_turn", subject: n, detail: {}, now: "2026-11-01T00:00:00.000Z" });
    db(a).prepare(`DELETE FROM schema_migrations WHERE version = ?`).run("2026-11-02-hostile-schedule-event");
    a.close();
    const b = RunStore.open(path);
    expect(b.listOpenIncidents().filter((i) => i.kind === "hostile_schedule_turn")).toEqual([]);
    expect(b.getLedgerEvents().filter((e) => e.event_type === "incident_resolved" && (e.payload as { kind: string }).kind === "hostile_schedule_turn")).toHaveLength(3);
    b.openIncident({ kind: "hostile_schedule_turn", subject: "r4", detail: {}, now: "2026-11-02T00:00:00.000Z" });
    b.close();
    const c = RunStore.open(path);
    expect(c.listOpenIncidents().filter((i) => i.kind === "hostile_schedule_turn")).toHaveLength(1);
    c.close();
  });
});

describe("transcript_trust_at", () => {
  it("is set when the level changes and kept while it stays; a new row gets it too; a legacy row reads null", () => {
    const s = RunStore.openInMemory();
    s.setTranscriptTrust("42", "hostile", "2026-11-01T00:00:00.000Z");
    s.setTranscriptTrust("42", "hostile", "2026-11-02T00:00:00.000Z");
    expect(s.getTranscriptTrustSince("42")).toEqual({ level: "hostile", at: "2026-11-01T00:00:00.000Z" });
    s.setTranscriptTrust("42", "untrusted", "2026-11-03T00:00:00.000Z");
    expect(s.getTranscriptTrustSince("42")).toEqual({ level: "untrusted", at: "2026-11-03T00:00:00.000Z" });
    db(s).prepare("UPDATE planner_session_state SET transcript_trust_at = NULL WHERE chat_id = '42'").run();
    expect(s.getTranscriptTrustSince("42")).toEqual({ level: "untrusted", at: null });
    expect(s.getTranscriptTrustSince("nope")).toBeNull();
    s.close();
  });
});

// Spec 2026-11-02 §6.2: /fresh must survive a restart, and only the reset that served the stored request may clear it (N2).
describe("the /fresh marker", () => {
  it("is an upsert, survives a reopen, and only the commit that serves the stored request clears it (N2)", () => {
    const path = fileStore();
    const a = RunStore.open(path);
    a.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");                     // no row yet: inserted (P21b)
    a.close();
    const b = RunStore.open(path);
    expect(b.freshRequestedAt("42")).toBe("2026-11-02T01:00:00.000Z");
    b.requestFreshTranscript("42", "2026-11-02T02:00:00.000Z");                     // a second /fresh replaces it
    b.setTranscriptTrust("42", "hostile", "2026-11-02T00:00:00.000Z");
    expect(b.commitFreshTranscript("42", "2026-11-02T01:00:00.000Z", "2026-11-02T03:00:00.000Z")).toBe(false);
    expect(b.freshRequestedAt("42")).toBe("2026-11-02T02:00:00.000Z");
    expect(b.getTranscriptTrust("42")).toBe("hostile");                              // a commit that did not serve it lowers nothing
    expect(b.commitFreshTranscript("42", "2026-11-02T02:00:00.000Z", "2026-11-02T03:00:00.000Z")).toBe(true);
    expect([b.freshRequestedAt("42"), b.getTranscriptTrustSince("42")]).toEqual([null, { level: "clean", at: "2026-11-02T03:00:00.000Z" }]);
    b.close();
  });
  it("a fresh reset records reason fresh and no seed (P31); a lesson reset still seeds", () => {
    const s = RunStore.openInMemory();
    s.recordPlannerSessionReset("42", "fp", "t", "fresh");
    expect(s.getPlannerSessionState("42")).toMatchObject({ pending_fingerprint: "fp", seed_pending: 0 });
    s.recordPlannerSessionReset("43", "fp", "t");
    expect(s.getPlannerSessionState("43")).toMatchObject({ seed_pending: 1 });
    expect(s.getLedgerEvents().filter((e) => e.event_type === "planner_session_reset").map((e) => (e.payload as { reason: string }).reason)).toEqual(["fresh", "lesson_change"]);
    s.close();
  });
});
