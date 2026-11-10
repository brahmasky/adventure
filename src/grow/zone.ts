import { type Stats, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hardenedGit } from "../run/git-hardened.js";
import { GROW_LIMITS } from "./checks.js";

export class GrowZoneError extends Error {
  constructor(readonly code: "not_toplevel" | "git_failed" | "bad_name", options?: { cause?: unknown }) { super(code, options); }
}
export const skillPath = (name: string): string => `skills/${name}/SKILL.md`;
const IDENTITY = ["-c", "user.name=Houge", "-c", "user.email=houge@localhost", "-c", "commit.gpgsign=false"];
/** Global config off does not switch off `~/.config/git/attributes`; this does. */
const NO_ATTRIBUTES_FILE = ["-c", "core.attributesFile=/dev/null"];
/** Files in `.git` that would make git read config from somewhere other than the byte-checked `.git/config`. */
const CONFIG_REDIRECTS = ["commondir", "config.worktree"];
/**
 * The only repository config the zone accepts. `ensure(true)` writes it right after `git init`, and `assertToplevel`
 * fails closed unless `.git/config` is exactly this: a planted `[filter]`, `[core] hooksPath` or alias then never runs.
 */
export const CANONICAL_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";
const GIT_TIMEOUT_MS = 20_000;
const OP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The grow zone's git repository (spec §5.1). Every call names the git dir and work tree, and never inherits a GIT_* variable. */
export class GrowZone {
  readonly dir: string;
  constructor(dir: string, private readonly opts: { signal?: AbortSignal } = {}) { this.dir = resolve(dir); }

  private async git(args: string[]): Promise<string> {
    // GIT_COMMON_DIR pins the common dir to `.git` itself: a planted `.git/commondir` cannot lend another repository's config.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", GIT_CEILING_DIRECTORIES: dirname(this.dir), GIT_COMMON_DIR: join(this.dir, ".git") };
    try {
      const r = await hardenedGit(["--git-dir", join(this.dir, ".git"), "--work-tree", this.dir, ...IDENTITY, ...NO_ATTRIBUTES_FILE, ...args],
        { env, cwd: this.dir, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, ...(this.opts.signal ? { signal: this.opts.signal } : {}) });
      return r.stdout;
    } catch (e) { throw new GrowZoneError("git_failed", { cause: e }); }
  }

  /**
   * Creates the repository only when `allowInit`; a missing `.git` (or an unborn HEAD) otherwise is a fault and
   * nothing is created.
   */
  async ensure(allowInit: boolean): Promise<void> {
    const gitDir = join(this.dir, ".git");
    const st = lstatOrNull(gitDir);
    if (st === null) {
      if (!allowInit) throw new GrowZoneError("not_toplevel");
      mkdirSync(this.dir, { recursive: true });
      await this.git(["init", "-q", "-b", "main"]);
      writeFileSync(join(gitDir, "config"), CANONICAL_CONFIG);
    } else if (allowInit && st.isDirectory() && isEmptyRepo(gitDir)) {
      // A crash between `git init` and the config write: nothing is in it, so finishing it loses nothing.
      // Any other `.git` is never rewritten; `assertToplevel` fails closed on its config.
      writeFileSync(join(gitDir, "config"), CANONICAL_CONFIG);
    }
    await this.assertToplevel();
    mkdirSync(join(this.dir, "skills"), { recursive: true });
    if (!(await this.hasHead())) {
      if (!allowInit || !isEmptyRepo(gitDir)) throw new GrowZoneError("not_toplevel");
      await this.git(["commit", "-q", "--allow-empty", "-m", "grow zone"]);
    }
  }

  private async hasHead(): Promise<boolean> {
    try { await this.git(["rev-parse", "-q", "--verify", "HEAD"]); return true; } catch { return false; }
  }

  /**
   * With an explicit `--work-tree`, `rev-parse --show-toplevel` always answers the work tree, so it proves little by
   * itself. What stops git climbing into an enclosing repository, or into another one, is the explicit `--git-dir`
   * (no discovery), `<dir>/.git` being a real directory (not a gitfile or symlink that redirects), and
   * `GIT_CEILING_DIRECTORIES` in every call's environment. What stops planted config from running commands is the
   * byte-exact config, the pinned common dir (and no `commondir` or `config.worktree` file to redirect it), and the
   * absence of attribute files anywhere in the tree (a filter needs both a definition and an attribute).
   */
  async assertToplevel(): Promise<void> {
    const dotGit = join(this.dir, ".git");
    if (!lstatOrNull(dotGit)?.isDirectory()) throw new GrowZoneError("not_toplevel");
    let config: string;
    try { config = readFileSync(join(dotGit, "config"), "utf8"); } catch (e) { throw new GrowZoneError("not_toplevel", { cause: e }); }
    if (config !== CANONICAL_CONFIG) throw new GrowZoneError("not_toplevel");
    if (CONFIG_REDIRECTS.some((f) => lstatOrNull(join(dotGit, f)) !== null)) throw new GrowZoneError("not_toplevel");
    if (lstatOrNull(join(dotGit, "info", "attributes")) !== null || holdsAttributes(this.dir, true)) throw new GrowZoneError("not_toplevel");
    const top = (await this.git(["rev-parse", "--show-toplevel"])).trim();
    if (realpathSync(top) !== realpathSync(this.dir)) throw new GrowZoneError("not_toplevel");
  }

