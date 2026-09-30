import { execFileSync } from "node:child_process";
import { execFileAsync, type ExecFileAsyncOptions } from "./exec-file-async.js";

/**
 * Daemon-side git (self-write worktrees, diffs, publish, merge) never runs code from user or system git config
 * (A3). Floor A already write-denies ~/.gitconfig and ~/.config/git to the sandbox; this is the second layer:
 * no global/system config at all, no fsmonitor, no hooks.
 */
export const HARDENED_GIT_FLAGS: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

export function hardenedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

export function hardenedGit(args: string[], opts: ExecFileAsyncOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", [...HARDENED_GIT_FLAGS, ...args], { ...opts, env: hardenedGitEnv(opts.env) });
}

export function hardenedGitSync(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: hardenedGitEnv(opts.env) });
}

/**
 * The commit identity git would have used, read with the normal config (a `git config --get` runs no hook,
 * fsmonitor or helper), so a hardened commit or merge keeps Paco's author line. Empty when unset.
 */
export function gitIdentityEnv(dir: string): Record<string, string> {
  const get = (key: string): string => {
    try {
      return execFileSync("git", [...HARDENED_GIT_FLAGS, "-C", dir, "config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch { return ""; }
  };
  const name = get("user.name"); const email = get("user.email");
  return {
    ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}),
    ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {})
  };
}
