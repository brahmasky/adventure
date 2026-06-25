import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexWriteArgs, createSelfWriteCodexAdapter } from "../../src/capabilities/coding-agent.js";

let temps: string[] = [];

/** A throwaway git repo with one commit, used as the worktree-stand-in for the adapter. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-caw-repo-"));
  temps.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@test"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "pipe" });
  writeFileSync(join(dir, "src.txt"), "console.log('hi')\n");
  execFileSync("git", ["-C", dir, "add", "src.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { stdio: "pipe" });
  return dir;
}

/** A fake `codex` that records argv + stdin, then exits 0 (success) or 3 (fail). */
function fakeCodex(opts: { argvFile: string; stdinFile: string; behavior: "success" | "fail" }): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-caw-bin-"));
  temps.push(dir);
  const bin = join(dir, "codex");
  const exitLine = opts.behavior === "fail" ? "exit 3" : "exit 0";
  const script = `#!/usr/bin/env bash
: > "${opts.argvFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${opts.argvFile}"; done
cat > "${opts.stdinFile}"
${exitLine}
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

describe("buildCodexWriteArgs", () => {
  it("uses workspace-write sandbox, -C worktree, trailing stdin marker; no model when unset", () => {
    expect(buildCodexWriteArgs("/wt")).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "-C",
      "/wt",
      "-"
    ]);
  });

  it("is identical to read-only EXCEPT workspace-write (no -o outfile in write mode)", () => {
    const args = buildCodexWriteArgs("/wt");
    expect(args).toContain("workspace-write");
    expect(args).not.toContain("read-only");
  });

  it("adds -m <model> when a model is set", () => {
    expect(buildCodexWriteArgs("/wt", "gpt-5")).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "-C",
      "/wt",
      "-m",
      "gpt-5",
      "-"
    ]);
  });

  it("NEVER includes a bypass / yolo / skip-git-repo-check flag", () => {
    const args = buildCodexWriteArgs("/wt", "gpt-5").join(" ");
    expect(args).not.toMatch(/dangerously-bypass/);
    expect(args).not.toMatch(/yolo/);
    expect(args).not.toMatch(/skip-git-repo-check/);
  });
});

describe("createSelfWriteCodexAdapter", () => {
  it("rejects an empty task without shelling out", () => {
    const adapter = createSelfWriteCodexAdapter({ worktree: "/wt" });
    expect(adapter({ task: "" })).toEqual({ ok: false, error: "task must be a non-empty string" });
  });

  it("runs codex workspace-write in the worktree, feeds the task on stdin", () => {
    const wt = gitRepo();
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-caw-cap-")), "argv");
    const stdinFile = join(mkdtempSync(join(tmpdir(), "houge-caw-cap-")), "stdin");
    temps.push(argvFile, stdinFile);
    const bin = fakeCodex({ argvFile, stdinFile, behavior: "success" });

    const adapter = createSelfWriteCodexAdapter({
      worktree: wt,
      env: { HOUGE_CODEX_BIN: bin, HOUGE_CODEX_MODEL: "gpt-5" }
    });
    const result = adapter({ task: "fix the intent router so it sees your identity" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.worktree).toBe(wt);
      expect(result.output.model).toBe("gpt-5");
      expect(result.output.bin).toBe(bin);
    }

    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    expect(argv).toContain("--sandbox");
    expect(argv).toContain("workspace-write");
    expect(argv).not.toContain("read-only");
    expect(argv.join(" ")).not.toMatch(/dangerously-bypass|yolo|skip-git-repo-check/);
    const cIdx = argv.indexOf("-C");
    expect(argv[cIdx + 1]).toBe(wt);

    expect(readFileSync(stdinFile, "utf8")).toContain("fix the intent router");
  });

  it("maps a non-zero codex exit to a clean error", () => {
    const wt = gitRepo();
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-caw-cap-")), "argv");
    const stdinFile = join(mkdtempSync(join(tmpdir(), "houge-caw-cap-")), "stdin");
    temps.push(argvFile, stdinFile);
    const bin = fakeCodex({ argvFile, stdinFile, behavior: "fail" });

    const adapter = createSelfWriteCodexAdapter({ worktree: wt, env: { HOUGE_CODEX_BIN: bin } });
    const result = adapter({ task: "write a fix" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-zero|status 3/);
  });

  it("maps a missing codex binary (ENOENT) to a clean error", () => {
    const adapter = createSelfWriteCodexAdapter({
      worktree: gitRepo(),
      env: { HOUGE_CODEX_BIN: "codex-does-not-exist-anywhere" }
    });
    const result = adapter({ task: "write a fix" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });

  it("maps a timeout to a clean error", () => {
    const wt = gitRepo();
    const dir = mkdtempSync(join(tmpdir(), "houge-caw-slow-"));
    temps.push(dir);
    const bin = join(dir, "codex");
    writeFileSync(bin, "#!/usr/bin/env bash\nsleep 5\n");
    chmodSync(bin, 0o755);

    const adapter = createSelfWriteCodexAdapter({
      worktree: wt,
      env: { HOUGE_CODEX_BIN: bin, HOUGE_CODEX_TIMEOUT_MS: "300" }
    });
    const result = adapter({ task: "write a fix" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out/);
  });
});
