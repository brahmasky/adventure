import { chmodSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Daemon-side temp space (final review B13, round 2 N1). os.tmpdir() is /private/var/folders/…/T, which a sandboxed
 * child could once write: a symlink planted there redirected a daemon read, and a worktree there could be rewritten
 * between review and publish. The daemon temp root is `~/Library/Caches/houge-daemon` (HOUGE_DAEMON_TMP_DIR overrides
 * it): OUTSIDE the Houge repo, so an agentic leg run in a media dir (agy) can never reach the repo's `.env` through a
 * git-toplevel workspace. Both Seatbelt profiles read- and write-deny it (protected-paths secretPaths).
 *
 * Self-write worktrees are git by design and stay under `<data>/selfwrite` (write-denied to every profile). `<data>` is
 * the directory of houge.sqlite: the process cwd in production; a CoreWorker given another data dir sets it.
 */
let dataDir: string | undefined;
const roots = new Set<string>();

export function setDaemonDataDir(dir: string): void { dataDir = dir; }
export function daemonDataDir(): string { return dataDir ?? process.cwd(); }

/** HOUGE_DAEMON_TMP_DIR when absolute, else `<home>/Library/Caches/houge-daemon`. */
export function resolveDaemonTmpDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const v = env.HOUGE_DAEMON_TMP_DIR?.trim();
  return v && isAbsolute(v) ? v : join(home, "Library", "Caches", "houge-daemon");
}

/** The daemon temp root, created and kept at 0700. Its direct children are the only media files a seat may be handed. */
export function daemonTmpRoot(): string {
  const root = resolveDaemonTmpDir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700); // an existing root with a looser mode is tightened
  roots.add(root);
  return root;
}

/** The nearest directory at or above `dir` holding a `.git` (dir or file), or null outside any git repo. */
export function gitAncestor(dir: string): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

/** Register a caller-chosen temp root (tests' per-file roots); it must be daemon-owned like the default root. */
export function registerDaemonTmpRoot(root: string): void { roots.add(root); }

/** True when `dir` sits directly under a daemon temp root (never os.tmpdir()). */
export function isDaemonTmpDir(dir: string): boolean { return roots.has(dirname(dir)); }

export function daemonMkdtempSync(prefix: string): string {
  return mkdtempSync(join(daemonTmpRoot(), prefix));
}

export function daemonMkdtemp(prefix: string): Promise<string> {
  return mkdtemp(join(daemonTmpRoot(), prefix));
}

/** `<data>/selfwrite` (0700): the self-write worktrees, `.git` pointer file included, out of every sandbox's reach. */
export function selfWriteRoot(data: string = daemonDataDir()): string {
  const root = join(data, "selfwrite");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
