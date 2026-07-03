import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSelfWriteDeps } from "../../src/core/core-worker.js";
import { checkSelfWriteDiff, parseDiffRaw } from "../../src/capabilities/self-write-guard.js";

/**
 * The default SelfWriteDeps diff readers (live-gate fix, run_1280539d): a writer-created
 * NET-NEW file must be visible to BOTH checkers. Before the fix, `git diff --raw HEAD` /
 * `git diff HEAD` omitted untracked files entirely — the guard could not deny a new file
 * at a protected path (fail-closed bypass) and the reviewer rejected every new-file fix
 * as "file not shown" while `git add -A` still published it. The readers now register
 * untracked files with intent-to-add (`git add -N .`) before diffing.
 *
 * These are orchestration/deps tests against REAL git fixtures — the guard/floor test
 * files stay untouched (the guard is only exercised, never modified).
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/** A committed repo standing in for the self-write worktree (HEAD exists, .gitignore tracked). */
function worktreeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-swdeps-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@test");
  git(dir, "config", "user.name", "test");
  // Mirror the real repo: node_modules/ is gitignored (the worktree carries the tracked file).
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  mkdirSync(join(dir, "src", "prompt"), { recursive: true });
  writeFileSync(join(dir, "src", "prompt", "base.ts"), "export const base = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("defaultSelfWriteDeps diff readers — net-new files are visible to guard + reviewer", () => {
  it("an untracked NEW file appears as a status-A raw entry AND with full content in the unified diff", () => {
    const wt = worktreeFixture();
    writeFileSync(join(wt, "src", "prompt", "user-time-zone.ts"), "export function resolveUserTimeZone(): string { return \"UTC\"; }\n");
    const deps = defaultSelfWriteDeps();

    const raw = deps.rawDiff(wt);
    expect(raw).toMatch(/A\tsrc\/prompt\/user-time-zone\.ts/);

    const unified = deps.unifiedDiff(wt);
    expect(unified).toContain("src/prompt/user-time-zone.ts");
    expect(unified).toContain("resolveUserTimeZone"); // the reviewer sees the CONTENT, not "file not shown"
  });

  it("SECURITY: an untracked NEW file at a protected path is DENIED by the guard (creation, not just edits)", () => {
    const wt = worktreeFixture();
    mkdirSync(join(wt, "src", "policy"), { recursive: true });
    writeFileSync(join(wt, "src", "policy", "evil.ts"), "export const allowEverything = true;\n");
    const deps = defaultSelfWriteDeps();

    const result = checkSelfWriteDiff(parseDiffRaw(deps.rawDiff(wt)));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denied.some((d) => d.path.includes("src/policy/evil.ts"))).toBe(true);
    }
  });

  it("an untracked NEW file at an allowed path passes the guard and reaches the reviewer diff", () => {
    const wt = worktreeFixture();
    writeFileSync(join(wt, "src", "prompt", "foo.ts"), "export const foo = 42;\n");
    const deps = defaultSelfWriteDeps();

    expect(checkSelfWriteDiff(parseDiffRaw(deps.rawDiff(wt)))).toEqual({ allowed: true });
    const unified = deps.unifiedDiff(wt);
    expect(unified).toContain("src/prompt/foo.ts");
    expect(unified).toContain("foo = 42");
  });

  it("the gitignored node_modules symlink is NEVER registered by the intent-to-add step", () => {
    const wt = worktreeFixture();
    // The mkNodeModulesLink step symlinks the live project's node_modules into the worktree.
    const fakeModules = mkdtempSync(join(tmpdir(), "houge-swdeps-nm-"));
    dirs.push(fakeModules);
    symlinkSync(fakeModules, join(wt, "node_modules"), "dir");
    writeFileSync(join(wt, "src", "prompt", "foo.ts"), "export const foo = 1;\n");
    const deps = defaultSelfWriteDeps();

    const raw = deps.rawDiff(wt);
    expect(raw).not.toContain("node_modules");
    expect(raw).toMatch(/A\tsrc\/prompt\/foo\.ts/); // the real new file still shows
    expect(deps.unifiedDiff(wt)).not.toContain("node_modules");
  });

  it("refine-loop re-checks stay correct: a file added AFTER the first diff shows on the next one (idempotent add -N)", () => {
    const wt = worktreeFixture();
    writeFileSync(join(wt, "src", "prompt", "first.ts"), "export const a = 1;\n");
    const deps = defaultSelfWriteDeps();
    expect(deps.rawDiff(wt)).toMatch(/A\tsrc\/prompt\/first\.ts/);

    // Attempt 2: the writer creates ANOTHER new file — the re-check must see both.
    writeFileSync(join(wt, "src", "prompt", "second.ts"), "export const b = 2;\n");
    const raw2 = deps.rawDiff(wt);
    expect(raw2).toMatch(/A\tsrc\/prompt\/first\.ts/);
    expect(raw2).toMatch(/A\tsrc\/prompt\/second\.ts/);
    expect(deps.unifiedDiff(wt)).toContain("const b = 2");
  });
});
