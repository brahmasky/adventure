import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_DISARM_PATH } from "../../src/config/disarm-posture.js";
import { daemonOnlyDirs, operationalWriteDeny, secretPaths, writableExceptions } from "../../src/omp/protected-paths.js";
import { chatWorkspace } from "../../src/omp/workspace.js";
import { BACKUP_DIR_NAME } from "../../src/run/db-backup.js";
import { DEFAULT_PARK_MARKER_PATH, DEFAULT_TOMBSTONE_PATH } from "../../src/run/tombstone.js";

/**
 * The repo is PUBLIC and production runs with <data> = the repo root. Every runtime path the daemon creates there holds
 * Paco's chats, media, worktrees or credentials-adjacent state: a careless `git add` must never pick one up. The list is
 * derived from the code that names the paths, so a new runtime dir fails here until it is ignored.
 */
const repo = fileURLToPath(new URL("../..", import.meta.url));
const ctx = { home: "/nonexistent-home", repo, data: repo };

function runtimePaths(): string[] {
  const fromCode = [
    chatWorkspace(repo, "123"), join(repo, "omp", "sessions", "chat-123"), join(repo, "omp", "system-chat-123.md"),
    ...writableExceptions(ctx, "planner"), ...daemonOnlyDirs(ctx), ...operationalWriteDeny(ctx), ...secretPaths(ctx),
    join(repo, BACKUP_DIR_NAME, "x.sqlite"), join(repo, DEFAULT_TOMBSTONE_PATH), join(repo, DEFAULT_PARK_MARKER_PATH),
    join(repo, DEFAULT_DISARM_PATH), join(repo, "houge.daemon.lock"), join(repo, "runs", "run_1", "report.md"),
    join(repo, "logs", "houge-daemon.err.log"), join(repo, "tmp", "x")
  ];
  // only paths strictly under the data dir: the repo root itself and $HOME paths are not runtime artifacts here
  return [...new Set(fromCode)].filter((p) => p.startsWith(repo) && p !== repo && !p.startsWith(join(repo, "src") + sep));
}

function checkIgnore(rel: string): boolean {
  try { execFileSync("git", ["check-ignore", "-q", "--no-index", rel], { cwd: repo, stdio: "ignore" }); return true; }
  catch { return false; }
}

/** A path that need not exist yet: a dir-only pattern (`dist/`) matches it through a child, so probe both. */
function ignored(path: string): boolean {
  const rel = relative(repo, path);
  return checkIgnore(rel) || checkIgnore(join(rel, "probe"));
}

describe("runtime data under the repo root is gitignored (public repo, item 7)", () => {
  it("covers the omp runtime dir: sessions, workspaces, bridge, profiles, config", () => {
    for (const p of [join(repo, "omp"), join(repo, "omp", "bridge", "s.sock"), join(repo, "omp", "planner.sb"), join(repo, "omp", "houge-config.yml")]) {
      expect(ignored(p), relative(repo, p)).toBe(true);
    }
  });

  it("covers every runtime path the code names under the data dir", () => {
    const paths = runtimePaths();
    expect(paths.length).toBeGreaterThan(10);
    expect(paths.filter((p) => !ignored(p)).map((p) => relative(repo, p))).toEqual([]);
  });

  it("does not swallow the tracked omp sources and tests", () => {
    for (const rel of ["src/omp/workspace.ts", "tests/omp/workspace.test.ts", "tests/fixtures/fake-omp.mjs"]) expect(checkIgnore(rel), rel).toBe(false);
  });
});
