import { createHash } from "node:crypto";
import type { JevChoiceQuestion, JevNoulQuestion, JevQuestion, JevScoreQuestion } from "../jev-client.js";

/**
 * A frozen Jev question (ADR 0029 §3.1), one of TypeSafe's three wire types. Choice criteria are an ORDERED list
 * because jev-1.13 leans toward the first option: order is part of the calibration key, so the hash covers it. Score
 * levels are ordered by meaning (level 0 first). The model id is NOT in the hash — it is the second key of a threshold
 * row (§3.5), so a model move and a wording edit are told apart in the rows.
 */
export interface ChoiceQuestion {
  id: string;
  type: "choice";
  instructions: string;
  criteria: ReadonlyArray<readonly [string, string]>;
}
export interface ScoreQuestion {
  id: string;
  type: "score";
  instructions: string;
  levels: readonly string[];
}
export interface NoulQuestion {
  id: string;
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export function optionsOf(q: ChoiceQuestion): string[] {
  return q.criteria.map(([option]) => option);
}

/** The wire shape. A choice's criteria object keeps the listed order as its insertion order. */
export function toJevQuestion(q: Question): JevQuestion {
  switch (q.type) {
    case "choice": {
      const criteria: Record<string, string> = {};
      for (const [option, text] of q.criteria) criteria[option] = text;
      return { type: "choice", instructions: q.instructions, criteria } satisfies JevChoiceQuestion;
    }
    case "score":
      return { type: "score", instructions: q.instructions, criteria: [...q.levels] } satisfies JevScoreQuestion;
    case "noul":
      return (q.criteria
        ? { type: "noul", instructions: q.instructions, criteria: { true: q.criteria.true, false: q.criteria.false } }
        : { type: "noul", instructions: q.instructions }) satisfies JevNoulQuestion;
  }
}

/**
 * sha256 over the exact request shape, per type. A choice hashes `{type, instructions, criteria: [[opt, text], …]}` —
 * byte-identical to the choice-only hash, so lane 1's calibration rows still name their questions. A score hashes its
 * ordered levels; a noul its `[["true", …], ["false", …]]` pair, or no `criteria` key when it has none.
 */
export function criteriaHash(q: Question): string {
  return createHash("sha256").update(JSON.stringify(hashShape(q))).digest("hex");
}

function hashShape(q: Question): Record<string, unknown> {
  switch (q.type) {
    case "choice": return { type: q.type, instructions: q.instructions, criteria: q.criteria.map(([o, t]) => [o, t]) };
    case "score": return { type: q.type, instructions: q.instructions, criteria: [...q.levels] };
    case "noul": return q.criteria
      ? { type: q.type, instructions: q.instructions, criteria: [["true", q.criteria.true], ["false", q.criteria.false]] }
      : { type: q.type, instructions: q.instructions };
  }
}
