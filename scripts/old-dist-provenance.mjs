// Shared by the parity gate and the rollback check: prove --old-dist really is the previous build, not any dist/ at hand.
// The dist's worktree (its parent directory) must sit at the expected base commit, and the named compiled file (default
// core-worker.js) must differ from the new build's. `file` names the compiled module the slice changed (a slice that leaves core-worker.ts untouched passes another). Anything else is a setup error (the caller exits 2), never a vacuous PASS.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";

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

const STAMP = ".provenance.json";
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** sha256 over every file under dir except the stamp, sorted by relative path: `relpath\0sha256(contents)\n` each. The one implementation (stamp and verify share it). */
export function distHash(dir) {
  const files = walk(dir).map((f) => relative(dir, f)).filter((r) => r !== STAMP).sort();
  const h = createHash("sha256");
  for (const rel of files) h.update(`${rel}\0${sha256(join(dir, rel))}\n`);
  return h.digest("hex");
}

/** A stamped old build (scripts/stamp-dist.mjs): stamp present, worktree clean, HEAD = stamp.head, dist hash = stamp, core-worker.js differs from the new build. */
export function verifyStampedDist(oldDist, newDist) {
  const worktree = dirname(oldDist);
  const stampPath = join(oldDist, STAMP);
  if (!existsSync(stampPath)) throw new Error(`--old-dist-4b ${oldDist} has no ${STAMP}: run node scripts/stamp-dist.mjs ${worktree} first`);
  const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  let head, dirty;
  try {
    head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    dirty = execFileSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8" }).trim();
  } catch (e) { throw new Error(`--old-dist-4b ${oldDist}: its parent ${worktree} is not a git worktree (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`); }
  if (dirty) throw new Error(`--old-dist-4b worktree ${worktree} is not clean`);
  if (head !== stamp.head) throw new Error(`--old-dist-4b stamp is for ${String(stamp.head).slice(0, 12)} but the worktree HEAD is ${head.slice(0, 12)}: run node scripts/stamp-dist.mjs ${worktree} again`);
  const hash = distHash(oldDist);
  if (hash !== stamp.dist_sha256) throw new Error(`--old-dist-4b dist hash ${hash.slice(0, 12)} does not match its stamp ${String(stamp.dist_sha256).slice(0, 12)} (dist changed since stamping): run node scripts/stamp-dist.mjs ${worktree} again`);
  if (sha256(join(oldDist, "core/core-worker.js")) === sha256(join(newDist, "core/core-worker.js"))) throw new Error(`--old-dist-4b has the same core/core-worker.js as the new build: it is not a previous build`);
  return { head, hash };
}
