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
    encoding: "utf8",
    // Pin global caps so the overview is deterministic (also exercises env→caps).
    env: {
      ...process.env,
      HOUGE_GLOBAL_MAX_RUNS_24H: "50",
      HOUGE_GLOBAL_MAX_TOOL_CALLS_24H: "200",
      HOUGE_GLOBAL_MAX_GATED_ATTEMPTS_24H: "25"
    }
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

  it("opens an empty local DB, prints ok JSON with overview, and exits 0", () => {
    const result = runStatus([], makeTempDir());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseStdout(result.stdout)).toEqual({
      ok: true,
      status: {
        runs: [],
        overview: {
          window_hours: 24,
          runs_by_state: {},
          last_error: null,
          budget: [
            { kind: "runs", used: 0, limit: 50, remaining: 50 },
            { kind: "tool_calls", used: 0, limit: 200, remaining: 200 },
            { kind: "gated_attempts", used: 0, limit: 25, remaining: 25 }
          ],
          poller: null,
          rating: { pending_since: null, last_rating: null, last_rating_at: null }
        }
      }
    });
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
