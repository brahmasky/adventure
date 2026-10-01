import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Daemon-side temp space (final review B13). os.tmpdir() is /private/var/folders/…/T, which a sandboxed child (or a
 * background process it left running) could once write: a symlink planted there redirected a daemon read, and a
 * worktree there could be rewritten between review and publish. Every daemon temp dir now lives under `<data>/tmp`
 * and every self-write worktree under `<data>/selfwrite`; both are write-denied in the planner and shell profiles
 * (protected-paths operationalWriteDeny), and the profiles no longer allow /private/var/folders at all.
 *
 * `<data>` is the directory of houge.sqlite: the process cwd in production (every CLI path opens houge.sqlite
 * relative to it); a CoreWorker given another data dir (tests, an operator override) sets it at construction.
 */
let dataDir: string | undefined;
const roots = new Set<string>();

export function setDaemonDataDir(dir: string): void { dataDir = dir; }
export function daemonDataDir(): string { return dataDir ?? process.cwd(); }

/** `<data>/tmp` (0700), created on demand. Its direct children are the only media files a seat may be handed. */
export function daemonTmpRoot(data: string = daemonDataDir()): string {
  const root = join(data, "tmp");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  roots.add(root);
  return root;
}

/** Register a caller-chosen temp root (tests' per-file roots); it must be daemon-owned like `<data>/tmp`. */
export function registerDaemonTmpRoot(root: string): void { roots.add(root); }

/** True when `dir` sits directly under a daemon temp root (never os.tmpdir()). */
export function isDaemonTmpDir(dir: string): boolean { return roots.has(dirname(dir)); }

export function daemonMkdtempSync(prefix: string, data?: string): string {
  return mkdtempSync(join(daemonTmpRoot(data), prefix));
}

export function daemonMkdtemp(prefix: string, data?: string): Promise<string> {
  return mkdtemp(join(daemonTmpRoot(data), prefix));
}

/** `<data>/selfwrite` (0700): the self-write worktrees, `.git` pointer file included, out of every sandbox's reach. */
export function selfWriteRoot(data: string = daemonDataDir()): string {
  const root = join(data, "selfwrite");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
