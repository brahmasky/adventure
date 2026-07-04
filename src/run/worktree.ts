import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileAsync } from "./exec-file-async.js";

/**
 * Git-worktree harness (ADR 0011 §5). A self-diagnose / self-write consult runs Codex
 * against a FRESH worktree of committed HEAD — which, by construction, contains only
 * TRACKED files. Gitignored secrets (`.env`, `~/.codex/auth.json`, `houge.sqlite`) are
 * absent with no deny-list to maintain, the daemon's live tree is untouched, and it is a
 * real git repo (Codex requires one). Reused by Phase 3 (code self-write).
 *
 * No external deps — `git` is shelled via the promisified `execFileAsync` (⓪·3g: git ops
 * on the evolution pipeline must not block the daemon's event loop). The worktree is
 * checked out at a detached HEAD (we never branch here); teardown is idempotent.
 */

export interface Worktree {
  /** Absolute path to the checked-out worktree. */
  path: string;
}

/**
 * Create a fresh git worktree of committed HEAD under the OS tmp dir (detached HEAD).
 * Throws if `git` is unavailable or `projectRoot` is not a git repository.
 */
export async function createWorktree(projectRoot: string): Promise<Worktree> {
  // Let git CREATE the directory (don't pre-make it) so `git worktree remove` fully
  // deletes it — git refuses to delete a worktree dir it didn't create. The path is a
  // unique, not-yet-existing dir under the OS tmp.
  const path = join(tmpdir(), `houge-worktree-${randomUUID()}`);
  // `--detach` checks out HEAD without creating a branch.
  await execFileAsync("git", ["-C", projectRoot, "worktree", "add", "--detach", path, "HEAD"]);
  return { path };
}

/**
 * Remove a worktree created by {@link createWorktree}. Idempotent — a missing/already-
 * removed worktree (or any git error) is swallowed, so this is safe to call in a
 * `finally` even if creation half-failed. As a backstop, any directory left behind is
 * force-removed so no worktree leaks even if git's own teardown declines.
 */
export async function removeWorktree(path: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", path]);
  } catch {
    // Idempotent teardown: already gone, never added, or git unavailable — fall through.
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best-effort backstop
  }
}
