// tests/omp/seatbelt.test.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderSeatbelt, writeSeatbeltProfiles } from "../../src/omp/seatbelt.js";

describe("Seatbelt profiles — floor A at the OS level (spec §3 L1a/L1b)", () => {
  const ctx = { home: "/Users/p", repo: "/Users/p/Projects/adventure", data: "/Users/p/Projects/adventure" };

  it("renders subpath denies for secret dirs and literal denies for secret files, in both profiles", () => {
    const { planner, shell } = renderSeatbelt(ctx);
    for (const p of [planner, shell]) {
      expect(p).toContain('(deny file-read* file-write* (subpath "/Users/p/.ssh"))');
      expect(p).toContain('(deny file-read* file-write* (literal "/Users/p/Projects/adventure/.env"))');
      expect(p).toContain("(deny signal (target others))");
      expect(p).toContain('(deny process-exec (literal "/bin/launchctl"))');
    }
  });

  it("lets the planner process use its own omp profile store but denies it to shell (D11: the OS cannot split it inside one process)", () => {
    const { planner, shell } = renderSeatbelt(ctx);
    expect(planner).not.toContain('(subpath "/Users/p/.omp")');
    expect(shell).toContain('(deny file-read* file-write* (subpath "/Users/p/.omp"))');
  });

  it("denies writes to the whole repo and re-allows only the workspace (and sessions for the planner), after the denies", () => {
    const { planner, shell } = renderSeatbelt(ctx);
    for (const p of [planner, shell]) expect(p).toContain('(deny file-write* (subpath "/Users/p/Projects/adventure"))');
    const allowWs = '(allow file-write* (subpath "/Users/p/Projects/adventure/omp/workspace"))';
    expect(shell.indexOf(allowWs)).toBeGreaterThan(shell.indexOf('(deny file-write* (subpath "/Users/p/Projects/adventure"))'));
    expect(planner).toContain('(allow file-write* (subpath "/Users/p/Projects/adventure/omp/sessions"))');
    expect(shell).not.toContain("omp/sessions");
  });

  it("keeps network allowed in both profiles — D12 chose Claude Code posture for shell", () => {
    const { planner, shell } = renderSeatbelt(ctx);
    expect(planner).not.toContain("(deny network");
    expect(shell).not.toContain("(deny network");
  });

  it("escapes quotes and backslashes so a crafted path cannot break out of the profile string", () => {
    const { shell } = renderSeatbelt({ ...ctx, home: '/Users/p"x\\y' });
    expect(shell).toContain('/Users/p\\"x\\\\y/.ssh');
  });

  it.runIf(process.platform === "darwin")("denies a real read of a secret file and allows a normal one, live", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-sb-"));
    const live = { home: root, repo: join(root, "repo"), data: join(root, "repo") };
    mkdirSync(join(root, ".ssh"), { recursive: true }); mkdirSync(join(live.data, "omp"), { recursive: true });
    writeFileSync(join(root, ".ssh", "id"), "secret"); writeFileSync(join(root, "note.txt"), "fine");
    const { shell } = writeSeatbeltProfiles(live);
    const denied = spawnSync("sandbox-exec", ["-f", shell, "cat", join(root, ".ssh", "id")], { encoding: "utf8" });
    const allowed = spawnSync("sandbox-exec", ["-f", shell, "cat", join(root, "note.txt")], { encoding: "utf8" });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toMatch(/Operation not permitted/);
    expect(allowed.stdout).toBe("fine");
    mkdirSync(join(live.data, "omp", "workspace"), { recursive: true });
    const inWs = spawnSync("sandbox-exec", ["-f", shell, "sh", "-c", `echo x > ${join(live.data, "omp", "workspace", "ok.txt")}`]);
    const inRepo = spawnSync("sandbox-exec", ["-f", shell, "sh", "-c", `echo x > ${join(live.repo, "evil.ts")}`]);
    expect(inWs.status).toBe(0);
    expect(inRepo.status).not.toBe(0);
  });
});
