import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installedBinaryDirs, isDeniedRead, isDeniedWrite, realpathOrSelf, secretPaths } from "../../src/omp/protected-paths.js";

const ctx = { home: "/Users/p", repo: "/Users/p/Projects/adventure", data: "/Users/p/Projects/adventure" };

describe("floor A path sets — the planner may touch anything under home except these (D5, D6)", () => {
  it("denies reads of every secret store, including the planner's own OAuth store (D11 hook mitigation)", () => {
    for (const p of ["/Users/p/.ssh/id_rsa", "/Users/p/Projects/adventure/.env", "/Users/p/Projects/adventure/houge.sqlite-wal",
      "/Users/p/.omp/profiles/houge/agent/agent.db", "/Users/p/.claude/x", "/Users/p/.codex/auth.json",
      "/Users/p/.kimi/credentials/kimi-code.json", "/Users/p/Library/Keychains/login.keychain-db"]) {
      expect(isDeniedRead(p, ctx), p).toBe(true);
    }
  });

  it("denies the widened credential set and top-level ~/.<name>.env files to the gate too (A4)", () => {
    for (const p of ["/Users/p/.aws/credentials", "/Users/p/.config/gh/hosts.yml", "/Users/p/.npmrc", "/Users/p/.docker/config.json",
      "/Users/p/.cargo/credentials.toml", "/Users/p/.git-credentials", "/Users/p/.houge/x", "/Users/p/.foo.env", "/Users/p/.ENV"]) {
      expect(isDeniedRead(p, ctx), p).toBe(true);
    }
    expect(isDeniedRead("/Users/p/notes.env", ctx)).toBe(false);
    expect(isDeniedRead("/Users/p/Projects/x/.foo.env", ctx)).toBe(false);
  });

  it("allows Paco's own files — yolo under home is the decision", () => {
    expect(isDeniedRead("/Users/p/Documents/taxes.pdf", ctx)).toBe(false);
    expect(isDeniedWrite("/Users/p/Downloads/out.csv", ctx)).toBe(false);
  });

  it("denies writes to Houge's own operation: protected repo files, dist, DB, profiles, and any launch agent (a new plist is persistence)", () => {
    for (const p of ["/Users/p/Projects/adventure/src/policy/capability-policy.ts", "/Users/p/Projects/adventure/AGENTS.md",
      "/Users/p/Projects/adventure/dist/cli.js", "/Users/p/Projects/adventure/omp/shell.sb",
      "/Users/p/Library/LaunchAgents/com.houge.daemon.plist", "/Users/p/Library/LaunchAgents/com.evil.persist.plist"]) {
      expect(isDeniedWrite(p, ctx), p).toBe(true);
    }
  });

  it("denies writes anywhere in the Houge repo except the planner workspace — repo changes go through self_write_propose (review blocker 2)", () => {
    expect(isDeniedWrite("/Users/p/Projects/adventure/src/core/core-worker.ts", ctx)).toBe(true);
    expect(isDeniedWrite("/Users/p/Projects/adventure/omp/workspace/chat-42/out.csv", ctx)).toBe(false);
  });

  it("matches on segment boundaries so a look-alike name is not caught by accident", () => {
    expect(isDeniedRead("/Users/p/.sshkeys-notes/readme", ctx)).toBe(false);
  });

  it("matches case-insensitively because APFS is case-insensitive by default", () => {
    expect(isDeniedRead("/Users/p/.SSH/id_rsa", ctx)).toBe(true);
  });

  it("lists absolute paths only — a relative entry would silently match nothing in Seatbelt", () => {
    for (const p of secretPaths(ctx)) expect(p.startsWith("/")).toBe(true);
  });
});

describe("floor A write policy — the gate mirrors the profiles' default-deny (A1)", () => {
  it("denies writes outside $HOME and the temp roots, and into the install trees and code-running dotfiles inside $HOME", () => {
    for (const p of ["/usr/local/bin/omp", "/opt/homebrew/bin/x", "/Users/p/.bun/bin/omp", "/Users/p/.local/bin/agy",
      "/Users/p/.zshrc", "/Users/p/.gitconfig", "/Users/p/.config/fish/config.fish", "/Users/p/.config/git/config"]) {
      expect(isDeniedWrite(p, ctx), p).toBe(true);
    }
    expect(isDeniedWrite("/private/tmp/x", ctx)).toBe(false);
    expect(isDeniedWrite("/Users/p/.config/other/x", ctx)).toBe(false);
  });

  it("denies the rest of the code-running dotfiles Paco's own tools load: login/logout shells, ZDOTDIR, vim/nvim, tmux, direnv (security N3)", () => {
    for (const rel of [".bash_login", ".zlogout", ".zsh/.zshrc", ".config/zsh/.zshrc", ".vimrc", ".vim/plugin/x.vim", ".config/nvim/init.lua",
      ".tmux.conf", ".config/tmux/tmux.conf", ".envrc"]) {
      expect(isDeniedWrite(`/Users/p/${rel}`, ctx), rel).toBe(true);
    }
    expect(isDeniedWrite("/Users/p/Projects/other/.envrc", ctx)).toBe(false); // only the one directly in $HOME
    expect(isDeniedWrite("/Users/p/.vimrc-notes.txt", ctx)).toBe(false); // segment boundary
  });

  it("denies the binary dirs the daemon later runs unsandboxed, when the context names them", () => {
    expect(isDeniedWrite("/Users/p/tools/omp", { ...ctx, binDirs: ["/Users/p/tools"] })).toBe(true);
    expect(isDeniedWrite("/Users/p/tools/omp", ctx)).toBe(false);
  });

  it("installedBinaryDirs finds a PATH symlink's own dir AND its real target's dir (replacing either runs code)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "houge-bin-")));
    mkdirSync(join(root, "pkg", "dist"), { recursive: true }); mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "pkg", "dist", "cli.js"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(join(root, "pkg", "dist", "cli.js"), join(root, "bin", "omp"));
    const dirs = installedBinaryDirs({ PATH: `${join(root, "bin")}:/nonexistent` }, "/usr/local/bin/node");
    expect(dirs).toEqual(expect.arrayContaining([join(root, "bin"), join(root, "pkg", "dist"), "/usr/local/bin"]));
  });
});

describe("realpathOrSelf — Seatbelt matches canonical paths only", () => {
  it("canonicalises the deepest existing ancestor for a not-yet-created path, so its rule still matches", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "houge-rp-")));
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(realpathOrSelf(join(root, "link", "new", "deep", "f.txt"))).toBe(join(root, "real", "new", "deep", "f.txt"));
  });

  it("returns an existing path's realpath and leaves a wholly missing absolute path as-is", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "houge-rp-")));
    expect(realpathOrSelf(root)).toBe(root);
    expect(realpathOrSelf("/nonexistent-houge-x/y")).toBe("/nonexistent-houge-x/y");
  });
});
