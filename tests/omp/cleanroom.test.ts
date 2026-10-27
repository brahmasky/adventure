import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLEANROOM_PROFILE_NAME, type CleanroomDirs, CleanroomPathError, cleanroomEnv, cleanroomRoot, validateCleanroomDirs, writeCleanroomProfile } from "../../src/omp/cleanroom.js";
import { realpathOrSelf, writeRoots } from "../../src/omp/protected-paths.js";
import { CLEANROOM_EXEC_ALLOW, renderCleanroom, renderSeatbelt, sbplRegexLiteral } from "../../src/omp/seatbelt.js";
import { resolveDaemonTmpDir } from "../../src/run/daemon-tmp.js";

vi.setConfig({ testTimeout: 30_000 });

const made: string[] = [];
/** A temp daemon tmp root holding `cleanroom/` (the only place a pair may live), canonical. */
function cacheRoot(): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "hg-cr-"))); made.push(r);
  mkdirSync(join(r, "cleanroom"));
  return r;
}
afterEach(() => { for (const r of made.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** The validator derives its root from HOUGE_DAEMON_TMP_DIR (no caller-supplied root): point it at `root` for fn. */
function withCacheRoot<T>(root: string, fn: () => T): T {
  const saved = process.env.HOUGE_DAEMON_TMP_DIR; process.env.HOUGE_DAEMON_TMP_DIR = root;
  try { return fn(); } finally { if (saved === undefined) delete process.env.HOUGE_DAEMON_TMP_DIR; else process.env.HOUGE_DAEMON_TMP_DIR = saved; }
}

function pair(root: string): { room: string; home: string } {
  const room = join(root, "cleanroom", "room-1"); const home = join(root, "cleanroom", "home-1");
  mkdirSync(room); mkdirSync(home);
  return { room, home };
}
const reasonOf = (fn: () => unknown) => { try { fn(); return "ok"; } catch (e) { return e instanceof CleanroomPathError ? e.reason : `other:${String(e)}`; } };
const validateUnder = (root: string, input: { room: string; home: string }) => reasonOf(() => withCacheRoot(root, () => validateCleanroomDirs(input)));
const plain = (d: { room: string; home: string }) => ({ room: d.room, home: d.home });

describe("validateCleanroomDirs — the room and the home are daemon-made, empty, disjoint and under the cache root (spec §Rendering API)", () => {
  it("returns canonical paths for a fresh, empty, disjoint pair under <daemon tmp>/cleanroom, frozen", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const d = withCacheRoot(root, () => validateCleanroomDirs({ room, home }));
    expect(plain(d)).toEqual({ room: realpathSync(room), home: realpathSync(home) });
    expect(Object.isFrozen(d)).toBe(true);
    expect(cleanroomRoot({ HOUGE_DAEMON_TMP_DIR: root }, "/nowhere")).toBe(join(root, "cleanroom"));
  });
  it("only a validated pair reaches the writer (a literal pair is a type error)", () => {
    const fake = { room: "/x/room", home: "/x/home" };
    // @ts-expect-error a plain RoomPair is not a CleanroomDirs
    expect(() => writeCleanroomProfile(fake)).toThrow();
  });
  it("rejects a relative path (a profile rendered from a relative path would allow whatever the cwd made of it)", () => {
    const root = cacheRoot(); const { home } = pair(root);
    expect(validateUnder(root, { room: "room-1", home })).toBe("not_absolute");
  });
  it("rejects a path outside the cache root (the planner/shell profiles only deny the cache root, so anywhere else is reachable by them)", () => {
    const root = cacheRoot(); const other = cacheRoot(); const { room } = pair(root); const { home } = pair(other);
    expect(validateUnder(root, { room, home })).toBe("outside_cache_root");
  });
  it("the root is derived, never supplied: a pair under os.tmpdir() is rejected while HOUGE_DAEMON_TMP_DIR points elsewhere", () => {
    const loose = realpathSync(mkdtempSync(join(tmpdir(), "hg-loose-"))); made.push(loose);
    const room = join(loose, "room-1"); const home = join(loose, "home-1"); mkdirSync(room); mkdirSync(home);
    expect(validateUnder(cacheRoot(), { room, home })).toBe("outside_cache_root");
  });
  it("rejects the cleanroom root itself, a look-alike sibling (`cleanroom-evil`), and any pair when the root does not exist", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    expect(validateUnder(root, { room: join(root, "cleanroom"), home })).toBe("outside_cache_root");
    const evil = join(root, "cleanroom-evil", "x"); mkdirSync(evil, { recursive: true });
    expect(validateUnder(root, { room: evil, home })).toBe("outside_cache_root");
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "hg-bare-"))); made.push(bare); // no cleanroom/ inside
    let err: unknown; try { withCacheRoot(bare, () => validateCleanroomDirs({ room, home })); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CleanroomPathError);
    expect(err).toMatchObject({ reason: "outside_cache_root", path: join(bare, "cleanroom") }); // a missing root, not a raw ENOENT
  });
  it("rejects a symlink component: the room itself, the home itself, or an intermediate directory (the SBPL subpath would match the link, the child would read the target)", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const link = join(root, "cleanroom", "room-link"); symlinkSync(room, link);
    expect(validateUnder(root, { room: link, home })).toBe("symlink_component");
    const homeLink = join(root, "cleanroom", "home-link"); symlinkSync(home, homeLink);
    expect(validateUnder(root, { room, home: homeLink })).toBe("symlink_component");
    const real = join(root, "cleanroom", "real"); mkdirSync(join(real, "room"), { recursive: true });
    symlinkSync(real, join(root, "cleanroom", "sub"));
    expect(validateUnder(root, { room: join(root, "cleanroom", "sub", "room"), home })).toBe("symlink_component");
  });
  it("rejects room == home and either containing the other (the home must stay unwritable: writes are allowed under the room)", () => {
    const root = cacheRoot(); const { room } = pair(root);
    expect(validateUnder(root, { room, home: room })).toBe("overlap");
    const inner = join(room, "home"); mkdirSync(inner);
    expect(validateUnder(root, { room, home: inner })).toBe("overlap");
    expect(validateUnder(root, { room: inner, home: room })).toBe("overlap");
  });
  it("rejects a case alias of the room as the home: on APFS `ROOM-1` IS `room-1`, so string comparison saw two dirs", () => {
    const root = cacheRoot(); const { room } = pair(root);
    const alias = join(root, "cleanroom", "ROOM-1");
    if (!existsSync(alias)) expect.fail("case-sensitive volume: this test needs the default case-insensitive APFS");
    expect(validateUnder(root, { room, home: alias })).toBe("overlap");
    expect(validateUnder(root, { room: alias, home: room })).toBe("overlap");
  });
  it("rejects a non-empty room or home (a planted ~/.curlrc in a readable home IS honoured — probe (e))", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    writeFileSync(join(home, ".curlrc"), "-H 'X-Planted: yes'");
    expect(validateUnder(root, { room, home })).toBe("not_empty");
    rmSync(join(home, ".curlrc")); writeFileSync(join(room, "planted"), "x");
    expect(validateUnder(root, { room, home })).toBe("not_empty");
  });
  it("accepts the pair given through a symlinked spelling of the root (/var → /private/var), returning canonical paths", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const viaVar = (p: string) => p.replace(/^\/private\/var\//, "/var/");
    expect(viaVar(root), "tmpdir is under /private/var on macOS: the alias must differ or the test is vacuous").not.toBe(root);
    const d = withCacheRoot(viaVar(root), () => validateCleanroomDirs({ room: viaVar(room), home: viaVar(home) }));
    expect(plain(d)).toEqual({ room, home });
  });
  it("rejects a non-normalized path: `<root>/link/../room` stats one directory through the link and would check another", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const outside = cacheRoot(); symlinkSync(outside, join(root, "cleanroom", "link"));
    const viaLink = `${root}/cleanroom/link/../room-1`; // string, not join(): join() would normalize the `..` away
    expect(validateUnder(root, { room: viaLink, home })).toBe("not_absolute");
    expect(validateUnder(root, { room: `${room}/`, home })).toBe("not_absolute");
  });
  it("rejects a component that is a symlink to the cleanroom root itself, and a cleanroom root that is itself a symlink", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const cr = join(root, "cleanroom"); symlinkSync(cr, join(cr, "self")); // self -> the root: lstat must win over the inode match
    expect(validateUnder(root, { room: join(cr, "self", "room-1"), home })).toBe("symlink_component");
    const other = cacheRoot(); rmSync(join(other, "cleanroom"), { recursive: true }); symlinkSync(cr, join(other, "cleanroom"));
    expect(validateUnder(other, { room, home })).toBe("symlink_component"); // rooms would sit outside `other`'s deny rule
  });
  it("rejects a file or a missing path as the room", () => {
    const root = cacheRoot(); const { home } = pair(root);
    const f = join(root, "cleanroom", "file"); writeFileSync(f, "x");
    expect(validateUnder(root, { room: f, home })).toBe("not_directory");
    expect(validateUnder(root, { room: join(root, "cleanroom", "missing"), home })).toBe("not_directory");
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
    for (const s of ['(subpath "/usr")', '(subpath "/bin")', '(subpath "/System")', '(subpath "/private/etc/ssl")',
      '(literal "/dev/null")', `(subpath "${dirs.room}")`, `(subpath "${dirs.home}")`]) expect(p).toContain(`(allow file-read* ${s})`);
    expect(p).not.toContain('(subpath "/private/etc")');
    // /Library holds world-writable trees (/Library/Caches …): a child could read what another planted there
    expect(p).not.toContain('(allow file-read* (subpath "/Library"))');
    expect(p).toContain('(allow file-read-data (literal "/"))');
    const allows = lines().filter((l) => l.startsWith("(allow file-read* "));
    expect(allows).toHaveLength(11); // "/" literal + 4 system trees + /dev/null + 3 time-zone paths + room + home
  });
  it("denies /usr/local AFTER the /usr allow: Homebrew's tree is user-writable inside a readable system root, and SBPL takes the last match", () => {
    const l = lines();
    const allowUsr = l.indexOf('(allow file-read* (subpath "/usr"))');
    const denyLocal = l.indexOf('(deny file-read* (subpath "/usr/local"))');
    expect(allowUsr).toBeGreaterThan(2);
    expect(denyLocal).toBeGreaterThan(allowUsr);
  });
  it("grants metadata on / /etc /var /tmp and on every ancestor of the room and the home (DNS and getcwd need them — probe items 2 and 3)", () => {
    const p = renderCleanroom(dirs);
    for (const d of ["/", "/etc", "/var", "/tmp", "/Users", "/Users/p", "/Users/p/Library", "/Users/p/Library/Caches", "/Users/p/Library/Caches/houge-daemon"])
      expect(p).toContain(`(allow file-read-metadata (literal "${d}"))`);
  });
  it("renders both spellings of a symlinked path (/tmp and /private/tmp): Seatbelt matches the canonical one, callers may hold either", () => {
    const two = { room: "/tmp/hg-x/room", home: "/tmp/hg-x/home" }; // does not exist: realpathOrSelf resolves /tmp only
    const p = renderCleanroom(two);
    for (const v of ["/tmp/hg-x", "/private/tmp/hg-x"]) {
      expect(p).toContain(`(allow file-read* (subpath "${v}/room"))`);
      expect(p).toContain(`(allow file-read* (subpath "${v}/home"))`);
      expect(p).toContain(`(allow file-write* (regex #"^${sbplRegexLiteral(`${v}/room`)}/"))`);
      expect(p).not.toContain(`(allow file-write* (subpath "${v}/home"))`);
    }
  });
  it("denies every write, then re-allows only the room and /dev/null — never the home", () => {
    const l = lines();
    const deny = l.indexOf("(deny file-write*)");
    expect(deny).toBeGreaterThan(2);
    const writes = l.filter((x) => x.startsWith("(allow file-write*"));
    expect(writes).toEqual([`(allow file-write* (regex #"^${dirs.room}/"))`, '(allow file-write* (literal "/dev/null"))']);
    expect(l.indexOf(writes[0]!)).toBeGreaterThan(deny);
  });
  it("denies the exec and IPC escape hatches: launchctl, security, the python3 install shim, launchd lookup, signals to others", () => {
    const p = renderCleanroom(dirs);
    for (const s of ['(deny process-exec (literal "/bin/launchctl"))', '(deny process-exec (literal "/usr/bin/security"))',
      '(deny process-exec (literal "/usr/bin/python3"))', '(deny mach-lookup (global-name "com.apple.launchd"))', "(deny signal (target others))"])
      expect(p).toContain(s);
  });
  it("P8: denies every local network form, UDP, Unix sockets, listening and all Mach lookups — DNS keeps its one socket", () => {
    const p = renderCleanroom(dirs);
    expect(p).toContain("(deny mach-lookup)");
    // the three families sit in one rule and each names its family: a bare `(remote ip …)` stops matching IPv4
    // loopback as soon as any ip6 rule exists (measured 2026-10-28), so the grammar test forbids it outright
    expect(p).toContain('(deny network-outbound (remote ip4 "localhost:*") (remote ip6 "*:*") (remote udp4 "*:*"))');
    expect(p).not.toMatch(/\(remote ip "/);
    expect(p).toContain("(deny network-outbound (remote unix-socket))");
    expect(lines().filter((l) => l.startsWith("(allow network-outbound"))).toEqual(['(allow network-outbound (literal "/private/var/run/mDNSResponder"))']);
    expect(p).toContain("(deny network-inbound)");
    expect(p).toContain("(deny network-bind)");
    const mach = lines().indexOf("(deny mach-lookup)"); const net = lines().findIndex((l) => l.startsWith("(deny network-outbound (remote ip4"));
    expect(mach).toBeGreaterThan(0); expect(net).toBeGreaterThan(mach);
  });
  it("the room's clock is the host's: localtime and the zoneinfo trees are readable (root-owned, outside every write set)", () => {
    const p = renderCleanroom(dirs);
    for (const s of ['(literal "/private/etc/localtime")', '(subpath "/private/var/db/timezone")', '(subpath "/usr/share/zoneinfo")']) expect(p).toContain(`(allow file-read* ${s})`);
    for (const d of ["/private", "/private/var", "/private/var/db"]) expect(p).toContain(`(allow file-read-metadata (literal "${d}"))`);
  });
  it("exec allowlist: process-exec* is denied by default and re-allowed only for the named binaries, each of which exists on this Mac", () => {
    const l = lines();
    expect(l.indexOf("(deny process-exec*)")).toBeGreaterThan(l.indexOf('(deny process-exec (literal "/usr/bin/python3"))'));
    const allow = l.find((x) => x.startsWith("(allow process-exec* "))!;
    expect(l.indexOf(allow)).toBeGreaterThan(l.indexOf("(deny process-exec*)"));
    for (const b of CLEANROOM_EXEC_ALLOW) expect(allow, b).toContain(`(literal "${b}")`);
    for (const b of ["/bin/bash", "/usr/bin/env", "/usr/bin/nice", "/usr/bin/curl", "/bin/date", "/bin/test", "/bin/pwd"]) expect(CLEANROOM_EXEC_ALLOW).toContain(b);
    for (const b of ["/usr/bin/perl", "/usr/bin/python3", "/usr/bin/ruby", "/usr/bin/script", "/usr/bin/screen", "/usr/bin/osascript", "/usr/bin/nc", "/usr/bin/openssl"]) expect(allow, b).not.toContain(`"${b}"`); // never in the allow line (python3 appears only in its deny)
    if (process.platform === "darwin") for (const b of CLEANROOM_EXEC_ALLOW) expect(existsSync(b), b).toBe(true); // /usr/bin/test does not exist here; /bin/test does
  });
  it("the room is writable inside but the room path itself is not: an orphan cannot re-create the room after teardown", () => {
    const p = renderCleanroom(dirs);
    expect(p).toContain(`(allow file-write* (regex #"^${dirs.room}/"))`);
    expect(p).not.toContain(`(allow file-write* (subpath "${dirs.room}"))`);
    expect(lastRuleFor(p, "file-write*", `${dirs.room}/cj.txt`)).toBe("allow");
    expect(lastRuleFor(p, "file-write*", dirs.room)).toBe("deny");
    expect(lastRuleFor(p, "file-write*", `${dirs.room}-evil/x`)).toBe("deny");
  });
  it("is deterministic for the same pair, and a room path with a quote or backslash is refused (SBPL's regex literal has no escape for them)", () => {
    expect(renderCleanroom(dirs)).toBe(renderCleanroom(dirs));
    const odd = { room: '/Users/p/Library/Caches/houge-daemon/r"1', home: '/Users/p/Library/Caches/houge-daemon/home-1' };
    expect(() => renderCleanroom(odd)).toThrow(/quote|backslash/);
  });
  it("escapes quotes and backslashes in the read rules of the home path", () => {
    const odd = { room: "/Users/p/Library/Caches/houge-daemon/room-1", home: '/Users/p/Library/Caches/houge-daemon/h"\\1' };
    expect(renderCleanroom(odd)).toContain('(allow file-read* (subpath "/Users/p/Library/Caches/houge-daemon/h\\"\\\\1"))');
  });
});

