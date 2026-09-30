// tests/llm/seat-routing.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { judgeSeat, oneShotAdapter, seatBudgetMs, seatChain } from "../../src/llm/registry.js";
import { RunStore } from "../../src/run/run-store.js";
import { FAKE_OMP_BIN, pinOmpEnv } from "../helpers/omp-env.js";

pinOmpEnv();

describe("seat routing — which subscription model serves each non-planner call (spec §8)", () => {
  const cfg = resolveOmpConfig({});
  it("puts the high-volume reader on Gemini Flash first and never on the planner's first model", () => {
    expect(seatChain(cfg, "reader")[0]?.model).toBe("gemini-3.8-flash");
    expect(seatChain(cfg, "reader").map((m) => m.model)).not.toContain(cfg.planner[0]?.model);
  });
  it("runs memory ticks on k3 at low effort", () => {
    expect(seatChain(cfg, "distill")).toEqual([{ provider: "kimi-code", model: "k3", effort: "low" }]);
    for (const role of ["consolidate", "extract", "attribution", "frame", "verify"] as const) expect(seatChain(cfg, role)).toEqual(cfg.ticks);
  });
  it("keeps the reviewer on a different family from the codex writer", () => {
    expect(seatChain(cfg, "reviewer").every((m) => !m.model.startsWith("gpt"))).toBe(true);
  });
  it("gives each judge seat exactly ONE string by index — a judge never falls back to another model (quorum diversity)", () => {
    expect(cfg.judges.map((_, i) => judgeSeat(cfg, i))).toEqual(cfg.judges.map((m) => [m]));
    expect(judgeSeat(cfg, cfg.judges.length)).toEqual([]);
  });
  it("puts the panel chair on cfg.chair and the photo reader on cfg.media", () => {
    expect(seatChain(cfg, "chair")).toEqual(cfg.chair);
    expect(seatChain(cfg, "media_transcribe")).toEqual(cfg.media);
  });
  it("refuses to route the codex writer through omp", () => {
    expect(() => seatChain(cfg, "writer")).toThrow(/codex/);
  });
  it("budgets a seat for every leg timing out, so the runner cap never kills a healthy fall-through", () => {
    expect(seatBudgetMs(cfg, "reader")).toBe(cfg.reader.length * cfg.oneshotTimeoutMs);
  });
});

describe("oneShotAdapter — the audited one-shot call every seat makes", () => {
  let dir: string;
  let store: RunStore;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "houge-seat-")); store = RunStore.openInMemory(); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  function fakeCfg(scenario: object) {
    writeFileSync(join(dir, "s.json"), JSON.stringify(scenario));
    process.env.FAKE_OMP_SCENARIO = join(dir, "s.json");
    process.env.FAKE_OMP_ARGV_LOG = join(dir, "argv.log");
    return resolveOmpConfig({ HOUGE_OMP_BIN: FAKE_OMP_BIN, HOUGE_OMP_SANDBOX: "0", HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG" });
  }
  const argv = () => readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; stdin: string });

  it("folds the system prompt ahead of the question on stdin and audits the leg under the scope's role", async () => {
    const cfg = fakeCfg({ "*": { text: "fine" } });
    const r = await oneShotAdapter(store, cfg, { correlation_id: "tick:t", role: "distill" }).answer({ question: "Q", system: "S" });
    expect(r).toMatchObject({ ok: true, answer: "fine" });
    expect(argv()[0]?.stdin).toBe("S\n\nQ");
    expect(argv()[0]?.argv).toContain("kimi-code/k3");
    const rows = store.getLedgerEventsByCorrelation("tick:t").filter((e) => e.event_type === "llm_attempt");
    expect(rows.map((e) => e.payload)).toEqual([expect.objectContaining({ role: "distill", outcome: "ok", family: "kimi" })]);
  });

  it("a version mismatch opens ONE omp_version_mismatch incident per version string and leaves no audit row", async () => {
    const cfg = fakeCfg({ "*": { text: "never" } });
    const refuse = () => ({ ok: false as const, kind: "version_mismatch" as const, version: "18.5.0", reason: "omp 18.5.0 is not the pinned 18.4.4" });
    const seat = oneShotAdapter(store, cfg, { correlation_id: "tick:v", role: "extract" }, undefined, { versionCheck: refuse });
    for (let i = 0; i < 3; i += 1) expect(await seat.answer({ question: "q" })).toMatchObject({ ok: false, unavailable: true });
    const open = store.listOpenIncidents().filter((i) => i.kind === "omp_version_mismatch");
    expect(open.map((i) => i.subject)).toEqual(["omp:18.5.0"]);
    expect(store.getLedgerEventsByCorrelation("tick:v").filter((e) => e.event_type === "llm_attempt")).toEqual([]);
  });

  it("I2: a check that never READ a version opens omp_unavailable — even when the reason text looks like a version", async () => {
    const cfg = fakeCfg({ "*": { text: "never" } });
    const refuse = () => ({ ok: false as const, kind: "not_runnable" as const, version: null, reason: "omp not runnable: omp 1.2.3 is not the pinned 18.4.4" });
    await oneShotAdapter(store, cfg, { correlation_id: "tick:u", role: "extract" }, undefined, { versionCheck: refuse }).answer({ question: "q" });
    expect(store.listOpenIncidents().map((i) => [i.kind, i.subject])).toEqual([["omp_unavailable", "omp:not_runnable"]]);
  });

  it("I2: a refused check carries a structured omp_check out of spawnOneShot (no regex over the error text)", async () => {
    const cfg = fakeCfg({ "*": { text: "never" } });
    const refuse = () => ({ ok: false as const, kind: "no_version" as const, version: null, reason: "printed nothing" });
    const r = await oneShotAdapter(store, cfg, { correlation_id: "tick:s", role: "extract" }, undefined, { versionCheck: refuse }).answer({ question: "q" });
    expect(r).toMatchObject({ ok: false, unavailable: true, omp_check: { kind: "no_version" } });
  });

  it("a reader on the planner's family still answers and records family_collapse + a wall_collapse event (D10)", async () => {
    const cfg = fakeCfg({ "*": { text: "digest" } });
    const r = await oneShotAdapter(store, cfg, { correlation_id: "tick:w", role: "reader" }, "gemini").answer({ question: "q" });
    expect(r.ok).toBe(true);
    const events = store.getLedgerEventsByCorrelation("tick:w");
    expect(events.find((e) => e.event_type === "llm_attempt")?.payload).toMatchObject({ family_collapse: true });
    expect(events.filter((e) => e.event_type === "wall_collapse")).toHaveLength(1);
  });
});
