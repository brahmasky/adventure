import { realpathSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { DiffEntry } from "../capabilities/self-write-guard.js";
import { hardenedGit } from "../run/git-hardened.js";

/** The guard reports a rename/copy as `old -> new`; this is the same display key for an entry. */
const displayOf = (e: DiffEntry): string => (e.oldPath ? `${e.oldPath} -> ${e.path}` : e.path);

/**
 * Map the guard's denied paths back to the diff entries they came from. Throws when one does not map, so a
 * revert can never silently skip a path (the caller goes terminal instead of retrying on a dirty tree).
 */
export function deniedEntries(entries: DiffEntry[], denied: Array<{ path: string }>): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const d of denied) {
    const match = entries.find((e) => displayOf(e) === d.path);
    if (!match) throw new Error(`no diff entry for denied path: ${d.path || "(empty)"}`);
    if (!out.includes(match)) out.push(match);
  }
  return out;
}

/** `git checkout HEAD -- <path>` (argv, literal pathspec): the path's index and file go back to HEAD. */
async function restoreFromHead(worktree: string, path: string): Promise<void> {
  await hardenedGit(["--literal-pathspecs", "-C", worktree, "checkout", "HEAD", "--", path]);
}

/** Resolve `path` inside the worktree, refusing anything that escapes it lexically or through a symlinked parent. */
function insideWorktree(worktree: string, path: string): string {
  const root = resolve(worktree);
  const abs = resolve(root, path);
  if (!abs.startsWith(root + sep)) throw new Error(`refusing to remove a path outside the worktree: ${path}`);
  let parent: string;
  try {
    parent = realpathSync(dirname(abs));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return abs; // no parent on disk: nothing to remove there
    throw error;
  }
  const realRoot = realpathSync(root);
  if (parent !== realRoot && !parent.startsWith(realRoot + sep)) throw new Error(`refusing to remove a path outside the worktree: ${path}`);
  return abs;
}

/** Drop a writer-added path: its intent-to-add index entry (if any) and the file itself. */
async function removeAdded(worktree: string, path: string): Promise<void> {
  const abs = insideWorktree(worktree, path);
  await hardenedGit(["--literal-pathspecs", "-C", worktree, "rm", "-q", "-r", "-f", "--cached", "--ignore-unmatch", "--", path]);
  rmSync(abs, { recursive: true, force: true });
}

/**
 * Restore every given diff entry in the worktree to HEAD (the default `SelfWriteDeps.revertPaths`): a writer-added
 * file (A) or copy destination (C) is removed; a rename (R) restores the old path and removes the new one; anything
 * else (M/D/T) is checked out from HEAD. Throws on the first failure or a malformed entry (fail closed).
 */
export async function revertWorktreePaths(worktree: string, entries: DiffEntry[]): Promise<void> {
  for (const e of entries) {
    if (e.malformed || e.path === "") throw new Error(`cannot revert a malformed diff entry: ${e.raw ?? "(no raw line)"}`);
    if (e.status === "A" || e.status === "C") {
      await removeAdded(worktree, e.path);
    } else if (e.status === "R") {
      if (!e.oldPath) throw new Error(`rename without a source path: ${e.path}`);
      await removeAdded(worktree, e.path);
      await restoreFromHead(worktree, e.oldPath);
    } else {
      await restoreFromHead(worktree, e.path);
    }
  }
}
