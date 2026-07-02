import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASK_DISCIPLINE,
  composeSystemPrompt,
  GUARDRAILS,
  LOOP_DISCIPLINE,
  LOOP_GUARDRAILS,
  RESEARCH_DISCIPLINE
} from "../../src/prompt/composer.js";

let dirs: string[] = [];
function memoryRoot(identity = "I am 猴哥."): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-compose-loop-"));
  dirs.push(dir);
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "core", "houge.md"), identity, "utf8");
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("the additive `loop` composer surface (ADR 0013, step ⓪·1)", () => {
  it("composes identity + loop discipline + the loop ground rule", () => {
    const prompt = composeSystemPrompt(memoryRoot(), "loop");
    expect(prompt).toContain("I am 猴哥.");
    expect(prompt).toContain(LOOP_DISCIPLINE);
    expect(prompt).toContain(LOOP_GUARDRAILS);
    // The answer-don't-act guardrail would contradict the loop; it is NOT used here.
    expect(prompt).not.toContain(GUARDRAILS);
  });

  it("folds lessons + skills in via the existing readers", () => {
    const prompt = composeSystemPrompt(memoryRoot(), "loop", {
      lessonsReader: (scope) => (scope === "ask" ? "- be more concise" : undefined),
      lessonsScope: "ask",
      skillsReader: (scope) => (scope === "ask" ? "### cross-check — when: comparing\nverify" : undefined),
      skillsScope: "ask"
    });
    expect(prompt).toContain("## What you've learned — apply these\n- be more concise");
    expect(prompt).toContain("## Skills — apply when relevant");
  });

  it("existing surfaces stay byte-identical (goldens safe): GUARDRAILS unchanged, no loop text", () => {
    const root = memoryRoot();
    const now = new Date("2026-07-02T00:00:00.000Z");
    for (const surface of ["ask", "research", "research-critique", "selfcode", "skill-author"]) {
      const prompt = composeSystemPrompt(root, surface, { now });
      expect(prompt).toContain(GUARDRAILS);
      expect(prompt).not.toContain(LOOP_DISCIPLINE);
      expect(prompt).not.toContain(LOOP_GUARDRAILS);
    }
    // Spot-check the exact legacy assembly for a surface (identity + discipline + guardrails).
    const ask = composeSystemPrompt(root, "ask", { now });
    expect(ask).toBe(
      ["Today's date is 2026-07-02 (UTC).", "I am 猴哥.", ASK_DISCIPLINE, GUARDRAILS].join("\n\n")
    );
    const research = composeSystemPrompt(root, "research", { now });
    expect(research).toBe(
      ["Today's date is 2026-07-02 (UTC).", "I am 猴哥.", RESEARCH_DISCIPLINE, GUARDRAILS].join("\n\n")
    );
  });
});
