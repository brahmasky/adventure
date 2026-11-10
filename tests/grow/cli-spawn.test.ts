import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GROW_CLI_USAGE } from "../../src/grow/cli.js";

const cliPath = resolve("src/cli.ts");
const tsxPath = resolve("node_modules/.bin/tsx");
let tempDirs: string[] = [];

const makeTempDir = (): string => { const d = mkdtempSync(join(tmpdir(), "houge-grow-cli-")); tempDirs.push(d); return d; };

/** Spawned like tests/status/status-cli.test.ts, with the zone and the kill switch pinned to temp paths so nothing reaches the real ones. */
function runGrow(args: string[], cwd: string, tombstone?: string) {
  const root = makeTempDir();
  return spawnSync(tsxPath, [cliPath, "grow", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOUGE_ENV_FILE: undefined, HOUGE_GROW_DIR: join(root, "grow"), HOUGE_TOMBSTONE_PATH: tombstone ?? join(root, "houge.kill") }
  });
}

describe("houge grow CLI (spawned)", () => {
  afterEach(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); tempDirs = []; });

  it("a tombstoned daemon refuses trust with the parked message and exit 1", () => {
    const cwd = makeTempDir();
    const tomb = join(cwd, "tomb");
    writeFileSync(tomb, JSON.stringify({ killed_at: "2026-11-10T00:00:00.000Z", by: "test" }));
    const r = runGrow(["trust", "some-skill"], cwd, tomb);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(tomb);
    expect(r.stderr).not.toContain(GROW_CLI_USAGE);
  });

  it("a bad name prints the usage line and exits 1", () => {
    const r = runGrow(["trust", "Bad_Name"], makeTempDir());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(GROW_CLI_USAGE);
  });

  it("an unknown subcommand prints the usage line", () => {
    const r = runGrow(["frobnicate"], makeTempDir());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(GROW_CLI_USAGE);
  });

  it.each([["list"], ["log"], ["check"], ["show", "some-skill"], ["undo", "some-skill"], ["trust", "some-skill"], ["adopt", "some-skill"]])(
    "refuses outside the checkout (no houge.sqlite) for `grow %s`, and creates no database", (...args) => {
      const cwd = makeTempDir();
      const r = runGrow(args, cwd);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("houge grow: no houge.sqlite here; run from the Houge checkout");
      expect(r.stdout).not.toContain("queued");
      expect(existsSync(join(cwd, "houge.sqlite"))).toBe(false);
    }, 30_000);
});
