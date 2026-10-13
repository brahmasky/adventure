import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSelfWriteDeps } from "../../src/core/core-worker.js";
import { checkSelfWriteDiff, parseDiffRaw, type GuardResult } from "../../src/capabilities/self-write-guard.js";

/**
 * Final review 2026-10-13 (Critical): without `-z`, git C-quotes any path with a non-ASCII byte, a tab, a quote or
 * a backslash (`"src/policy/\303\261.ts"`), and the leading `"` kept that path from ever matching the protected
 * surface or `tests/`. These run the REAL default diff reader and the REAL guard on a real temp repo.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/** A committed repo that already carries a non-ASCII test file (the edit case needs an existing one). */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-swquote-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@test");
  git(dir, "config", "user.name", "test");
  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "src", "prompt"), { recursive: true });
  writeFileSync(join(dir, "tests", "é.test.ts"), "export const t = 1;\n");
  writeFileSync(join(dir, "src", "prompt", "base.ts"), "export const base = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

function write(dir: string, rel: string, body = "export const x = 1;\n"): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

const guard = async (dir: string): Promise<GuardResult> => checkSelfWriteDiff(parseDiffRaw(await defaultSelfWriteDeps().rawDiff(dir)));
const reasons = (r: GuardResult): string => (r.allowed ? "" : r.denied.map((d) => `${d.path}: ${d.reason}`).join("\n"));

describe("guard on non-ASCII / quoted paths (real git, real guard)", () => {
  it("a new non-ASCII file under .github/workflows/ is denied as protected (why: a CI workflow is supply chain)", async () => {
    const dir = repo();
    write(dir, ".github/workflows/é.yml", "on: push\n");
    const r = await guard(dir);
    expect(r.allowed).toBe(false);
    expect(reasons(r)).toContain("protected path: .github/workflows/é.yml");
  });

  it("a new non-ASCII file under src/policy/ is denied as protected (why: gate machinery is Paco's hand only)", async () => {
    const dir = repo();
    write(dir, "src/policy/ñ.ts");
    const r = await guard(dir);
    expect(r.allowed).toBe(false);
    expect(reasons(r)).toContain("protected path: src/policy/ñ.ts");
  });

  it("an edit to an existing non-ASCII test is denied by test integrity (why: existing tests judge the writer)", async () => {
    const dir = repo();
    writeFileSync(join(dir, "tests", "é.test.ts"), "export const t = 2;\n");
    const r = await guard(dir);
    expect(r.allowed).toBe(false);
    expect(reasons(r)).toMatch(/tests\/é\.test\.ts: test integrity/);
  });

  it("a filename with a tab is denied (why: a control character in a path is never something to reason about)", async () => {
    const dir = repo();
    write(dir, "src/prompt/a\tb.ts");
    const r = await guard(dir);
    expect(r.allowed).toBe(false);
    expect(reasons(r)).toMatch(/control-character path/);
  });

  it("ordinary ASCII paths are unchanged: an allowed add passes, a rename keeps both sides (why: the fix must not deny normal work)", async () => {
    const dir = repo();
    write(dir, "src/prompt/new.ts");
    git(dir, "mv", "src/prompt/base.ts", "src/prompt/moved.ts");
    const entries = parseDiffRaw(await defaultSelfWriteDeps().rawDiff(dir));
    expect(entries.map((e) => `${e.status} ${e.oldPath ?? ""}>${e.path}`).sort()).toEqual(["A >src/prompt/new.ts", "R src/prompt/base.ts>src/prompt/moved.ts"]);
    expect(checkSelfWriteDiff(entries)).toEqual({ allowed: true });
  });
});

describe("parseDiffRaw -z format and the quoted-path backstop", () => {
  it("parses NUL-separated records, including a rename and a path that contains a newline", () => {
    const raw = ":100644 100644 a b M\0src/a.ts\0:100644 100644 a a R100\0src/old.ts\0src/new.ts\0:000000 100644 0 c A\0src/x\ny.ts\0";
    expect(parseDiffRaw(raw)).toEqual([
      expect.objectContaining({ status: "M", path: "src/a.ts", oldMode: "100644", newMode: "100644" }),
      expect.objectContaining({ status: "R", oldPath: "src/old.ts", path: "src/new.ts" }),
      expect.objectContaining({ status: "A", path: "src/x\ny.ts", newMode: "100644" })
    ]);
  });

  it("a truncated -z record is malformed and denied (why: fail closed on input we do not understand)", () => {
    const parsed = parseDiffRaw(":100644 100644 a a R100\0src/old.ts\0");
    expect(parsed[0]!.malformed).toBe(true);
    expect(checkSelfWriteDiff(parsed).allowed).toBe(false);
  });

  it("a C-quoted path from the line format is denied even when its text is outside the locked surface (why: defense in depth)", () => {
    const r = checkSelfWriteDiff(parseDiffRaw(':000000 100644 0 c A\t"src/prompt/\\303\\251.ts"\n'));
    expect(r.allowed).toBe(false);
    expect(reasons(r)).toMatch(/quoted/);
  });

  it("a quoted rename source is denied too (why: both sides of a rename are checked)", () => {
    const r = checkSelfWriteDiff([{ status: "R", oldPath: '"src/policy/\\303\\261.ts"', path: "src/prompt/a.ts", oldMode: "100644", newMode: "100644" }]);
    expect(r.allowed).toBe(false);
  });
});
