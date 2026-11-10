import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hardenedGit } from "../run/git-hardened.js";
import { GROW_LIMITS } from "./checks.js";

export class GrowZoneError extends Error {
  constructor(readonly code: "not_toplevel" | "git_failed" | "bad_name") { super(code); }
}
export const skillPath = (name: string): string => `skills/${name}/SKILL.md`;
const IDENTITY = ["-c", "user.name=Houge", "-c", "user.email=houge@localhost", "-c", "commit.gpgsign=false"];
const GIT_TIMEOUT_MS = 20_000;
const OP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The grow zone's git repository (spec §5.1). Every call names the git dir and work tree, and never inherits a GIT_* variable. */
export class GrowZone {
  constructor(readonly dir: string, private readonly opts: { signal?: AbortSignal } = {}) {}

  private async git(args: string[]): Promise<string> {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", GIT_CEILING_DIRECTORIES: dirname(this.dir) };
    try {
      const r = await hardenedGit(["--git-dir", join(this.dir, ".git"), "--work-tree", this.dir, ...IDENTITY, ...args],
        { env, cwd: this.dir, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, ...(this.opts.signal ? { signal: this.opts.signal } : {}) });
      return r.stdout;
    } catch { throw new GrowZoneError("git_failed"); }
  }

  /** Creates the repository only when `allowInit`; a missing `.git` otherwise is a fault and nothing is created. */
  async ensure(allowInit: boolean): Promise<void> {
    if (!existsSync(join(this.dir, ".git"))) {
      if (!allowInit) throw new GrowZoneError("not_toplevel");
      mkdirSync(this.dir, { recursive: true });
      await this.git(["init", "-q", "-b", "main"]);
      await this.git(["commit", "-q", "--allow-empty", "-m", "grow zone"]);
    }
    mkdirSync(join(this.dir, "skills"), { recursive: true });
    await this.assertToplevel();
  }

  /**
   * With an explicit `--work-tree`, `rev-parse --show-toplevel` always answers the work tree, so it proves little by
   * itself. What stops git climbing into an enclosing repository is the explicit `--git-dir` (no discovery),
   * the existence check on `<dir>/.git` here (a lost `.git` is a fault, never a fallback), and
   * `GIT_CEILING_DIRECTORIES` in every call's environment.
   */
  async assertToplevel(): Promise<void> {
    if (!existsSync(join(this.dir, ".git"))) throw new GrowZoneError("not_toplevel");
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

  async writeAndCommit(name: string, text: string, message: string): Promise<string> {
    this.checkName(name);
    await this.assertToplevel();
    const file = join(this.dir, skillPath(name));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
    await this.git(["add", "--", skillPath(name)]);
    await this.git(["commit", "-q", "--allow-empty", "-m", message]);
    return this.head();
  }

  async removeAndCommit(name: string, message: string): Promise<string> {
    this.checkName(name);
    await this.assertToplevel();
    await this.git(["rm", "-q", "--", skillPath(name)]);
    await this.git(["commit", "-q", "-m", message]);
    return this.head();
  }

  /** The newest commit whose message carries `Grow-Op: <opId>`, null when none; a git failure throws, never "not found". */
  async findOpCommit(opId: string): Promise<string | null> {
    if (!OP_ID_RE.test(opId)) throw new GrowZoneError("bad_name");
    const out = (await this.git(["log", "-n", "1", "--format=%H", "--fixed-strings", "--grep", `Grow-Op: ${opId}`])).trim();
    return out === "" ? null : out;
  }

  /** Discards staged and unstaged changes and untracked files; `reset --hard` also works when the only commit is empty. */
  async restoreToHead(): Promise<void> {
    await this.assertToplevel();
    await this.git(["reset", "-q", "--hard", "HEAD"]);
    await this.git(["clean", "-fdq"]);
  }

  async bundle(toPath: string): Promise<void> {
    await this.assertToplevel();
    const tmp = `${toPath}.tmp`;
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
