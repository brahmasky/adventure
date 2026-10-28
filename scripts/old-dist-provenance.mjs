// Shared by the parity gate and the rollback check: prove --old-dist really is the previous build, not any dist/ at hand.
// The dist's worktree (its parent directory) must sit at the expected base commit, and the named compiled file (default
// core-worker.js) must differ from the new build's. `file` names the compiled module the slice changed (a slice that leaves core-worker.ts untouched passes another). Anything else is a setup error (the caller exits 2), never a vacuous PASS.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

export const DEFAULT_OLD_BASE = "3bff437";
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function verifyOldDist(oldDist, newDist, base = DEFAULT_OLD_BASE, file = "core/core-worker.js") {
  const worktree = dirname(oldDist);
  let head;
  try { head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch (e) { throw new Error(`--old-dist ${oldDist}: its parent ${worktree} is not a git worktree (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`); }
  if (!head.startsWith(base)) throw new Error(`--old-dist ${oldDist} is not the previous build: its worktree HEAD is ${head.slice(0, 12)}, expected ${base} (pass --old-base <sha> to name another base)`);
  const [a, b] = [sha256(join(oldDist, file)), sha256(join(newDist, file))];
  if (a === b) throw new Error(`--old-dist ${oldDist} has the same ${file} as the new build (${a.slice(0, 12)}): it is not a previous build`);
  return { head, oldHash: a.slice(0, 12), newHash: b.slice(0, 12) };
}
