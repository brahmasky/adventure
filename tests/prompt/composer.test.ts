import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASK_DISCIPLINE,
  composeSystemPrompt,
  FALLBACK_IDENTITY,
  GUARDRAILS,
  intentToScope,
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

  it("folds the scope's skills block in with a when: line when the reader supplies one", () => {
    const root = memoryRoot("I am 猴哥.");
    const prompt = composeSystemPrompt(root, "research", {
      skillsReader: reader({
        research: "### cross-check — when: comparing figures\nVerify each number against its source."
      })
    });
    expect(prompt).toContain("## Skills — apply when relevant");
    expect(prompt).toContain("when: comparing figures");
    expect(prompt).toContain("Verify each number against its source.");
  });

  it("is byte-identical when no skills reader vs a reader that returns nothing (goldens safe)", () => {
    const root = memoryRoot("I am 猴哥.");
    const now = new Date("2026-06-19T00:00:00.000Z");
    const baseline = composeSystemPrompt(root, "research", { now });
    const withEmptyReader = composeSystemPrompt(root, "research", { now, skillsReader: () => undefined });
    expect(withEmptyReader).toBe(baseline);
  });

  it("skillsScope override lets the critique reuse research skills", () => {
    const root = memoryRoot("I am 猴哥.");
    const prompt = composeSystemPrompt(root, "research-critique", {
      skillsReader: reader({ research: "### cross-check — when: comparing figures\nmethod body" }),
      skillsScope: "research"
    });
    expect(prompt).toContain("method body");
  });
});

describe("intentToScope", () => {
  it("maps answer→ask and research→research", () => {
    expect(intentToScope("answer")).toBe("ask");
    expect(intentToScope("research")).toBe("research");
    expect(intentToScope("feedback")).toBe("ask");
    expect(intentToScope("clarify")).toBe("ask");
  });
});
