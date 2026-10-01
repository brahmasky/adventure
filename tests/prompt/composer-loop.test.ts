import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASK_DISCIPLINE,
  composeSystemPrompt,
  DISCIPLINES,
  GUARDRAILS,
  LOOP_GO_AHEAD_RULE,
  OMP_LOOP_DISCIPLINE,
  OMP_LOOP_GUARDRAILS,
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

describe("the `omp` composer surface (ADR 0002 V2: the planner acts through real tools)", () => {
  it("names houge_status for questions about its own runtime, restarts and live code (live 2026-10-02: it asked Paco to kickstart)", () => {
    expect(OMP_LOOP_DISCIPLINE).toMatch(/houge_status for your own runtime: restarts, which code is live/);
  });

  it("a short go-ahead to Houge's own concrete proposal means carry it out, restated in full in any task/focus input (run_79faefea)", () => {
    // Live: Paco answered a proposal with `好，修复一下`; downstream seats saw only those five
    // characters. The rule is part of the planner discipline, not a self-write special case.
    expect(OMP_LOOP_DISCIPLINE).toContain(LOOP_GO_AHEAD_RULE);
    expect(LOOP_GO_AHEAD_RULE).toMatch(/proposal/i);
    expect(LOOP_GO_AHEAD_RULE).toMatch(/without asking again/i);
    expect(LOOP_GO_AHEAD_RULE).toMatch(/restate/i);
    expect(LOOP_GO_AHEAD_RULE).toMatch(/focus/i);
    for (const ack of ["go", "yes", "好", "可以"]) expect(LOOP_GO_AHEAD_RULE).toContain(`"${ack}"`);
    // Guard: a chat go-ahead is never a gate's approval tap, and an "ok" to an answer is not
    // approval of an earlier proposal.
    expect(LOOP_GO_AHEAD_RULE).toMatch(/never stands in for an approval tap that Houge's gates ask for/);
    expect(LOOP_GO_AHEAD_RULE).toMatch(/acknowledgement like 'ok' to an answer is not approval of an earlier proposal/);
    // The spirit stays: prefer doing over asking.
    expect(OMP_LOOP_DISCIPLINE).toMatch(/Prefer doing over asking/);
  });

  it("self_write_propose is named with its precondition: verify the cause in the code first (run_79faefea)", () => {
    expect(OMP_LOOP_DISCIPLINE).toMatch(/self_write_propose[^.]*after you have confirmed the cause in the code/);
  });

  it("composes identity + the omp discipline + the omp ground rule — never the answer-don't-act GUARDRAILS", () => {
    const prompt = composeSystemPrompt(memoryRoot(), "omp");
    expect(prompt).toContain("I am 猴哥.");
    expect(prompt).toContain(OMP_LOOP_DISCIPLINE);
    expect(prompt).toContain(OMP_LOOP_GUARDRAILS);
    // The answer-don't-act guardrail would contradict a planner that uses tools.
    expect(prompt).not.toContain(GUARDRAILS);
  });

  it("folds lessons + skills in via the existing readers", () => {
    const prompt = composeSystemPrompt(memoryRoot(), "omp", {
      lessonsReader: (scope) => (scope === "ask" ? "- be more concise" : undefined),
      lessonsScope: "ask",
      skillsReader: (scope) => (scope === "ask" ? "### cross-check — when: comparing\nverify" : undefined),
      skillsScope: "ask"
    });
    expect(prompt).toContain("## What you've learned — apply these\n- be more concise");
    expect(prompt).toContain("## Skills — apply when relevant");
  });

  it("the other surfaces stay byte-identical (goldens safe): GUARDRAILS unchanged, no planner text", () => {
    const root = memoryRoot();
    const now = new Date("2026-07-02T00:00:00.000Z");
    for (const surface of ["ask", "research", "research-critique", "selfcode", "skill-author"]) {
      const prompt = composeSystemPrompt(root, surface, { now });
      expect(prompt).toContain(GUARDRAILS);
      expect(prompt).not.toContain(OMP_LOOP_DISCIPLINE);
      expect(prompt).not.toContain(OMP_LOOP_GUARDRAILS);
    }
    const ask = composeSystemPrompt(root, "ask", { now });
    expect(ask).toBe(["Today's date is 2026-07-02 (UTC).", "I am 猴哥.", ASK_DISCIPLINE, GUARDRAILS].join("\n\n"));
    const research = composeSystemPrompt(root, "research", { now });
    expect(research).toBe(["Today's date is 2026-07-02 (UTC).", "I am 猴哥.", RESEARCH_DISCIPLINE, GUARDRAILS].join("\n\n"));
  });

  it("the old `loop` surface (the JSON action protocol) is gone with the inner loop (Task 14)", () => {
    expect(Object.keys(DISCIPLINES)).not.toContain("loop");
  });
});
