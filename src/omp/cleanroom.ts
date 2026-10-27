import { lstatSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveDaemonTmpDir } from "../run/daemon-tmp.js";
import { renderCleanroom } from "./seatbelt.js";

/**
 * The clean room (decision-ladder design §8.3): a standing-approved command runs with a fresh, empty room as cwd and a
 * fresh, empty, read-only home. Both are daemon-made under `<daemon tmp>/cleanroom`, inside the cache root the planner
 * and shell profiles already read- and write-deny, so nothing a sandboxed child planted can be inside them. The
 * validator proves that shape before a profile is rendered from the paths; a bad pair is a denied run, never a looser
 * profile.
 */
export type CleanroomReason = "not_absolute" | "not_directory" | "symlink_component" | "outside_cache_root" | "overlap" | "not_empty";

export class CleanroomPathError extends Error {
  constructor(public readonly reason: CleanroomReason, public readonly path: string) {
    super(`cleanroom ${reason}: ${path}`);
    this.name = "CleanroomPathError";
  }
}

/** A room and a home as plain paths: what the pure renderer and env builder take. */
export interface RoomPair { room: string; home: string }

const VALIDATED: unique symbol = Symbol("cleanroom.validated");
/** Canonical absolute paths of a validated pair. Only validateCleanroomDirs makes one, so only it reaches the writer. */
export type CleanroomDirs = Readonly<RoomPair> & { readonly [VALIDATED]: true };

/**
 * The only directory a pair may live under. Derived, never supplied (a caller-given root of "/" was accepted). The
 * `cleanroom/` subdirectory keeps rooms apart from every child's TMPDIR, which Slice 1 moves to a sibling subdirectory.
 */
export function cleanroomRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(resolveDaemonTmpDir(env, home), "cleanroom");
}

const ident = (p: string): string => { const s = statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; };

/** inode ids of p and every ancestor up to and including `/` — APFS case/normalization aliases share inodes, strings do not. */
function lineage(p: string): string[] {
  const out: string[] = [];
  for (let d = p; ; d = dirname(d)) { out.push(ident(d)); if (d === dirname(d)) return out; }
}

/**
 * Containment by inode (strictly below the root, under any spelling of either), then every component from the path up
 * to the root must be a real directory — a symlink anywhere would move the subpath rule.
 */
function canonicalDir(p: string, rootId: string): { path: string; id: string } {
  // absolute AND normalized: `<root>/link/../room` would stat one directory (through the link) and check another
  if (!isAbsolute(p) || resolve(p) !== p) throw new CleanroomPathError("not_absolute", p);
  let st; try { st = statSync(p, { bigint: true }); } catch { throw new CleanroomPathError("not_directory", p); }
  if (!st.isDirectory()) throw new CleanroomPathError("not_directory", p);
  const id = `${st.dev}:${st.ino}`;
  let line; try { line = lineage(p); } catch { throw new CleanroomPathError("not_directory", p); }
  if (id === rootId || !line.includes(rootId)) throw new CleanroomPathError("outside_cache_root", p);
  try {
    for (let d = p; ; d = dirname(d)) {
      // lstat BEFORE the root compare: a link that points at the root itself must still count as a symlink component
      if (lstatSync(d).isSymbolicLink()) throw new CleanroomPathError("symlink_component", p);
      if (ident(d) === rootId) break;
      if (d === dirname(d)) throw new CleanroomPathError("outside_cache_root", p); // the tree moved under us since the lineage
    }
    // case as given: Seatbelt matches paths case-insensitively on APFS, so a rule from either case covers the dir (fails safe)
    return { path: realpathSync(p), id };
  } catch (e) { throw e instanceof CleanroomPathError ? e : new CleanroomPathError("not_directory", p); }
}

/** The root is a real directory (no symlink: it would carry the rooms outside the planner/shell deny) with a known inode. */
function rootIdent(root: string): string {
  try {
    if (lstatSync(root).isSymbolicLink()) throw new CleanroomPathError("symlink_component", root);
    return ident(root);
  } catch (e) { throw e instanceof CleanroomPathError ? e : new CleanroomPathError("outside_cache_root", root); }
}

export function validateCleanroomDirs(input: RoomPair): CleanroomDirs {
  const root = cleanroomRoot();
  const rootId = rootIdent(root);
  const room = canonicalDir(input.room, rootId);
  const home = canonicalDir(input.home, rootId);
  try {
    // overlap before emptiness: a home nested in the room makes the room non-empty, and the overlap is the real fault.
    // By inode: `ROOM-1` and `room-1` are one APFS directory but two strings.
    if (lineage(room.path).includes(home.id) || lineage(home.path).includes(room.id)) {
      throw new CleanroomPathError("overlap", `${room.path} ~ ${home.path}`);
    }
    for (const [d, given] of [[room.path, input.room], [home.path, input.home]] as const) {
      if (readdirSync(d).length > 0) throw new CleanroomPathError("not_empty", given);
    }
  } catch (e) { throw e instanceof CleanroomPathError ? e : new CleanroomPathError("not_directory", `${input.room} ~ ${input.home}`); }
  return Object.freeze({ room: room.path, home: home.path, [VALIDATED]: true as const });
}

export const CLEANROOM_PROFILE_NAME = "cleanroom.sb";

/** Nothing is inherited from the daemon (codex round 4 B19): these six, and TMPDIR inside the room. */
export function cleanroomEnv(dirs: RoomPair): { PATH: string; LANG: string; HOME: string; CURL_HOME: string; XDG_CONFIG_HOME: string; TMPDIR: string } {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", HOME: dirs.home, CURL_HOME: dirs.home, XDG_CONFIG_HOME: dirs.home, TMPDIR: dirs.room };
}

/**
 * The profile is a sidecar in the HOME, which the child can read but never write: it cannot be swapped mid-run (and
 * sandbox-exec has parsed it before the child starts). Written after validation, so "home is empty" held at that point.
 */
export function writeCleanroomProfile(dirs: CleanroomDirs): string {
  // the brand is erased at runtime: a plain-JS caller handing over a literal pair must fail here, not write a profile
  if (!(VALIDATED in dirs)) throw new TypeError("cleanroom: writeCleanroomProfile needs a pair from validateCleanroomDirs");
  const path = join(dirs.home, CLEANROOM_PROFILE_NAME);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, renderCleanroom(dirs), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}
