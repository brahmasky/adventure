import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CleanroomPathError, validateCleanroomDirs } from "../../src/omp/cleanroom.js";
import { renderCleanroom } from "../../src/omp/seatbelt.js";

const made: string[] = [];
function cacheRoot(): string { const r = mkdtempSync(join(tmpdir(), "hg-cr-")); made.push(r); return realpathSync(r); }
afterEach(() => { for (const r of made.splice(0)) rmSync(r, { recursive: true, force: true }); });

function pair(root: string): { room: string; home: string } {
  const room = join(root, "room-1"); const home = join(root, "home-1");
  mkdirSync(room); mkdirSync(home);
  return { room, home };
}
const reasonOf = (fn: () => unknown) => { try { fn(); return "ok"; } catch (e) { return e instanceof CleanroomPathError ? e.reason : `other:${String(e)}`; } };

describe("validateCleanroomDirs — the room and the home are daemon-made, empty, disjoint and under the cache root (spec §Rendering API)", () => {
  it("returns canonical paths for a fresh, empty, disjoint pair under the cache root", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    expect(validateCleanroomDirs({ room, home, cacheRoot: root })).toEqual({ room: realpathSync(room), home: realpathSync(home) });
  });
  it("rejects a relative path (a profile rendered from a relative path would allow whatever the cwd made of it)", () => {
    const root = cacheRoot(); const { home } = pair(root);
    expect(reasonOf(() => validateCleanroomDirs({ room: "room-1", home, cacheRoot: root }))).toBe("not_absolute");
  });
  it("rejects a path outside the cache root (the planner/shell profiles only deny the cache root, so anywhere else is reachable by them)", () => {
    const root = cacheRoot(); const other = cacheRoot(); const { room } = pair(root); const { home } = pair(other);
    expect(reasonOf(() => validateCleanroomDirs({ room, home, cacheRoot: root }))).toBe("outside_cache_root");
  });
  it("rejects a symlink component (the SBPL subpath would match the link, the child would read the target)", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const link = join(root, "room-link"); symlinkSync(room, link);
    expect(reasonOf(() => validateCleanroomDirs({ room: link, home, cacheRoot: root }))).toBe("symlink_component");
  });
  it("rejects room == home and either containing the other (the home must stay unwritable: writes are allowed under the room)", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    expect(reasonOf(() => validateCleanroomDirs({ room, home: room, cacheRoot: root }))).toBe("overlap");
    const inner = join(room, "home"); mkdirSync(inner);
    expect(reasonOf(() => validateCleanroomDirs({ room, home: inner, cacheRoot: root }))).toBe("overlap");
    expect(reasonOf(() => validateCleanroomDirs({ room: inner, home: room, cacheRoot: root }))).toBe("overlap");
    void home;
  });
  it("rejects a non-empty room or home (a planted ~/.curlrc in a readable home IS honoured — probe (e))", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    writeFileSync(join(home, ".curlrc"), "-H 'X-Planted: yes'");
    expect(reasonOf(() => validateCleanroomDirs({ room, home, cacheRoot: root }))).toBe("not_empty");
  });
  it("accepts the pair when given through a symlinked spelling of the cache root itself (/tmp → /private/tmp), returning canonical paths", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const viaTmp = (p: string) => p.replace(/^\/private\/tmp\//, "/tmp/");
    if (viaTmp(root) === root) return; // not a /private/tmp-based tmpdir on this machine
    expect(validateCleanroomDirs({ room: viaTmp(room), home: viaTmp(home), cacheRoot: viaTmp(root) })).toEqual({ room, home });
  });
  it("rejects a non-normalized path: `<root>/link/../room` stats one directory through the link and would check another (review finding)", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const outside = cacheRoot(); symlinkSync(outside, join(root, "link"));
    const viaLink = `${root}/link/../room-1`; // string, not join(): join() would normalize the `..` away
    expect(reasonOf(() => validateCleanroomDirs({ room: viaLink, home, cacheRoot: root }))).toBe("not_absolute");
    expect(reasonOf(() => validateCleanroomDirs({ room: `${room}/`, home, cacheRoot: root }))).toBe("not_absolute");
  });
  it("rejects a file or a missing path as the room", () => {
    const root = cacheRoot(); const { home } = pair(root);
    const f = join(root, "file"); writeFileSync(f, "x");
    expect(reasonOf(() => validateCleanroomDirs({ room: f, home, cacheRoot: root }))).toBe("not_directory");
    expect(reasonOf(() => validateCleanroomDirs({ room: join(root, "missing"), home, cacheRoot: root }))).toBe("not_directory");
  });
});

