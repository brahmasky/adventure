import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSkillFile,
  resolveSkillMaxPerScope,
  resolveSkillName,
  resolveSkillRefinePasses,
  resolveSkillsEnabled,
  setFrontmatterFields,
  stripFrontmatterFields,
  SkillStore,
  type SkillMeta
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

/** A skill whose frontmatter name matches its filename slug — needed for meta assertions. */
function skillNamed(scope: string, name: string): string {
  return `---\nname: ${name}\nscope: ${scope}\nwhen: using ${name}\nanchors:\n  - a\nversion: 2\nlast_verified: 2026-06-21\norigin: refined\n---\n\nBody of ${name}.`;
}

describe("retire / restore lifecycle (skill retirement)", () => {
  it("retireSkill moves to _retired/<scope>/, stamps retired/retired_by, and goes inert", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "cross-check-figures", skillNamed("research", "cross-check-figures"));
    const r = store.retireSkill("research", "cross-check-figures", { date: "2026-07-29", by: "paco" });
    expect(r.ok).toBe(true);
    // Moved: retired copy exists (stamped), active file is gone.
    const retiredText = readFileSync(join(root, "_retired", "research", "cross-check-figures.md"), "utf8");
    expect(retiredText).toContain("retired: 2026-07-29");
    expect(retiredText).toContain("retired_by: paco");
    expect(existsSync(join(root, "research", "cross-check-figures.md"))).toBe(false);
    // Inert: excluded from list() and never folded into a prompt block.
    expect(store.list().some((m) => m.name === "cross-check-figures")).toBe(false);
    expect(store.readScopeBlock("research")).toBeUndefined();
    // Visible in the graveyard view, with the retire stamps parsed onto the meta.
    const retired = store.listRetired();
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({
      name: "cross-check-figures",
      scope: "research",
      retired: "2026-07-29",
      retired_by: "paco"
    });
  });

  it("retireSkill with supersededBy stamps superseded_by", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "old-way", skillNamed("research", "old-way"));
    const r = store.retireSkill("research", "old-way", {
      date: "2026-07-29",
      by: "refine",
      supersededBy: "new-way"
    });
    expect(r.ok).toBe(true);
    const retiredText = readFileSync(join(root, "_retired", "research", "old-way.md"), "utf8");
    expect(retiredText).toContain("retired_by: refine");
    expect(retiredText).toContain("superseded_by: new-way");
    expect(store.listRetired()[0]!.superseded_by).toBe("new-way");
  });

  it("answers 'not found' vs 'already retired' distinctly", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    expect(store.retireSkill("research", "ghost", { date: "2026-07-29", by: "paco" })).toEqual({
      ok: false,
      error: "not found"
    });
    store.writeSkill("research", "real", skillNamed("research", "real"));
    expect(store.retireSkill("research", "real", { date: "2026-07-29", by: "paco" }).ok).toBe(true);
    expect(store.retireSkill("research", "real", { date: "2026-07-30", by: "paco" })).toEqual({
      ok: false,
      error: "already retired"
    });
  });

  it("restoreSkill moves back, strips all three stamps, keeps version/last_verified", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "comeback", skillNamed("research", "comeback"));
    store.retireSkill("research", "comeback", { date: "2026-07-29", by: "paco", supersededBy: "x" });
    const r = store.restoreSkill("research", "comeback");
    expect(r.ok).toBe(true);
    const text = readFileSync(join(root, "research", "comeback.md"), "utf8");
    expect(text).not.toContain("retired:");
    expect(text).not.toContain("retired_by:");
    expect(text).not.toContain("superseded_by:");
    expect(text).toContain("version: 2");
    expect(text).toContain("last_verified: 2026-06-21");
    // Moved, not copied: the graveyard slot is empty again and the skill is active.
    expect(existsSync(join(root, "_retired", "research", "comeback.md"))).toBe(false);
    expect(store.listRetired()).toHaveLength(0);
    expect(store.list().some((m) => m.name === "comeback")).toBe(true);
  });

  it("restoreSkill refuses when an active same-name skill exists (never overwrites)", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "dup", skillNamed("research", "dup"));
    store.retireSkill("research", "dup", { date: "2026-07-29", by: "paco" });
    store.writeSkill("research", "dup", skillNamed("research", "dup")); // a new active generation
    const r = store.restoreSkill("research", "dup");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("refusing to overwrite");
    // The retired copy is untouched by the refusal.
    expect(existsSync(join(root, "_retired", "research", "dup.md"))).toBe(true);
  });

  it("restoreSkill answers 'not found in _retired' for an absent graveyard entry", () => {
    const store = new SkillStore({ root: tempRoot() });
    expect(store.restoreSkill("research", "ghost")).toEqual({ ok: false, error: "not found in _retired" });
  });

  it("re-retiring a name overwrites the graveyard copy — the graveyard holds the latest", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "x", skillNamed("research", "x"));
    store.retireSkill("research", "x", { date: "2026-07-29", by: "paco" });
    // A new active generation under the same name (same lineage), retired again later.
    store.writeSkill("research", "x", skillNamed("research", "x").replace("Body of x.", "Second-generation body of x."));
    const r = store.retireSkill("research", "x", { date: "2026-08-01", by: "refine" });
    expect(r.ok).toBe(true);
    const retired = store.listRetired().filter((m) => m.name === "x");
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({ retired: "2026-08-01", retired_by: "refine" });
    const text = readFileSync(join(root, "_retired", "research", "x.md"), "utf8");
    expect(text).toContain("Second-generation body of x.");
    expect(text).not.toContain("retired: 2026-07-29");
  });

  it("_retired is never an active scope; a malformed graveyard file is skipped by listRetired", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    writeSkill(root, join("_retired", "research"), "good.md", skillNamed("research", "good"));
    writeSkill(root, join("_retired", "research"), "bad.md", "this file has no frontmatter at all");
    // Excluded from every active view.
    expect(store.list().every((m) => m.scope !== "_retired")).toBe(true);
    expect(store.list().some((m) => m.name === "good")).toBe(false);
    // The graveyard view keeps the valid one and never throws on the bad one.
    expect(store.listRetired().map((m) => m.name)).toEqual(["good"]);
  });
});

