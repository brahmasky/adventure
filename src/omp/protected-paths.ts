import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { PROTECTED_DIRS, PROTECTED_FILES } from "../capabilities/self-write-guard.js";
import { resolveDaemonTmpDir } from "../run/daemon-tmp.js";

/**
 * `binDirs`: the directories holding the binaries the daemon later runs OUTSIDE the sandbox (omp, codex, agy,
 * node): see installedBinaryDirs. Absent means none are known (unit tests); the $HOME install trees still apply.
 */
export interface PathContext { home: string; repo: string; data: string; binDirs?: string[] }

/** Credential stores under $HOME: read- and write-denied in both profiles (the planner keeps ~/.omp, D11). */
export const HOME_SECRETS: readonly string[] = [
  ".ssh", ".omp",
  // AI and dev tools
  ".claude", ".claude.json", ".codex", ".gemini", ".kimi", ".kimi-code", ".copilot", ".grok", ".hermes", ".antigravity",
  ".antigravity-ide", ".pi", ".agentmemory", ".agents",
  // Houge and other bots
  ".houge", ".dsh", ".whatsapp-bot",
  // cloud and container
  ".docker", ".config/gh", ".config/gcloud", ".aws", ".azure", ".kube",
  // keys and tokens
  ".npmrc", ".cargo/credentials", ".cargo/credentials.toml", ".gnupg", ".netrc", ".git-credentials",
  "Library/Keychains",
  // credential stores found readable 2026-10-12 (decision ladder spec §7.0): browser profiles, session stores, Claude's app data
  ".agent-browser", ".dev-browser", ".zsh_sessions", ".local/share/fish", ".local/share/opencode", "Library/Cookies", "Library/Safari",
  "Library/Application Support/Claude", "Library/Application Support/Google/Chrome", "Library/Application Support/BraveSoftware",
  "Library/Application Support/Firefox", "Library/Application Support/Arc", "Library/Application Support/Microsoft Edge"
];

export function secretPaths(ctx: PathContext): string[] {
  return [
    join(ctx.repo, ".env"), join(ctx.data, "houge.sqlite"), join(ctx.data, "houge.sqlite-wal"), join(ctx.data, "houge.sqlite-shm"),
    // the daemon temp root holds Paco's media downloads and codex out-files: no child reads or writes it (N1)
    resolveDaemonTmpDir(process.env, ctx.home),
    ...HOME_SECRETS.map((p) => join(ctx.home, p))
  ];
}

/** A top-level `~/.<name>.env` (or `~/.env`) file: other tools' secrets, by naming convention. */
export const HOME_DOTENV_NAME = /^\.(?:[^/]+\.)?env$/i;

/**
 * Credential files by NAME anywhere under $HOME (spec §7.0 item 1; plan S3 narrows `id_*` and the `*auth*` directory
 * pattern). Each entry is a regex body that follows `^<home>` and precedes `$`. Only `. * ? [] ()` and `\.` are used,
 * never `|`, so the Seatbelt renderer (seatbelt.ts credentialRules) and isCredentialPath read every body identically.
 */
export const CREDENTIAL_PATTERNS: readonly string[] = [
  "(/.*)?/\\.[Ee][Nn][Vv]", "(/.*)?/\\.[Ee][Nn][Vv]\\.[^/]*", // templates re-allowed: ENV_TEMPLATE_PATTERNS
  "/\\.local/share/(.*/)?auth\\.json", "/\\.config/(.*/)?auth\\.json", "/\\.local/share/(.*/)?credentials[^/]*", "/\\.config/(.*/)?credentials[^/]*",
  "(/.*)?/id_rsa(\\.pub)?", "(/.*)?/id_dsa(\\.pub)?", "(/.*)?/id_ecdsa(\\.pub)?", "(/.*)?/id_ed25519(\\.pub)?", "(/.*)?/id_ecdsa_sk(\\.pub)?",
  "(/.*)?/id_ed25519_sk(\\.pub)?",
  "/\\.bash_history", "/\\.zsh_history", "/\\.sh_history", "/\\.python_history", "/\\.node_repl_history", "/\\.psql_history", "/\\.mysql_history",
  "/\\.sqlite_history", "/\\.irb_history", "/\\.rediscli_history", "/\\.lesshst", "/\\.config/fish/fish_variables",
  "(/.*)?/service_account[^/]*\\.json", "(/.*)?/client_secret[^/]*\\.json", "(/.*)?/[^/]*credentials[^/]*\\.json",
  // token stores, not design tokens or tokenizers (senior W8): token.json, *_token*.json, *-token.json
  "(/.*)?/token\\.json", "(/.*)?/[^/]*_token[^/]*\\.json", "(/.*)?/[^/]*-token\\.json",
  // private keys by name, not public certificates or CA bundles (senior W8); key stores always
  "(/.*)?/[^/]*private[^/]*\\.pem", "(/.*)?/[^/]*private[^/]*\\.key", "(/.*)?/[^/]*privkey[^/]*\\.pem", "(/.*)?/[^/]*privkey[^/]*\\.key",
  "(/.*)?/key\\.pem", "(/.*)?/server\\.key", "(/.*)?/client\\.key", "(/.*)?/tls\\.key", "(/.*)?/ssl\\.key",
  "(/.*)?/[^/]*\\.p12", "(/.*)?/[^/]*\\.pfx",
  "/Projects/(.*/)?\\.[^/]*auth[^/]*(/.*)?", "/Projects/(.*/)?auth_info[^/]*(/.*)?"
];
/** .env templates carry no secrets and coding tasks write them: re-allowed after the patterns above (Seatbelt: a later allow). */
export const ENV_TEMPLATE_PATTERNS: readonly string[] = ["(/.*)?/\\.[Ee][Nn][Vv]\\.example", "(/.*)?/\\.[Ee][Nn][Vv]\\.sample", "(/.*)?/\\.[Ee][Nn][Vv]\\.template"];

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ENV_TEMPLATE_NAME = /\/\.env\.(?:example|sample|template)$/i;
const credentialCache = new Map<string, RegExp[]>();

