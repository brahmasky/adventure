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
  it("is pinned away from the real home directory for the whole suite", () => {
    expect(resolveGrowDir(process.env, homedir()).startsWith(join(homedir(), "Library"))).toBe(false);
  });
});
