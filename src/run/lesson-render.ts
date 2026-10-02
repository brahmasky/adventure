import { createHash } from "node:crypto";
import { themeRank } from "./lesson-themes.js";
import { resolveLessonCapPerScope, type LessonRow, type RunStore } from "./run-store.js";

/**
 * The omp planner's lesson section (memory A1 §1). `readLessonBlock` keeps its contract for its other callers;
 * this renderer is omp's: every active lesson of both scopes, theme then id (a rating or decay never reorders
 * it), skip-and-continue under a char cap. Pure: raising a skip is the caller's job (turn-context at spawn, the
 * invariant sweep twice a day).
 */
export const OMP_LESSON_SCOPES = ["ask", "research"] as const;

/** Char cap on the rendered section (HOUGE_LESSON_CHAR_CAP). */
export const DEFAULT_LESSON_CHAR_CAP = 4000;

export function resolveLessonCharCap(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_LESSON_CHAR_CAP);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LESSON_CHAR_CAP;
}

/**
 * The lesson SET a planner session was started on (memory A1 §6): sha256 over (id, text, avoid, theme) of every
 * active ask + research lesson, sorted by id. Never the rendered bytes, so a reorder, a rating or a date flip
 * cannot trigger a reset.
 */
export function lessonSetFingerprint(store: Pick<RunStore, "getActiveLessons">, scopes: readonly string[] = OMP_LESSON_SCOPES): string {
  const rows = scopes
    .flatMap((scope) => store.getActiveLessons(scope))
    .map((l) => [l.id, l.text, l.avoid, l.theme] as const)
    .sort((a, b) => a[0] - b[0]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export interface LessonSkip { lesson_id: number; chars: number; cap: number }

export interface LessonSection {
  /** The rendered bullets, or undefined when none rendered (the composer omits the section). */
  block: string | undefined;
  /** Rendered lesson ids, in render order: what attribution credits. */
  ids: number[];
  /** Scopes with at least one rendered lesson, in `scopes` order. */
  scopes: string[];
  skipped: LessonSkip[];
}

export function lessonBullet(row: Pick<LessonRow, "text" | "avoid" | "theme">): string {
  const head = `- [${row.theme}] ${row.text}`;
  return row.avoid ? `${head}\n  AVOID: ${row.avoid}` : head;
}

/** The scopes' active lessons (each row-capped per scope, as today), theme then id. */
function orderedLessons(store: Pick<RunStore, "getActiveLessons">, scopes: readonly string[], env: NodeJS.ProcessEnv): LessonRow[] {
  const cap = resolveLessonCapPerScope(env);
  return scopes
    .flatMap((scope) => store.getActiveLessons(scope, cap))
    .sort((a, b) => themeRank(a.theme) - themeRank(b.theme) || a.theme.localeCompare(b.theme) || a.id - b.id);
}

export function renderLessonSection(
  store: Pick<RunStore, "getActiveLessons">,
  scopes: readonly string[] = OMP_LESSON_SCOPES,
  env: NodeJS.ProcessEnv = process.env
): LessonSection {
  const cap = resolveLessonCharCap(env);
  const bullets: string[] = [];
  const ids: number[] = [];
  const rendered = new Set<string>();
  const skipped: LessonSkip[] = [];
  let length = 0;
  for (const row of orderedLessons(store, scopes, env)) {
    const bullet = lessonBullet(row);
    const next = length + (bullets.length > 0 ? 1 : 0) + bullet.length;
    if (next > cap) {
      skipped.push({ lesson_id: row.id, chars: bullet.length, cap });
      continue; // skip-and-continue: a smaller lesson later may still fit
    }
    bullets.push(bullet);
    ids.push(row.id);
    rendered.add(row.scope);
    length = next;
  }
  return { block: bullets.length > 0 ? bullets.join("\n") : undefined, ids, scopes: scopes.filter((s) => rendered.has(s)), skipped };
}
