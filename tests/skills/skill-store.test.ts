import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSkillFile,
  resolveSkillMaxPerScope,
  resolveSkillsEnabled,
  SkillStore
} from "../../src/skills/skill-store.js";

let dirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-skills-"));
  dirs.push(dir);
  return dir;
}
function writeSkill(root: string, scope: string, file: string, content: string): void {
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, scope, file), content, "utf8");
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const VALID = `---
name: cross-check-figures
scope: research
when: comparing numbers across multiple sources
anchors:
  - a part never exceeds its whole
  - units are converted before comparison
version: 2
last_verified: 2026-06-21
origin: refined
---

Compare each figure against its source before trusting it.`;

describe("parseSkillFile", () => {
  it("parses frontmatter (name/scope/when/anchors/version) + body", () => {
    const parsed = parseSkillFile(VALID);
    expect(parsed).not.toBeNull();
    expect(parsed!.meta.name).toBe("cross-check-figures");
    expect(parsed!.meta.when).toBe("comparing numbers across multiple sources");
    expect(parsed!.meta.anchors).toEqual([
      "a part never exceeds its whole",
      "units are converted before comparison"
    ]);
    expect(parsed!.meta.version).toBe(2);
    expect(parsed!.body).toContain("Compare each figure");
  });

  it("returns null on missing required fields or no frontmatter fence (never throws)", () => {
    expect(parseSkillFile("no frontmatter here")).toBeNull();
    expect(parseSkillFile("---\nname: x\nscope: research\n---\nbody")).toBeNull(); // no `when`
    expect(parseSkillFile("")).toBeNull();
  });

  it("parses a file with CRLF line endings (Windows-authored skill is not silently skipped)", () => {
    const crlf = VALID.replace(/\n/g, "\r\n");
    const parsed = parseSkillFile(crlf);
    expect(parsed).not.toBeNull();
    expect(parsed!.meta.name).toBe("cross-check-figures");
    expect(parsed!.meta.when).toBe("comparing numbers across multiple sources");
    expect(parsed!.body).not.toContain("\r");
  });
});

describe("SkillStore.readScopeBlock", () => {
  it("renders a valid skill with the when: prefix and body", () => {
    const root = tempRoot();
    writeSkill(root, "research", "cross-check.md", VALID);
    const block = new SkillStore({ root }).readScopeBlock("research");
    expect(block).toContain("### cross-check-figures — when: comparing numbers across multiple sources");
    expect(block).toContain("Compare each figure");
  });

  it("returns undefined for a missing root/scope dir (no crash)", () => {
    const block = new SkillStore({ root: join(tempRoot(), "does-not-exist") }).readScopeBlock("research");
    expect(block).toBeUndefined();
  });

  it("skips a malformed file rather than throwing, keeping the valid ones", () => {
    const root = tempRoot();
    writeSkill(root, "research", "good.md", VALID);
    writeSkill(root, "research", "bad.md", "this file has no frontmatter at all");
    const block = new SkillStore({ root }).readScopeBlock("research");
    expect(block).toContain("cross-check-figures");
    expect(block).not.toContain("no frontmatter");
  });

  it("enforces the per-scope cap, taking the alphabetically-first files", () => {
    const root = tempRoot();
    for (const letter of ["a", "b", "c", "d", "e"]) {
      writeSkill(
        root,
        "research",
        `${letter}.md`,
        `---\nname: skill-${letter}\nscope: research\nwhen: hint ${letter}\n---\nbody ${letter}`
      );
    }
    const block = new SkillStore({ root, maxPerScope: 4 }).readScopeBlock("research")!;
    expect(block).toContain("skill-a");
    expect(block).toContain("skill-d");
    expect(block).not.toContain("skill-e"); // 5th dropped by the cap
    expect((block.match(/### skill-/g) ?? []).length).toBe(4);
  });
});

describe("SkillStore.list", () => {
  it("returns metadata for each skill including char count, skipping malformed", () => {
    const root = tempRoot();
    writeSkill(root, "research", "cross-check.md", VALID);
    writeSkill(root, "research", "bad.md", "no frontmatter");
    const metas = new SkillStore({ root }).list();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      name: "cross-check-figures",
      scope: "research",
      when: "comparing numbers across multiple sources",
      version: 2,
      origin: "refined"
    });
    expect(metas[0]!.anchors).toHaveLength(2);
    expect(metas[0]!.chars).toBeGreaterThan(0);
  });
});

describe("SkillStore.regenerateRegistry", () => {
  it("writes a generated REGISTRY.md listing each skill", () => {
    const root = tempRoot();
    writeSkill(root, "research", "cross-check.md", VALID);
    new SkillStore({ root }).regenerateRegistry();
    const registry = readFileSync(join(root, "REGISTRY.md"), "utf8");
    expect(registry).toContain("AUTO-GENERATED");
    expect(registry).toContain("cross-check-figures · research");
    expect(registry).toContain("2 anchors");
    expect(registry).toContain("v2");
  });
});

describe("resolvers", () => {
  it("skills enabled defaults ON; only 0/false/no/off disables", () => {
    expect(resolveSkillsEnabled({})).toBe(true);
    expect(resolveSkillsEnabled({ HOUGE_SKILLS_ENABLED: "off" })).toBe(false);
    expect(resolveSkillsEnabled({ HOUGE_SKILLS_ENABLED: "0" })).toBe(false);
    expect(resolveSkillsEnabled({ HOUGE_SKILLS_ENABLED: "1" })).toBe(true);
  });

  it("max-per-scope defaults to 4 and clamps invalid values", () => {
    expect(resolveSkillMaxPerScope({})).toBe(4);
    expect(resolveSkillMaxPerScope({ HOUGE_SKILL_MAX_PER_SCOPE: "2" })).toBe(2);
    expect(resolveSkillMaxPerScope({ HOUGE_SKILL_MAX_PER_SCOPE: "x" })).toBe(4);
  });
});
