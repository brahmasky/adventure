import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSelfWriteWriter, runSelfWriter } from "../../src/capabilities/self-write-writer.js";

let temps: string[] = [];

/** A throwaway git repo with one commit, used as the worktree stand-in. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-sww-repo-"));
  temps.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@test"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "pipe" });
  writeFileSync(join(dir, "src.txt"), "console.log('hi')\n");
  execFileSync("git", ["-C", dir, "add", "src.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { stdio: "pipe" });
  return dir;
}

/** A fake bin that records argv + stdin, then prints `stdout` and exits `code`. */
function fakeBin(name: string, opts: {
  argvFile?: string;
  stdinFile?: string;
  stdout?: string;
  code?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-sww-bin-"));
  temps.push(dir);
  const bin = join(dir, name);
  const lines = ["#!/usr/bin/env bash"];
  if (opts.argvFile) {
    lines.push(`: > "${opts.argvFile}"`);
    lines.push(`for a in "$@"; do printf '%s\\n' "$a" >> "${opts.argvFile}"; done`);
  }
  if (opts.stdinFile) lines.push(`cat > "${opts.stdinFile}"`);
  else lines.push("cat > /dev/null");
  if (opts.stdout !== undefined) {
    const safe = opts.stdout.replace(/'/g, "'\\''");
    lines.push(`printf '%s' '${safe}'`);
  }
  lines.push(`exit ${opts.code ?? 0}`);
  writeFileSync(bin, lines.join("\n") + "\n");
  chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

describe("resolveSelfWriteWriter", () => {
  it("defaults to codex when unset", async () => {
    expect(resolveSelfWriteWriter({})).toBe("codex");
  });
  it("honors explicit codex", async () => {
    expect(resolveSelfWriteWriter({ HOUGE_SELFWRITE_WRITER: "codex" })).toBe("codex");
  });
  it("maps a stale HOUGE_SELFWRITE_WRITER=claude to codex (claude removed from the runtime — graceful degradation)", async () => {
    expect(resolveSelfWriteWriter({ HOUGE_SELFWRITE_WRITER: "claude" })).toBe("codex");
    expect(resolveSelfWriteWriter({ HOUGE_SELFWRITE_WRITER: "  CLAUDE " })).toBe("codex");
  });
  it("is tolerant of garbage (falls back to codex)", async () => {
    expect(resolveSelfWriteWriter({ HOUGE_SELFWRITE_WRITER: "banana" })).toBe("codex");
    expect(resolveSelfWriteWriter({ HOUGE_SELFWRITE_WRITER: "" })).toBe("codex");
  });
});

describe("runSelfWriter — codex", () => {
  it("rejects an empty task without shelling out", async () => {
    await expect(runSelfWriter({ writer: "codex", worktree: "/wt", task: "  " })).resolves.toEqual({
      ok: false,
      error: "task must be a non-empty string"
    });
  });

  it("builds codex args with --sandbox workspace-write + --json + NO bypass flag, returns usageRaw", async () => {
    const wt = gitRepo();
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-sww-cap-")), "argv");
    const stdinFile = join(mkdtempSync(join(tmpdir(), "houge-sww-cap-")), "stdin");
    temps.push(argvFile, stdinFile);
    const jsonl = '{"type":"token_count","input_tokens":5,"output_tokens":7}\n';
    const bin = fakeBin("codex", { argvFile, stdinFile, stdout: jsonl, code: 0 });

    const result = await runSelfWriter({
      writer: "codex",
      worktree: wt,
      task: "fix the intent router",
      env: { HOUGE_CODEX_BIN: bin, HOUGE_CODEX_MODEL: "gpt-5" }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe("codex");
      expect(result.model).toBe("gpt-5");
      expect(result.usageRaw).toContain("token_count");
    }

    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    expect(argv).toContain("--json");
    expect(argv).toContain("--sandbox");
    expect(argv).toContain("workspace-write");
    expect(argv).not.toContain("read-only");
    expect(argv.join(" ")).not.toMatch(/dangerously-bypass|yolo|skip-git-repo-check|bypassPermissions/);
    expect(readFileSync(stdinFile, "utf8")).toContain("fix the intent router");
  });

  it("maps a non-zero codex exit to a clean error", async () => {
    const wt = gitRepo();
    const bin = fakeBin("codex", { code: 3 });
    const result = await runSelfWriter({
      writer: "codex",
      worktree: wt,
      task: "write a fix",
      env: { HOUGE_CODEX_BIN: bin }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-zero|status 3/);
  });
});

