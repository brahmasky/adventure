// tests/omp/seatbelt.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderSeatbelt, writeSeatbeltProfiles } from "../../src/omp/seatbelt.js";

describe("Seatbelt profiles — floor A at the OS level (spec §3 L1a/L1b)", () => {
  const ctx = { home: "/Users/p", repo: "/Users/p/Projects/adventure", data: "/Users/p/Projects/adventure" };

  it("renders subpath denies for secret dirs and files alike (a file guess must never decide a secret rule), in both profiles", () => {
    const { planner, shell } = renderSeatbelt(ctx);
    for (const p of [planner, shell]) {
      expect(p).toContain('(deny file-read* file-write* (subpath "/Users/p/.ssh"))');
      expect(p).toContain('(deny file-read* file-write* (subpath "/Users/p/Projects/adventure/.env"))');
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

  it("renders a not-yet-existing dotted secret dir as subpath so it cannot fail open while absent", () => {
    const { shell } = renderSeatbelt(ctx);
    expect(shell).not.toContain("(literal \"/Users/p/.ssh\")");
    expect(shell).toContain('(deny file-read* file-write* (subpath "/Users/p/.config/gcloud"))');
  });

  it("denies renaming every ancestor of a denied root, but never / itself (rename-bypass fix)", () => {
    const { shell } = renderSeatbelt(ctx);
    for (const d of ["/Users/p/Projects", "/Users/p/.config", "/Users/p", "/Users/p/Library"]) {
      expect(shell).toContain(`(deny file-write* (literal "${d}"))`);
    }
    expect(shell).not.toContain('(literal "/"))');
  });

  it("write-denies the whole LaunchAgents directory, not just Houge's plist — any new plist is persistence", () => {
    expect(renderSeatbelt(ctx).shell).toContain('(deny file-write* (subpath "/Users/p/Library/LaunchAgents"))');
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

  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  function liveRoot() {
    const root = mkdtempSync(join(tmpdir(), "houge-sb-"));
    roots.push(root);
    const live = { home: root, repo: join(root, "Projects", "adventure"), data: join(root, "Projects", "adventure") };
    mkdirSync(join(live.data, "omp", "workspace"), { recursive: true });
    mkdirSync(join(root, ".config", "gcloud"), { recursive: true });
    writeFileSync(join(live.repo, ".env"), "SECRET");
    writeFileSync(join(root, ".config", "gcloud", "creds.json"), "creds");
    const { shell } = writeSeatbeltProfiles(live);
    const run = (...cmd: string[]) => spawnSync("sandbox-exec", ["-f", shell, ...cmd], { encoding: "utf8" });
    return { root, live, run, elsewhere: join(root, "elsewhere") };
  }

  it.runIf(process.platform === "darwin")("blocks mv of the repo's parent, so the repo cannot be carried to an unprotected path", () => {
    const { root, live, run, elsewhere } = liveRoot();
    const mv = run("mv", join(root, "Projects"), elsewhere);
    expect(mv.status).not.toBe(0);
    expect(mv.stderr).toMatch(/Operation not permitted/);
    expect(existsSync(elsewhere)).toBe(false);
    expect(run("cat", join(live.repo, ".env")).status).not.toBe(0);
    expect(readFileSync(join(live.repo, ".env"), "utf8")).toBe("SECRET");
  });

  it.runIf(process.platform === "darwin")("blocks mv of ~/.config, the ancestor of a secret dir", () => {
    const { root, run, elsewhere } = liveRoot();
    const mv = run("mv", join(root, ".config"), elsewhere);
    expect(mv.status).not.toBe(0);
    expect(mv.stderr).toMatch(/Operation not permitted/);
    expect(existsSync(join(root, ".config", "gcloud", "creds.json"))).toBe(true);
  });

  it.runIf(process.platform === "darwin")("still lets a process create files inside an ancestor dir, and write in the workspace", () => {
    const { root, live, run } = liveRoot();
    expect(run("sh", "-c", `echo y > ${join(root, "Projects", "newfile")}`).status).toBe(0);
    expect(run("sh", "-c", `echo y > ${join(live.data, "omp", "workspace", "ok.txt")}`).status).toBe(0);
    expect(run("sh", "-c", `echo y > ${join(live.repo, "evil.ts")}`).status).not.toBe(0);
  });
});
