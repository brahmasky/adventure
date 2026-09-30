import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSelfWriteDeps } from "../../src/core/core-worker.js";
import { defaultMergeActionDeps } from "../../src/capabilities/self-write-merge.js";
import { publishBranch } from "../../src/run/branch-publish.js";
import { createWorktree, removeWorktree } from "../../src/run/worktree.js";

const temps: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * A $HOME whose ~/.gitconfig plants code: an fsmonitor hook and a hooks dir, each appending to a marker file.
 * This is what a sandbox escape via ~/.gitconfig would leave behind (security C3 probe 2).
 */
function plantedHome(): { home: string; marker: string } {
  const home = mkdtempSync(join(tmpdir(), "houge-gh-home-")); temps.push(home);
  const marker = join(home, "RAN");
  const hook = join(home, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\necho "$0" >> '${marker}'\n`); chmodSync(hook, 0o755);
  mkdirSync(join(home, "hooks"));
  for (const h of ["post-checkout", "pre-commit", "post-commit", "reference-transaction"]) {
    writeFileSync(join(home, "hooks", h), `#!/bin/sh\necho ${h} >> '${marker}'\n`); chmodSync(join(home, "hooks", h), 0o755);
  }
  writeFileSync(join(home, ".gitconfig"), `[core]\n\tfsmonitor = ${hook}\n\thooksPath = ${join(home, "hooks")}\n`);
  return { home, marker };
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-gh-repo-")); temps.push(dir);
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q"); git("config", "user.email", "t@test"); git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-q", "-m", "init");
  return dir;
}

describe("daemon-side git ignores user/system git config (A3: defence in depth behind floor A)", () => {
  it("the planted ~/.gitconfig really runs code under a plain git call (the probe is live)", () => {
    const { home, marker } = plantedHome(); const dir = repo();
    writeFileSync(join(dir, "b.txt"), "b\n");
    execFileSync("git", ["-C", dir, "add", "-N", "--", "."], { stdio: "pipe", env: { ...process.env, HOME: home } });
    expect(existsSync(marker)).toBe(true);
  });

  it("worktree create, intent-to-add, both diffs and publish (checkout, add, commit) run no planted hook or fsmonitor", async () => {
    const { home, marker } = plantedHome(); const dir = repo();
    vi.stubEnv("HOME", home);
    const wt = await createWorktree(dir);
    try {
      writeFileSync(join(wt.path, "new.txt"), "n\n");
      const deps = defaultSelfWriteDeps();
      expect(await deps.rawDiff(wt.path)).toContain("new.txt");
      expect(await deps.unifiedDiff(wt.path)).toContain("+n");
      await publishBranch(wt.path, "houge/test-branch", "t");
      const author = execFileSync("git", ["-C", dir, "log", "-1", "--format=%ae", "houge/test-branch"], { encoding: "utf8" }).trim();
      expect(author).toBe("t@test"); // the repo identity survives the hardening
    } finally { await removeWorktree(wt.path); }
    expect(existsSync(marker)).toBe(false);
  });

  it("the merge path (checkout, merge commit, branch delete) runs no planted hook and keeps the repo identity", () => {
    const { home, marker } = plantedHome(); const dir = repo();
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    const main = git("branch", "--show-current").trim();
    git("checkout", "-q", "-b", "feat"); writeFileSync(join(dir, "f.txt"), "f\n"); git("add", "f.txt"); git("commit", "-q", "-m", "f");
    git("checkout", "-q", main); writeFileSync(join(dir, "m.txt"), "m\n"); git("add", "m.txt"); git("commit", "-q", "-m", "m");
    vi.stubEnv("HOME", home);
    const deps = defaultMergeActionDeps({ dir, notifyDurable: () => undefined });
    deps.merge("feat", main);
    deps.deleteBranch("feat");
    expect(git("log", "-1", "--format=%P %ae", main).trim().split(" ")).toHaveLength(3); // a real merge commit
    expect(git("log", "-1", "--format=%ae", main).trim()).toBe("t@test");
    expect(existsSync(marker)).toBe(false);
  });
});