/** Does one SBPL filter match path? literal / subpath / regex only; APFS is case-insensitive, so matching is too. */
function filterHits(filter: string, path: string, line: string): boolean {
  const q = /^\((subpath|literal) "((?:[^"\\]|\\.)*)"\)$/.exec(filter);
  if (q) {
    const p = q[2]!.replace(/\\(.)/g, "$1").toLowerCase(); const x = path.toLowerCase();
    return q[1] === "literal" ? x === p : x === p || x.startsWith(p.endsWith("/") ? p : p + "/");
  }
  const r = /^\(regex #"((?:[^"\\]|\\.)*)"\)$/.exec(filter);
  if (r) return new RegExp(r[1]!, "i").test(path);
  throw new Error(`lastRuleFor: unknown filter shape on a file rule: ${line}`); // a new rule shape fails loudly, never skipped
}

/** SBPL takes the LAST matching rule. Returns "allow" | "deny" | null for one verb and one path. */
function lastRuleFor(profile: string, verb: "file-read*" | "file-write*", path: string): "allow" | "deny" | null {
  let verdict: "allow" | "deny" | null = null;
  for (const line of profile.split("\n")) {
    const m = /^\((allow|deny) ([^()"]+?)(?: (\(.*\)))?\)$/.exec(line);
    const fileRule = /\bfile-(read|write)\*/.test(line);
    if (!m) { if (fileRule) throw new Error(`lastRuleFor: unparsed file rule: ${line}`); continue; }
    if (!m[2]!.split(" ").includes(verb)) continue; // signal / process-exec / mach-lookup / metadata-only lines
    if (m[3] === undefined || filterHits(m[3], path, line)) verdict = m[1] as "allow" | "deny";
  }
  return verdict;
}

describe("lastRuleFor — the evaluator the effective-policy tests rest on is itself right", () => {
  const profile = [
    "(version 1)",
    "(deny file-read*)",
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (literal "/"))',
    '(deny file-read* (subpath "/users/p/x"))',
    '(allow file-read* (literal "/q\\"uote"))',
    '(allow file-read* (regex #"^/Users/p/x/ok$"))',
    '(deny file-write* (subpath "/usr"))'
  ].join("\n");

  it("subpath is component-bounded, literal is exact, an escaped quote is unescaped, matching is case-insensitive", () => {
    expect(lastRuleFor(profile, "file-read*", "/usr/bin/curl")).toBe("allow");
    expect(lastRuleFor(profile, "file-read*", "/usr2/x")).toBe("deny");
    expect(lastRuleFor(profile, "file-read*", "/")).toBe("allow");
    expect(lastRuleFor(profile, "file-read*", "/etc")).toBe("deny");
    expect(lastRuleFor(profile, "file-read*", '/q"uote')).toBe("allow");
    expect(lastRuleFor(profile, "file-read*", "/Users/P/X/secret")).toBe("deny");
  });
  it("a regex allow after a subpath deny re-opens exactly the matching path; the verb filter keeps write rules off reads", () => {
    expect(lastRuleFor(profile, "file-read*", "/Users/p/x/ok")).toBe("allow");
    expect(lastRuleFor(profile, "file-read*", "/Users/p/x/ok2")).toBe("deny");
    expect(lastRuleFor(profile, "file-write*", "/usr/bin/curl")).toBe("deny");
    expect(lastRuleFor(profile, "file-write*", "/tmp/x")).toBeNull();
  });
  it("order matters: reversing two rules flips the verdict", () => {
    const a = '(allow file-read* (subpath "/a"))'; const d = '(deny file-read* (subpath "/a"))';
    expect(lastRuleFor([a, d].join("\n"), "file-read*", "/a/b")).toBe("deny");
    expect(lastRuleFor([d, a].join("\n"), "file-read*", "/a/b")).toBe("allow");
  });
  it("throws on a file rule whose filter it does not understand, instead of skipping it", () => {
    expect(() => lastRuleFor('(deny file-read* (vnode-type SYMLINK))', "file-read*", "/x")).toThrow(/unknown filter/);
    expect(() => lastRuleFor('(deny file-write* (require-any (literal "/a") (literal "/b")))', "file-write*", "/x")).toThrow(/unknown filter/);
  });
});

/**
 * tests/helpers/setup-no-real-omp.ts sets HOUGE_DAEMON_TMP_DIR for every test file, and secretPaths() reads process.env:
 * render with the DEFAULT cache root (under $HOME), which is the case the test is about. Same idiom as seatbelt.test.ts:187.
 */
function withDefaultCacheRoot<T>(fn: () => T): T {
  const saved = process.env.HOUGE_DAEMON_TMP_DIR; delete process.env.HOUGE_DAEMON_TMP_DIR;
  try { return fn(); } finally { if (saved !== undefined) process.env.HOUGE_DAEMON_TMP_DIR = saved; }
}

describe("effective policy — the planner and shell profiles deny the cache root the room lives in, even though $HOME is writable", () => {
  const ctx = { home: "/Users/p", repo: "/Users/p/Projects/adventure", data: "/Users/p/Projects/adventure" };
  const cache = resolveDaemonTmpDir({}, ctx.home); // /Users/p/Library/Caches/houge-daemon
  const room = `${cache}/cleanroom/room-1`; const home = `${cache}/cleanroom/home-1`;

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
    const { planner } = withDefaultCacheRoot(() => renderSeatbelt(ctx));
    expect(lastRuleFor(planner, "file-write*", join(ctx.data, "omp", "sessions", "s.json"))).toBe("allow");
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
      const cr = renderCleanroom({ room: `${cache2}/cleanroom/room-1`, home: `${cache2}/cleanroom/home-1` });
      const { planner, shell } = withDefaultCacheRoot(() => renderSeatbelt(c));
      for (const kind of ["planner", "shell"] as const) for (const w of writeRoots(c, kind)) for (const v of [...new Set([w, realpathOrSelf(w)])]) {
        expect(lastRuleFor(cr, "file-read*", v), `read ${v}`).toBe("deny");
        expect(lastRuleFor(cr, "file-read*", `${v}/child.txt`), `read ${v}/child.txt`).toBe("deny");
      }
      // /dev/null is left out: planner/shell write-allow it as a device sink (DEV_WRITES); nothing can be planted in it
      for (const t of ["/usr", "/bin", "/System", "/private/etc/ssl"]) for (const prof of [planner, shell]) {
        expect(lastRuleFor(prof, "file-write*", t), `write ${t}`).toBe("deny");
        expect(lastRuleFor(prof, "file-write*", `${t}/x`), `write ${t}/x`).toBe("deny");
      }
    }
  });
});