  async head(): Promise<string> { return (await this.git(["rev-parse", "HEAD"])).trim(); }

  async readHead(name: string): Promise<string | null> {
    this.checkName(name);
    const present = (await this.git(["ls-tree", "--name-only", "HEAD", "--", skillPath(name)])).trim();
    if (present === "") return null;
    return this.git(["show", `HEAD:${skillPath(name)}`]);
  }

  async listHead(): Promise<string[]> {
    const out = await this.git(["ls-tree", "-r", "--name-only", "HEAD", "--", "skills"]);
    return out.split("\n").map((p) => /^skills\/([a-z0-9-]+)\/SKILL\.md$/.exec(p)?.[1]).filter((n): n is string => n !== undefined).sort();
  }

  /** After a throw the work tree may hold the new text: the caller must call `restoreToHead()`. */
  async writeAndCommit(name: string, text: string, message: string): Promise<string> {
    this.checkName(name);
    await this.assertToplevel();
    this.refuseSymlinks(name);
    const file = join(this.dir, skillPath(name));
    mkdirSync(dirname(file), { recursive: true });
    rmSync(`${file}.tmp`, { force: true });
    writeFileSync(`${file}.tmp`, text, { flag: "wx" });
    renameSync(`${file}.tmp`, file);
    await this.git(["add", "--", skillPath(name)]);
    await this.git(["commit", "-q", "--allow-empty", "-m", message, "--", skillPath(name)]);
    return this.head();
  }

  /** After a throw the work tree may differ from HEAD: the caller must call `restoreToHead()`. */
  async removeAndCommit(name: string, message: string): Promise<string> {
    this.checkName(name);
    await this.assertToplevel();
    await this.git(["rm", "-q", "--", skillPath(name)]);
    await this.git(["commit", "-q", "-m", message, "--", skillPath(name)]);
    return this.head();
  }

  private refuseSymlinks(name: string): void {
    for (const p of ["skills", `skills/${name}`, skillPath(name)]) {
      if (lstatOrNull(join(this.dir, p))?.isSymbolicLink()) throw new GrowZoneError("not_toplevel");
    }
  }

  /** The newest commit with a message line exactly `Grow-Op: <opId>`, null when none; a git failure throws, never "not found". */
  async findOpCommit(opId: string): Promise<string | null> {
    if (!OP_ID_RE.test(opId)) throw new GrowZoneError("bad_name");
    await this.assertToplevel();
    // The UUID pattern holds no regex metacharacters; git matches the anchored pattern per message line.
    const out = (await this.git(["log", "-n", "1", "--format=%H", "--basic-regexp", "--grep", `^Grow-Op: ${opId}$`])).trim();
    return out === "" ? null : out;
  }

  /** Discards staged and unstaged changes and untracked files; `reset --hard` also works when the only commit is empty. */
  async restoreToHead(): Promise<void> {
    await this.assertToplevel();
    await this.git(["reset", "-q", "--hard", "HEAD"]);
    await this.git(["clean", "-fdq"]);
  }

  async bundle(toPath: string): Promise<void> {
    if (!isAbsolute(toPath)) throw new GrowZoneError("bad_name");
    await this.assertToplevel();
    const tmp = `${toPath}.tmp`;
    rmSync(tmp, { force: true });   // a crash mid-bundle left it behind: start from nothing
    rmSync(`${tmp}.lock`, { force: true });   // a killed git leaves its lock and the next create fails; the daemon is the only bundle writer
    try {
      await this.git(["bundle", "create", "-q", tmp, "--all"]);
      await this.git(["bundle", "verify", "-q", tmp]);
      renameSync(tmp, toPath);
    } catch (e) { rmSync(tmp, { force: true }); throw e; }
  }

  private checkName(name: string): void {
    if (!GROW_LIMITS.nameRe.test(name)) throw new GrowZoneError("bad_name");
  }
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch { return null; }
}

/** True only when a git dir provably holds nothing, judged from the filesystem alone (no git runs). False on any error. */
export function isEmptyRepo(gitDir: string): boolean {
  try {
    if (hasFile(join(gitDir, "refs")) || lstatOrNull(join(gitDir, "packed-refs")) !== null || lstatOrNull(join(gitDir, "index")) !== null) return false;
    for (const e of readdirSync(join(gitDir, "objects"), { withFileTypes: true })) {
      if (!e.isDirectory() || (e.name !== "info" && e.name !== "pack") || hasFile(join(gitDir, "objects", e.name))) return false;
    }
    return true;
  } catch { return false; }
}

/** True when a `.gitattributes` of any type sits anywhere under `dir`; symlinks are not followed, the zone's own `.git` is skipped. */
function holdsAttributes(dir: string, top = false): boolean {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { throw new GrowZoneError("not_toplevel", { cause: e }); }
  return entries.some((e) => e.name === ".gitattributes" || (e.isDirectory() && !(top && e.name === ".git") && holdsAttributes(join(dir, e.name))));
}

function hasFile(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some((e) => !e.isDirectory() || hasFile(join(dir, e.name)));
}
