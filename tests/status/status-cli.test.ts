import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = resolve("src/cli.ts");
const tsxPath = resolve("node_modules/.bin/tsx");
let tempDirs: string[] = [];

function runStatus(args: string[], cwd: string) {
  return spawnSync(tsxPath, [cliPath, "status", ...args], {
    cwd,
    encoding: "utf8"
  });
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-status-"));
  tempDirs.push(dir);
  return dir;
}

function parseStdout(stdout: string): unknown {
  return JSON.parse(stdout);
}

describe("houge status CLI", () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("opens an empty local DB, prints ok JSON, and exits 0", () => {
    const result = runStatus([], makeTempDir());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseStdout(result.stdout)).toEqual({ ok: true, status: { runs: [] } });
  });

  it("prints RUN_NOT_FOUND JSON and exits 1 for a missing run id", () => {
    const result = runStatus(["missing-run"], makeTempDir());

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(parseStdout(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_FOUND" }
    });
  });

  it("rejects extra status args with a usage error", () => {
    const result = runStatus(["first", "extra"], makeTempDir());

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(parseStdout(result.stdout)).toEqual({
      ok: false,
      error: { code: "CLI_USAGE", message: "Usage: houge status [run_id]" }
    });
  });
});
