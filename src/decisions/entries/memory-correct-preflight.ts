import type { Entry, RungAnswer } from "../types.js";

export type MemoryCorrectVerdict = "allow" | "refuse";
/** writeRefusal's trust limits (src/capabilities/memory-correct.ts), in their check order; both `too_many` checks map here. */
export const MEMORY_CORRECT_REFUSALS = ["not_operator_turn", "tainted_turn", "too_many", "not_offered"] as const;
export type MemoryCorrectRefusal = (typeof MEMORY_CORRECT_REFUSALS)[number];
/** No caller field: rowOf stores verdict + reason only (plan P3). */
export interface MemoryCorrectInput { refused: MemoryCorrectRefusal | null }

function rule(s: MemoryCorrectInput): RungAnswer<MemoryCorrectVerdict> {
  return s.refused === null ? { verdict: "allow" } : { verdict: "refuse", reason: s.refused };
}

export const MEMORY_CORRECT_PREFLIGHT: Entry<MemoryCorrectInput, MemoryCorrectVerdict> = {
  id: "memory.correct_preflight", version: 1, stage: "pre_tool", input: "tool",
  question: "Does this memory retire or correct pass the code-owned trust limits?",
  verdicts: ["allow", "refuse"],
  ladder: [{ kind: "rule", name: "writeRefusal", decide: rule }],
  fail: "refuse", defaultVerdict: "allow", outcomes: [], armed: { rule: "on" },
  effects: { allow: { kind: "none", reversible: true, announced: "none" }, refuse: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [...MEMORY_CORRECT_REFUSALS],
};
