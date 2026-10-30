#!/usr/bin/env node
// Stamp a clean worktree's build: node scripts/stamp-dist.mjs <worktree>
// Refuses a dirty worktree, runs `npm run build` there, writes <worktree>/dist/.provenance.json {head, clean, dist_sha256}.
// The differential harness (--old-dist-4b) re-derives all three before trusting the build.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { distHash } from "./old-dist-provenance.mjs";

const arg = process.argv[2];
if (!arg) { console.error("usage: node scripts/stamp-dist.mjs <worktree>"); process.exit(2); }
const worktree = resolve(arg);
const git = (...a) => execFileSync("git", ["-C", worktree, ...a], { encoding: "utf8" }).trim();
try {
  if (git("status", "--porcelain")) throw new Error(`${worktree} is not clean: commit or discard changes first`);
  execFileSync("npm", ["run", "build"], { cwd: worktree, stdio: "inherit" });
  if (git("status", "--porcelain")) throw new Error(`${worktree} became dirty during the build`);
  const stamp = { head: git("rev-parse", "HEAD"), clean: true, dist_sha256: distHash(join(worktree, "dist")) };
  writeFileSync(join(worktree, "dist", ".provenance.json"), `${JSON.stringify(stamp, null, 2)}\n`);
  console.log(`stamped ${worktree}/dist: head ${stamp.head.slice(0, 12)}, dist ${stamp.dist_sha256.slice(0, 12)}`);
} catch (e) { console.error(`stamp-dist: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
