import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASK_DISCIPLINE,
  composeSystemPrompt,
  EPISODIC_SECTION_HEADER,
  FALLBACK_IDENTITY,
  GUARDRAILS,
  RESEARCH_DISCIPLINE
} from "../../src/prompt/composer.js";

let dirs: string[] = [];
function memoryRoot(identity?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-compose-"));
  dirs.push(dir);
  if (identity !== undefined) {
    mkdirSync(join(dir, "core"), { recursive: true });
    writeFileSync(join(dir, "core", "houge.md"), identity, "utf8");
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A lesson-block reader backed by an in-memory map (the run-store provides the real one). */
function reader(blocks: Record<string, string>): (scope: string) => string | undefined {
  return (scope) => blocks[scope];
}

describe("composeSystemPrompt", () => {
  it("assembles identity + discipline + guardrails (no reader → no lessons section)", () => {
    const root = memoryRoot("# Houge\nI am 猴哥, curious and honest.");
    const prompt = composeSystemPrompt(root, "research");
    expect(prompt).toContain("I am 猴哥, curious and honest."); // identity (loaded, not duplicated)
    expect(prompt).toContain(RESEARCH_DISCIPLINE);
    expect(prompt).toContain(GUARDRAILS);
    expect(prompt).not.toContain("What you've learned"); // no lessons section
  });

  it("a reader that returns nothing for the scope omits the lessons section", () => {
    const root = memoryRoot("I am 猴哥.");
    const prompt = composeSystemPrompt(root, "research", { lessonsReader: reader({}) });
    expect(prompt).not.toContain("What you've learned");
  });

  it("folds the scope's lesson block into the prompt when the reader supplies one", () => {
    const root = memoryRoot("I am 猴哥.");
    const prompt = composeSystemPrompt(root, "research", {
      lessonsReader: reader({ research: "- prefer filings over forums" })
    });
    expect(prompt).toContain("What you've learned");
    expect(prompt).toContain("prefer filings over forums");
  });

  it("falls back to a default identity when houge.md is absent", () => {
    const prompt = composeSystemPrompt(memoryRoot(), "ask");
    expect(prompt).toContain(FALLBACK_IDENTITY);
    expect(prompt).toContain(ASK_DISCIPLINE);
  });

  it("prepends the injected trusted temporal-context line (grounds the model's clock)", () => {
    const root = memoryRoot("I am 猴哥.");
    const prompt = composeSystemPrompt(root, "ask", { now: new Date("2026-06-19T00:00:00.000Z") });
    expect(prompt).toContain("Today's date is 2026-06-19 (UTC).");
    // It leads the prompt so the date grounds everything that follows.
    expect(prompt.startsWith("Today's date is 2026-06-19 (UTC).")).toBe(true);
  });

  it("lessonsScope override lets the critique reuse research lessons", () => {
    const root = memoryRoot("I am 猴哥.");
    const prompt = composeSystemPrompt(root, "research-critique", {
      lessonsReader: reader({ research: "- check the math" }),
      lessonsScope: "research"
    });
    expect(prompt).toContain("check the math");
  });

  it("folds the episodic block in under its header when the reader supplies one (Phase M B3)", () => {
    const root = memoryRoot("I am 猴哥.");
    const prompt = composeSystemPrompt(root, "ask", {
      episodicReader: () => "- Paco lives in Sydney\n- Paco 喜欢周末骑车",
      lessonsReader: reader({ ask: "- be concise" }),
      growIndex: () => "- unit-convert — converting"
    });
    expect(prompt).toContain(EPISODIC_SECTION_HEADER);
    expect(prompt).toContain("- Paco lives in Sydney");
    // Placement: between the grow procedures and lessons — memory grounds the answer before
    // behavioural preferences shape it.
    expect(prompt.indexOf("## Your procedures (grow zone)")).toBeLessThan(prompt.indexOf(EPISODIC_SECTION_HEADER));
    expect(prompt.indexOf(EPISODIC_SECTION_HEADER)).toBeLessThan(prompt.indexOf("## What you've learned"));
  });

  it("is byte-identical when no episodic reader vs a reader that returns nothing (goldens safe)", () => {
    // WHY: the feature is flag-gated OFF by default — every existing surface must
    // compose the exact bytes it did before Phase M, or the eval goldens (and the
    // self-write byte-differential) would move without a behaviour change.
    const root = memoryRoot("I am 猴哥.");
    const now = new Date("2026-07-15T00:00:00.000Z");
    const baseline = composeSystemPrompt(root, "ask", { now });
    const withEmptyReader = composeSystemPrompt(root, "ask", { now, episodicReader: () => undefined });
    expect(withEmptyReader).toBe(baseline);
    expect(baseline).not.toContain(EPISODIC_SECTION_HEADER);
  });
});
