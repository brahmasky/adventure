import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  createCodingAgentAdapter,
  resolveCodexBin,
  resolveCodexEnabled,
  resolveCodexModel,
  resolveCodexTimeoutMs
} from "../../src/capabilities/coding-agent.js";

let temps: string[] = [];

/** A throwaway git repo with one commit (so `worktree add HEAD` works). */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-ca-repo-"));
  temps.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@test"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "pipe" });
  writeFileSync(join(dir, "src.txt"), "console.log('hi')\n");
  execFileSync("git", ["-C", dir, "add", "src.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { stdio: "pipe" });
  return dir;
}

/**
 * Write a fake `codex` executable (a shell script) that records its argv + stdin to
 * `argvFile`/`stdinFile`, then performs `behavior`. The `-o <file>` arg is parsed so the
 * success path can write the diagnosis there exactly like real codex does.
 */
function fakeCodex(opts: {
  argvFile: string;
  stdinFile: string;
  behavior: "success" | "fail" | "no-output";
  diagnosis?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-ca-bin-"));
  temps.push(dir);
  const bin = join(dir, "codex");
  const exitLine = opts.behavior === "fail" ? 'exit 3' : "exit 0";
  // Write argv (one per line) and stdin, find the -o target, optionally write to it.
  const writeOut =
    opts.behavior === "success"
      ? `printf '%s' "${(opts.diagnosis ?? "ROOT CAUSE: the classifier prompt lacks identity").replace(/"/g, '\\"')}" > "$OUTFILE"`
      : "# no output written";
  const script = `#!/usr/bin/env bash
: > "${opts.argvFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${opts.argvFile}"; done
cat > "${opts.stdinFile}"
OUTFILE=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then OUTFILE="$a"; fi
  prev="$a"
done
${writeOut}
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

describe("coding-agent config resolvers", () => {
  it("resolveCodexEnabled is off by default, on for truthy values", async () => {
    expect(resolveCodexEnabled({})).toBe(false);
    expect(resolveCodexEnabled({ HOUGE_CODEX_ENABLED: "0" })).toBe(false);
    expect(resolveCodexEnabled({ HOUGE_CODEX_ENABLED: "false" })).toBe(false);
    expect(resolveCodexEnabled({ HOUGE_CODEX_ENABLED: "1" })).toBe(true);
    expect(resolveCodexEnabled({ HOUGE_CODEX_ENABLED: "true" })).toBe(true);
    expect(resolveCodexEnabled({ HOUGE_CODEX_ENABLED: "ON" })).toBe(true);
  });

  it("resolveCodexBin / Model / TimeoutMs honor env with sane defaults", async () => {
    expect(resolveCodexBin({})).toBe("codex");
    expect(resolveCodexBin({ HOUGE_CODEX_BIN: "/usr/bin/codex" })).toBe("/usr/bin/codex");
    expect(resolveCodexModel({})).toBeUndefined();
    expect(resolveCodexModel({ HOUGE_CODEX_MODEL: "gpt-5" })).toBe("gpt-5");
    expect(resolveCodexTimeoutMs({})).toBe(240_000);
    expect(resolveCodexTimeoutMs({ HOUGE_CODEX_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(resolveCodexTimeoutMs({ HOUGE_CODEX_TIMEOUT_MS: "nope" })).toBe(240_000);
  });
});

describe("buildCodexArgs", () => {
  it("uses read-only sandbox, -C worktree, -o outfile, trailing stdin marker; no model when unset", async () => {
    expect(buildCodexArgs("/wt", "/out.txt")).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "-C",
      "/wt",
      "-o",
      "/out.txt",
      "-"
    ]);
  });

  it("adds -m <model> when a model is set", async () => {
    expect(buildCodexArgs("/wt", "/out.txt", "gpt-5")).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "-C",
      "/wt",
      "-o",
      "/out.txt",
      "-m",
      "gpt-5",
      "-"
    ]);
  });

  it("never includes a dangerously-bypass flag", async () => {
    const args = buildCodexArgs("/wt", "/out.txt", "gpt-5").join(" ");
    expect(args).not.toMatch(/dangerously-bypass/);
  });
});

describe("createCodingAgentAdapter", () => {
  it("rejects an empty question without shelling out", async () => {
    const adapter = createCodingAgentAdapter({ projectRoot: gitRepo() });
    await expect(adapter({ question: "" })).resolves.toEqual({ ok: false, error: "question must be a non-empty string" });
  });

  it("runs codex read-only, feeds the question on stdin, and reads the diagnosis from -o", async () => {
    const repo = gitRepo();
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-ca-cap-")), "argv");
    const stdinFile = join(mkdtempSync(join(tmpdir(), "houge-ca-cap-")), "stdin");
    temps.push(argvFile, stdinFile);
    const bin = fakeCodex({ argvFile, stdinFile, behavior: "success", diagnosis: "ROOT CAUSE: missing identity" });

    const adapter = createCodingAgentAdapter({
      projectRoot: repo,
      env: { HOUGE_CODEX_BIN: bin, HOUGE_CODEX_MODEL: "gpt-5" }
    });
    const result = await adapter({ question: "why did you ask which 猴哥?" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.diagnosis).toBe("ROOT CAUSE: missing identity");
      expect(result.output.model).toBe("gpt-5");
      expect(result.output.bin).toBe(bin);
    }

    // Argv: read-only sandbox, the model flag, and a -C pointing at a fresh worktree
    // (NOT the project root) — never a bypass flag.
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    expect(argv).toContain("--sandbox");
    expect(argv).toContain("read-only");
    expect(argv).toContain("-m");
    expect(argv).toContain("gpt-5");
    expect(argv.join(" ")).not.toMatch(/dangerously-bypass/);
    const cIdx = argv.indexOf("-C");
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cIdx + 1]).not.toBe(repo);
    expect(argv[cIdx + 1]).toContain("houge-worktree-");

    // The question was fed on stdin.
    expect(readFileSync(stdinFile, "utf8")).toContain("why did you ask which 猴哥?");

    // The worktree was cleaned up (the -C dir no longer exists).
    expect(existsSync(String(argv[cIdx + 1]))).toBe(false);
  });

  it("maps a non-zero codex exit to a clean error and still cleans up the worktree", async () => {
    const repo = gitRepo();
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-ca-cap-")), "argv");
    const stdinFile = join(mkdtempSync(join(tmpdir(), "houge-ca-cap-")), "stdin");
    temps.push(argvFile, stdinFile);
    const bin = fakeCodex({ argvFile, stdinFile, behavior: "fail" });

    const adapter = createCodingAgentAdapter({ projectRoot: repo, env: { HOUGE_CODEX_BIN: bin } });
    const result = await adapter({ question: "diagnose this" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-zero|status 3/);

    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    const cIdx = argv.indexOf("-C");
    expect(existsSync(String(argv[cIdx + 1]))).toBe(false); // cleaned up even on failure
  });

  it("maps a missing codex binary (ENOENT) to a clean error", async () => {
    const adapter = createCodingAgentAdapter({
      projectRoot: gitRepo(),
      env: { HOUGE_CODEX_BIN: "codex-does-not-exist-anywhere" }
    });
    const result = await adapter({ question: "diagnose this" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });

  it("maps a timeout to a clean error", async () => {
    const repo = gitRepo();
    // A fake codex that sleeps longer than the timeout.
    const dir = mkdtempSync(join(tmpdir(), "houge-ca-slow-"));
    temps.push(dir);
    const bin = join(dir, "codex");
    writeFileSync(bin, "#!/usr/bin/env bash\nsleep 5\n");
    chmodSync(bin, 0o755);

    const adapter = createCodingAgentAdapter({
      projectRoot: repo,
      env: { HOUGE_CODEX_BIN: bin, HOUGE_CODEX_TIMEOUT_MS: "300" }
    });
    const result = await adapter({ question: "diagnose this" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out/);
  });

  it("maps a missing output file to a clean error", async () => {
    const repo = gitRepo();
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-ca-cap-")), "argv");
    const stdinFile = join(mkdtempSync(join(tmpdir(), "houge-ca-cap-")), "stdin");
    temps.push(argvFile, stdinFile);
    const bin = fakeCodex({ argvFile, stdinFile, behavior: "no-output" });

    const adapter = createCodingAgentAdapter({ projectRoot: repo, env: { HOUGE_CODEX_BIN: bin } });
    const result = await adapter({ question: "diagnose this" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no output file/);
  });
});
