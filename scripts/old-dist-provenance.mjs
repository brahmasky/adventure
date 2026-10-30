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

/** An error carrying a closed `kind`; callers print provenanceText(kind), never the message. */
export class ProvenanceError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
const TEXT = {
  base_unknown: "provenance: merge base unknown", stamp_missing: "provenance: stamp missing", not_worktree: "provenance: old dist parent is not a git worktree",
  dirty: "provenance: dirty worktree", head_mismatch: "provenance: head is not the merge base", stamp_mismatch: "provenance: stamp is not for the merge base",
  hash_mismatch: "provenance: dist hash mismatch", same_build: "provenance: same build as new (the compared file is identical)",
  base_is_head: "provenance: merge base is this build's own HEAD (already merged); pass --old-base <full sha>",
};
/** The fixed text for a failure of verifyStampedDist / mergeBaseOf; anything else is one generic line. */
export const provenanceText = (e) => TEXT[e?.kind] ?? "provenance: failed";

/** The base the old build must be pinned to: `explicit` (--old-base, a full sha) when given, else the full merge-base sha of HEAD and main in the new build's worktree root (the parent of newDist). A merge base equal to the worktree's own HEAD (the branch is already merged) is refused: the caller must pass --old-base. */
export function mergeBaseOf(newDist, explicit) {
  if (explicit !== undefined && explicit !== null) {
    if (!/^[0-9a-f]{40}$/.test(explicit)) throw new ProvenanceError("base_unknown", "--old-base must be a full sha");
    return explicit;
  }
  try {
    const git = (...a) => execFileSync("git", ["-C", dirname(newDist), ...a], { encoding: "utf8" }).trim();
    const base = git("merge-base", "HEAD", "main");
    if (base === git("rev-parse", "HEAD")) throw new ProvenanceError("base_is_head", "merge base is HEAD");
    return base;
  } catch (e) { throw e instanceof ProvenanceError ? e : new ProvenanceError("base_unknown", "git merge-base failed"); }
}

/** A stamped old build (scripts/stamp-dist.mjs) pinned to `base` (full sha): stamp present and for `base`, worktree clean at `base`, dist hash = stamp, `file` (default core/core-worker.js) differs from the new build. */
export function verifyStampedDist(oldDist, newDist, base, file = "core/core-worker.js") {
  if (!/^[0-9a-f]{40}$/.test(base ?? "")) throw new ProvenanceError("base_unknown", "base must be a full sha");
  const worktree = dirname(oldDist);
  const stampPath = join(oldDist, STAMP);
  if (!existsSync(stampPath)) throw new ProvenanceError("stamp_missing", "no stamp");
  let stamp;
  try { stamp = JSON.parse(readFileSync(stampPath, "utf8")); } catch { throw new ProvenanceError("stamp_missing", "stamp unreadable"); }
  let head, dirty;
  try {
    head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    dirty = execFileSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8" }).trim();
  } catch { throw new ProvenanceError("not_worktree", "not a worktree"); }
  if (dirty) throw new ProvenanceError("dirty", "dirty");
  if (head !== base) throw new ProvenanceError("head_mismatch", "head != base");
  if (stamp.head !== base) throw new ProvenanceError("stamp_mismatch", "stamp head != base");
  const hash = distHash(oldDist);
  if (hash !== stamp.dist_sha256) throw new ProvenanceError("hash_mismatch", "hash");
  if (sha256(join(oldDist, file)) === sha256(join(newDist, file))) throw new ProvenanceError("same_build", "same");
  return { head, hash };
}
