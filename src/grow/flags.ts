import { isAbsolute, join, relative, resolve, sep } from "node:path";

const off = (raw: string | undefined): boolean => { const v = raw?.trim().toLowerCase(); return v === "0" || v === "false" || v === "no" || v === "off"; };

/** Off removes the index and both grow tools (the composer omits the section). Default on. */
export function resolveSkillsEnabled(env: NodeJS.ProcessEnv): boolean { return !off(env.HOUGE_SKILLS_ENABLED); }

/** Off refuses every submit; reading continues. Default on; in DISARM_FLAGS. */
export function resolveGrowEnabled(env: NodeJS.ProcessEnv): boolean { return !off(env.HOUGE_GROW_ENABLED); }

/** True when `dir` is `home` or an ancestor of it: denying such a path would deny the whole home. */
function coversHome(dir: string, home: string): boolean {
  const rel = relative(dir, resolve(home));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when `child` is `parent` or inside it, compared by path segment (`/a/b` is not inside `/a/bc`). */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when `dir` equals, contains, or sits inside `other`: a deny on one would cut off the other. */
const overlaps = (dir: string, other: string): boolean => isWithin(dir, other) || isWithin(other, dir);

/**
 * The grow zone's own git repository, outside the code checkout (spec §5.1). An override must be absolute, at least
 * three segments deep, and not the home directory or an ancestor of it, and overlapping none of `avoid` (the checkout, the data dir) nor ~/.omp; anything else falls back to the default.
 */
export function resolveGrowDir(env: NodeJS.ProcessEnv, home: string, avoid: readonly string[] = []): string {
  const fallback = join(home, "Library", "Application Support", "houge", "grow");
  const raw = env.HOUGE_GROW_DIR?.trim();
  if (!raw || !isAbsolute(raw)) return fallback;
  const dir = resolve(raw);
  if (dir.split(sep).filter(Boolean).length < 3 || coversHome(dir, home)) return fallback;
  // the grow dir is read+write-denied: refuse one that overlaps the checkout, the data dir, or ~/.omp (the planner profile exempts it)
  if ([...avoid, join(home, ".omp")].some((a) => overlaps(dir, a))) return fallback;
  return dir;
}
