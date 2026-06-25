import { execFileSync } from "node:child_process";

/**
 * Branch publish (ADR 0011, Phase 3 — code self-write, step 7). After all three checkers pass,
 * the verified diff (living in a throwaway worktree) is published as a BRANCH so the ref persists
 * in the common repo after the worktree is torn down. The branch is the reviewable artifact —
 * Paco merges + reloads at his leisure (§5: the daemon NEVER hot-swaps; nothing runs until merge).
 *
 * This is a NEW module (not in worktree.ts) — but it IS in the protected gate-machinery class, so
 * `self-write-guard.ts` lists it: Houge's runtime self-write channel can never edit branch-publish.
 *
 * A worktree created by `createWorktree` shares the common repo's `.git`, so a branch created here
 * (with `git -C <worktree> checkout -b`) and committed is immediately visible to the live repo as a
 * normal ref. We commit the working changes onto the new branch so the diff is captured permanently;
 * the live tree / current branch is untouched (the worktree has its own detached HEAD).
 *
 * No external deps — `git` is shelled via `execFileSync`.
 */

interface NodeError extends Error {
  stderr?: Buffer | string | null;
}

/** A self-write branch name from a run id: `houge/selfwrite/<run-id>`. */
export function selfWriteBranchName(runId: string): string {
  return `houge/selfwrite/${runId}`;
}

/**
 * Publish the worktree's verified changes as `branchName` in the common repo. Creates the branch
 * at the worktree's HEAD (`checkout -b`), stages everything (`git add -A`), and commits with a
 * message naming the task. Returns `branchName`. Throws on any git failure (the caller records a
 * failure event) — there is no silent half-publish.
 */
export function publishBranch(worktree: string, branchName: string, taskSummary?: string): string {
  const message = taskSummary && taskSummary.trim().length > 0
    ? `houge self-write: ${taskSummary.trim()}`
    : `houge self-write: ${branchName}`;
  try {
    // Create + switch the worktree onto the new branch (from its detached HEAD).
    execFileSync("git", ["-C", worktree, "checkout", "-b", branchName], { stdio: "pipe" });
    // Stage every change Codex made in the worktree.
    execFileSync("git", ["-C", worktree, "add", "-A"], { stdio: "pipe" });
    // Commit so the branch ref carries the diff and persists after the worktree is removed.
    execFileSync("git", ["-C", worktree, "commit", "-m", message], { stdio: "pipe" });
  } catch (error) {
    const err = error as NodeError;
    const detail = err.stderr != null ? err.stderr.toString().trim() : err.message;
    throw new Error(`Failed to publish branch ${branchName}: ${detail}`);
  }
  return branchName;
}
