import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * The clean room (decision-ladder design §8.3): a standing-approved command runs with a fresh, empty room as cwd and a
 * fresh, empty, read-only home. Both are daemon-made under the daemon cache root, which the planner and shell profiles
 * already read- and write-deny, so nothing a sandboxed child planted can be inside them. The validator proves that
 * shape before a profile is rendered from the paths; a bad pair is a denied run, never a looser profile.
 */
export type CleanroomReason = "not_absolute" | "not_directory" | "symlink_component" | "outside_cache_root" | "overlap" | "not_empty";

export class CleanroomPathError extends Error {
  constructor(public readonly reason: CleanroomReason, public readonly path: string) {
    super(`cleanroom ${reason}: ${path}`);
    this.name = "CleanroomPathError";
  }
}

/** Canonical absolute paths of a validated pair. */
export interface CleanroomDirs { room: string; home: string }

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Containment first, over EITHER spelling of the cache root (as given, canonical: /tmp vs /private/tmp), then every
 * component from the path up to the root must be a real directory — a symlink anywhere would move the subpath rule.
 */
function canonicalDir(p: string, roots: readonly string[]): string {
  // absolute AND normalized: `<root>/link/../room` would stat one directory (through the link) and check another
  if (!isAbsolute(p) || resolve(p) !== p) throw new CleanroomPathError("not_absolute", p);
  let st; try { st = statSync(p); } catch { throw new CleanroomPathError("not_directory", p); }
  if (!st.isDirectory()) throw new CleanroomPathError("not_directory", p);
  if (roots.includes(p) || !roots.some((r) => inside(p, r))) throw new CleanroomPathError("outside_cache_root", p);
  for (let d = p; !roots.includes(d) && d !== dirname(d); d = dirname(d)) {
    if (lstatSync(d).isSymbolicLink()) throw new CleanroomPathError("symlink_component", p);
  }
  try { return realpathSync(p); } catch { throw new CleanroomPathError("not_directory", p); }
}

export function validateCleanroomDirs(input: { room: string; home: string; cacheRoot: string }): CleanroomDirs {
  const roots = [...new Set([resolve(input.cacheRoot), realpathSync(input.cacheRoot)])];
  const room = canonicalDir(input.room, roots);
  const home = canonicalDir(input.home, roots);
  // overlap before emptiness: a home nested in the room makes the room non-empty, and the overlap is the real fault
  if (room === home || inside(room, home) || inside(home, room)) throw new CleanroomPathError("overlap", `${room} ~ ${home}`);
  for (const [d, given] of [[room, input.room], [home, input.home]] as const) {
    if (readdirSync(d).length > 0) throw new CleanroomPathError("not_empty", given);
  }
  return { room, home };
}
