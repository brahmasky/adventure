import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WIKI_CONTRADICTIONS_SECTION_HEADER,
  writeWikiPageFile,
  type WikiPageRender
} from "../../src/report/wiki-writer.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-wiki-writer-"));
  dirs.push(dir);
  return dir;
}

function page(overrides: Partial<WikiPageRender> = {}): WikiPageRender {
  return {
    topic_slug: "asml-q2-2026",
    title: "ASML Q2 2026 earnings",
    summary: "Beat expectations.",
    key_facts: ["EPS €4.9", "Bookings up 20%"],
    body_md: "## Results\nGood quarter.",
    sources: ["https://a.com/x", "https://b.com/y"],
    last_verified: "2026-07-16T12:00:00.000Z",
    confidence: 0.85,
    supersedes: null,
    reuse_value: 1,
    contradictions: [],
    ...overrides
  };
}

describe("writeWikiPageFile (the markdown RENDER — sqlite stays truth)", () => {
  it("writes memory/wiki/<slug>.md with the full YAML frontmatter + title/summary/facts/body", () => {
    const root = projectRoot();
    const path = writeWikiPageFile(root, page());
    expect(path).toBe(join(root, "memory", "wiki", "asml-q2-2026.md"));
    const content = readFileSync(path, "utf8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("topic: asml-q2-2026");
    expect(content).toContain("  - https://a.com/x");
    expect(content).toContain("  - https://b.com/y");
    expect(content).toContain("last_verified: 2026-07-16T12:00:00.000Z");
    expect(content).toContain("confidence: 0.85");
    expect(content).toContain("supersedes: null");
    expect(content).toContain("reuse_value: 1");
    expect(content).toContain("# ASML Q2 2026 earnings");
    expect(content).toContain("Beat expectations.");
    expect(content).toContain("- EPS €4.9");
    expect(content).toContain("## Results");
  });

  it("renders lineage + null confidence honestly on an unverified refine", () => {
    const content = readFileSync(
      writeWikiPageFile(projectRoot(), page({ confidence: null, last_verified: null, supersedes: 12 })),
      "utf8"
    );
    expect(content).toContain("confidence: null");
    expect(content).toContain("last_verified: null");
    expect(content).toContain("supersedes: 12");
  });

  it("adds the Contradictions section ONLY when contradictions exist — both sides verbatim", () => {
    const root = projectRoot();
    const clean = readFileSync(writeWikiPageFile(root, page()), "utf8");
    expect(clean).not.toContain(WIKI_CONTRADICTIONS_SECTION_HEADER);

    const contested = readFileSync(
      writeWikiPageFile(
        root,
        page({
          topic_slug: "contested",
          contradictions: [{ claim: "EPS", a: "source 1: €4.9", b: "source 2: €5.2" }]
        })
      ),
      "utf8"
    );
    expect(contested).toContain(WIKI_CONTRADICTIONS_SECTION_HEADER);
    expect(contested).toContain("source 1: €4.9");
    expect(contested).toContain("source 2: €5.2");
  });

  it("overwrites on re-save (the render is regenerated every save)", () => {
    const root = projectRoot();
    writeWikiPageFile(root, page());
    const path = writeWikiPageFile(root, page({ title: "ASML Q2 2026 earnings (updated)" }));
    expect(readFileSync(path, "utf8")).toContain("(updated)");
  });

  it("flattens line breaks inside a source URL — no frontmatter forgery (verifier F1)", () => {
    const root = projectRoot();
    const path = writeWikiPageFile(
      root,
      page({ sources: ["https://evil.com/x\n---\nINJECTED: true", "https://ok.com/y confidence: 1.00"] })
    );
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n");
    // The hostile payload stays INSIDE its source line — never a line of its own.
    expect(lines).not.toContain("INJECTED: true");
    expect(lines).not.toContain("confidence: 1.00");
    // The frontmatter fence appears exactly twice (open + close) — nothing forged a third.
    expect(lines.filter((line) => line === "---")).toHaveLength(2);
    expect(content).toContain("  - https://evil.com/x --- INJECTED: true");
  });

  it("rejects path-hostile slugs at the filename boundary (defense-in-depth)", () => {
    const root = projectRoot();
    for (const slug of ["", "a/b", "a\\b", "..", "a..b"]) {
      expect(() => writeWikiPageFile(root, page({ topic_slug: slug }))).toThrow(/Invalid wiki slug/);
    }
    // Nothing escaped the wiki dir.
    expect(existsSync(join(root, "b.md"))).toBe(false);
  });
});
