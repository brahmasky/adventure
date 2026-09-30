import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { PROTECTED_DIRS, PROTECTED_FILES } from "../capabilities/self-write-guard.js";

/**
 * `binDirs`: the directories holding the binaries the daemon later runs OUTSIDE the sandbox (omp, codex, agy,
 * node): see installedBinaryDirs. Absent means none are known (unit tests); the $HOME install trees still apply.
 */
export interface PathContext { home: string; repo: string; data: string; binDirs?: string[] }

export function secretPaths(ctx: PathContext): string[] {
  const h = (p: string) => join(ctx.home, p);
  return [
    join(ctx.repo, ".env"), join(ctx.data, "houge.sqlite"), join(ctx.data, "houge.sqlite-wal"), join(ctx.data, "houge.sqlite-shm"),
    h(".ssh"), h(".gnupg"), h(".pi"), h(".claude"), h(".codex"), h(".kimi"), h(".kimi-code"), h(".omp"),
    h(".config/gcloud"), h("Library/Keychains"), h(".claude.json")
  ];
}

export function protectedRepoPaths(ctx: PathContext): string[] {
  return [...PROTECTED_DIRS, ...PROTECTED_FILES].map((p) => join(ctx.repo, p));
}

/**
 * Writes are denied everywhere except these roots (D5 read literally: yolo under $HOME). Outside $HOME only the
 * temp roots are writable; /dev is handled literally by the profile renderer.
 */
export function writeRoots(ctx: PathContext, kind: "planner" | "shell"): string[] {
  return [ctx.home, "/private/tmp", "/private/var/folders", ...writableExceptions(ctx, kind)];
}

/** Binary install trees under $HOME: code here is run later by unsandboxed processes (the daemon, Paco's shell). */
export const HOME_INSTALL_TREES: readonly string[] = [".bun", ".local", ".npm", ".nvm", ".cargo", ".rustup", ".pyenv",
  ".volta", ".deno", "go", ".homebrew", ".oh-my-zsh"];

/** Config that makes git, a shell or a terminal run code: a planted entry would fire outside the sandbox. */
export const HOME_CODE_CONFIG: readonly string[] = [".gitconfig", ".config/git",
  ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".profile", ".tcshrc", ".config/fish", ".p10k.zsh",
  ".wezterm.lua", ".config/ghostty", ".config/iterm2", ".config/starship.toml"];

export function writableExceptions(ctx: PathContext, kind: "planner" | "shell"): string[] {
  const ws = join(ctx.data, "omp", "workspace");
  return kind === "planner" ? [ws, join(ctx.data, "omp", "sessions")] : [ws];
}

export function operationalWriteDeny(ctx: PathContext): string[] {
  return [ctx.repo, join(ctx.repo, "dist"), join(ctx.data, "omp", "bridge"), join(ctx.data, "omp", "planner.sb"),
    join(ctx.data, "omp", "shell.sb"), join(ctx.data, "omp", "houge-config.yml"),
    join(ctx.home, "Library/LaunchAgents"), join(ctx.data, "houge.kill"), join(ctx.data, "houge.parked"),
    ...[...HOME_INSTALL_TREES, ...HOME_CODE_CONFIG].map((p) => join(ctx.home, p)), ...(ctx.binDirs ?? [])];
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  if (name.includes("/")) return isAbsolute(name) ? name : null;
  for (const dir of (env.PATH ?? "").split(delimiter).filter((d) => isAbsolute(d))) {
    const hit = join(dir, name);
    try { accessSync(hit, constants.X_OK); if (statSync(hit).isFile()) return hit; } catch { /* next PATH entry */ }
  }
  return null;
}

/**
 * The directory of each binary the daemon runs unsandboxed (omp, codex, agy, and node itself), both where PATH
 * finds it and where it really lives (~/.bun/bin/omp is a symlink into the package): replacing either runs code.
 */
export function installedBinaryDirs(env: NodeJS.ProcessEnv, execPath: string): string[] {
  const names = [env.HOUGE_OMP_BIN?.trim() || "omp", env.HOUGE_CODEX_BIN?.trim() || "codex", env.HOUGE_AGY_BIN?.trim() || "agy"];
  const hits = [...names.map((n) => onPath(n, env)), execPath].filter((h): h is string => h !== null);
  const dirs = new Set<string>();
  for (const hit of hits) {
    dirs.add(dirname(hit));
    try { dirs.add(dirname(realpathSync(hit))); } catch { /* dangling: the lookup dir is still denied */ }
  }
  return [...dirs];
}

/**
 * Canonical form of `p`. Seatbelt matches canonical paths only (/var is a symlink to /private/var),
 * so a path that does not exist yet is canonicalised through its deepest existing ancestor and the
 * missing tail is re-appended.
 */
export function realpathOrSelf(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try { return join(realpathSync(cur), ...tail); } catch { /* not there yet: climb */ }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(cur.slice(parent.length).replace(/^\/+/, ""));
    cur = parent;
  }
}

function under(abs: string, roots: string[]): boolean {
  const a = realpathOrSelf(abs).toLowerCase();
  return roots.some((r) => {
    const root = realpathOrSelf(r).toLowerCase();
    return a === root || a.startsWith(root.endsWith("/") ? root : `${root}/`);
  });
}

export function isDeniedRead(absPath: string, ctx: PathContext): boolean {
  return under(absPath, secretPaths(ctx));
}

/** Mirrors the profiles: secrets, then the re-allowed workspace (never sessions: the model must not edit its transcript), then the denies, then default-deny. */
export function isDeniedWrite(absPath: string, ctx: PathContext): boolean {
  if (isDeniedRead(absPath, ctx)) return true;
  if (under(absPath, writableExceptions(ctx, "shell"))) return false;
  if (under(absPath, [...protectedRepoPaths(ctx), ...operationalWriteDeny(ctx)])) return true;
  return !under(absPath, writeRoots(ctx, "shell"));
}
