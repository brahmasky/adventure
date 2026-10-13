import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSelfWriteDeps } from "../../src/core/core-worker.js";
import { deniedEntries, revertWorktreePaths } from "../../src/core/self-write-revert.js";
import { checkSelfWriteDiff, parseDiffRaw } from "../../src/capabilities/self-write-guard.js";
import type { DiffEntry } from "../../src/capabilities/self-write-guard.js";

/**
 * The default revert a guard-driven retry runs first (live gate 2026-10-13 run 3): the worktree persists across
 * attempts, so a denied edit left on disk made attempt 2 fail the guard for attempt 1's change. These run REAL git
 * on a temp repo, with the entries read by the same default diff reader the guard uses.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-swrevert-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@test");
  git(dir, "config", "user.name", "test");
  mkdirSync(join(dir, "src", "omp"), { recursive: true });
  for (const f of ["modified.ts", "deleted.ts", "renamed.ts", "keep.ts"]) writeFileSync(join(dir, "src", "omp", f), `export const ${f.split(".")[0]} = "original ${f}";\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const entriesOf = async (dir: string): Promise<DiffEntry[]> => parseDiffRaw(await defaultSelfWriteDeps().rawDiff(dir));

describe("revertWorktreePaths (real git)", () => {
  it("restores modified, deleted and renamed paths to HEAD and removes added ones, leaving other edits alone (why: the retry must start clean of denied edits only)", async () => {
    const dir = repo();
    const omp = join(dir, "src", "omp");
    writeFileSync(join(omp, "modified.ts"), "export const modified = 'writer';\n");
    unlinkSync(join(omp, "deleted.ts"));
    git(dir, "mv", "src/omp/renamed.ts", "src/omp/moved.ts");
    mkdirSync(join(omp, "newdir"));
    writeFileSync(join(omp, "newdir", "added.ts"), "export const added = 1;\n");
    writeFileSync(join(omp, "keep.ts"), "export const keep = 'unlocked fix';\n");
    const entries = await entriesOf(dir);
    expect(entries.some((e) => e.status === "R" && e.oldPath === "src/omp/renamed.ts")).toBe(true); // the rename case is really exercised
    await revertWorktreePaths(dir, entries.filter((e) => e.path !== "src/omp/keep.ts"));
    for (const f of ["modified.ts", "deleted.ts", "renamed.ts"]) expect(readFileSync(join(omp, f), "utf8")).toBe(`export const ${f.split(".")[0]} = "original ${f}";\n`);
    expect(existsSync(join(omp, "moved.ts"))).toBe(false);
    expect(existsSync(join(omp, "newdir", "added.ts"))).toBe(false);
    // Only the unlocked edit is left in the diff the guard will see next.
    expect((await entriesOf(dir)).map((e) => `${e.status} ${e.path}`)).toEqual(["M src/omp/keep.ts"]);
  });

  it("refuses a path that escapes the worktree (why: a denied path is writer-shaped; deleting outside the tree must be impossible)", async () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), "houge-swrevert-out-"));
    dirs.push(outside);
    writeFileSync(join(outside, "victim.txt"), "x");
    await expect(revertWorktreePaths(dir, [{ status: "A", path: `../${outside.split("/").pop()}/victim.txt` }])).rejects.toThrow(/outside the worktree/);
    expect(existsSync(join(outside, "victim.txt"))).toBe(true);
  });

  it("refuses to remove through a symlinked directory (why: the real file behind the link is outside the tree)", async () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), "houge-swrevert-out-"));
    dirs.push(outside);
    writeFileSync(join(outside, "victim.txt"), "x");
    symlinkSync(outside, join(dir, "link"), "dir");
    await expect(revertWorktreePaths(dir, [{ status: "A", path: "link/victim.txt" }])).rejects.toThrow(/outside the worktree/);
    expect(existsSync(join(outside, "victim.txt"))).toBe(true);
  });

  it("a malformed entry fails the revert (why: fail closed, never retry on a tree we could not clean)", async () => {
    const dir = repo();
    await expect(revertWorktreePaths(dir, [{ status: "?", path: "", malformed: true }])).rejects.toThrow();
  });
});

describe("deniedEntries", () => {
  it("maps the guard's denied display paths back to diff entries, renames included (why: the guard reports 'old -> new', git needs both paths)", () => {
    const entries = parseDiffRaw(":100644 100644 a b M\tsrc/run/x.ts\n:100644 100644 a b R100\tsrc/run/a.ts\tsrc/omp/b.ts\n");
    const guard = checkSelfWriteDiff(entries);
    if (guard.allowed) throw new Error("expected a denial");
    expect(deniedEntries(entries, guard.denied)).toEqual([entries[1]]);
  });

  it("a denied path with no matching entry throws (why: a revert that silently skips a path leaves the tree dirty)", () => {
    expect(() => deniedEntries([], [{ path: "src/omp/x.ts" }])).toThrow(/src\/omp\/x.ts/);
  });
});
