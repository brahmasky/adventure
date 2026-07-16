import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WikiContradiction } from "../capabilities/wiki.js";

/**
 * The wiki page's markdown RENDER (Phase W, ADR 0020 decision 1): SQLite is truth;
 * `memory/wiki/<slug>.md` is regenerated on every save so a human (or a grep) can read
 * the knowledge base directly. The caller treats a write failure as NON-FATAL — a
 * broken render must never fail the save.
 */
export interface WikiPageRender {
  topic_slug: string;
  title: string;
  summary: string;
  key_facts: string[];
  body_md: string;
  sources: string[];
  last_verified: string | null;
  confidence: number | null;
  supersedes: number | null;
  reuse_value: number;
  contradictions: WikiContradiction[];
}

/** Rendered ONLY when contradictions exist — the honest "sources disagree" section. */
export const WIKI_CONTRADICTIONS_SECTION_HEADER = "## Contradictions (unresolved)";

/** Write (overwrite) the page render; returns the file path. Throws on a hostile slug. */
export function writeWikiPageFile(projectRoot: string, page: WikiPageRender): string {
  validateSlug(page.topic_slug);

  const dir = join(projectRoot, "memory", "wiki");
  mkdirSync(dir, { recursive: true });

  const content = [
    "---",
    `topic: ${page.topic_slug}`,
    "sources:",
    ...page.sources.map((source) => `  - ${flattenSourceLine(source)}`),
    `last_verified: ${page.last_verified ?? "null"}`,
    `confidence: ${page.confidence === null ? "null" : page.confidence.toFixed(2)}`,
    `supersedes: ${page.supersedes ?? "null"}`,
    `reuse_value: ${page.reuse_value}`,
    "---",
    "",
    `# ${page.title}`,
    "",
    page.summary,
    "",
    ...(page.key_facts.length > 0 ? ["## Key facts", "", ...page.key_facts.map((f) => `- ${f}`), ""] : []),
    page.body_md,
    ...(page.contradictions.length > 0
      ? [
          "",
          WIKI_CONTRADICTIONS_SECTION_HEADER,
          "",
          ...page.contradictions.map((c) => `- ${c.claim}: (a) ${c.a} ↔ (b) ${c.b}`)
        ]
      : []),
    ""
  ].join("\n");

  const path = join(dir, `${page.topic_slug}.md`);
  writeFileSync(path, content);
  return path;
}

/**
 * A source URL is provider-supplied text — a line break inside one would forge
 * frontmatter lines in the render (verifier F1). Flatten every line-break class.
 */
function flattenSourceLine(source: string): string {
  return source.replace(/[\r\n\u2028\u2029\u0085]+/g, " ").trim();
}

/**
 * Defense-in-depth path guard (the report-writer validateRunId pattern): the slug is
 * normalized upstream, but the FILENAME boundary re-checks — an empty or path-hostile
 * slug must never touch the filesystem.
 */
function validateSlug(slug: string): void {
  if (slug === "" || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error(`Invalid wiki slug: ${slug}`);
  }
}
