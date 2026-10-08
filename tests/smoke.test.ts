import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getHougeVersion } from "../src/index.js";

// The CLI loads `<cwd>/.env` at start (src/config/load-env.ts). On the merge path the test gate runs in the live repo,
// where that is the daemon's real .env: probe the built CLI from an empty temp dir so no live config can reach it.
const CLI = resolve("dist/cli.js");
const probeDirs: string[] = [];
const probeCwd = (): string => { const d = mkdtempSync(resolve(tmpdir(), "houge-smoke-")); probeDirs.push(d); return d; };
afterAll(() => { for (const d of probeDirs) rmSync(d, { recursive: true, force: true }); });

describe("project scaffold", () => {
  it("exports a version string for diagnostics", () => {
    expect(getHougeVersion()).toMatch(/^0\.1\.0-/);
  });

  it("builds the configured CLI bin path", () => {
    rmSync("dist", { recursive: true, force: true });
    execFileSync("npm", ["run", "build"], { stdio: "pipe" });

    const version = spawnSync("node", [CLI, "--version"], { encoding: "utf8", cwd: probeCwd() });

    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(getHougeVersion());
    expect(version.stderr).toBe("");
  });

  it("reports unknown CLI commands with a failing exit code", () => {
    rmSync("dist", { recursive: true, force: true });
    execFileSync("npm", ["run", "build"], { stdio: "pipe" });

    const unknown = spawnSync("node", [CLI, "bogus"], { encoding: "utf8", cwd: probeCwd() });

    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr.trim()).toBe("Unknown command: bogus");
  });
});
