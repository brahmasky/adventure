import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGrowDir, resolveGrowEnabled, resolveSkillsEnabled } from "../../src/grow/flags.js";

const DEFAULT = "/Users/x/Library/Application Support/houge/grow";

describe("grow flags", () => {
  it("is on unless explicitly disabled, so a typo never silences the grow zone", () => {
    for (const v of [undefined, "", "1", "true", "typo"]) expect(resolveGrowEnabled({ HOUGE_GROW_ENABLED: v })).toBe(true);
    for (const v of ["0", "false", "No", " off "]) expect(resolveGrowEnabled({ HOUGE_GROW_ENABLED: v })).toBe(false);
    expect(resolveSkillsEnabled({ HOUGE_SKILLS_ENABLED: "off" })).toBe(false);
    expect(resolveSkillsEnabled({})).toBe(true);
  });
  it("lives outside the checkout by default and takes only an absolute override", () => {
    expect(resolveGrowDir({}, "/Users/x")).toBe(DEFAULT);
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "/data/grow/zone" }, "/Users/x")).toBe("/data/grow/zone");
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "relative/grow" }, "/Users/x")).toBe(DEFAULT);
  });
  it("refuses an override that would turn a broad directory into a write-denied path", () => {
    for (const bad of ["/", "/Users", "/Users/x", "/tmp/x"]) expect(resolveGrowDir({ HOUGE_GROW_DIR: bad }, "/Users/x")).toBe(DEFAULT);
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "/private/tmp/a/grow" }, "/Users/x")).toBe("/private/tmp/a/grow");
  });
  it("refuses an override that overlaps the checkout, the data dir or ~/.omp, which the sandbox would cut off from every child", () => {
    const repo = "/Users/x/Projects/adventure", data = "/Users/x/Library/Application Support/houge/data", avoid = [repo, data];
    const pick = (dir: string): string => resolveGrowDir({ HOUGE_GROW_DIR: dir }, "/Users/x", avoid);
    for (const bad of [repo, "/Users/x/Projects", `${repo}/grow`, `${data}/omp/workspace/grow`, "/Users/x/.omp/x", "/Users/x/.omp"]) expect(pick(bad), bad).toBe(DEFAULT);
    expect(pick("/private/tmp/a/grow")).toBe("/private/tmp/a/grow");
    expect(pick(`${repo}-other/grow`)).toBe(`${repo}-other/grow`);
  });
  it("compares overlaps case-insensitively, as the deny matcher does on a case-insensitive volume", () => {
    const repo = "/Users/x/Projects/adventure", avoid = [repo, "/Users/x/Library/Application Support/houge/data"];
    const pick = (dir: string): string => resolveGrowDir({ HOUGE_GROW_DIR: dir }, "/Users/x", avoid);
    for (const bad of ["/users/x/projects/adventure", "/USERS/X/Projects/adventure/grow", "/Users/x/.OMP/x", "/USERS/x"]) expect(pick(bad), bad).toBe(DEFAULT);
    expect(pick(`${repo}-other/grow`)).toBe(`${repo}-other/grow`);
    expect(pick("/Private/Tmp/A/grow")).toBe("/Private/Tmp/A/grow");
  });
  it("returns the normalised path it validated, never the raw override", () => {
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "/data/a/../grow/zone/" }, "/Users/x")).toBe("/data/grow/zone");
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "/data/a/b/../../../../Users/x" }, "/Users/x")).toBe(DEFAULT);
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "/Users/x/Library/../" }, "/Users/x")).toBe(DEFAULT);
  });
  it("is pinned away from the real home directory for the whole suite", () => {
    expect(resolveGrowDir(process.env, homedir()).startsWith(join(homedir(), "Library"))).toBe(false);
  });
});
