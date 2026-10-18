import { LESSON_AVOID_MAX_CHARS, shouldRejectLesson, type MemoryDistill } from "./distill.js";
import { checkEvidence, normalizeForEvidence, type TranscriptLine } from "./episodic-evidence.js";
import { sanitizeFactText, shouldRejectFact } from "./episodic-extract.js";
import { storedTurnIds } from "./memory-sources.js";

/**
 * The memory save's code backstops (spec 2026-10-15 §6). The model never decides what Paco said: a rule is judged
 * against his cut text and the prior reply (ADR 0010 §5's lifting rule), a fact against the numbered line it cites.
 */
export type LessonSide = { ok: true; lesson: string; avoid?: string } | { ok: false; reason: "rejected_by_backstop" };
export type FactSide = { ok: true; fact: string; source_turn_ids: string[] } | { ok: false; reason: "no_evidence" | "rejected_by_backstop" };

/** The rule side; null when the distill wrote no rule. A lifted or over-cap AVOID is dropped, not the rule. */
export function checkLessonSide(d: MemoryDistill, pacoText: string, prior: string): LessonSide | null {
  if (d.lesson === undefined) return null;
  if (shouldRejectLesson(d.lesson, pacoText, prior)) return { ok: false, reason: "rejected_by_backstop" };
  const avoid = d.avoid !== undefined && d.avoid.length <= LESSON_AVOID_MAX_CHARS && !shouldRejectLesson(d.avoid, pacoText, prior) ? d.avoid : undefined;
  return { ok: true, lesson: d.lesson, ...(avoid ? { avoid } : {}) };
}

/** Plan Rev 2 item 5: a quote must carry words, not a character (checkEvidence alone accepts one). */
export const MIN_QUOTE_CHARS = 6;
export const MIN_QUOTE_CHARS_CJK = 3;
const HAN_ONLY = /^\p{Script=Han}+$/u;

function quoteTooShort(quote: string): boolean {
  // Only letters and digits count: punctuation and spaces carry no words, so "。。。" or "!!!!!!" is never a quote.
  const q = normalizeForEvidence(quote).replace(/[^\p{L}\p{N}]/gu, "");
  if (q.length === 0) return true;
  return Array.from(q).length < (HAN_ONLY.test(q) ? MIN_QUOTE_CHARS_CJK : MIN_QUOTE_CHARS);
}

/**
 * The fact side; null when the distill wrote no fact. The A1 evidence check runs in enforce mode here whatever
 * HOUGE_EPISODIC_EVIDENCE says (spec §6): the quote must be on one of Paco's numbered lines, never the prior, and long
 * enough to mean something; a fact lifted from the prior that Paco never wrote is refused (the lesson lifting rule).
 */
export function checkFactSide(d: MemoryDistill, lines: readonly TranscriptLine[], runSource: (run_id: string) => string | undefined,
  paco: { text: string; prior: string }): FactSide | null {
  if (d.fact === undefined) return null;
  if (d.factRefused || !d.evidence || quoteTooShort(d.evidence.quote)) return { ok: false, reason: "no_evidence" };
  const verdict = checkEvidence(d.evidence, lines, runSource);
  if (!verdict.ok) return { ok: false, reason: "no_evidence" };
  const fact = sanitizeFactText(d.fact);
  if (shouldRejectFact(fact) || shouldRejectLesson(fact, paco.text, paco.prior)) return { ok: false, reason: "rejected_by_backstop" };
  return { ok: true, fact, source_turn_ids: storedTurnIds(verdict.turn_id) };
}
