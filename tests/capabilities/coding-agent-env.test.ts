import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodingAgentAdapter } from "../../src/capabilities/coding-agent.js";

let temps: string[] = [];

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-caenv-repo-"));
  temps.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@test"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "pipe" });
  writeFileSync(join(dir, "src.txt"), "x\n");
  execFileSync("git", ["-C", dir, "add", "src.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { stdio: "pipe" });
  return dir;
}

/** Fake codex that dumps its OWN environment to `envDump`, then writes to the `-o` outfile. */
function fakeCodexDumpingEnv(envDump: string): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-caenv-bin-"));
  temps.push(dir);
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\nprintenv > "${envDump}"\nOUTFILE=""\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "-o" ]; then OUTFILE="$a"; fi\n  prev="$a"\ndone\nprintf 'ROOT CAUSE: ok' > "$OUTFILE"\nexit 0\n`
  );
  chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

describe("Codex child env lockdown (ADR 0015 §5)", () => {
  it("spawns Codex with an ALLOWLISTED env — no *_API_KEY / token leaks into the child", async () => {
    const repo = gitRepo();
    const envDump = join(mkdtempSync(join(tmpdir(), "houge-caenv-out-")), "env.txt");
    temps.push(join(envDump, ".."));
    const bin = fakeCodexDumpingEnv(envDump);

    // Seed the daemon's ambient env with secrets, exactly what the firewall defends against.
    const prevKimi = process.env.KIMI_API_KEY;
    const prevTok = process.env.HOUGE_TELEGRAM_BOT_TOKEN;
    process.env.KIMI_API_KEY = "kimi-should-not-leak-123456";
    process.env.HOUGE_TELEGRAM_BOT_TOKEN = "111:token-should-not-leak";
    try {
      const adapter = createCodingAgentAdapter({ projectRoot: repo, env: { HOUGE_CODEX_BIN: bin } });
      const result = await adapter({ question: "diagnose" });
      expect(result.ok).toBe(true);

      const childEnv = readFileSync(envDump, "utf8");
      expect(childEnv).not.toContain("KIMI_API_KEY");
      expect(childEnv).not.toContain("kimi-should-not-leak-123456");
      expect(childEnv).not.toContain("HOUGE_TELEGRAM_BOT_TOKEN");
      expect(childEnv).not.toContain("token-should-not-leak");
      // The child DOES get the minimal allowlist so it can still run (PATH at least).
      expect(childEnv).toMatch(/^PATH=/m);
    } finally {
      if (prevKimi === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = prevKimi;
      if (prevTok === undefined) delete process.env.HOUGE_TELEGRAM_BOT_TOKEN;
      else process.env.HOUGE_TELEGRAM_BOT_TOKEN = prevTok;
    }
  });

  it("honors HOUGE_CODEX_ENV_PASSTHROUGH as an explicit opt-in escape hatch", async () => {
    const repo = gitRepo();
    const envDump = join(mkdtempSync(join(tmpdir(), "houge-caenv-out2-")), "env.txt");
    temps.push(join(envDump, ".."));
    const bin = fakeCodexDumpingEnv(envDump);

    const prevPass = process.env.HOUGE_CODEX_ENV_PASSTHROUGH;
    const prevExtra = process.env.MY_CODEX_EXTRA;
    process.env.HOUGE_CODEX_ENV_PASSTHROUGH = "MY_CODEX_EXTRA";
    process.env.MY_CODEX_EXTRA = "passed-through-value";
    try {
      const adapter = createCodingAgentAdapter({ projectRoot: repo, env: { HOUGE_CODEX_BIN: bin } });
      const result = await adapter({ question: "diagnose" });
      expect(result.ok).toBe(true);
      expect(readFileSync(envDump, "utf8")).toContain("MY_CODEX_EXTRA=passed-through-value");
    } finally {
      if (prevPass === undefined) delete process.env.HOUGE_CODEX_ENV_PASSTHROUGH;
      else process.env.HOUGE_CODEX_ENV_PASSTHROUGH = prevPass;
      if (prevExtra === undefined) delete process.env.MY_CODEX_EXTRA;
      else process.env.MY_CODEX_EXTRA = prevExtra;
    }
  });
});
