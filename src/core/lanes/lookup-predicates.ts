/** Stage B §5 step 2 constants; the lane's earlier-lines rule, address strip and query check live here so the decision entries import a leaf (spec R6 §4.1, plan P9). */
export const REWRITE_MAX_CHARS = 40;
export const REWRITE_RECENT_MS = 30 * 60_000;
export const QUERY_MAX_CHARS = 120;

/**
 * Earlier lines go into the rewrite prompt only for a short or quoting follow-up to a recent line: Paco's previous Telegram
 * line at most 30 min old, AND quoting or at most 40 code points. They can carry text Houge wrote from web sources, so a
 * message that stands on its own gets none. `ageMs > …` as before: NaN or a negative age counts as recent.
 */
export function earlierLinesOf(message: string, quoted: boolean, ageMs: number | null): boolean {
  return ageMs !== null && !(ageMs > REWRITE_RECENT_MS) && (quoted || [...message.trim()].length <= REWRITE_MAX_CHARS);
}

// Both run on the trimmed message and start on a fixed character, so neither rescans a run of whitespace from every position.
const ADDRESS_HEAD = /^(?:猴哥|houge)\s*[,，:：!！、]\s*/i;
const ADDRESS_TAIL = /[,，、]\s*(?:猴哥|houge)\s*[.。!！?？]*$/i;
/**
 * The message without the name Paco addresses Houge by, for the search of the bare message (the rewrite late, failed or
 * SAME). Only at the very start or end and set off by punctuation, so the name as the subject of a question stays ("猴哥
 * 帮我查" with a bare space is left to the rewrite: "Houge is …" reads the same way); a message that is nothing but the
 * address stays whole.
 */
export function stripAddress(message: string): string {
  const s = message.trim().replace(ADDRESS_HEAD, "").replace(ADDRESS_TAIL, "").trim();
  return s.length > 0 ? s : message;
}

export type QueryCheck = { kind: "same" } | { kind: "invalid" } | { kind: "query"; q: string };
/** The model's rewrite: stripped as today; SAME (any case, optional . ! 。); empty, multi-line, over 120 UTF-16 units or a URL is invalid. */
export function queryCheckOf(raw: string): QueryCheck {
  const q = raw.trim().replace(/^["'`“”「]+|["'`“”」]+$/g, "").trim();
  if (q.length === 0) return { kind: "invalid" };
  if (/^same[.!。]?$/i.test(q)) return { kind: "same" };
  if (q.includes("\n") || q.length > QUERY_MAX_CHARS || /https?:\/\/|www\./i.test(q)) return { kind: "invalid" };
  return { kind: "query", q };
}

export interface ThinInput { answered: boolean; url: boolean }
export type ThinStep = "thin" | "answered" | "no_url";
/** Stage B §5 step 5 trigger: the first read left the objective unanswered and a listable URL exists. */
export function thinOf(s: ThinInput): ThinStep {
  if (s.answered) return "answered";
  return s.url ? "thin" : "no_url";
}