describe("renderCleanroom — SBPL for the sealed room (spec §Required SBPL facts)", () => {
  const dirs = { room: "/Users/p/Library/Caches/houge-daemon/room-1", home: "/Users/p/Library/Caches/houge-daemon/home-1" };
  const lines = () => renderCleanroom(dirs).split("\n").filter(Boolean);

  it("opens with the three-line floor: version, allow default, deny every read", () => {
    expect(lines().slice(0, 3)).toEqual(["(version 1)", "(allow default)", "(deny file-read*)"]);
  });
  it("re-allows reads only in the system trees, /private/etc/ssl (not all of /private/etc — B30), /dev/null, the room and the home", () => {
    const p = renderCleanroom(dirs);
    for (const s of ['(subpath "/usr")', '(subpath "/bin")', '(subpath "/System")', '(subpath "/Library")', '(subpath "/private/etc/ssl")',
      '(literal "/dev/null")', `(subpath "${dirs.room}")`, `(subpath "${dirs.home}")`]) expect(p).toContain(`(allow file-read* ${s})`);
    expect(p).not.toContain('(subpath "/private/etc")');
    expect(p).toContain('(allow file-read-data (literal "/"))');
    const allows = lines().filter((l) => l.startsWith("(allow file-read* "));
    expect(allows).toHaveLength(9); // "/" literal + 5 system trees + /dev/null + room + home
  });
  it("grants metadata on /etc /var /tmp and on every ancestor of the room and the home (DNS and getcwd need them — probe items 2 and 3)", () => {
    const p = renderCleanroom(dirs);
    for (const d of ["/etc", "/var", "/tmp", "/Users", "/Users/p", "/Users/p/Library", "/Users/p/Library/Caches", "/Users/p/Library/Caches/houge-daemon"])
      expect(p).toContain(`(allow file-read-metadata (literal "${d}"))`);
  });
  it("denies every write, then re-allows only the room and /dev/null — never the home", () => {
    const l = lines();
    const deny = l.indexOf("(deny file-write*)");
    expect(deny).toBeGreaterThan(2);
    const writes = l.filter((x) => x.startsWith("(allow file-write*"));
    expect(writes).toEqual([`(allow file-write* (subpath "${dirs.room}"))`, '(allow file-write* (literal "/dev/null"))']);
    expect(l.indexOf(writes[0]!)).toBeGreaterThan(deny);
  });
  it("denies the exec and IPC escape hatches: launchctl, security, the python3 install shim, launchd lookup, signals to others", () => {
    const p = renderCleanroom(dirs);
    for (const s of ['(deny process-exec (literal "/bin/launchctl"))', '(deny process-exec (literal "/usr/bin/security"))',
      '(deny process-exec (literal "/usr/bin/python3"))', '(deny mach-lookup (global-name "com.apple.launchd"))', "(deny signal (target others))"])
      expect(p).toContain(s);
  });
  it("is deterministic for the same pair and escapes quotes in a path", () => {
    expect(renderCleanroom(dirs)).toBe(renderCleanroom(dirs));
    const odd = { room: '/Users/p/Library/Caches/houge-daemon/r"1', home: "/Users/p/Library/Caches/houge-daemon/h-1" };
    expect(renderCleanroom(odd)).toContain('(allow file-write* (subpath "/Users/p/Library/Caches/houge-daemon/r\\"1"))');
  });
});
