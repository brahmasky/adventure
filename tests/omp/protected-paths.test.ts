import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDeniedRead, isDeniedWrite, realpathOrSelf, secretPaths } from "../../src/omp/protected-paths.js";

const ctx = { home: "/Users/p", repo: "/Users/p/Projects/adventure", data: "/Users/p/Projects/adventure" };

describe("floor A path sets — the planner may touch anything under home except these (D5, D6)", () => {
  it("denies reads of every secret store, including the planner's own OAuth store (D11 hook mitigation)", () => {
    for (const p of ["/Users/p/.ssh/id_rsa", "/Users/p/Projects/adventure/.env", "/Users/p/Projects/adventure/houge.sqlite-wal",
      "/Users/p/.omp/profiles/houge/agent/agent.db", "/Users/p/.claude/x", "/Users/p/.codex/auth.json",
      "/Users/p/.kimi/credentials/kimi-code.json", "/Users/p/Library/Keychains/login.keychain-db"]) {
      expect(isDeniedRead(p, ctx), p).toBe(true);
    }
  });

  it("allows Paco's own files — yolo under home is the decision", () => {
    expect(isDeniedRead("/Users/p/Documents/taxes.pdf", ctx)).toBe(false);
    expect(isDeniedWrite("/Users/p/Downloads/out.csv", ctx)).toBe(false);
  });

  it("denies writes to Houge's own operation: protected repo files, dist, DB, profiles, launch agents", () => {
    for (const p of ["/Users/p/Projects/adventure/src/policy/capability-policy.ts", "/Users/p/Projects/adventure/AGENTS.md",
      "/Users/p/Projects/adventure/dist/cli.js", "/Users/p/Projects/adventure/omp/shell.sb",
      "/Users/p/Library/LaunchAgents/com.houge.daemon.plist"]) {
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
