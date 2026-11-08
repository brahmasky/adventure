import { LESSON_REWRITE_DAYS } from "../decisions/entries/improve-route.js";
import { cosineSimilarity } from "../llm/embeddings.js";
import type { RunStore } from "../run/run-store.js";
import { PROPOSAL_TTL_DAYS } from "./proposals.js";
import { EMBED_TEXT_CHAR_CAP, type Embedder } from "./recurrence.js";

/**
 * Addendum Rev 2.3.1 A + ruling R1' (ADR 0034 10.5): the 14-day block covers repeats, not the category. A lesson or fact draft
 * is compared (cosine of the embedded texts, at or above LESSON_REPEAT_COSINE) with the draft text of proposals on the same
 * (target, scope): a near-copy of one Paco undid (reverted, 14 d) is a repeat; a near-copy of a lesson Houge still holds
 * (accepted, LESSON_REWRITE_DAYS) is the 'lesson did not hold' rewrite; of an accepted fact (14 d), a repeat. Set to 0.6 by controller ruling 2026-11-08 (probe: max distinct 0.479, min near 0.667; a false repeat loses a correction, a false new only adds a duplicate),
 * set from the threshold probe (scripts/probe-lesson-repeat-cosine.mjs). The embeds run outside any transaction and count
 * against the tick's budget.
 */
export const LESSON_REPEAT_COSINE = 0.6;
export type Candidate = { proposal_id: string; text: string; state: "accepted" | "reverted"; resolved_at: string };
export type RepeatResult = { kind: "repeat" | "new"; ids: string[] } | { kind: "rewrite"; ids: string[]; ageDays: number; matched: string } | { kind: "embed_down" } | { kind: "over_budget" };
const DAY_MS = 24 * 60 * 60 * 1000;
const capped = (t: string): string => Array.from(t).slice(0, EMBED_TEXT_CHAR_CAP).join("");
const before = (now: string, days: number): string => new Date(Date.parse(now) - days * DAY_MS).toISOString();

/** The candidates of a pair at `now`: reverted 14 d; accepted 30 d for a lesson (the rewrite window), 14 d for a fact. The check and the commit recheck read this one list. */
export function repeatCandidatesFor(store: RunStore, target: "lesson" | "fact", scope: string, now: string): Candidate[] {
  return store.repeatCandidates(target, scope, before(now, PROPOSAL_TTL_DAYS), before(now, target === "lesson" ? LESSON_REWRITE_DAYS : PROPOSAL_TTL_DAYS));
}

/** The near-copies of `text` among the candidates with text, or a stop; no candidate with text means no embed call at all (R2). */
async function nearCopies(d: { embed: Embedder; overBudget: () => boolean }, text: string, cands: readonly Candidate[]): Promise<Candidate[] | "embed_down" | "over_budget"> {
  const withText = cands.filter((c) => c.text.trim().length > 0);
  if (withText.length === 0) return [];
  const mine = await d.embed(capped(text));
  if (mine === null) return "embed_down";
  if (d.overBudget()) return "over_budget"; // checked after every embed, the last one included: a group that crossed the budget stops unconsumed
  const near: Candidate[] = [];
  for (const c of withText) {
    const v = await d.embed(capped(c.text));
    if (v === null) return "embed_down";
    if (d.overBudget()) return "over_budget";
    if (cosineSimilarity(mine, v) >= LESSON_REPEAT_COSINE) near.push(c);
  }
  return near;
}

/** `ids` is every candidate's proposal id (the commit rechecks it). A reverted near-copy wins over an accepted one: Paco's undo sticks. */
export async function repeatCheck(d: { store: RunStore; embed: Embedder; overBudget: () => boolean }, target: "lesson" | "fact", scope: string, text: string, now: string): Promise<RepeatResult> {
  const cands = repeatCandidatesFor(d.store, target, scope, now);
  const ids = cands.map((c) => c.proposal_id);
  const near = await nearCopies(d, text, cands);
  if (near === "embed_down" || near === "over_budget") return { kind: near };
  if (near.length === 0) return { kind: "new", ids };
  const held = near.filter((c) => c.state === "accepted");
  if (target === "fact" || held.length < near.length) return { kind: "repeat", ids };
  const newest = held.reduce((m, c) => (c.resolved_at > m.resolved_at ? c : m));
  return { kind: "rewrite", ids, ageDays: Math.floor((Date.parse(now) - Date.parse(newest.resolved_at)) / DAY_MS), matched: newest.proposal_id };
}

/** The commit-time recheck: the same candidate ids, in the same (proposal_id) order. */
export const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
