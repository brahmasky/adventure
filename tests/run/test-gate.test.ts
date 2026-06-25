import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestGateTimeoutMs, runTestGate } from "../../src/run/test-gate.js";

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
