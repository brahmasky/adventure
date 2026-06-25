import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishBranch, selfWriteBranchName } from "../../src/run/branch-publish.js";
import { createWorktree, removeWorktree } from "../../src/run/worktree.js";

let dirs: string[] = [];
let worktrees: string[] = [];

afterEach(() => {
  for (const wt of worktrees) removeWorktree(wt);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  worktrees = [];
});

/** A throwaway git repo with one commit on a branch, so HEAD + worktrees work. */
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-branchpub-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@houge.dev");
  git("config", "user.name", "Houge Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "file.txt"), "original\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  return dir;
}

describe("publishBranch (Phase 3 step 7)", () => {
  it("creates a named branch with the worktree's changes committed, visible in the common repo", () => {
    const repo = tmpRepo();
    const wt = createWorktree(repo).path;
    worktrees.push(wt);

    // Simulate Codex's diff inside the worktree.
    writeFileSync(join(wt, "file.txt"), "fixed\n");
    writeFileSync(join(wt, "newfile.txt"), "added\n");

    const branch = selfWriteBranchName("run_abc123");
    const returned = publishBranch(wt, branch, "fix the thing");
    expect(returned).toBe("houge/selfwrite/run_abc123");

    // The branch ref exists in the COMMON repo (persists after the worktree is removed).
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", branch], { encoding: "utf8" });
    expect(branches).toContain(branch);

    // The branch's tip carries the diff (both the modified + the new file).
    const tree = execFileSync("git", ["-C", repo, "show", `${branch}:file.txt`], { encoding: "utf8" });
    expect(tree).toBe("fixed\n");
    const added = execFileSync("git", ["-C", repo, "show", `${branch}:newfile.txt`], { encoding: "utf8" });
    expect(added).toBe("added\n");

    // The commit message names the task.
    const msg = execFileSync("git", ["-C", repo, "log", "-1", "--format=%s", branch], { encoding: "utf8" });
    expect(msg).toContain("fix the thing");
  });

  it("throws (no silent half-publish) when git cannot operate", () => {
    expect(() => publishBranch("/no/such/worktree/path", "houge/selfwrite/x")).toThrow(/Failed to publish branch/);
  });
});
