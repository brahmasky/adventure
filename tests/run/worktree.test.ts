import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selfWriteRoot } from "../../src/run/daemon-tmp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktree, removeWorktree } from "../../src/run/worktree.js";

let repos: string[] = [];

/** Create a throwaway git repo with one commit so `worktree add HEAD` has a HEAD. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-wt-repo-"));
  repos.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@test"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "pipe" });
  writeFileSync(join(dir, "tracked.txt"), "tracked content\n");
  writeFileSync(join(dir, ".gitignore"), "secret.env\n");
  writeFileSync(join(dir, "secret.env"), "TOKEN=shh\n");
  execFileSync("git", ["-C", dir, "add", "tracked.txt", ".gitignore"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { stdio: "pipe" });
  return dir;
}

afterEach(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
  repos = [];
});

describe("worktree harness (ADR 0011)", () => {
  it("creates a worktree of HEAD containing only tracked files (no gitignored secrets)", async () => {
    const repo = gitRepo();
    const wt = await createWorktree(repo);
    try {
      expect(existsSync(wt.path)).toBe(true);
      // Tracked file is present; the gitignored secret is absent by construction.
      expect(existsSync(join(wt.path, "tracked.txt"))).toBe(true);
      expect(existsSync(join(wt.path, "secret.env"))).toBe(false);
    } finally {
      await removeWorktree(wt.path);
    }
  });

  it("removeWorktree tears the worktree down and is idempotent", async () => {
    const repo = gitRepo();
    const wt = await createWorktree(repo);
    await removeWorktree(wt.path);
    expect(existsSync(wt.path)).toBe(false);
    // Second remove (already gone) must not throw.
    await expect(removeWorktree(wt.path)).resolves.toBeUndefined();
    // Removing a never-created path must not throw.
    await expect(removeWorktree(join(tmpdir(), "houge-wt-does-not-exist"))).resolves.toBeUndefined();
  });

  it("puts the worktree, .git pointer file included, under <data>/selfwrite — never os.tmpdir(), which the sandbox could write (B13)", async () => {
    const repo = gitRepo();
    const wt = await createWorktree(repo);
    try {
      expect(dirname(wt.path)).toBe(selfWriteRoot());
      expect(readFileSync(join(wt.path, ".git"), "utf8")).toContain(join(realpathSync(repo), ".git", "worktrees")); // gitdir stays in the repo
    } finally {
      await removeWorktree(wt.path);
    }
  });

  it("throws when the project root is not a git repository", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "houge-wt-norepo-"));
    repos.push(notARepo);
    await expect(createWorktree(notARepo)).rejects.toThrow();
  });
});
