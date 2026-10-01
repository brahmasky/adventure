import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishBranch, selfWriteBranchName, summarizeFocus } from "../../src/run/branch-publish.js";
import { createWorktree, removeWorktree } from "../../src/run/worktree.js";

let dirs: string[] = [];
let worktrees: string[] = [];

afterEach(async () => {
  for (const wt of worktrees) await removeWorktree(wt);
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
  it("creates a named branch with the worktree's changes committed, visible in the common repo", async () => {
    const repo = tmpRepo();
    const wt = (await createWorktree(repo)).path;
    worktrees.push(wt);

    // Simulate Codex's diff inside the worktree.
    writeFileSync(join(wt, "file.txt"), "fixed\n");
    writeFileSync(join(wt, "newfile.txt"), "added\n");

    const branch = selfWriteBranchName("run_abc123");
    const returned = await publishBranch(wt, branch, "fix the thing");
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

  it("never commits a node_modules symlink that the test-gate symlinked in", async () => {
    const repo = tmpRepo();
    const realNodeModules = mkdtempSync(join(tmpdir(), "houge-nm-"));
    dirs.push(realNodeModules);
    const wt = (await createWorktree(repo)).path;
    worktrees.push(wt);

    // Codex's source change …
    writeFileSync(join(wt, "file.txt"), "fixed\n");
    // … plus the node_modules symlink the orchestrator adds for the test-gate (a FILE symlink, so
    // .gitignore's `node_modules/` dir-pattern does NOT catch it — the regression from the live gate).
    symlinkSync(realNodeModules, join(wt, "node_modules"), "dir");

    const branch = selfWriteBranchName("run_nm");
    await publishBranch(wt, branch, "fix with node_modules present");

    // The source change is committed …
    expect(execFileSync("git", ["-C", repo, "show", `${branch}:file.txt`], { encoding: "utf8" })).toBe("fixed\n");
    // … but node_modules is NOT in the published tree.
    const tree = execFileSync("git", ["-C", repo, "ls-tree", "--name-only", branch], { encoding: "utf8" });
    expect(tree).not.toContain("node_modules");
  });

  it("throws (no silent half-publish) when git cannot operate", async () => {
    await expect(publishBranch("/no/such/worktree/path", "houge/selfwrite/x")).rejects.toThrow(/Failed to publish branch/);
  });

  it("a long multi-line focus: the commit message is the one-line SUBJECT only — no focus text beyond the label", async () => {
    // A Merge with push publishes the commit message to the PUBLIC repo, while Paco only ever saw
    // the 120-char label and the diff: nothing he did not see may ride the commit.
    const repo = tmpRepo();
    const wt = (await createWorktree(repo)).path;
    worktrees.push(wt);
    writeFileSync(join(wt, "file.txt"), "fixed\n");
    const focus = `修复 createSrcPhraseChecker 的子串匹配\nCause: "regate" hits "aggregate". ${"d".repeat(1900)}`;
    const branch = selfWriteBranchName("run_long");
    await publishBranch(wt, branch, focus);
    const message = execFileSync("git", ["-C", repo, "log", "-1", "--format=%B", branch], { encoding: "utf8" }).trim();
    expect(message).toBe("houge self-write: 修复 createSrcPhraseChecker 的子串匹配");
    expect(message).not.toContain("regate");
    expect(message).not.toContain("ddd");
  });
});

describe("summarizeFocus — the code-owned one-line label for a focus of up to 2000 chars", () => {
  it("keeps a short CJK focus intact (no cut, no ellipsis)", () => {
    expect(summarizeFocus("修复短语检查器的子串匹配")).toBe("修复短语检查器的子串匹配");
  });

  it("takes the first non-empty line of a multi-line focus, whitespace-collapsed", () => {
    expect(summarizeFocus("\n  fix   the\tphrase checker  \nCause: substring match\nTest: add one")).toBe("fix the phrase checker");
  });

  it("exactly 120 chars is kept whole; 121 is cut to 120 plus an ellipsis", () => {
    const at = "a".repeat(120);
    expect(summarizeFocus(at)).toBe(at);
    expect(summarizeFocus(`${at}b`)).toBe(`${at}…`);
  });

  it("a 2000-char focus becomes at most 121 chars ending in an ellipsis", () => {
    const out = summarizeFocus("x".repeat(2000));
    expect(out.length).toBe(121);
    expect(out.endsWith("…")).toBe(true);
  });

  it("caps at a caller-chosen width (the ledger's 200-char field)", () => {
    const out = summarizeFocus("y".repeat(2000), 199);
    expect(out.length).toBe(200);
    expect(out.endsWith("…")).toBe(true);
  });
});

