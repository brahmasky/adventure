import type { ImproveJevState, ImproveTarget } from "../decisions/entries/improve-route.js";

/** 2b-ii §4.3 rung 3: the Tiny seat picks ONE word among Jev's top two, from the same redacted state. Code parses; anything else is no answer. */
export const PICK_DISCIPLINE = "You choose between two improvement targets for Houge, Paco's assistant, from a short description of one recurring signal. "
  + "Reply with exactly one word: the first option or the second option. No other words, no punctuation.";

export function buildPickQuestion(s: ImproveJevState, top2: readonly [ImproveTarget, ImproveTarget]): string {
  return [`signal: ${s.signal}`, `value: ${s.value}`, `scope: ${s.scope}`, `count: ${s.count}`, `count_14d: ${s.count_14d}`, `category: ${s.category ?? "none"}`, `lane: ${s.lane ?? "none"}`,
    `capability: ${s.capability ?? "none"}`, `tools: ${s.tools}`, `last_improvement: ${s.last_improvement}`, "", "paco_text (Paco's words, redacted):", s.paco_text.replace(/\s+/g, " "), "",
    `Options: ${top2[0]} or ${top2[1]}.`, `Answer with one word: ${top2[0]} or ${top2[1]}.`].join("\n");
}

export function parsePick(text: string, top2: readonly [ImproveTarget, ImproveTarget]): ImproveTarget | null {
  const word = text.trim().toLowerCase().replace(/[.!。]+$/, "");
  return top2.find((t) => t === word) ?? null;
}
