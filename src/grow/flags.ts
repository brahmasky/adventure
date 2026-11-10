import { isAbsolute, join, relative, resolve, sep } from "node:path";

const off = (raw: string | undefined): boolean => { const v = raw?.trim().toLowerCase(); return v === "0" || v === "false" || v === "no" || v === "off"; };

/** Off removes the index and both grow tools (the composer omits the section). Default on. */
export function resolveSkillsEnabled(env: NodeJS.ProcessEnv): boolean { return !off(env.HOUGE_SKILLS_ENABLED); }

/** Off refuses every submit; reading continues. Default on; in DISARM_FLAGS. */
export function resolveGrowEnabled(env: NodeJS.ProcessEnv): boolean { return !off(env.HOUGE_GROW_ENABLED); }

/**
 * Lower-cased absolute spelling, as the deny matcher compares (macOS volumes are case-insensitive). Over-refuses on a
 * case-sensitive volume, the safe direction. No filesystem access: a symlink spelling is not resolved here.
 */
const key = (p: string): string => resolve(p).toLowerCase();

/** True when `child` is `parent` or inside it, compared by path segment (`/a/b` is not inside `/a/bc`). */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(key(parent), key(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when `dir` equals, contains, or sits inside `other`: a deny on one would cut off the other. */
const overlaps = (dir: string, other: string): boolean => isWithin(dir, other) || isWithin(other, dir);

/**
 * The grow zone's own git repository, outside the code checkout (spec §5.1). An override must be absolute, at least
 * three segments deep, not the home directory or an ancestor of it, and overlapping none of `avoid` (the checkout,
 * the data dir) nor ~/.omp; anything else falls back to the default. The returned path keeps the override's own
 * normalised spelling.
 */
export function resolveGrowDir(env: NodeJS.ProcessEnv, home: string, avoid: readonly string[] = []): string {
  const fallback = join(home, "Library", "Application Support", "houge", "grow");
  const raw = env.HOUGE_GROW_DIR?.trim();
  if (!raw || !isAbsolute(raw)) return fallback;
  const dir = resolve(raw);
  if (dir.split(sep).filter(Boolean).length < 3 || isWithin(home, dir)) return fallback; // home or an ancestor of it
  // the grow dir is read+write-denied: refuse one that overlaps the checkout, the data dir, or ~/.omp (the planner profile exempts it)
  if ([...avoid, join(home, ".omp")].some((a) => overlaps(dir, a))) return fallback;
  return dir;
}
