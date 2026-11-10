import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundlePathFor, ensureGrowBundle } from "../../src/grow/bundle.js";
import { growSetup, mkTmp } from "../helpers/grow.js";

describe("grow bundle", () => {
  it("names the bundle after its snapshot, one rule for every caller", () => {
    expect(bundlePathFor("/b/houge-20261110T000000Z.sqlite")).toBe("/b/houge-20261110T000000Z.grow.bundle");
  });

  it("writes a bundle beside the newest snapshot that has none, once, and reports when there is nothing to pair", async () => {
    const s = await growSetup(); const backupDir = mkTmp();
    expect(await ensureGrowBundle({ zone: s.zone, backupDir })).toBe("none");
    writeFileSync(join(backupDir, "houge-20261109T000000Z.sqlite"), "old");
    writeFileSync(join(backupDir, "houge-20261110T000000Z.sqlite"), "new");
    expect(await ensureGrowBundle({ zone: s.zone, backupDir })).toBe("written");
    expect(existsSync(join(backupDir, "houge-20261110T000000Z.grow.bundle"))).toBe(true);
    expect(existsSync(join(backupDir, "houge-20261109T000000Z.grow.bundle"))).toBe(false);
    expect(await ensureGrowBundle({ zone: s.zone, backupDir })).toBe("exists");
  });

  it("answers none for a missing folder, and ignores files that are not final snapshots", async () => {
    const s = await growSetup(); const backupDir = mkTmp();
    expect(await ensureGrowBundle({ zone: s.zone, backupDir: join(backupDir, "nope") })).toBe("none");
    writeFileSync(join(backupDir, "houge-20261110T000000Z.sqlite.tmp"), "half");
    expect(await ensureGrowBundle({ zone: s.zone, backupDir })).toBe("none");
  });

  it("answers failed, leaving no partial file, when the repository cannot be bundled", async () => {
    const s = await growSetup(); const backupDir = mkTmp();
    writeFileSync(join(backupDir, "houge-20261110T000000Z.sqlite"), "new");
    rmSync(join(s.dir, "grow", ".git"), { recursive: true, force: true });
    expect(await ensureGrowBundle({ zone: s.zone, backupDir })).toBe("failed");
    expect(readdirSync(backupDir)).toEqual(["houge-20261110T000000Z.sqlite"]);
  });

  it("replaces a *.tmp a crashed run left behind, and leaves only the bundle", async () => {
    const s = await growSetup(); const backupDir = mkTmp();
    writeFileSync(join(backupDir, "houge-20261110T000000Z.sqlite"), "new");
    writeFileSync(join(backupDir, "houge-20261110T000000Z.grow.bundle.tmp"), "half a bundle from a crash");
    expect(await ensureGrowBundle({ zone: s.zone, backupDir })).toBe("written");
    expect(readdirSync(backupDir).sort()).toEqual(["houge-20261110T000000Z.grow.bundle", "houge-20261110T000000Z.sqlite"]);
    expect(readFileSync(join(backupDir, "houge-20261110T000000Z.grow.bundle")).subarray(0, 16).toString()).toContain("git bundle");
  });
});
