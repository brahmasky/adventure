// tests/omp/seatbelt.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderSeatbelt, writeSeatbeltProfiles } from "../../src/omp/seatbelt.js";
import { HOME_CODE_CONFIG, HOME_INSTALL_TREES, HOME_SECRETS } from "../../src/omp/protected-paths.js";

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
    expect(shell.lastIndexOf(allowWs)).toBeGreaterThan(shell.indexOf('(deny file-write* (subpath "/Users/p/Projects/adventure"))'));
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

  it("pins the workspace root (and sessions root for the planner) with a literal deny after the allows", () => {
    const { planner, shell } = renderSeatbelt(ctx);
    const ws = "/Users/p/Projects/adventure/omp/workspace";
    const ss = "/Users/p/Projects/adventure/omp/sessions";
    const denyWs = `(deny file-write* (literal "${ws}"))`;
    expect(shell.indexOf(denyWs)).toBeGreaterThan(shell.lastIndexOf(`(allow file-write* (subpath "${ws}"))`));
    expect(planner.indexOf(`(deny file-write* (literal "${ss}"))`)).toBeGreaterThan(planner.lastIndexOf(`(allow file-write* (subpath "${ss}"))`));
    expect(shell).not.toContain(`(literal "${ss}")`);
    const pinChats = '(deny file-write* (regex #"^/Users/p/Projects/adventure/omp/workspace/chat-[^/]+$"))';
    expect(shell.indexOf(pinChats)).toBeGreaterThan(shell.lastIndexOf(`(allow file-write* (subpath "${ws}"))`)); // C2: chat dirs pinned too
  });

  it.runIf(process.platform === "darwin")("the workspace root cannot be moved, removed or swapped for a symlink, but its contents stay fully usable", () => {
    const { root, live, run, elsewhere } = liveRoot();
    const ws = join(live.data, "omp", "workspace");
    const mv = run("mv", ws, elsewhere);
    expect(mv.status).not.toBe(0);
    expect(mv.stderr).toMatch(/Operation not permitted/);
    expect(run("rm", "-rf", ws).status).not.toBe(0);
    expect(existsSync(ws)).toBe(true);
    expect(run("sh", "-c", `echo y > ${ws}/a.txt && mkdir ${ws}/d && mv ${ws}/a.txt ${ws}/d/b.txt`).status).toBe(0);
    expect(existsSync(join(ws, "d", "b.txt"))).toBe(true);
    expect(root).toBeTruthy();
  });

  it.runIf(process.platform === "darwin")("planner profile pins the sessions root the same way", () => {
    const { live } = liveRoot();
    const ss = join(live.data, "omp", "sessions");
    mkdirSync(ss, { recursive: true });
    const { planner } = writeSeatbeltProfiles(live);
    const run = (...cmd: string[]) => spawnSync("sandbox-exec", ["-f", planner, ...cmd], { encoding: "utf8" });
    const mv = run("mv", ss, join(live.data, "omp", "workspace", "s2"));
    expect(mv.status).not.toBe(0);
    expect(mv.stderr).toMatch(/Operation not permitted/);
    expect(run("sh", "-c", `echo y > ${ss}/a.jsonl && mkdir ${ss}/d && mv ${ss}/a.jsonl ${ss}/d/b.jsonl`).status).toBe(0);
  });
  it("denies every write by default and re-opens only $HOME, the temp roots and the /dev sinks, in that order (A1: yolo under $HOME, literally)", () => {
    for (const p of [renderSeatbelt(ctx).planner, renderSeatbelt(ctx).shell]) {
      const denyAll = p.indexOf("(deny file-write*)\n");
      expect(denyAll).toBeGreaterThan(p.indexOf("(allow default)"));
      for (const root of ["/Users/p", "/private/tmp", "/private/var/folders"]) {
        expect(p.indexOf(`(allow file-write* (subpath "${root}"))`), root).toBeGreaterThan(denyAll);
      }
      expect(p).toContain('(allow file-write* (literal "/dev/null"))');
      expect(p).not.toContain('(allow file-write* (subpath "/usr');
    }
  });

  it("denies the $HOME install trees, the code-running dotfiles and the binary dirs AFTER the $HOME allow (last match wins)", () => {
    const withBins = { ...ctx, binDirs: ["/usr/local/Cellar/node/25.5.0/bin", "/Users/p/.local/bin"] };
    for (const p of [renderSeatbelt(withBins).planner, renderSeatbelt(withBins).shell]) {
      const allowHome = p.indexOf('(allow file-write* (subpath "/Users/p"))');
      for (const rel of [...HOME_INSTALL_TREES, ...HOME_CODE_CONFIG]) {
        expect(p.indexOf(`(deny file-write* (subpath "/Users/p/${rel}"))`), rel).toBeGreaterThan(allowHome);
      }
      expect(p).toContain('(deny file-write* (subpath "/usr/local/Cellar/node/25.5.0/bin"))');
    }
  });

  function fakeHome() {
    const root = mkdtempSync(join(tmpdir(), "houge-sbh-"));
    roots.push(root);
    const home = join(root, "home"); const repo = join(home, "Projects", "adventure");
    const live = { home, repo, data: repo };
    for (const d of [".bun/bin", ".local/bin", ".config/fish", ".omp/profiles/houge", "Documents", "bin"]) mkdirSync(join(home, d), { recursive: true });
    mkdirSync(join(repo, "omp", "workspace", "chat-1"), { recursive: true });
    writeFileSync(join(home, ".omp/profiles/houge/auth.json"), "OMPCANARY");
    // a stub "omp": the planner process must still read its own profile store (D11)
    writeFileSync(join(home, "bin", "omp"), `#!/bin/sh\n/bin/cat "$HOME/.omp/profiles/houge/auth.json"\n`, { mode: 0o755 });
    const profiles = writeSeatbeltProfiles(live);
    const run = (prof: string, ...cmd: string[]) =>
      spawnSync("/usr/bin/sandbox-exec", ["-f", prof, ...cmd], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home } });
    const canWrite = (prof: string, path: string) => run(prof, "/bin/sh", "-c", `echo x > '${path}'`).status === 0;
    return { home, live, profiles, run, canWrite };
  }

  it.runIf(process.platform === "darwin")("live: install trees, dotfiles and outside-$HOME paths are write-denied; $HOME, the workspace, /tmp and /dev/null stay writable", () => {
    const { home, live, profiles, canWrite } = fakeHome();
    const outside = [`/private/var/tmp/houge-canary-${process.pid}`, `/Users/Shared/houge-canary-${process.pid}`];
    try {
      for (const prof of [profiles.planner, profiles.shell]) {
        for (const rel of [".bun/bin/omp", ".local/bin/agy", ".zshrc", ".gitconfig", ".config/fish/config.fish", ".p10k.zsh"]) {
          expect(canWrite(prof, join(home, rel)), rel).toBe(false);
        }
        for (const p of outside) expect(canWrite(prof, p), p).toBe(false);
        expect(canWrite(prof, join(home, "Documents", "ok.txt"))).toBe(true);
        expect(canWrite(prof, join(live.data, "omp", "workspace", "chat-1", "ok.txt"))).toBe(true);
        expect(canWrite(prof, `/tmp/houge-sb-ok-${process.pid}`)).toBe(true);
        expect(canWrite(prof, "/dev/null")).toBe(true);
      }
    } finally {
      for (const p of [...outside, `/tmp/houge-sb-ok-${process.pid}`]) rmSync(p, { force: true });
    }
  });

  it.runIf(process.platform === "darwin")("live: a stub omp under planner.sb still reads <home>/.omp, and node still starts (the planner keeps working)", () => {
    const { home, profiles, run } = fakeHome();
    const stub = run(profiles.planner, join(home, "bin", "omp"));
    expect(stub.stdout).toBe("OMPCANARY");
    const node = run(profiles.planner, process.execPath, "-e", "process.stdout.write('up')");
    expect(node.stdout).toBe("up");
  });
  it("read-denies every credential store in both profiles except ~/.omp for the planner, and denies exec of /usr/bin/security (A4)", () => {
    const { planner, shell } = renderSeatbelt(ctx);
    for (const rel of HOME_SECRETS) {
      expect(shell, rel).toContain(`(deny file-read* file-write* (subpath "/Users/p/${rel}"))`);
      if (rel !== ".omp") expect(planner, rel).toContain(`(deny file-read* file-write* (subpath "/Users/p/${rel}"))`);
    }
    for (const p of [planner, shell]) expect(p).toContain('(deny process-exec (literal "/usr/bin/security"))');
  });

  it.runIf(process.platform === "darwin")("live: credential stores and top-level ~/.<name>.env files are unreadable, and /usr/bin/security cannot run, in both profiles", () => {
    const { home, profiles, run } = fakeHome();
    const canaries: Record<string, string> = { ".aws/credentials": "AWS", ".foo.env": "DOTENV", ".env": "ENV", ".npmrc": "NPM",
      ".config/gh/hosts.yml": "GH", ".docker/config.json": "DOCKER", ".netrc": "NETRC", ".agents/token": "AGENTS" };
    for (const [rel, body] of Object.entries(canaries)) { mkdirSync(join(home, rel, ".."), { recursive: true }); writeFileSync(join(home, rel), body); }
    writeFileSync(join(home, "notes.env"), "PLAIN");
    for (const prof of [profiles.planner, profiles.shell]) {
      for (const rel of Object.keys(canaries)) expect(run(prof, "/bin/cat", join(home, rel)).status, rel).not.toBe(0);
      expect(run(prof, "/bin/cat", join(home, "notes.env")).stdout).toBe("PLAIN");
      const sec = run(prof, "/usr/bin/security", "help");
      expect(sec.status).not.toBe(0);
      expect(sec.stderr).toMatch(/Operation not permitted/);
    }
  });
});
