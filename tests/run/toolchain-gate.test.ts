import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectStagePlan, runToolchainGate } from "../../src/run/toolchain-gate.js";
import type { ContainerRunResult, ContainerRuntime } from "../../src/run/container-runner.js";

const PINNED_ENV = ["HOUGE_EXTWORK_MEMORY", "HOUGE_EXTWORK_CPUS", "HOUGE_EXTWORK_PIDS", "HOUGE_EXTWORK_STAGE_TIMEOUT_MS"] as const;
let saved: Record<string, string | undefined> = {};
let dirs: string[] = [];
beforeEach(() => {
  saved = {};
  for (const k of PINNED_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of PINNED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A fixture workspace dir containing the given marker files. */
function fixtureDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-toolchain-"));
  dirs.push(dir);
  for (const f of files) writeFileSync(join(dir, f), "x");
  return dir;
}

const RT: ContainerRuntime = { bin: "docker" };

describe("detectStagePlan — ecosystem detection from workspace files", () => {
  it("node: npm ci (egress) then npm test (none)", () => {
    const plan = detectStagePlan(fixtureDir(["package.json"]));
    expect(plan.map((s) => s.cmd.join(" "))).toEqual(["npm ci", "npm test"]);
    expect(plan.map((s) => s.network)).toEqual(["egress", "none"]);
  });

  it("python: pip install (egress) then pytest (none)", () => {
    const plan = detectStagePlan(fixtureDir(["requirements.txt"]));
    expect(plan.map((s) => s.cmd[0])).toEqual(["pip", "pytest"]);
    expect(plan[0]!.network).toBe("egress");
    expect(plan[1]!.network).toBe("none");
  });

  it("rust: cargo build (egress fetch) then cargo test --offline (none)", () => {
    const plan = detectStagePlan(fixtureDir(["Cargo.toml"]));
    expect(plan.map((s) => s.cmd.join(" "))).toEqual(["cargo build", "cargo test --offline"]);
    expect(plan[1]!.network).toBe("none");
  });

  it("make: a single make stage (none)", () => {
    const plan = detectStagePlan(fixtureDir(["Makefile"]));
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ cmd: ["make"], network: "none" });
  });

  it("no recognized toolchain → empty plan", () => {
    expect(detectStagePlan(fixtureDir(["README.md"]))).toEqual([]);
  });
});

describe("runToolchainGate — first-red-stops, per-stage network, all injected", () => {
  function fakeRunner(results: ContainerRunResult[], calls: Array<{ cmd: string[]; network: string }>) {
    let i = 0;
    return async (_rt: ContainerRuntime, o: { cmd: string[]; network: string }): Promise<ContainerRunResult> => {
      calls.push({ cmd: o.cmd, network: o.network });
      return results[Math.min(i++, results.length - 1)]!;
    };
  }

  it("all green → ok, both stages ran with their declared networks", async () => {
    const calls: Array<{ cmd: string[]; network: string }> = [];
    const workspace = fixtureDir(["package.json"]);
    const result = await runToolchainGate({
      runtime: RT,
      workspace,
      image: "img",
      env: process.env,
      runInContainer: fakeRunner(
        [
          { exitCode: 0, output: "installed", timedOut: false },
          { exitCode: 0, output: "tests pass", timedOut: false }
        ],
        calls
      )
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { cmd: ["npm", "ci"], network: "egress" },
      { cmd: ["npm", "test"], network: "none" }
    ]);
  });

  it("first stage red → stops immediately, later stages never run, failedStage named", async () => {
    const calls: Array<{ cmd: string[]; network: string }> = [];
    const workspace = fixtureDir(["package.json"]);
    const result = await runToolchainGate({
      runtime: RT,
      workspace,
      image: "img",
      env: process.env,
      runInContainer: fakeRunner([{ exitCode: 1, output: "npm ci exploded", timedOut: false }], calls)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStage).toBe("npm ci");
      expect(result.output).toContain("npm ci exploded");
    }
    // The test stage was never reached.
    expect(calls).toHaveLength(1);
  });

  it("a vanished runtime mid-run surfaces as unavailable (graceful, not a throw)", async () => {
    const calls: Array<{ cmd: string[]; network: string }> = [];
    const workspace = fixtureDir(["Makefile"]);
    const result = await runToolchainGate({
      runtime: RT,
      workspace,
      image: "img",
      env: process.env,
      runInContainer: fakeRunner([{ exitCode: null, output: "runtime unavailable", timedOut: false, unavailable: true }], calls)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unavailable).toBe(true);
  });

  it("no toolchain marker → passes vacuously without invoking the container", async () => {
    const calls: Array<{ cmd: string[]; network: string }> = [];
    const result = await runToolchainGate({
      runtime: RT,
      workspace: fixtureDir(["README.md"]),
      image: "img",
      env: process.env,
      runInContainer: fakeRunner([], calls)
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
