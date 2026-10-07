import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOmpPanelSeats, PANEL_JUDGE_SEAT_INDEX } from "../../src/capabilities/idea-panel-seats.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { formatModelString } from "../../src/omp/model-string.js";
import { RunStore } from "../../src/run/run-store.js";
import { FAKE_OMP_BIN, pinOmpEnv } from "../helpers/omp-env.js";

// The panel seats on omp (spec §8, ruling 8): each judge is pinned to ONE `HOUGE_OMP_JUDGES` string
// by index (never a chain — a healthy-leg fallback would void the quorum's model diversity), and the
// chair rides `HOUGE_OMP_CHAIR`. The old contained claude/codex spawns are gone with the claude CLI.
pinOmpEnv();
let dir: string;
let store: RunStore;
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "houge-seats-"));
  store = RunStore.openInMemory();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function fake(scenario: Record<string, unknown>): NodeJS.ProcessEnv {
  writeFileSync(join(dir, "s.json"), JSON.stringify(scenario));
  process.env.FAKE_OMP_SCENARIO = join(dir, "s.json");
  process.env.FAKE_OMP_ARGV_LOG = join(dir, "argv.log");
  return { HOUGE_OMP_BIN: FAKE_OMP_BIN, HOUGE_OMP_SANDBOX: "0", HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG" };
}
const spawns = () => (existsSync(join(dir, "argv.log")) ? readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; stdin: string }) : []);
const modelOf = (argv: string[]) => argv[argv.indexOf("--model") + 1];
const rows = (role: string) => store.getLedgerEventsByCorrelation("tick:idea_panel").filter((e) => e.event_type === "llm_attempt" && e.payload.role === role).map((e) => e.payload);

describe("buildOmpPanelSeats — the four panel seats on omp", () => {
  it("each judge seat spawns exactly its own HOUGE_OMP_JUDGES string, one leg, digest on stdin", async () => {
    const env = fake({ "*": { text: '{"scores":[]}' } });
    const cfg = resolveOmpConfig(env);
    const seats = buildOmpPanelSeats({ store, correlation_id: "tick:idea_panel", env });
    expect(await seats.judges.kimi({ question: "DIGEST-K", system: "lens" })).toEqual({ ok: true, answer: '{"scores":[]}' });
    await seats.codexJudge({ digest: "DIGEST-C", system: "lens" });
    await seats.judges.gemini({ question: "DIGEST-G", system: "lens" });
    const want = (name: keyof typeof PANEL_JUDGE_SEAT_INDEX) => { const m = cfg.judges[PANEL_JUDGE_SEAT_INDEX[name]]!; return `${m.provider}/${m.model}`; };
    expect(spawns().map((s) => modelOf(s.argv))).toEqual([want("kimi"), want("codex"), want("gemini")]);
    expect(spawns()[0]?.stdin).toBe("lens\n\nDIGEST-K");
    expect(rows("judge")).toHaveLength(3);
  });

  it("a dead judge model is a failed seat, NEVER a fall-through to another model (quorum diversity)", async () => {
    const env = fake({ "kimi-code/k3": { exit: 1, stderr: "429 usage limit reached" }, "*": { text: "other model" } });
    const seats = buildOmpPanelSeats({ store, correlation_id: "tick:idea_panel", env });
    expect(await seats.judges.kimi({ question: "d", system: "s" })).toEqual({ ok: false });
    expect(spawns()).toHaveLength(1);
    expect(rows("judge")).toEqual([expect.objectContaining({ provider: "kimi-code", outcome: "error", error_kind: "quota" })]);
  });

  it("the chair runs on cfg.chair and is audited as chair", async () => {
    const env = fake({ "*": { text: '{"picks":[]}' } });
    const seats = buildOmpPanelSeats({ store, correlation_id: "tick:idea_panel", env });
    expect(await seats.chair({ digest: "D", system: "S" })).toEqual({ ok: true, answer: '{"picks":[]}' });
    const chairModel = resolveOmpConfig(env).chair[0]!;
    expect(modelOf(spawns()[0]!.argv)).toBe(`${chairModel.provider}/${chairModel.model}`);
    expect(rows("chair")).toEqual([expect.objectContaining({ outcome: "ok", family: "claude" })]);
  });

  it("an omp that cannot be asked makes every seat unavailable (the tick's mean-score fallback), with no spawn", async () => {
    const env = fake({ "*": { text: "never" } });
    const refuse = () => ({ ok: false as const, kind: "not_runnable" as const, version: null, reason: "omp not runnable" });
    const seats = buildOmpPanelSeats({ store, correlation_id: "tick:idea_panel", env, versionCheck: refuse });
    expect(await seats.chair({ digest: "D", system: "S" })).toEqual({ ok: false, unavailable: true });
    expect(spawns()).toEqual([]);
  });

  it("a judge index past the configured list is unavailable instead of borrowing another seat's model", async () => {
    const env = { ...fake({ "*": { text: "x" } }), HOUGE_OMP_JUDGES: "kimi-code/k3" };
    const seats = buildOmpPanelSeats({ store, correlation_id: "tick:idea_panel", env });
    expect(await seats.codexJudge({ digest: "d", system: "s" })).toEqual({ ok: false, unavailable: true });
    expect(spawns()).toEqual([]);
    expect(formatModelString(resolveOmpConfig(env).judges[0]!)).toBe("kimi-code/k3");
  });
});

describe("buildOmpPanelSeats — the daemon's stop", () => {
  it("a seat built with the stop signal spawns nothing once it has aborted", async () => {
    const env = fake({ "*": { text: '{"scores":[]}' } });
    const seats = buildOmpPanelSeats({ store, correlation_id: "tick:idea_panel", env, signal: AbortSignal.abort() });
    expect(await seats.judges.kimi({ question: "D", system: "lens" })).toEqual({ ok: false });
    expect(await seats.chair({ digest: "D", system: "chair" })).toEqual({ ok: false });
    expect(spawns()).toEqual([]);
  });
});
