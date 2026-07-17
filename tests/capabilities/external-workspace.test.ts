import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  buildExtWorkPublishedNotification,
  cloneExternalRepo,
  defaultExternalWorkDeps,
  removeExternalWorkspace,
  resolveExtWorkEnabled,
  validateCloneUrl,
  writeExternalWorkArtifact
} from "../../src/capabilities/external-workspace.js";
import { manifestFor } from "../../src/core/tool-manifest.js";

const PINNED_ENV = ["HOUGE_EXTWORK_ENABLED"] as const;
let saved: Record<string, string | undefined> = {};
let dirs: string[] = [];
beforeEach(() => {
  saved = {};
  for (const k of PINNED_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of PINNED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("resolveExtWorkEnabled", () => {
  it("defaults OFF; accepts 1/true/yes/on", () => {
    expect(resolveExtWorkEnabled(process.env)).toBe(false);
    for (const v of ["1", "true", "YES", "on"]) {
      expect(resolveExtWorkEnabled({ HOUGE_EXTWORK_ENABLED: v } as NodeJS.ProcessEnv)).toBe(true);
    }
    expect(resolveExtWorkEnabled({ HOUGE_EXTWORK_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("external_work manifest arming", () => {
  it("is absent from the manifest when the flag is off, present when armed", () => {
    expect(manifestFor(["external_work"], {} as NodeJS.ProcessEnv)).toEqual([]);
    const armed = manifestFor(["external_work"], { HOUGE_EXTWORK_ENABLED: "1" } as NodeJS.ProcessEnv);
    expect(armed.map((e) => e.name)).toEqual(["external_work"]);
    expect(armed[0]!.side_effect_level).toBe("external_read");
  });
});

describe("validateCloneUrl — SSRF floor + https-only (P1)", () => {
  it("accepts a plain public https URL", () => {
    expect(validateCloneUrl("https://github.com/owner/repo.git")).toMatchObject({ ok: true });
  });

  const refused: Array<[string, string]> = [
    ["http://github.com/owner/repo", "http (P1 is https-only)"],
    ["ssh://git@github.com/owner/repo", "ssh scheme"],
    ["git://github.com/owner/repo", "git scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["https://user:token@github.com/owner/repo", "credentials in the URL"],
    ["https://127.0.0.1/repo", "loopback IP"],
    ["https://10.0.0.5/repo", "private IP"],
    ["https://[::1]/repo", "ipv6 loopback"]
  ];
  for (const [url, why] of refused) {
    it(`refuses ${why}: ${url}`, () => {
      const result = validateCloneUrl(url);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("refused:");
    });
  }
});

describe("cloneExternalRepo", () => {
  const publicResolve = async () => [{ address: "140.82.112.3" }]; // github.com, public

  it("refuses a bad URL WITHOUT invoking git or DNS", async () => {
    let execCalled = false;
    let dnsCalled = false;
    const result = await cloneExternalRepo("http://github.com/owner/repo", {
      sizeCapMB: 500,
      timeoutMs: 1000,
      exec: async () => { execCalled = true; return {}; },
      resolveHost: async () => { dnsCalled = true; return [{ address: "1.1.1.1" }]; }
    });
    expect(result.ok).toBe(false);
    expect(execCalled).toBe(false);
    expect(dnsCalled).toBe(false);
  });

  it("tears down the partial clone when git fails", async () => {
    const result = await cloneExternalRepo("https://github.com/owner/repo.git", {
      sizeCapMB: 500,
      timeoutMs: 1000,
      resolveHost: publicResolve,
      exec: async () => { throw new Error("fatal: could not read from remote"); }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("clone failed");
  });

  it("refuses a public hostname that resolves to a PRIVATE IP, WITHOUT cloning (verifier MAJOR-3)", async () => {
    let execCalled = false;
    const result = await cloneExternalRepo("https://internal.corp.example.com/x.git", {
      sizeCapMB: 500,
      timeoutMs: 1000,
      exec: async () => { execCalled = true; return {}; },
      resolveHost: async () => [{ address: "10.0.0.5" }] // A-record → private
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("blocked address");
    expect(execCalled).toBe(false); // never reached git clone
  });

  it("refuses a host that resolves to a link-local metadata IP (169.254.169.254)", async () => {
    const result = await cloneExternalRepo("https://evil.example.com/x.git", {
      sizeCapMB: 500,
      timeoutMs: 1000,
      exec: async () => ({}),
      resolveHost: async () => [{ address: "169.254.169.254" }]
    });
    expect(result.ok).toBe(false);
  });
});

describe("unifiedDiff host-hardening (verifier MAJOR-2)", () => {
  it("does NOT execute a repo-local textconv/external-diff command during git diff", async () => {
    const repo = mkdtempSync(join(tmpdir(), "houge-extwork-difftest-"));
    dirs.push(repo);
    const sentinel = join(repo, "PWNED_ON_HOST");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    // A hostile external-diff driver that writes a host sentinel if git ever invokes it.
    git("config", "diff.evil.command", `sh -c 'touch ${sentinel}' --`);
    writeFileSync(join(repo, ".gitattributes"), "*.foo diff=evil\n");
    writeFileSync(join(repo, "a.foo"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(repo, "a.foo"), "two\n"); // a change to diff

    // The default unifiedDiff (with --no-ext-diff --no-textconv) must NOT run the driver.
    await defaultExternalWorkDeps().unifiedDiff(repo);
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe("removeExternalWorkspace", () => {
  it("removes a dir and is idempotent (missing dir is a no-op, never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "houge-extwork-rm-"));
    expect(existsSync(dir)).toBe(true);
    removeExternalWorkspace(dir);
    expect(existsSync(dir)).toBe(false);
    expect(() => removeExternalWorkspace(dir)).not.toThrow();
  });
});

describe("writeExternalWorkArtifact", () => {
  it("writes patch.diff + report.md under runs/<run_id>/", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-extwork-art-"));
    dirs.push(root);
    const artifact = writeExternalWorkArtifact(root, "run_abc", {
      task: "fix the parser",
      repoUrl: "https://github.com/owner/repo",
      patch: "diff --git a/x b/x\n+fixed",
      gateOutput: "all green"
    });
    expect(existsSync(artifact.patchPath)).toBe(true);
    expect(existsSync(artifact.reportPath)).toBe(true);
    expect(readFileSync(artifact.patchPath, "utf8")).toContain("+fixed");
    const report = readFileSync(artifact.reportPath, "utf8");
    expect(report).toContain("https://github.com/owner/repo");
    expect(report).toContain("fix the parser");
  });
});

describe("published notification", () => {
  it("names the local patch path (no push in P1)", () => {
    const text = buildExtWorkPublishedNotification("fix the parser", "runs/run_abc/patch.diff");
    expect(text).toContain("runs/run_abc/patch.diff");
    expect(text).toContain("fix the parser");
  });
});
