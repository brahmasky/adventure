import type { Entry, RungAnswer } from "../types.js";

export type MemoryAdmitVerdict = "admit" | "refuse";
/** The code-owned memory-save refusals (spec 2026-10-30 §4.1): three before the distill, three backstop sides after it. */
export const MEMORY_ADMIT_REASONS = ["scheduled_run", "already_saved", "code_owned", "lesson_backstop", "fact_backstop", "fact_no_evidence"] as const;
export type MemoryAdmitReason = (typeof MEMORY_ADMIT_REASONS)[number];
export interface MemoryAdmitInput { seam: "pre" | "backstop"; refused?: MemoryAdmitReason }

function rule(s: MemoryAdmitInput): RungAnswer<MemoryAdmitVerdict> {
  return s.refused === undefined ? { verdict: "admit" } : { verdict: "refuse", reason: s.refused };
}

export const MEMORY_LESSON_ADMIT: Entry<MemoryAdmitInput, MemoryAdmitVerdict> = {
  id: "memory.lesson_admit", version: 1, stage: "pre_tool", input: "mixed",
  question: "Does this memory save (rule or fact) pass the code-owned admission checks?",
  verdicts: ["admit", "refuse"],
  ladder: [{ kind: "rule", name: "memoryAdmits", decide: rule }],
  fail: "refuse", defaultVerdict: "admit", outcomes: [], armed: { rule: "on" },
  effects: { admit: { kind: "none", reversible: true, announced: "none" }, refuse: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [...MEMORY_ADMIT_REASONS],
};
