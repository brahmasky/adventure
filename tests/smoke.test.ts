import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { getHougeVersion } from "../src/index.js";

describe("project scaffold", () => {
  it("exports a version string for diagnostics", () => {
    expect(getHougeVersion()).toMatch(/^0\.1\.0-/);
  });

  it("builds the configured CLI bin path", () => {
    rmSync("dist", { recursive: true, force: true });
    execFileSync("npm", ["run", "build"], { stdio: "pipe" });

    const version = spawnSync("node", ["dist/cli.js", "--version"], {
      encoding: "utf8"
    });

    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(getHougeVersion());
    expect(version.stderr).toBe("");
  });

  it("reports unknown CLI commands with a failing exit code", () => {
    rmSync("dist", { recursive: true, force: true });
    execFileSync("npm", ["run", "build"], { stdio: "pipe" });

    const unknown = spawnSync("node", ["dist/cli.js", "bogus"], {
      encoding: "utf8"
    });

    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr.trim()).toBe("Unknown command: bogus");
  });
});