/** bash exports these three itself under `env -i`; they carry nothing from the daemon (verified: `env -i … bash -c env`). */
const BASH_OWN = ["PWD", "SHLVL", "_"];

/** A validated pair under a temp cache root, its profile written, and a runner that launches like Slice 1 will: env -i, cwd = room. */
function sealedRoom() {
  const root = cacheRoot(); const { room, home } = pair(root);
  const dirs = withCacheRoot(root, () => validateCleanroomDirs({ room, home }));
  const profile = writeCleanroomProfile(dirs);
  const env = cleanroomEnv(dirs);
  const run = (script: string) => spawnSync("/usr/bin/env", ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    "/usr/bin/sandbox-exec", "-f", profile, "/bin/bash", "-c", script], { cwd: dirs.room, encoding: "utf8" });
  return { root, dirs, profile, env, run };
}

describe("writeCleanroomProfile / cleanroomEnv", () => {
  it("refuses a pair that did not come from validateCleanroomDirs (the type brand is erased at runtime; a plain-JS caller must fail here, not write a profile)", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    expect(() => writeCleanroomProfile({ room, home } as unknown as CleanroomDirs)).toThrow(/validateCleanroomDirs/);
    expect(readdirSync(home)).toEqual([]);
  });
  it("writes the sidecar into the home at 0600 and returns its path; the home then holds exactly that file (no temp left behind)", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const dirs = withCacheRoot(root, () => validateCleanroomDirs({ room, home }));
    const p = writeCleanroomProfile(dirs);
    expect(p).toBe(join(dirs.home, CLEANROOM_PROFILE_NAME));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, "utf8")).toBe(renderCleanroom(dirs));
    expect(readdirSync(dirs.home)).toEqual([CLEANROOM_PROFILE_NAME]);
  });
  it("replaces a stale 0644 sidecar planted after validation with a fresh 0600 render (rename, not an in-place write that keeps the old mode)", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const dirs = withCacheRoot(root, () => validateCleanroomDirs({ room, home }));
    const stale = join(dirs.home, CLEANROOM_PROFILE_NAME); writeFileSync(stale, "(version 1)\n(allow default)\n", { mode: 0o644 });
    expect(statSync(stale).mode & 0o777).toBe(0o644);
    writeCleanroomProfile(dirs);
    expect(statSync(stale).mode & 0o777).toBe(0o600);
    expect(readFileSync(stale, "utf8")).toBe(renderCleanroom(dirs));
    expect(readdirSync(dirs.home)).toEqual([CLEANROOM_PROFILE_NAME]);
  });
  it("the fixed environment is exactly the six names from the spec, nothing inherited", () => {
    const dirs = { room: "/Users/p/Library/Caches/houge-daemon/r", home: "/Users/p/Library/Caches/houge-daemon/h" };
    expect(cleanroomEnv(dirs)).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", HOME: dirs.home, CURL_HOME: dirs.home,
      XDG_CONFIG_HOME: dirs.home, TMPDIR: dirs.room });
  });
});

