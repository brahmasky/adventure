import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { daemonMkdtempSync, daemonTmpRoot, gitAncestor, isDaemonTmpDir, resolveDaemonTmpDir, selfWriteRoot } from "../../src/run/daemon-tmp.js";

const SRC = new URL("../../src", import.meta.url).pathname;

/**
 * Every src use of the OS temp dir, with why it may stay. os.tmpdir() is /private/var/folders/…: a sandboxed child
 * (or a process it left behind) could write there, so no daemon code may read, execute or publish anything from it
 * (B13). The allowlist is empty: the daemon's temp space is src/run/daemon-tmp.ts (<data>/tmp, <data>/selfwrite).
 */
const ALLOWED_TMPDIR_USES: ReadonlyArray<{ file: string; why: string }> = [];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("daemon temp space (final review B13)", () => {
  it("no src file calls os.tmpdir() / tmpdir() outside the justified allowlist", () => {
    const hits = sources(SRC).filter((f) => /\btmpdir\s*\(/.test(readFileSync(f, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")))
      .map((f) => relative(SRC, f));
    expect(hits.filter((f) => !ALLOWED_TMPDIR_USES.some((a) => a.file === f))).toEqual([]);
  });

  it("temp dirs are made under <data>/tmp (0700) and only their direct children count as daemon temp dirs", () => {
    const dir = daemonMkdtempSync("houge-x-");
    expect(isDaemonTmpDir(dir)).toBe(true);
    expect(isDaemonTmpDir(join(dir, "nested"))).toBe(false);
    expect(statSync(daemonTmpRoot()).mode & 0o777).toBe(0o700);
    expect(statSync(selfWriteRoot()).mode & 0o777).toBe(0o700);
  });

  it("the temp root lives OUTSIDE the repo by default, in ~/Library/Caches/houge-daemon; HOUGE_DAEMON_TMP_DIR overrides it (round 2 N1)", () => {
    expect(resolveDaemonTmpDir({}, "/Users/p")).toBe("/Users/p/Library/Caches/houge-daemon");
    expect(resolveDaemonTmpDir({ HOUGE_DAEMON_TMP_DIR: "/srv/houge-tmp" }, "/Users/p")).toBe("/srv/houge-tmp");
    expect(resolveDaemonTmpDir({ HOUGE_DAEMON_TMP_DIR: "relative/tmp" }, "/Users/p")).toBe("/Users/p/Library/Caches/houge-daemon");
  });

  it("an existing temp root with a looser mode is tightened to 0700 by the daemon (N1)", () => {
    chmodSync(daemonTmpRoot(), 0o755);
    expect(statSync(daemonTmpRoot()).mode & 0o777).toBe(0o700);
  });

  it("gitAncestor finds the repo a dir sits in (a .git dir or file at it or any ancestor), and nothing outside one (N1)", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-git-anc-"));
    mkdirSync(join(root, "repo", ".git"), { recursive: true }); mkdirSync(join(root, "repo", "tmp", "houge-media-x"), { recursive: true });
    expect(gitAncestor(join(root, "repo", "tmp", "houge-media-x"))).toBe(join(root, "repo"));
    expect(gitAncestor(join(root, "repo"))).toBe(join(root, "repo"));
    mkdirSync(join(root, "plain", "x"), { recursive: true });
    expect(gitAncestor(join(root, "plain", "x"))).toBeNull();
  });
});

