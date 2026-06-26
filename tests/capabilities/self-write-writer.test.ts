import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeWriteArgs,
  resolveClaudeWriterModel,
  resolveSelfWriteWriter,
  runSelfWriter
} from "../../src/capabilities/self-write-writer.js";

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

/** A fake bin that records argv + stdin (+ optionally cwd/PATH), then prints `stdout` and exits `code`. */
function fakeBin(name: string, opts: {
  argvFile?: string;
  stdinFile?: string;
  cwdFile?: string;
  pathFile?: string;
  stdout?: string;
  code?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-sww-bin-"));
  temps.push(dir);
  const bin = join(dir, name);
  const lines = ["#!/usr/bin/env bash"];
  if (opts.cwdFile) lines.push(`pwd -P > "${opts.cwdFile}"`);
  if (opts.pathFile) lines.push(`printf '%s' "$PATH" > "${opts.pathFile}"`);
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
  it("defaults to codex when unset", () => {
    expect(resolveSelfWriteWriter({})).toBe("codex");
  });
  it("honors claude", () => {
    expect(resolveSelfWriteWriter({ HOUGE_SELFWRITE_WRITER: "claude" })).toBe("claude");
    expect(resolveSelfWriteWriter({ HOUGE_SELFWRITE_WRITER: "  CLAUDE " })).toBe("claude");
  });
  it("honors explicit codex", () => {
    expect(resolveSelfWriteWriter({ HOUGE_SELFWRITE_WRITER: "codex" })).toBe("codex");
  });
  it("is tolerant of garbage (falls back to codex)", () => {
    expect(resolveSelfWriteWriter({ HOUGE_SELFWRITE_WRITER: "banana" })).toBe("codex");
    expect(resolveSelfWriteWriter({ HOUGE_SELFWRITE_WRITER: "" })).toBe("codex");
  });
});

describe("resolveClaudeWriterModel", () => {
  it("defaults to sonnet", () => {
    expect(resolveClaudeWriterModel({})).toBe("sonnet");
  });
  it("honors HOUGE_CLAUDE_WRITER_MODEL", () => {
    expect(resolveClaudeWriterModel({ HOUGE_CLAUDE_WRITER_MODEL: "opus" })).toBe("opus");
  });
  it("falls back to HOUGE_CLAUDE_MODEL when the writer override is unset", () => {
    expect(resolveClaudeWriterModel({ HOUGE_CLAUDE_MODEL: "haiku" })).toBe("haiku");
  });
  it("prefers the writer override over the shared model", () => {
    expect(
      resolveClaudeWriterModel({ HOUGE_CLAUDE_WRITER_MODEL: "opus", HOUGE_CLAUDE_MODEL: "haiku" })
    ).toBe("opus");
  });
});

describe("buildClaudeWriteArgs (spike argv)", () => {
  it("builds -p --model --permission-mode bypassPermissions --output-format json, execution-free", () => {
    expect(buildClaudeWriteArgs("sonnet")).toEqual([
      "-p",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--disallowedTools",
      "Bash",
      "WebFetch",
      "WebSearch"
    ]);
  });

  it("EXECUTION-FREE: the writer cannot run shell (Bash) — that is the test-gate checker's job", () => {
    const argv = buildClaudeWriteArgs("sonnet");
    // --disallowedTools must be the LAST flag (variadic) and include Bash so the agentic writer
    // can't self-run npm test/build in a verify loop and burn its timeout (live 2026-06-26 600s).
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("Bash");
    const idx = argv.indexOf("--disallowedTools");
    expect(argv.slice(idx + 1)).toEqual(["Bash", "WebFetch", "WebSearch"]);
  });
});

