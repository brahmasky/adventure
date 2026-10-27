import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CleanroomPathError, validateCleanroomDirs } from "../../src/omp/cleanroom.js";
import { realpathOrSelf, writeRoots } from "../../src/omp/protected-paths.js";
import { renderCleanroom, renderSeatbelt } from "../../src/omp/seatbelt.js";
import { resolveDaemonTmpDir } from "../../src/run/daemon-tmp.js";

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

/** SBPL takes the LAST matching rule. Returns "allow" | "deny" | null for one verb and one path over subpath/literal rules. */
function lastRuleFor(profile: string, verb: "file-read*" | "file-write*", path: string): "allow" | "deny" | null {
  let verdict: "allow" | "deny" | null = null;
  for (const line of profile.split("\n")) {
    const m = /^\((allow|deny) ([^(]+?) \((subpath|literal) "((?:[^"\\]|\\.)*)"\)\)$/.exec(line);
    if (!m) { if (verb === "file-write*" && line === "(deny file-write*)") verdict = "deny"; if (verb === "file-read*" && line === "(deny file-read*)") verdict = "deny"; continue; }
    const verbs = m[2]!.split(" ");
    if (!verbs.includes(verb)) continue;
    const p = m[4]!.replace(/\\(.)/g, "$1");
    const hit = m[3] === "literal" ? path === p : path === p || path.startsWith(p.endsWith("/") ? p : p + "/");
    if (hit) verdict = m[1] as "allow" | "deny";
  }
  return verdict;
}

/**
 * tests/helpers/setup-no-real-omp.ts sets HOUGE_DAEMON_TMP_DIR for every test file, and secretPaths() reads process.env:
 * render with the DEFAULT cache root (under $HOME), which is the case the test is about. Same idiom as seatbelt.test.ts:187.
 */
function withDefaultCacheRoot<T>(fn: () => T): T {
  const saved = process.env.HOUGE_DAEMON_TMP_DIR; delete process.env.HOUGE_DAEMON_TMP_DIR;
  try { return fn(); } finally { if (saved !== undefined) process.env.HOUGE_DAEMON_TMP_DIR = saved; }
}

describe("effective policy — the planner and shell profiles deny the cache root the room lives in, even though $HOME is writable (codex blocker 1)", () => {
  const ctx = { home: "/Users/p", repo: "/Users/p/Projects/adventure", data: "/Users/p/Projects/adventure" };
  const cache = resolveDaemonTmpDir({}, ctx.home); // /Users/p/Library/Caches/houge-daemon
  const room = `${cache}/room-1`; const home = `${cache}/home-1`;

  it("denies reads and writes of the room and the home to both profiles as the LAST matching rule", () => {
    const { planner, shell } = withDefaultCacheRoot(() => renderSeatbelt(ctx));
    for (const p of [planner, shell]) for (const d of [room, home, `${room}/cj.txt`, `${home}/.curlrc`]) {
      expect(lastRuleFor(p, "file-write*", d), `write ${d}`).toBe("deny");
      expect(lastRuleFor(p, "file-read*", d), `read ${d}`).toBe("deny");
    }
  });
  it("sanity: the same evaluator says $HOME/Documents is writable and the repo is not (the evaluator is not vacuous)", () => {
    const { shell } = renderSeatbelt(ctx);
    expect(lastRuleFor(shell, "file-write*", "/Users/p/Documents/x.txt")).toBe("allow");
    expect(lastRuleFor(shell, "file-write*", "/Users/p/Projects/adventure/src/x.ts")).toBe("deny");
  });
  it("the clean room's readable set and the planner/shell EFFECTIVE write set do not intersect on the cache root", () => {
    const cr = renderCleanroom({ room, home });
    const { planner, shell } = withDefaultCacheRoot(() => renderSeatbelt(ctx));
    for (const d of [room, home]) {
      expect(lastRuleFor(cr, "file-read*", d)).toBe("allow");
      expect(lastRuleFor(planner, "file-write*", d)).toBe("deny");
      expect(lastRuleFor(shell, "file-write*", d)).toBe("deny");
    }
  });
  it("spec rule 5, over real rendered policies: every planner/shell write root (and a child of each) is unreadable in the clean room, and every clean-room system tree is unwritable by planner and shell — fixture ctx and the real $HOME", () => {
    const real = { home: process.env.HOME!, repo: process.cwd(), data: process.cwd() };
    for (const c of [ctx, real]) {
      const cache2 = resolveDaemonTmpDir({}, c.home);
      const cr = renderCleanroom({ room: `${cache2}/room-1`, home: `${cache2}/home-1` });
      const { planner, shell } = withDefaultCacheRoot(() => renderSeatbelt(c));
      for (const kind of ["planner", "shell"] as const) for (const w of writeRoots(c, kind)) for (const v of [...new Set([w, realpathOrSelf(w)])]) {
        expect(lastRuleFor(cr, "file-read*", v), `read ${v}`).toBe("deny");
        expect(lastRuleFor(cr, "file-read*", `${v}/child.txt`), `read ${v}/child.txt`).toBe("deny");
      }
      // /dev/null is left out: planner/shell write-allow it as a device sink (DEV_WRITES); nothing can be planted in it
      for (const t of ["/usr", "/bin", "/System", "/Library", "/private/etc/ssl"]) for (const prof of [planner, shell]) {
        expect(lastRuleFor(prof, "file-write*", t), `write ${t}`).toBe("deny");
        expect(lastRuleFor(prof, "file-write*", `${t}/x`), `write ${t}/x`).toBe("deny");
      }
    }
  });
});
