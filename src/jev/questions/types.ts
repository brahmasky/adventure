import { createHash } from "node:crypto";
import type { JevChoiceQuestion } from "../jev-client.js";

/**
 * A frozen Jev question (ADR 0029 §3.1). Criteria are an ORDERED list because jev-1.13 leans toward the first
 * option: order is part of the calibration key, so the hash covers it. The model id is NOT in the hash — it is the
 * second key of a threshold row (§3.5), so a model move and a wording edit are told apart in the rows.
 */
export interface Question {
  id: string;
  type: "choice";
  instructions: string;
  criteria: ReadonlyArray<readonly [string, string]>;
}

export function optionsOf(q: Question): string[] {
  return q.criteria.map(([option]) => option);
}

/** The wire shape: an object whose insertion order is the listed order. */
export function toJevQuestion(q: Question): JevChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const [option, text] of q.criteria) criteria[option] = text;
  return { type: q.type, instructions: q.instructions, criteria };
}

/** sha256 over the exact request shape: `{type, instructions, criteria: [[opt, text], …]}`. */
export function criteriaHash(q: Question): string {
  return createHash("sha256").update(JSON.stringify({ type: q.type, instructions: q.instructions, criteria: q.criteria.map(([o, t]) => [o, t]) })).digest("hex");
}