/** The patterns anchored at one spelling of $HOME (cached: isDeniedRead runs on every built-in gate). */
export function credentialRegexes(home: string): RegExp[] {
  const hit = credentialCache.get(home);
  if (hit) return hit;
  const res = CREDENTIAL_PATTERNS.map((b) => new RegExp(`^${escapeRegex(home)}${b}$`, "i")); // case-insensitive, as APFS and Seatbelt are
  credentialCache.set(home, res);
  return res;
}

/** True when either spelling of the path (as given, canonical) matches a credential pattern under either spelling of $HOME. */
export function isCredentialPath(absPath: string, home: string): boolean {
  const forms = [...new Set([resolve(absPath), realpathOrSelf(absPath)])];
  const homes = [...new Set([resolve(home), realpathOrSelf(home)])];
  if (forms.some((f) => ENV_TEMPLATE_NAME.test(f))) return false;
  return homes.some((h) => credentialRegexes(h).some((re) => forms.some((f) => re.test(f))));
}

export function protectedRepoPaths(ctx: PathContext): string[] {
  return [...PROTECTED_DIRS, ...PROTECTED_FILES].map((p) => join(ctx.repo, p));
}

/**
 * Writes are denied everywhere except these roots (D5 read literally: yolo under $HOME). Outside $HOME only
 * /private/tmp is writable; /private/var/folders (os.tmpdir()) is not (B13: a symlink planted there redirected daemon
 * reads), so children get TMPDIR=<workspace>/.tmp instead. /dev is handled literally by the profile renderer.
 */
export function writeRoots(ctx: PathContext, kind: "planner" | "shell"): string[] {
  return [ctx.home, "/private/tmp", ...writableExceptions(ctx, kind)];
}

/** Binary install trees under $HOME: code here is run later by unsandboxed processes (the daemon, Paco's shell). */
export const HOME_INSTALL_TREES: readonly string[] = [".bun", ".local", ".npm", ".nvm", ".cargo", ".rustup", ".pyenv",
  ".volta", ".deno", "go", ".homebrew", ".oh-my-zsh"];

/**
 * Config that makes git, a shell, a terminal or an editor run code: a planted entry would fire outside the sandbox. A
 * denylist, so incomplete by nature (accepted residual until SP3, spec §14): an allowlist of writable $HOME subtrees is
 * the structural fix.
 */
export const HOME_CODE_CONFIG: readonly string[] = [".gitconfig", ".config/git",
  ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".zsh", ".config/zsh", ".bashrc", ".bash_profile", ".bash_login", ".profile",
  ".tcshrc", ".config/fish", ".p10k.zsh", ".wezterm.lua", ".config/ghostty", ".config/iterm2", ".config/starship.toml",
  ".vimrc", ".vim", ".config/nvim", ".tmux.conf", ".config/tmux", ".envrc"];

export function writableExceptions(ctx: PathContext, kind: "planner" | "shell"): string[] {
  const ws = join(ctx.data, "omp", "workspace");
  return kind === "planner" ? [ws, join(ctx.data, "omp", "sessions")] : [ws];
}

/** The self-write worktrees (src/run/daemon-tmp.ts): never writable by a sandboxed child (B13). The temp root is a secret path. */
export function daemonOnlyDirs(ctx: PathContext): string[] {
  return [join(ctx.data, "selfwrite")];
}

export function operationalWriteDeny(ctx: PathContext): string[] {
  return [ctx.repo, join(ctx.repo, "dist"), ...daemonOnlyDirs(ctx), join(ctx.data, "omp", "bridge"), join(ctx.data, "omp", "planner.sb"),
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

function isHomeDotenv(abs: string, ctx: PathContext): boolean {
  const real = realpathOrSelf(abs);
  return dirname(real).toLowerCase() === realpathOrSelf(ctx.home).toLowerCase() && HOME_DOTENV_NAME.test(real.slice(dirname(real).length + 1));
}

export function isDeniedRead(absPath: string, ctx: PathContext): boolean {
  return under(absPath, secretPaths(ctx)) || isHomeDotenv(absPath, ctx) || isCredentialPath(absPath, ctx.home);
}

/** Mirrors the profiles: secrets, then the re-allowed workspace (never sessions: the model must not edit its transcript), then the denies, then default-deny. */
export function isDeniedWrite(absPath: string, ctx: PathContext): boolean {
  if (isDeniedRead(absPath, ctx)) return true;
  if (under(absPath, writableExceptions(ctx, "shell"))) return false;
  if (under(absPath, [...protectedRepoPaths(ctx), ...operationalWriteDeny(ctx)])) return true;
  return !under(absPath, writeRoots(ctx, "shell"));
}
