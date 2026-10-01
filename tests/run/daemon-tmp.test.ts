import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { daemonMkdtempSync, daemonTmpRoot, isDaemonTmpDir, selfWriteRoot } from "../../src/run/daemon-tmp.js";

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
});
