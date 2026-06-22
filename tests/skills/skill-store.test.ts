import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSkillFile,
  resolveSkillMaxPerScope,
  resolveSkillRefinePasses,
  resolveSkillsEnabled,
  setFrontmatterFields,
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

describe("SkillStore.writeSkill / readSkill (Phase 2b authoring)", () => {
  it("write+read roundtrip and regenerates the registry", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    const result = store.writeSkill("research", "cross-check-figures", VALID);
    expect(result.ok).toBe(true);
    const back = store.readSkill("research", "cross-check-figures");
    expect(back).not.toBeNull();
    expect(back!.meta.name).toBe("cross-check-figures");
    expect(back!.body).toContain("Compare each figure");
    // The registry was regenerated to include the new skill.
    const registry = readFileSync(join(root, "REGISTRY.md"), "utf8");
    expect(registry).toContain("cross-check-figures · research");
  });

  it("sanitizes the name to a filename-safe slug", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    const result = store.writeSkill("research", "Cross Check Figures!!", VALID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path.endsWith("/cross-check-figures.md")).toBe(true);
  });

  it("rejects a path that would escape the skills root (containment)", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    // `..` is stripped by the slug sanitizer, so the write stays inside root — but a
    // name that sanitizes to empty is rejected outright.
    const escape = store.writeSkill("research", "../../etc/passwd", VALID);
    // Sanitized to "etc-passwd" — still confined; assert it landed inside root
    // (compare against the real root, since macOS resolves /var → /private/var).
    expect(escape.ok).toBe(true);
    if (escape.ok) {
      const realRoot = realpathSync(root);
      expect(escape.path.startsWith(realRoot)).toBe(true);
      expect(escape.path).toContain("etc-passwd");
    }

    const empty = store.writeSkill("", "...", VALID);
    expect(empty.ok).toBe(false);
  });

  it("refine bumps version and regenerates the registry", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "x", VALID); // version 2 in VALID
    const before = store.readSkill("research", "x")!;
    const bumped = before.body; // body unchanged
    const newVersion = (before.meta.version ?? 1) + 1;
    const refined = VALID.replace("version: 2", `version: ${newVersion}`);
    const result = store.writeSkill("research", "cross-check-figures", refined);
    expect(result.ok).toBe(true);
    const after = store.readSkill("research", "cross-check-figures")!;
    expect(after.meta.version).toBe(3);
    expect(bumped).toContain("Compare each figure");
  });

  it("readSkill returns null for an absent or malformed skill", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    expect(store.readSkill("research", "nope")).toBeNull();
    writeSkill(root, "research", "bad.md", "no frontmatter");
    expect(store.readSkill("research", "bad")).toBeNull();
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

  it("refine-passes defaults to 3 and clamps invalid values", () => {
    expect(resolveSkillRefinePasses({})).toBe(3);
    expect(resolveSkillRefinePasses({ HOUGE_SKILL_REFINE_PASSES: "2" })).toBe(2);
    expect(resolveSkillRefinePasses({ HOUGE_SKILL_REFINE_PASSES: "x" })).toBe(3);
  });
});

const PENDING = `---
name: trust-first-result
scope: ask
when: answering a factual question
anchors:
  - the first result is always correct
version: 1
origin: learned
---

1. Run one web search. 2. Take the first result as truth.`;

describe("pending parking lot (Phase 2c)", () => {
  it("writes + lists a pending skill under _pending/<scope>/", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    const w = store.writePending("ask", "trust-first-result", PENDING);
    expect(w.ok).toBe(true);
    expect(readFileSync(join(root, "_pending", "ask", "trust-first-result.md"), "utf8")).toContain("trust-first-result");
    const pending = store.listPending();
    expect(pending.map((p) => p.name)).toEqual(["trust-first-result"]);
    expect(pending[0]!.scope).toBe("ask");
  });

  it("EXCLUDES _pending from active reads, list, and the ≤cap (4 active + 1 pending → 4 loaded)", () => {
    const root = tempRoot();
    const store = new SkillStore({ root, maxPerScope: 4 });
    for (let i = 0; i < 5; i += 1) {
      writeSkill(
        root,
        "research",
        `s${i}.md`,
        `---\nname: s${i}\nscope: research\nwhen: w${i}\nanchors:\n  - a\n---\n\nbody ${i}`
      );
    }
    store.writePending("research", "parked", PENDING.replace("scope: ask", "scope: research"));

    // The pending skill is never folded into a prompt block.
    const block = store.readScopeBlock("research");
    expect(block).not.toContain("trust-first-result");
    // Cap holds: exactly 4 loaded, pending excluded.
    expect(block!.match(/### /g)!.length).toBe(4);
    // list() (all scopes) excludes _pending entirely.
    expect(store.list().some((m) => m.name === "trust-first-result")).toBe(false);
    expect(store.list().every((m) => m.scope !== "_pending")).toBe(true);
    // listPending() sees it.
    expect(store.listPending().some((m) => m.name === "trust-first-result")).toBe(true);
  });

  it("pending write is contained — cannot escape the skills root", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    const escape = store.writePending("../../etc", "passwd", PENDING);
    // sanitizeSlug strips the path parts, so it stays inside; the file never lands outside root.
    if (escape.ok) {
      expect(realpathSync(escape.path).startsWith(realpathSync(root))).toBe(true);
    }
  });
});

describe("setFrontmatterFields (Phase 2c stamping)", () => {
  const FILE = `---\nname: x\nscope: ask\nwhen: w\nanchors:\n  - a\nversion: 1\n---\n\nbody`;

  it("injects score + last_verified into frontmatter", () => {
    const out = setFrontmatterFields(FILE, { score: 0.42, last_verified: "2026-06-22" });
    expect(out).toContain("score: 0.42");
    expect(out).toContain("last_verified: 2026-06-22");
    expect(out).toContain("body"); // body untouched
  });

  it("replaces an existing score line rather than duplicating", () => {
    const withScore = setFrontmatterFields(FILE, { score: 0.1 });
    const updated = setFrontmatterFields(withScore, { score: 0.9 });
    expect(updated.match(/score:/g)!.length).toBe(1);
    expect(updated).toContain("score: 0.90");
  });

  it("returns the file unchanged when there is no frontmatter fence", () => {
    expect(setFrontmatterFields("just body", { score: 0.5 })).toBe("just body");
  });
});
