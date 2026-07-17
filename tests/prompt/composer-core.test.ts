import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  CORE_FACTS_SECTION_HEADER,
  EPISODIC_SECTION_HEADER,
  WIKI_SECTION_HEADER
} from "../../src/prompt/composer.js";

let dirs: string[] = [];
function memoryRoot(identity = "I am 猴哥."): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-compose-core-"));
  dirs.push(dir);
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "core", "houge.md"), identity, "utf8");
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const NOW = new Date("2026-07-17T00:00:00.000Z");

describe("composeSystemPrompt — the always-known core band (location grounding)", () => {
  it("is byte-identical when no coreReader vs a reader that returns nothing (goldens safe)", () => {
    const root = memoryRoot();
    const baseline = composeSystemPrompt(root, "loop", { now: NOW });
    const withUndefined = composeSystemPrompt(root, "loop", { now: NOW, coreReader: () => undefined });
    const withEmpty = composeSystemPrompt(root, "loop", { now: NOW, coreReader: () => "" });
    expect(withUndefined).toBe(baseline);
    expect(withEmpty).toBe(baseline);
    expect(baseline).not.toContain(CORE_FACTS_SECTION_HEADER);
  });

  it("folds the core band in when present, headed by the exported constant", () => {
    const root = memoryRoot();
    const prompt = composeSystemPrompt(root, "loop", {
      now: NOW,
      coreReader: () => "- Paco lives in Sydney"
    });
    expect(prompt).toContain(CORE_FACTS_SECTION_HEADER);
    expect(prompt).toContain("- Paco lives in Sydney");
  });

  it("sits in a FIXED position: above the scored episodic band and the wiki band", () => {
    const root = memoryRoot();
    const prompt = composeSystemPrompt(root, "loop", {
      now: NOW,
      coreReader: () => "- Paco lives in Sydney",
      episodicReader: () => "- Paco mentioned a Melbourne trip",
      wikiReader: () => "- ASML Q2 2026 earnings (unverified):"
    });
    expect(prompt.indexOf(CORE_FACTS_SECTION_HEADER)).toBeLessThan(prompt.indexOf(EPISODIC_SECTION_HEADER));
    expect(prompt.indexOf(EPISODIC_SECTION_HEADER)).toBeLessThan(prompt.indexOf(WIKI_SECTION_HEADER));
  });

  it("appears even when the scored episodic band is absent (always-on grounding)", () => {
    const root = memoryRoot();
    const prompt = composeSystemPrompt(root, "loop", {
      now: NOW,
      coreReader: () => "- Paco lives in Sydney"
    });
    expect(prompt).toContain(CORE_FACTS_SECTION_HEADER);
    expect(prompt).not.toContain(EPISODIC_SECTION_HEADER);
  });

  it("the header names the band as always-known durable facts", () => {
    expect(CORE_FACTS_SECTION_HEADER).toContain("always known");
    expect(CORE_FACTS_SECTION_HEADER.toLowerCase()).toContain("about the user");
  });
});
