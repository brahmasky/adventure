/**
 * Lesson themes (memory A1, spec §5): closed labels that bound MERGING, never learning. A new theme is a code
 * change. The list order is the omp render order (spec §1: theme, then id); `unthemed` renders last.
 */
/** PROVISIONAL pending Paco (list and wording). */
export const LESSON_THEMES = ["format", "time", "honesty", "hygiene", "sources", "tasks", "self"] as const;
export type LessonTheme = (typeof LESSON_THEMES)[number];

/**
 * The scopes the omp planner renders together (memory A1 §1): one lesson set, so a reconcile verdict may target either.
 * Lives here (not lesson-render.ts) so run-store can use it without an import cycle.
 */
export const OMP_LESSON_SCOPES = ["ask", "research"] as const;

/**
 * A lesson is one line wherever it is shown (final-review B1): every whitespace run, including CR/LF, NEL (U+0085),
 * VT, FF and the Unicode line/paragraph separators, collapses to one space. Escapes only, never a raw separator.
 */
export function flattenLessonText(text: string): string {
  return text.replace(/[\s\u0085\u2028\u2029]+/g, " ").trim();
}

/** The column default and the label for a theme the reconcile call did not name from the list. */
export const UNTHEMED = "unthemed";

/** What belongs under each theme — shown to the reconcile call so it can pick one. */
export const LESSON_THEME_DEFINITIONS: Record<LessonTheme, string> = {
  format: "how a reply is shaped: length, structure, language, tone",
  time: "dates, time zones, schedules and how times are stated",
  honesty: "accuracy, stating uncertainty, admitting limits, never inventing facts",
  hygiene: "what never appears in a reply: sign-offs, forms of address, meta-commentary, garbled text, re-asking what Paco already said",
  sources: "how to search, which sources to trust, how to weigh and cite them",
  tasks: "content rules for a named recurring task, such as the AI daily report: what to include or leave out",
  self: "how Houge talks about or changes itself"
};

export function isLessonTheme(value: unknown): value is LessonTheme {
  return typeof value === "string" && (LESSON_THEMES as readonly string[]).includes(value);
}

/** Render rank: the list's order; `unthemed` (and any stray value) after every listed theme. */
export function themeRank(theme: string): number {
  const i = (LESSON_THEMES as readonly string[]).indexOf(theme);
  return i === -1 ? LESSON_THEMES.length : i;
}
