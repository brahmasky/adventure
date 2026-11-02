import type { Entry, RungAnswer } from "../types.js";

export type LessonsVerdict = "full" | "capped" | "none";
/** Captured in preparePaths from the spawned prompt's snapshot (spec R5 §4.3). */
export interface LessonsInput { rendered: number; skipped: number; failed: boolean }

function rule(s: LessonsInput): RungAnswer<LessonsVerdict> | LessonsVerdict {
  if (s.failed) return { verdict: "none", reason: "render_failed" };
  if (s.skipped > 0) return { verdict: "capped", reason: "char_cap" };
  return "full";
}

export const CONTEXT_LESSONS: Entry<LessonsInput, LessonsVerdict> = {
  id: "context.lessons", version: 1, stage: "pre_model", input: "tool",
  question: "Which active lessons does the spawned planner's system prompt hold under the char cap?",
  verdicts: ["full", "capped", "none"],
  ladder: [{ kind: "rule", name: "lesson_char_cap", decide: rule }],
  fail: "full", defaultVerdict: "full", outcomes: [], armed: { rule: "on" },
  effects: {
    full: { kind: "none", reversible: true, announced: "none" },
    capped: { kind: "tighten", reversible: true, announced: "none", what: "lessons the char cap hid are absent until the next spawn; each raises today's lesson_dropped incident" },
    none: { kind: "tighten", reversible: true, announced: "none", what: "the prompt holds no lessons; today's lesson_render_failed incident is raised" }
  },
  reasonCodes: ["char_cap", "render_failed"],
};
