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
  // Only letters, combining marks and digits count: punctuation and spaces carry no words, so "。。。" or "!!!!!!" is never a quote.
  const q = normalizeForEvidence(quote).replace(/[^\p{L}\p{M}\p{N}]/gu, "");
  if (q.length === 0) return true;
  return Array.from(q).length < (HAN_ONLY.test(q) ? MIN_QUOTE_CHARS_CJK : MIN_QUOTE_CHARS);
}

/** Directive phrases carry no fact: stripped before Han 2-grams are cut, so "记下来" yields no token at all. */
const HAN_DIRECTIVES = /记下来|记一下|记下|记住|保存|帮我|一下|请/gu;
/** Latin words that carry no fact (directives, pronouns, glue) and the two names every line may carry. */
const LATIN_STOPWORDS = new Set(["remember", "save", "note", "this", "that", "please", "these", "those", "with", "from", "have",
  "will", "would", "should", "could", "just", "also", "about", "what", "them", "they", "there", "here", "your", "mine", "paco", "houge"]);

/**
 * The substantive tokens of a text (final review, security): Han 2-grams, Latin words of four or more letters or any
 * capitalised one of two or more (lower-cased, a plural "s" dropped), numbers, and letter runs of three or more in other scripts.
 */
export function substantiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  const t = normalizeForEvidence(text);
  for (const run of t.replace(HAN_DIRECTIVES, " ").match(/\p{Script=Han}+/gu) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
  }
  for (const w of t.match(/\p{Script=Latin}+/gu) ?? []) {
    const low = w.toLowerCase();
    if (!LATIN_STOPWORDS.has(low) && (w.length >= 4 || (w.length >= 2 && /^\p{Lu}/u.test(w)))) out.add(low.length >= 5 ? low.replace(/s$/u, "") : low);
  }
  for (const n of t.match(/\p{N}+/gu) ?? []) out.add(n);
  for (const w of t.match(/[\p{L}\p{M}]+/gu) ?? []) if (!/\p{Script=Han}|\p{Script=Latin}/u.test(w) && Array.from(w).length >= 3) out.add(w.toLowerCase());
  return out;
}

/** The fact is tied to Paco's words only when it shares a substantive token with the line it cites. */
function factSupported(fact: string, quote: string, line: string): boolean {
  if (substantiveTokens(quote).size === 0) return false;
  const lineTokens = substantiveTokens(line);
  for (const tok of substantiveTokens(fact)) if (lineTokens.has(tok)) return true;
  return false;
}

/**
 * The fact side; null when the distill wrote no fact. The A1 evidence check runs in enforce mode here whatever
 * HOUGE_EPISODIC_EVIDENCE says (spec §6): the quote must be on one of Paco's numbered lines, never the prior, and long
 * enough to mean something, carry a substantive word, and the fact must share one with the cited line (a bare "记下来"
 * quote cannot carry a fact paraphrased from the prior); a fact lifted from the prior that Paco never wrote is refused.
 */
export function checkFactSide(d: MemoryDistill, lines: readonly TranscriptLine[], runSource: (run_id: string) => string | undefined,
  paco: { text: string; prior: string }): FactSide | null {
  if (d.fact === undefined) return null;
  if (d.factRefused || !d.evidence || quoteTooShort(d.evidence.quote)) return { ok: false, reason: "no_evidence" };
  const verdict = checkEvidence(d.evidence, lines, runSource);
  if (!verdict.ok) return { ok: false, reason: "no_evidence" };
  const fact = sanitizeFactText(d.fact);
  if (shouldRejectFact(fact) || shouldRejectLesson(fact, paco.text, paco.prior)) return { ok: false, reason: "rejected_by_backstop" };
  if (!factSupported(fact, d.evidence.quote, lines[d.evidence.line - 1]?.text ?? "")) return { ok: false, reason: "no_evidence" };
  return { ok: true, fact, source_turn_ids: storedTurnIds(verdict.turn_id) };
}
