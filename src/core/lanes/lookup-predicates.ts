/** Stage B §5 step 2 constants; the lane's recent-context rule and query check live here so the decision entries import a leaf (spec R6 §4.1, plan P9). */
export const REWRITE_RECENT_MS = 30 * 60_000;
export const QUERY_MAX_CHARS = 120;

/** Earlier lines go into the rewrite prompt only when Paco's previous Telegram line is at most 30 min old. `ageMs > …` as before: NaN or a negative age counts as recent. */
export function recentContextOf(ageMs: number | null): boolean {
  return ageMs !== null && !(ageMs > REWRITE_RECENT_MS);
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
