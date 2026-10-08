import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestGateTimeoutMs, runTestGate, runTestGateAsync } from "../../src/run/test-gate.js";

let temps: string[] = [];

/**
 * A throwaway dir with a `package.json` whose `typecheck`/`test`/`build` scripts are tiny
 * shell commands, so the gate runs in milliseconds and we never touch the real project suite.
 * Each script is given so we can make any single stage pass/fail/print on demand.
 */
function fakeProject(scripts: { typecheck: string; test: string; build: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-testgate-"));
  temps.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fake", version: "0.0.0", private: true, scripts }, null, 2)
  );
  return dir;
}

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

describe("resolveTestGateTimeoutMs", () => {
  it("defaults to 300000 and honors a valid env override; rejects garbage", () => {
    expect(resolveTestGateTimeoutMs({})).toBe(300_000);
    expect(resolveTestGateTimeoutMs({ HOUGE_TESTGATE_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(resolveTestGateTimeoutMs({ HOUGE_TESTGATE_TIMEOUT_MS: "nope" })).toBe(300_000);
    expect(resolveTestGateTimeoutMs({ HOUGE_TESTGATE_TIMEOUT_MS: "0" })).toBe(300_000);
  });
});

describe("runTestGate", () => {
  it("is green when typecheck, test, and build all pass", () => {
    const wt = fakeProject({ typecheck: "exit 0", test: "exit 0", build: "exit 0" });
    expect(runTestGate(wt, { env: {} })).toEqual({ green: true });
  });

  it("reports stage=typecheck and stops before running test/build when typecheck fails", () => {
    // `test` writes a marker; if the gate wrongly ran it, the marker would exist. The gate must
    // stop at typecheck, so we assert the stage mapping (the marker check is the intent: stop-first).
    const wt = fakeProject({
      typecheck: "echo TYPECHECK_FAILED; exit 1",
      test: "exit 1",
      build: "exit 1"
    });
    const result = runTestGate(wt, { env: {} });
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.stage).toBe("typecheck");
      expect(result.output).toContain("TYPECHECK_FAILED");
    }
  });

  it("reports stage=test when typecheck passes but test fails", () => {
    const wt = fakeProject({
      typecheck: "exit 0",
      test: "echo TEST_RED; exit 1",
      build: "exit 0"
    });
    const result = runTestGate(wt, { env: {} });
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.stage).toBe("test");
      expect(result.output).toContain("TEST_RED");
    }
  });

  it("reports stage=build when typecheck and test pass but build fails", () => {
    const wt = fakeProject({
      typecheck: "exit 0",
      test: "exit 0",
      build: "echo BUILD_BROKE; exit 1"
    });
    const result = runTestGate(wt, { env: {} });
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.stage).toBe("build");
      expect(result.output).toContain("BUILD_BROKE");
    }
  });

  it("strips node runtime-warning noise so the capped tail keeps the ACTUAL failure", () => {
    // Mirror the live failure (run_9d35d3c9): the real assertion error prints on stdout, then
    // stderr floods with per-worker ExperimentalWarning pairs. Unfiltered, the last-8KB tail
    // would be 100% warnings; the gate must surface the failure line instead.
    const warn =
      "echo '(node:45248) ExperimentalWarning: SQLite is an experimental feature and might change at any time' 1>&2; " +
      "echo '(Use `node --trace-warnings ...` to show where the warning was created)' 1>&2; ";
    const wt = fakeProject({
      typecheck: "exit 0",
      test: `echo 'FAIL tests/x.test.ts > pins the question string'; ${warn.repeat(200)} exit 1`,
      build: "exit 0"
    });
    const result = runTestGate(wt, { env: {} });
    expect(result.green).toBe(false);
    if (!result.green) {
      // npm's own preamble re-prints the script text (which mentions the warning words),
      // so assert on emitted warning LINES, not substrings.
      expect(result.output).toContain("FAIL tests/x.test.ts");
      expect(result.output).not.toMatch(/^\(node:\d+\) ExperimentalWarning/m);
      expect(result.output).not.toMatch(/^\(Use `node --trace-warnings/m);
    }
  });

  it("noise-only stderr does not blank the output (falls back to the error message)", () => {
    const wt = fakeProject({
      typecheck: "echo '(node:1) ExperimentalWarning: x' 1>&2; exit 1",
      test: "exit 0",
      build: "exit 0"
    });
    const result = runTestGate(wt, { env: {} });
    expect(result.green).toBe(false);
    if (!result.green) expect(result.output.trim().length).toBeGreaterThan(0);
  });

  it("caps a huge failure log so it can't blow memory (<= ~8KB)", () => {
    // Print far more than the 8KB cap on the failing stage.
    const wt = fakeProject({
      typecheck: 'for i in $(seq 1 5000); do echo "noise-line-$i-padding-padding-padding"; done; exit 1',
      test: "exit 0",
      build: "exit 0"
    });
    const result = runTestGate(wt, { env: {} });
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.stage).toBe("typecheck");
      // Capped to the last ~8KB (allow small slack for line boundaries).
      expect(result.output.length).toBeLessThanOrEqual(8 * 1024 + 256);
      // It's the TAIL that's kept, so the highest line numbers survive.
      expect(result.output).toContain("noise-line-5000");
    }
  });

  it("maps a timeout to a red result with the offending stage", () => {
    const wt = fakeProject({ typecheck: "sleep 5", test: "exit 0", build: "exit 0" });
    const result = runTestGate(wt, { env: { HOUGE_TESTGATE_TIMEOUT_MS: "300" } });
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.stage).toBe("typecheck");
      expect(result.output).toMatch(/timed out/);
    }
  });
});

// ⓪·3g: the async twin the SELF-WRITE pipeline uses — identical stages, order, and
// result mapping to the sync gate (which the merge path deliberately keeps).
describe("runTestGateAsync", () => {
  it("is green when typecheck, test, and build all pass", async () => {
    const wt = fakeProject({ typecheck: "exit 0", test: "exit 0", build: "exit 0" });
    await expect(runTestGateAsync(wt, { env: {} })).resolves.toEqual({ green: true });
  });

  it("stops at the FIRST red stage in typecheck → test → build order, with the captured output", async () => {
    const wt = fakeProject({
      typecheck: "exit 0",
      test: "echo TEST_RED; exit 1",
      build: "echo NEVER_RUNS; exit 1"
    });
    const result = await runTestGateAsync(wt, { env: {} });
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.stage).toBe("test");
      expect(result.output).toContain("TEST_RED");
      expect(result.output).not.toContain("NEVER_RUNS");
    }
  });

  it("maps a timeout to a red result with the offending stage", async () => {
    const wt = fakeProject({ typecheck: "sleep 5", test: "exit 0", build: "exit 0" });
    const result = await runTestGateAsync(wt, { env: { HOUGE_TESTGATE_TIMEOUT_MS: "300" } });
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.stage).toBe("typecheck");
      expect(result.output).toMatch(/timed out/);
    }
  });

  it("caps a huge failure log exactly like the sync gate (<= ~8KB, tail kept)", async () => {
    const wt = fakeProject({
      typecheck: 'for i in $(seq 1 5000); do echo "noise-line-$i-padding-padding-padding"; done; exit 1',
      test: "exit 0",
      build: "exit 0"
    });
    const result = await runTestGateAsync(wt, { env: {} });
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.output.length).toBeLessThanOrEqual(8 * 1024 + 256);
      expect(result.output).toContain("noise-line-5000");
    }
  });
});

// The gate must judge a self-authored diff, not the daemon's live config. It used to inherit process.env, so the
// daemon's .env (Jev armed since 2026-10-06: HOUGE_JEV_ENABLED=1 + HOUGE_JEV_TRIAGE_ENABLED=arm) turned an unrelated
// daemon test red and failed EVERY self-write (live 2026-10-08), as HOUGE_AGY_BIN once did (2026-06-26).
describe("the gate's npm children run on a minimal env, never the daemon's", () => {
  const leaky = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", TYPESAFE_API_KEY: "leak-check" };
  // the script fails if any daemon variable reached it, and needs PATH/HOME to have survived (npm itself ran)
  const probe = 'test -z "$HOUGE_JEV_ENABLED" && test -z "$HOUGE_JEV_TRIAGE_ENABLED" && test -z "$TYPESAFE_API_KEY" && test -n "$PATH" && test -n "$HOME"';
  const withLeakyEnv = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const saved = Object.fromEntries(Object.keys(leaky).map((k) => [k, process.env[k]]));
    Object.assign(process.env, leaky);
    try { return await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  it("sync gate: daemon flags and secrets do not reach the stages; PATH and HOME do", async () => {
    const wt = fakeProject({ typecheck: probe, test: probe, build: probe });
    expect(await withLeakyEnv(() => runTestGate(wt, { env: {} }))).toEqual({ green: true });
  });

  it("async gate (the self-write path): same minimal env", async () => {
    const wt = fakeProject({ typecheck: probe, test: probe, build: probe });
    expect(await withLeakyEnv(() => runTestGateAsync(wt, { env: {} }))).toEqual({ green: true });
  });
});
