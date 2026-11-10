import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scripts/copy-omp-assets.mjs", () => {
  it("clears a stale tool declaration so a deleted tool cannot survive a rebuild", () => {
    const dist = mkdtempSync(join(tmpdir(), "houge-dist-"));
    try {
      mkdirSync(join(dist, "omp/tools"), { recursive: true });
      writeFileSync(join(dist, "omp/tools/removed_tool.json"), "{}");
      execFileSync("node", ["scripts/copy-omp-assets.mjs", dist], { stdio: "pipe" });
      expect(existsSync(join(dist, "omp/tools/removed_tool.json"))).toBe(false);
      expect(readdirSync(join(dist, "omp/tools")).length).toBeGreaterThan(0);
      expect(existsSync(join(dist, "omp/shell-wrapper.sh"))).toBe(true);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