describe("SkillStore.readRawSkill", () => {
  it("returns the full file text (frontmatter + body), null when absent", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    const content = skillNamed("research", "raw-read");
    store.writeSkill("research", "raw-read", content);
    const raw = store.readRawSkill("research", "raw-read");
    expect(raw).toBe(content);
    expect(raw).toContain("---\nname: raw-read");
    expect(store.readRawSkill("research", "nope")).toBeNull();
    expect(store.readRawSkill("", "...")).toBeNull();
  });
});

describe("SkillStore.stampVerification", () => {
  it("updates score + last_verified in place with no version bump", () => {
    const root = tempRoot();
    const store = new SkillStore({ root });
    store.writeSkill("research", "verified", skillNamed("research", "verified"));
    expect(store.stampVerification("research", "verified", { score: 0.8, last_verified: "2026-07-29" })).toBe(true);
    const text = readFileSync(join(root, "research", "verified.md"), "utf8");
    expect(text).toContain("score: 0.80");
    expect(text).toContain("last_verified: 2026-07-29");
    expect(text).toContain("version: 2"); // no bump
    expect(text).toContain("Body of verified."); // body untouched
  });

  it("returns false for an absent skill or an empty slug", () => {
    const store = new SkillStore({ root: tempRoot() });
    expect(store.stampVerification("research", "ghost", { score: 0.5, last_verified: "2026-07-29" })).toBe(false);
    expect(store.stampVerification("", "...", { score: 0.5, last_verified: "2026-07-29" })).toBe(false);
  });
});

describe("stripFrontmatterFields", () => {
  it("removes only the named keys from the leading frontmatter block", () => {
    const stamped = `---\nname: x\nscope: ask\nwhen: w\nretired: 2026-07-29\nretired_by: paco\n---\n\nbody`;
    const out = stripFrontmatterFields(stamped, ["retired", "retired_by", "superseded_by"]);
    expect(out).not.toContain("retired");
    expect(out).toContain("name: x");
    expect(out).toContain("body");
  });

  it("returns the file unchanged when there is no frontmatter fence", () => {
    expect(stripFrontmatterFields("just body", ["retired"])).toBe("just body");
  });

  it("removes the frontmatter key but never touches an identical-looking line in the body", () => {
    const file = `---\nname: x\nscope: ask\nwhen: w\nretired: 2026-07-29\n---\n\nretired: keep-me\nmore body`;
    const out = stripFrontmatterFields(file, ["retired"]);
    const fenceEnd = out.indexOf("\n---\n") + "\n---\n".length;
    expect(out.slice(0, fenceEnd)).not.toContain("retired:"); // frontmatter key gone
    expect(out.slice(fenceEnd)).toContain("retired: keep-me"); // body line survives
  });
});

describe("resolveSkillName", () => {
  const meta = (scope: string, name: string): SkillMeta => ({ name, scope, when: "w", anchors: [], chars: 1 });
  const metas = [
    meta("research", "cross-check-figures"),
    meta("ask", "cross-check-figures"),
    meta("research", "verify-sources")
  ];

  it("exact name match wins; same name in two scopes → many", () => {
    const r = resolveSkillName(metas, "cross-check-figures");
    expect(r.status).toBe("many");
    if (r.status === "many") expect(r.metas).toHaveLength(2);
  });

  it("scope/name disambiguates", () => {
    const r = resolveSkillName(metas, "research/cross-check-figures");
    expect(r.status).toBe("one");
    if (r.status === "one") expect(r.meta.scope).toBe("research");
  });

  it("an unambiguous substring resolves to one", () => {
    const r = resolveSkillName(metas, "verify");
    expect(r.status).toBe("one");
    if (r.status === "one") expect(r.meta.name).toBe("verify-sources");
  });

  it("exact beats substring when both would match", () => {
    const pool = [meta("a", "check"), meta("a", "check-twice")];
    const r = resolveSkillName(pool, "check");
    expect(r.status).toBe("one");
    if (r.status === "one") expect(r.meta.name).toBe("check");
  });

  it("an ambiguous substring → many (caller asks, never guesses)", () => {
    const r = resolveSkillName(metas, "cross");
    expect(r.status).toBe("many");
    if (r.status === "many") expect(r.metas).toHaveLength(2);
  });

  it("unknown → none", () => {
    expect(resolveSkillName(metas, "zzz").status).toBe("none");
  });
});