describe("runSelfWriter — codex", () => {
  it("rejects an empty task without shelling out", () => {
    expect(runSelfWriter({ writer: "codex", worktree: "/wt", task: "  " })).toEqual({
      ok: false,
      error: "task must be a non-empty string"
    });
  });

  it("builds codex args with --sandbox workspace-write + --json + NO bypass flag, returns usageRaw", () => {
    const wt = gitRepo();
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-sww-cap-")), "argv");
    const stdinFile = join(mkdtempSync(join(tmpdir(), "houge-sww-cap-")), "stdin");
    temps.push(argvFile, stdinFile);
    const jsonl = '{"type":"token_count","input_tokens":5,"output_tokens":7}\n';
    const bin = fakeBin("codex", { argvFile, stdinFile, stdout: jsonl, code: 0 });

    const result = runSelfWriter({
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

  it("maps a non-zero codex exit to a clean error", () => {
    const wt = gitRepo();
    const bin = fakeBin("codex", { code: 3 });
    const result = runSelfWriter({
      writer: "codex",
      worktree: wt,
      task: "write a fix",
      env: { HOUGE_CODEX_BIN: bin }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-zero|status 3/);
  });
});

describe("runSelfWriter — claude", () => {
  it("is disabled when HOUGE_CLAUDE_BIN is unset", () => {
    const result = runSelfWriter({ writer: "claude", worktree: gitRepo(), task: "write a fix", env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("claude writer disabled: set HOUGE_CLAUDE_BIN");
  });

  it("builds the spike argv and returns the envelope as usageRaw on success", () => {
    const wt = gitRepo();
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-sww-cap-")), "argv");
    const stdinFile = join(mkdtempSync(join(tmpdir(), "houge-sww-cap-")), "stdin");
    temps.push(argvFile, stdinFile);
    const envelope = JSON.stringify({
      is_error: false,
      num_turns: 3,
      usage: { input_tokens: 5, output_tokens: 317 },
      total_cost_usd: 0.072
    });
    const bin = fakeBin("claude", { argvFile, stdinFile, stdout: envelope, code: 0 });

    const result = runSelfWriter({
      writer: "claude",
      worktree: wt,
      task: "fix the greet function",
      env: { HOUGE_CLAUDE_BIN: bin, HOUGE_CLAUDE_WRITER_MODEL: "sonnet" }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe("claude");
      expect(result.model).toBe("sonnet");
      expect(JSON.parse(result.usageRaw).total_cost_usd).toBe(0.072);
    }

    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    expect(argv).toEqual([
      "-p",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--disallowedTools",
      "Bash",
      "WebFetch",
      "WebSearch"
    ]);
    expect(readFileSync(stdinFile, "utf8")).toContain("fix the greet function");
  });

  it("MANDATE 2 — bypassPermissions is CONFINED to the worktree: cwd is the worktree, PATH is the daemon PATH, argv has NO --add-dir", () => {
    // The whole safety story of bypassPermissions rests on `cwd: <worktree>` (the throwaway). Prove the
    // claude writer actually spawns IN the worktree (not the live project root), under the restricted
    // daemon PATH, and that the argv never widens scope with --add-dir.
    const wt = gitRepo();
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-sww-cap-")), "argv");
    const cwdFile = join(mkdtempSync(join(tmpdir(), "houge-sww-cap-")), "cwd");
    const pathFile = join(mkdtempSync(join(tmpdir(), "houge-sww-cap-")), "path");
    temps.push(argvFile, cwdFile, pathFile);
    const envelope = JSON.stringify({ is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
    const bin = fakeBin("claude", { argvFile, cwdFile, pathFile, stdout: envelope, code: 0 });

    const result = runSelfWriter({
      writer: "claude",
      worktree: wt,
      task: "fix the greet function",
      env: { HOUGE_CLAUDE_BIN: bin }
    });
    expect(result.ok).toBe(true);

    // The writer ran INSIDE the worktree (realpath-compared: tmpdir may be a symlink on macOS).
    expect(realpathSync(readFileSync(cwdFile, "utf8").trim())).toBe(realpathSync(wt));
    // PATH was replaced with the restricted daemon PATH (NOT the inherited dev PATH).
    expect(readFileSync(pathFile, "utf8")).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    // No --add-dir (or any scope-widening flag) ever reaches the live project root.
    const argv = readFileSync(argvFile, "utf8");
    expect(argv).not.toMatch(/--add-dir|--cwd|--dangerously-skip|--project/);
  });

  it("returns a clean error when the envelope reports is_error", () => {
    const wt = gitRepo();
    const envelope = JSON.stringify({ is_error: true, result: "boom" });
    const bin = fakeBin("claude", { stdout: envelope, code: 0 });
    const result = runSelfWriter({
      writer: "claude",
      worktree: wt,
      task: "write a fix",
      env: { HOUGE_CLAUDE_BIN: bin }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/is_error/);
  });

  it("maps a missing claude binary (ENOENT) to a clean error", () => {
    const result = runSelfWriter({
      writer: "claude",
      worktree: gitRepo(),
      task: "write a fix",
      env: { HOUGE_CLAUDE_BIN: "/no/such/claude-bin-anywhere" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });
});
