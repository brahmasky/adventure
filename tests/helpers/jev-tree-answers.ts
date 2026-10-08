import type { JevAnswer, JevChoiceAnswer, JevNoulAnswer, JevScoreAnswer } from "../../src/jev/jev-client.js";
import { CATEGORIES } from "../../src/jev/questions/tree.js";

/** A choice answer: `top` carries p, the rest share 1 − p evenly; confidence as TypeSafe computes it. Tests only. */
export function choiceAns(options: readonly string[], top: string, p: number): JevChoiceAnswer {
  const rest = (1 - p) / (options.length - 1);
  const probabilities = Object.fromEntries(options.map((o) => [o, o === top ? p : rest]));
  const n = options.length;
  return { type: "choice", choice: top, probabilities, confidence: (p - 1 / n) / (1 - 1 / n) };
}

/** A score answer certain of one level (keys "0".."n-1"). */
export function scoreAns(level: number, n = 4): JevScoreAnswer {
  const probabilities = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === level ? 1 : 0]));
  return { type: "score", score: level, probabilities, confidence: 1 };
}

export const noulAns = (p: number): JevNoulAnswer => ({ type: "noul", noul: p });

/** The six tree answers; defaults are a plain light `answer` turn that states no rule. */
export function treeAnswers(o: { category: string; p?: number; setsRule?: number; scope?: "ask" | "research"; breadth?: number;
  reasoning?: number; actions?: number }): Record<string, JevAnswer> {
  return {
    category: choiceAns(CATEGORIES, o.category, o.p ?? 0.9), sets_rule: noulAns(o.setsRule ?? 0.05),
    rule_scope: choiceAns(["ask", "research"], o.scope ?? "ask", 0.9),
    breadth: scoreAns(o.breadth ?? 1), reasoning: scoreAns(o.reasoning ?? 1), actions: scoreAns(o.actions ?? 1)
  };
}