describe("sbplRegexLiteral", () => {
  it("is exact: a room path with regex punctuation matches itself and not a sibling that differs only there (regexPath widens on purpose for denies; an allow may not)", () => {
    const room = "/Users/p/Library/Caches/h.d+(1)[a]/cleanroom/room-1";
    const rule = `(allow file-write* (regex #"^${sbplRegexLiteral(room)}/"))`;
    expect(lastRuleFor(rule, "file-write*", `${room}/f`)).toBe("allow");
    expect(lastRuleFor(rule, "file-write*", "/Users/p/Library/Caches/hXd+(1)[a]/cleanroom/room-1/f")).toBeNull();
    expect(lastRuleFor(rule, "file-write*", "/Users/p/Library/Caches/h.dd(1)a/cleanroom/room-1/f")).toBeNull();
    expect(() => sbplRegexLiteral('/x/q"uote')).toThrow(/quote|backslash/);
  });
});

describe.runIf(process.platform === "darwin")("live clean room — the properties the probe established, re-proven on this Mac", () => {
  it("positive controls: a binary starts (dyld reads /), getcwd works (ancestor metadata), the room is writable, the home readable", () => {
    const { run, dirs } = sealedRoom();
    const r = run(`/bin/echo ok && /bin/pwd && /bin/echo x > f && /bin/cat f && /bin/ls -a "${dirs.home}"`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/getcwd/);
    expect(r.stdout).toContain(dirs.room);
  });
  it("the child sees the six fixed variables and bash's own three with known values (PWD = room, SHLVL = 1, _ = env) — nothing from the daemon", () => {
    const { run, dirs, env } = sealedRoom();
    const seen = Object.fromEntries(run("/usr/bin/env").stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    expect(Object.keys(seen).sort()).toEqual([...Object.keys(env), ...BASH_OWN].sort());
    expect(seen).toMatchObject({ ...env, PWD: dirs.room, SHLVL: "1", _: "/usr/bin/env" });
  });
  it("cannot read /private/etc/hosts, a planted file in os.tmpdir(), or a planted file under /private/tmp (B30 probes), each proven to exist", () => {
    const { run } = sealedRoom();
    const planted = [join(tmpdir(), `hg-planted-${process.pid}`), `/private/tmp/hg-planted-${process.pid}`];
    for (const f of planted) writeFileSync(f, "X-Planted: yes");
    try {
      for (const f of ["/private/etc/hosts", ...planted]) {
        expect(existsSync(f), `${f} exists`).toBe(true); // a missing file would also fail to read: prove the plant
        const r = run(`/bin/cat "${f}"`); expect(r.status, f).not.toBe(0); expect(r.stderr, f).toMatch(/Operation not permitted/);
      }
      // curl 8.7.1 (this Mac): an unreadable @file is exit 26 at option parsing, BEFORE any connect; a readable one
      // reaches the connect and fails with 7 (nothing listens on :1). The control proves the oracle distinguishes.
      expect(run("/bin/echo 'X-Ok: 1' > ok.txt && /usr/bin/curl -sS --max-time 2 -H @ok.txt http://127.0.0.1:1/").status).toBe(7);
      for (const f of ["/private/etc/hosts", ...planted]) {
        expect(run(`/usr/bin/curl -sS --max-time 2 -H @"${f}" http://127.0.0.1:1/`).status, `-H @${f}`).toBe(26);
        expect(run(`/usr/bin/curl -sS --max-time 2 --data-binary @"${f}" http://127.0.0.1:1/`).status, `-d @${f}`).toBe(26);
      }
    } finally { for (const f of planted) rmSync(f, { force: true }); }
  });
  it("curl config discovery: a .curlrc planted in the room (cwd, writable) is ignored; one in the readable home IS honoured — which is why the home must be empty and unwritable (probe (e))", () => {
    const { run, dirs } = sealedRoom();
    // no URL on the command line: exit 2 "no URL specified" unless a .curlrc supplied one (then connect → 7)
    expect(run("/bin/echo 'url = \"http://127.0.0.1:1/\"' > .curlrc && /usr/bin/curl -sS --max-time 2").status).toBe(2);
    writeFileSync(join(dirs.home, ".curlrc"), 'url = "http://127.0.0.1:1/"\n'); // daemon-side plant: what validation forbids
    expect(run("/usr/bin/curl -sS --max-time 2").status).toBe(7);
  });
  it("a symlink out of the room is blocked for reads, and the home cannot be written (no planted .curlrc)", () => {
    const { run, dirs, root } = sealedRoom();
    const outside = join(root, "outside.txt"); writeFileSync(outside, "secret");
    symlinkSync(outside, join(dirs.room, "link"));
    const r = run("/bin/cat link"); expect(r.status).not.toBe(0); expect(r.stderr).toMatch(/Operation not permitted/);
    const w = run(`/bin/echo planted > "${dirs.home}/.curlrc"`); expect(w.status).not.toBe(0); expect(w.stderr).toMatch(/Operation not permitted/);
    expect(existsSync(join(dirs.home, ".curlrc"))).toBe(false);
  });
  it("/Library and /usr/local cannot be listed (user- or world-writable trees inside the system roots — review B), each proven to exist", () => {
    const { run } = sealedRoom();
    for (const d of ["/Library", "/usr/local"]) {
      expect(existsSync(d), `${d} exists`).toBe(true);
      const r = run(`/bin/ls ${d}`); expect(r.status, d).not.toBe(0); expect(r.stderr, d).toMatch(/Operation not permitted/);
    }
  });
  it("the escape hatches are closed: launchctl, security and the python3 shim cannot exec", () => {
    const { run } = sealedRoom();
    for (const cmd of ["/bin/launchctl list", "/usr/bin/security help", "/usr/bin/python3 -c 1"]) {
      const r = run(cmd);
      expect(r.status, cmd).not.toBe(0);
      expect(r.stderr, cmd).toMatch(/Operation not permitted/);
    }
  });
  /**
   * A dual-stack HTTP listener on an ephemeral port, in a CHILD process: the control curl and `run` use spawnSync, which
   * blocks this event loop, so an in-process server could never answer the control (the test would then deadlock to 000).
   */
  async function localListener(): Promise<{ port: number; close: () => Promise<void> }> {
    const c = spawn(process.execPath, ["-e", 'const s=require("http").createServer((q,r)=>r.end("local"));s.listen(0,"::",()=>console.log(s.address().port))'], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<number>((r) => c.stdout!.once("data", (d) => r(Number(String(d).trim()))));
    return { port, close: async () => { c.kill(); } };
  }
  it("P8 live: a local HTTP listener is unreachable as 127.0.0.1, localhost, [::1], [::ffff:127.0.0.1] and 0.0.0.0, while the control (unsandboxed) reaches it", async () => {
    const { port, close } = await localListener();
    try {
      const ctl = spawnSync("/usr/bin/curl", ["-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${port}/`], { encoding: "utf8" });
      expect(ctl.stdout).toBe("200"); // the listener works: a denied connect below is the sandbox, not a dead port
      const { run } = sealedRoom();
      for (const host of ["127.0.0.1", "localhost", "[::1]", "[::ffff:127.0.0.1]", "0.0.0.0"]) {
        const r = run(`/usr/bin/curl -s -m 3 -o /dev/null -w '%{http_code}' http://${host}:${port}/`);
        expect(r.status, host).toBe(7); expect(r.stdout, host).toBe("000");
      }
    } finally { await close(); }
  });
  it("P8 live: a UDP datagram to loopback is refused through bash's own /dev/udp (no nc: the allowlist denies it, so a probe through it would pass for the wrong reason)", () => {
    const { run } = sealedRoom();
    const r = run("exec 3<>/dev/udp/127.0.0.1/9 && echo sent >&3 && echo UDP-SENT");
    expect(r.stdout).not.toContain("UDP-SENT"); expect(r.stderr).toMatch(/Operation not permitted/);
  });
  it("P8 live: a Unix socket in the room is unreachable (the bridge sockets are Unix sockets); the unsandboxed control reaches it", async () => {
    const { run, dirs } = sealedRoom();
    const sock = join(dirs.room, "t.sock");
    const c = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>r.end("u")).listen(${JSON.stringify(sock)},()=>console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((r) => c.stdout!.once("data", () => r()));
    try {
      expect(spawnSync("/usr/bin/curl", ["-s", "-m", "3", "--unix-socket", sock, "http://x/"], { encoding: "utf8" }).stdout).toBe("u");
      expect(run(`/usr/bin/curl -s -m 3 --unix-socket "${sock}" http://x/`).status).toBe(7);
    } finally { c.kill(); }
  });
  it("P8 live: HTTPS to a remote host still works and a bad certificate is still rejected — TLS needs no Mach lookup (skipped offline)", () => {
    const { run } = sealedRoom();
    const ctl = spawnSync("/usr/bin/curl", ["-s", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com/"], { encoding: "utf8" });
    if (ctl.stdout !== "200") return; // offline: the gate owns the network verdict (INCONCLUSIVE there), this test must not fail a laptop
    expect(run("/usr/bin/curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com/").stdout).toBe("200");
    expect(run("/usr/bin/curl -s -m 8 -o /dev/null https://expired.badssl.com/").status).toBe(60);
  });
  it("the room's clock is the host's (zoneinfo readable): `date +%Z` matches outside the sandbox", () => {
    const { run } = sealedRoom();
    const host = spawnSync("/bin/date", ["+%Z"], { encoding: "utf8" }).stdout.trim();
    expect(run("/bin/date +%Z").stdout.trim()).toBe(host);
  });
  it("exec allowlist live: perl and script are refused (the setsid() carriers), the allowed pipeline runs", () => {
    const { run } = sealedRoom();
    for (const cmd of ["/usr/bin/perl -e 1", "/usr/bin/script -q /dev/null /usr/bin/true", "/usr/bin/ruby -e 1"]) {
      const r = run(cmd); expect(r.status, cmd).toBe(126); expect(r.stderr, cmd).toMatch(/Operation not permitted/);
    }
    const ok = run("/bin/echo a b | /usr/bin/tr ' ' '\\n' | /usr/bin/wc -l | /usr/bin/tr -d ' '");
    expect(ok.status).toBe(0); expect(ok.stdout.trim()).toBe("2");
  });
  it("write rule live: files and subdirectories inside the room are writable, the room path itself is not re-creatable once removed", () => {
    const { run, dirs } = sealedRoom();
    expect(run("/bin/echo hi > f.txt && /bin/mkdir sub && /bin/echo ok").stdout.trim()).toBe("ok");
    rmSync(dirs.room, { recursive: true, force: true });
    // cwd is gone: run from the home (readable) instead
    const r = spawnSync("/usr/bin/env", ["-i", ...Object.entries(cleanroomEnv(dirs)).map(([k, v]) => `${k}=${v}`), "/usr/bin/sandbox-exec", "-f", join(dirs.home, CLEANROOM_PROFILE_NAME), "/bin/bash", "-c", `/bin/mkdir "${dirs.room}"`], { cwd: dirs.home, encoding: "utf8" });
    expect(r.status).not.toBe(0); expect(r.stderr).toMatch(/Operation not permitted/); expect(existsSync(dirs.room)).toBe(false);
  });
  it("bind live: with the real profile plus exactly one appended exec allow for nc, nc -l cannot bind (the network lines are byte-identical)", () => {
    const { dirs, profile, env } = sealedRoom();
    const real = readFileSync(profile, "utf8");
    const variant = `${real}(allow process-exec* (literal "/usr/bin/nc"))\n`;
    expect(variant.split("\n").filter((l) => l.includes("network"))).toEqual(real.split("\n").filter((l) => l.includes("network")));
    const vp = join(dirs.home, "variant.sb"); writeFileSync(vp, variant);
    const r = spawnSync("/usr/bin/env", ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "/usr/bin/sandbox-exec", "-f", vp, "/usr/bin/nc", "-l", "127.0.0.1", "48999"], { cwd: dirs.room, encoding: "utf8", timeout: 3000 });
    // nc is the first exec here, so the refusal is sandbox-exec's own (rc 1, "nc: Operation not permitted"), not bash's 126
    expect(r.stderr).toMatch(/Operation not permitted/); expect(r.status).not.toBe(0);
  });
});
