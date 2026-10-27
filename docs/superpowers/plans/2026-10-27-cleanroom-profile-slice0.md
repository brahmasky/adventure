# Clean-room profile, Slice 0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, per-run `cleanroom.sb` renderer plus the directory validation that makes it safe, proven by hermetic
tests and live `sandbox-exec` probes on this Mac — with **no** runtime caller yet (Slice 1) and **no** standing-approval
behaviour (Stage 4A).

**Architecture:** `src/omp/cleanroom.ts` validates the room/home pair (canonical, under the daemon cache root, empty,
non-overlapping, no symlink component) and writes the rendered profile as a sidecar in the read-only home.
`src/omp/seatbelt.ts` gains `renderCleanroom(ctx, dirs)` next to the two existing renderers, reusing `esc`, `variants`
and the SBPL ordering idiom. Tests prove the grammar, the effective denial of the cache root by the planner/shell
profiles, and the planted-file properties live. A gate script repeats the probes against `dist/` on the real cache root.

**Tech Stack:** Node 25 stdlib, TypeScript, vitest, macOS `sandbox-exec` (SBPL). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-ladder-cleanroom-profile-design.md` (Slice 0 scope: "renderer and chamber
property only"). Governing design: `docs/superpowers/specs/2026-10-12-decision-ladder-design.md` §8.3. Probe evidence:
`docs/superpowers/research/2026-10-12-in-loop-decisions/13-cleanroom-probe.md`.

## Global Constraints

- `dependencies: {}` stays empty (ADR 0001/0016). Node stdlib + devDeps only.
- Functions under 50 lines. Match `seatbelt.ts` style (one-line helpers, `esc`, `variants`, SBPL comments say *why*).
- `src/omp/` is protected surface: edits are under the approved spec; list every touched file by path in the report.
- Tests live in `tests/omp/`. Live `sandbox-exec` cases use `it.runIf(process.platform === "darwin")` and
  `vi.setConfig({ testTimeout: 30_000 })` like `tests/omp/seatbelt.test.ts`.
- Room and home must sit under the daemon cache root (`resolveDaemonTmpDir`, default `~/Library/Caches/houge-daemon`).
  Tests pass an explicit `cacheRoot` (a temp dir) — never `os.tmpdir()` as the *daemon* root.
- Profile text, verbatim from the spec (ROOM/HOME/ANCESTORS substituted, both path spellings via `variants`):
  `(version 1)` `(allow default)` `(deny file-read*)` · read allow: `/` literal, `/usr` `/bin` `/System` `/Library`
  `/private/etc/ssl` subpath, `/dev/null` literal, ROOM and HOME subpath · `(allow file-read-data (literal "/"))` ·
  metadata: `/` `/etc` `/var` `/tmp` literal + every ancestor of ROOM and HOME · `(deny file-write*)` ·
  `(allow file-write* (subpath ROOM) (literal "/dev/null"))` · `(deny signal (target others))` · deny `process-exec` of
  `/bin/launchctl`, `/usr/bin/security`, `/usr/bin/python3` · `(deny mach-lookup (global-name "com.apple.launchd"))`.
- Fixed child environment for every probe: `PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C.UTF-8 HOME=<home>
  CURL_HOME=<home> XDG_CONFIG_HOME=<home> TMPDIR=<room>`, launched with `/usr/bin/env -i`, cwd = room.
- Nothing in this slice selects the cleanroom profile at runtime: `shell-adapter.ts`, `bridge-handler.ts`,
  `capability-runner.ts` are **not** modified.
- Commit per task, Conventional Commits, stage by name. Push on green at the end of the slice (Tier A).

---

### Task 1: Directory validation — `validateCleanroomDirs`

**Files:**
- Create: `src/omp/cleanroom.ts`
- Test: `tests/omp/cleanroom.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (`node:fs` / `node:path` only; the dirs must already exist).
- Produces:
  ```ts
  export type CleanroomReason = "not_absolute" | "not_directory" | "symlink_component" | "outside_cache_root" | "overlap" | "not_empty";
  export class CleanroomPathError extends Error { constructor(public readonly reason: CleanroomReason, public readonly path: string) }
  export interface CleanroomDirs { room: string; home: string }  // canonical (realpath) absolute paths
  export function validateCleanroomDirs(input: { room: string; home: string; cacheRoot: string }): CleanroomDirs;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/omp/cleanroom.test.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CleanroomPathError, validateCleanroomDirs } from "../../src/omp/cleanroom.js";

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
  it("rejects a file or a missing path as the room", () => {
    const root = cacheRoot(); const { home } = pair(root);
    const f = join(root, "file"); writeFileSync(f, "x");
    expect(reasonOf(() => validateCleanroomDirs({ room: f, home, cacheRoot: root }))).toBe("not_directory");
    expect(reasonOf(() => validateCleanroomDirs({ room: join(root, "missing"), home, cacheRoot: root }))).toBe("not_directory");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/omp/cleanroom.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/omp/cleanroom.js"`.

- [ ] **Step 3: Implement**

```ts
// src/omp/cleanroom.ts
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
// (Task 4 adds renameSync/writeFileSync and join to these imports)

/**
 * The clean room (decision-ladder design §8.3): a standing-approved command runs with a fresh, empty room as cwd and a
 * fresh, empty, read-only home. Both are daemon-made under the daemon cache root, which the planner and shell profiles
 * already read- and write-deny, so nothing a sandboxed child planted can be inside them. The validator proves that
 * shape before a profile is rendered from the paths; a bad pair is a denied run, never a looser profile.
 */
export type CleanroomReason = "not_absolute" | "not_directory" | "symlink_component" | "outside_cache_root" | "overlap" | "not_empty";

export class CleanroomPathError extends Error {
  constructor(public readonly reason: CleanroomReason, public readonly path: string) {
    super(`cleanroom ${reason}: ${path}`);
    this.name = "CleanroomPathError";
  }
}

/** Canonical absolute paths of a validated pair. */
export interface CleanroomDirs { room: string; home: string }

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Containment first, over EITHER spelling of the cache root (as given, canonical: /tmp vs /private/tmp), then every
 * component from the path up to the root must be a real directory — a symlink anywhere would move the subpath rule.
 */
function canonicalDir(p: string, roots: readonly string[]): string {
  if (!isAbsolute(p)) throw new CleanroomPathError("not_absolute", p);
  let st; try { st = statSync(p); } catch { throw new CleanroomPathError("not_directory", p); }
  if (!st.isDirectory()) throw new CleanroomPathError("not_directory", p);
  const abs = resolve(p);
  if (roots.includes(abs) || !roots.some((r) => inside(abs, r))) throw new CleanroomPathError("outside_cache_root", p);
  for (let d = abs; !roots.includes(d) && d !== dirname(d); d = dirname(d)) {
    if (lstatSync(d).isSymbolicLink()) throw new CleanroomPathError("symlink_component", p);
  }
  return realpathSync(p);
}

export function validateCleanroomDirs(input: { room: string; home: string; cacheRoot: string }): CleanroomDirs {
  const roots = [...new Set([resolve(input.cacheRoot), realpathSync(input.cacheRoot)])];
  const room = canonicalDir(input.room, roots);
  const home = canonicalDir(input.home, roots);
  // overlap before emptiness: a home nested in the room makes the room non-empty, and the overlap is the real fault
  if (room === home || inside(room, home) || inside(home, room)) throw new CleanroomPathError("overlap", `${room} ~ ${home}`);
  for (const [d, given] of [[room, input.room], [home, input.home]] as const) {
    if (readdirSync(d).length > 0) throw new CleanroomPathError("not_empty", given);
  }
  return { room, home };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/omp/cleanroom.test.ts` → all green. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/omp/cleanroom.ts tests/omp/cleanroom.test.ts
git commit -m "feat(omp): validate clean-room directory pair before rendering"
```

---

### Task 2: `renderCleanroom` — the profile text

**Files:**
- Modify: `src/omp/seatbelt.ts` (add after `renderSeatbelt`)
- Test: `tests/omp/cleanroom.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `CleanroomDirs` from Task 1; `esc`, `variants` already in `seatbelt.ts`.
- Produces: `export function renderCleanroom(dirs: CleanroomDirs): string` — pure, no `PathContext` needed (the profile
  names no repo/data path; the cache root is implied by the validated dirs).

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/omp/cleanroom.test.ts
import { renderCleanroom } from "../../src/omp/seatbelt.js";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/omp/cleanroom.test.ts -t renderCleanroom`
Expected: FAIL — `renderCleanroom` is not exported.

- [ ] **Step 3: Implement** (append to `src/omp/seatbelt.ts`; add `import type { CleanroomDirs } from "./cleanroom.js";`)

```ts
/** Every ancestor directory of p, canonical and as given, root excluded: bash getcwd needs metadata on each (probe item 3). */
function ancestorsOf(p: string): string[] {
  const out = new Set<string>();
  for (const v of variants(p)) for (let d = dirname(v); d !== "/" && d !== "."; d = dirname(d)) out.add(d);
  return [...out];
}

const CLEANROOM_READ_TREES = ["/usr", "/bin", "/System", "/Library", "/private/etc/ssl"];

/**
 * The clean room (decision-ladder design §8.3, probe 13-cleanroom-probe.md): reads deny-default, re-opened only for the
 * system trees, /private/etc/ssl (curl's openssl.cnf; hosts and the resolver are NOT needed — DNS goes over IPC), the
 * room and the fresh home; metadata on the symlinks /etc /var /tmp (DNS) and the room's ancestors (getcwd); writes only
 * in the room; the launchd / security / python3-shim escape hatches closed. Network and the rest of IPC stay default
 * in Slice 0 — the P8 probe (Slice 1) narrows them before any sealed credit is granted.
 */
export function renderCleanroom(dirs: CleanroomDirs): string {
  const sub = (p: string) => variants(p).map((v) => `(allow file-read* (subpath "${esc(v)}"))`);
  const meta = (p: string) => `(allow file-read-metadata (literal "${esc(p)}"))`;
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-read*)",
    '(allow file-read* (literal "/"))',
    ...CLEANROOM_READ_TREES.flatMap(sub),
    '(allow file-read* (literal "/dev/null"))',
    ...sub(dirs.room),
    ...sub(dirs.home),
    '(allow file-read-data (literal "/"))',
    ...[...new Set(["/", "/etc", "/var", "/tmp", ...ancestorsOf(dirs.room), ...ancestorsOf(dirs.home)])].map(meta),
    "(deny file-write*)",
    ...variants(dirs.room).map((v) => `(allow file-write* (subpath "${esc(v)}"))`),
    '(allow file-write* (literal "/dev/null"))',
    "(deny signal (target others))",
    '(deny process-exec (literal "/bin/launchctl"))',
    '(deny process-exec (literal "/usr/bin/security"))',
    '(deny process-exec (literal "/usr/bin/python3"))',
    '(deny mach-lookup (global-name "com.apple.launchd"))'
  ].join("\n") + "\n";
}
```

Note on the count assertion: `variants()` returns one spelling when the path does not exist (tests) — 9 read allows. On a
real cache root under `/Users/...` the canonical and given spellings are equal too; under `/tmp` (tests' live cases)
there are two spellings and the live tests do not count lines.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/omp/cleanroom.test.ts tests/omp/seatbelt.test.ts` → green. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/omp/seatbelt.ts tests/omp/cleanroom.test.ts
git commit -m "feat(omp): render the clean-room Seatbelt profile"
```

---

### Task 3: Effective-policy test — the planner and shell profiles cannot reach the room

**Files:**
- Test: `tests/omp/cleanroom.test.ts` (append)

**Interfaces:**
- Consumes: `renderSeatbelt(ctx)` and `resolveDaemonTmpDir` (existing).
- Produces: a test-local SBPL evaluator `lastRuleFor(profile, verb, path)` reused by the gate script in Task 5 (copy, not import — scripts import `dist/` only).

Why: codex's blocker — `writeRoots()` includes all of `$HOME`, and the cache root lives under `$HOME`, so a naïve
"no overlap with write roots" assertion is false while the *effective* policy (last matching rule) still denies the
cache root. The test must evaluate the rendered policy the way SBPL does.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/omp/cleanroom.test.ts
import { renderSeatbelt } from "../../src/omp/seatbelt.js";
import { realpathOrSelf, writeRoots } from "../../src/omp/protected-paths.js";
import { resolveDaemonTmpDir } from "../../src/run/daemon-tmp.js";

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
```

- [ ] **Step 2: Run** — `npx vitest run tests/omp/cleanroom.test.ts -t "effective policy"`. Expected: green — `secretPaths`
  already denies the default cache root (N1). If a room/home assertion fails, the renderer order regressed: stop and
  report, do not loosen the evaluator.

- [ ] **Step 3: Commit**

```bash
git add tests/omp/cleanroom.test.ts
git commit -m "test(omp): clean room unreachable from planner and shell effective policies"
```

---

### Task 4: Live `sandbox-exec` properties (darwin, hermetic, no network)

**Files:**
- Modify: `src/omp/cleanroom.ts` — add `writeCleanroomProfile(dirs): string` (sidecar `<home>/cleanroom.sb`, atomic, 0600)
  and `cleanroomEnv(dirs): Record<string,string>` (the six fixed variables).
- Test: `tests/omp/cleanroom.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export const CLEANROOM_PROFILE_NAME = "cleanroom.sb";
  export function cleanroomEnv(dirs: CleanroomDirs): { PATH: string; LANG: string; HOME: string; CURL_HOME: string; XDG_CONFIG_HOME: string; TMPDIR: string };
  export function writeCleanroomProfile(dirs: CleanroomDirs): string; // returns the profile path
  ```
- Ruling (plan): the sidecar lives in the **home**, not the room — the child cannot write the home, so it cannot
  replace the profile mid-run; `sandbox-exec` has already parsed it anyway. `validateCleanroomDirs` runs **before**
  the write, so "home is empty" holds at validation time; the profile is the one file the daemon adds. Slice 1's
  teardown removes both directories whole.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/omp/cleanroom.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { cleanroomEnv, writeCleanroomProfile, CLEANROOM_PROFILE_NAME } from "../../src/omp/cleanroom.js";
import { vi } from "vitest";
vi.setConfig({ testTimeout: 30_000 });

/** bash exports these three itself under `env -i`; they carry nothing from the daemon (verified: `env -i … bash -c env`). */
const BASH_OWN = ["PWD", "SHLVL", "_"];

/** A validated pair under a temp cache root, its profile written, and a runner that launches like Slice 1 will: env -i, cwd = room. */
function sealedRoom() {
  const root = cacheRoot(); const { room, home } = pair(root);
  const dirs = validateCleanroomDirs({ room, home, cacheRoot: root });
  const profile = writeCleanroomProfile(dirs);
  const env = cleanroomEnv(dirs);
  const run = (script: string) => spawnSync("/usr/bin/env", ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    "/usr/bin/sandbox-exec", "-f", profile, "/bin/bash", "-c", script], { cwd: dirs.room, encoding: "utf8" });
  return { root, dirs, profile, env, run };
}

describe("writeCleanroomProfile / cleanroomEnv", () => {
  it("writes the sidecar into the home at 0600 and returns its path", () => {
    const root = cacheRoot(); const { room, home } = pair(root);
    const dirs = validateCleanroomDirs({ room, home, cacheRoot: root });
    const p = writeCleanroomProfile(dirs);
    expect(p).toBe(join(dirs.home, CLEANROOM_PROFILE_NAME));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, "utf8")).toBe(renderCleanroom(dirs));
  });
  it("the fixed environment is exactly the six names from the spec, nothing inherited", () => {
    const dirs = { room: "/Users/p/Library/Caches/houge-daemon/r", home: "/Users/p/Library/Caches/houge-daemon/h" };
    expect(cleanroomEnv(dirs)).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", HOME: dirs.home, CURL_HOME: dirs.home,
      XDG_CONFIG_HOME: dirs.home, TMPDIR: dirs.room });
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
  it("the escape hatches are closed: launchctl, security and the python3 shim cannot exec", () => {
    const { run } = sealedRoom();
    for (const cmd of ["/bin/launchctl list", "/usr/bin/security help", "/usr/bin/python3 -c 1"]) {
      const r = run(cmd);
      expect(r.status, cmd).not.toBe(0);
      expect(r.stderr, cmd).toMatch(/Operation not permitted/);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `writeCleanroomProfile` / `cleanroomEnv` not exported.

- [ ] **Step 3: Implement** (append to `src/omp/cleanroom.ts`)

```ts
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderCleanroom } from "./seatbelt.js";

export const CLEANROOM_PROFILE_NAME = "cleanroom.sb";

/** Nothing is inherited from the daemon (codex round 4 B19): these six, and TMPDIR inside the room. */
export function cleanroomEnv(dirs: CleanroomDirs): { PATH: string; LANG: string; HOME: string; CURL_HOME: string; XDG_CONFIG_HOME: string; TMPDIR: string } {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", HOME: dirs.home, CURL_HOME: dirs.home, XDG_CONFIG_HOME: dirs.home, TMPDIR: dirs.room };
}

/**
 * The profile is a sidecar in the HOME, which the child can read but never write: it cannot be swapped mid-run (and
 * sandbox-exec has parsed it before the child starts). Written after validation, so "home is empty" held at that point.
 */
export function writeCleanroomProfile(dirs: CleanroomDirs): string {
  const path = join(dirs.home, CLEANROOM_PROFILE_NAME);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, renderCleanroom(dirs), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}
```

`seatbelt.ts` imports `CleanroomDirs` as a type from `cleanroom.ts` and `cleanroom.ts` imports `renderCleanroom` from
`seatbelt.ts`: a type-only import on one side, so no runtime cycle. If `npm run build` complains, move
`CleanroomDirs` into `cleanroom.ts` only (it already is) and keep `import type` in `seatbelt.ts`.

- [ ] **Step 4: Run** — `npx vitest run tests/omp/cleanroom.test.ts` green on darwin; `npm run typecheck`; `npm run build`.
  If a `curl @file` probe returns 7 instead of 26, or the room `.curlrc` case returns 7, the file **was** read: that is
  a real failure of the seal — stop and report, do not change the expectation.

- [ ] **Step 5: Commit**

```bash
git add src/omp/cleanroom.ts tests/omp/cleanroom.test.ts
git commit -m "feat(omp): clean-room profile sidecar, fixed env, live sealed-room properties"
```

---

### Task 5: Live gate — `scripts/live-gate-cleanroom-profile.mjs`

**Files:**
- Create: `scripts/live-gate-cleanroom-profile.mjs`

**Interfaces:**
- Consumes from `dist/`: `omp/cleanroom.js` (`validateCleanroomDirs`, `writeCleanroomProfile`, `cleanroomEnv`),
  `omp/seatbelt.js` (`renderCleanroom`, `renderSeatbelt`), `run/daemon-tmp.js` (`daemonTmpRoot`, `resolveDaemonTmpDir`).
- PASS criterion (fails on silent degradation): every **positive control** passes AND every **negative probe** fails
  with the expected code. A sandbox that silently did not apply makes the negative probes "succeed", which is a FAIL.
  One network case (`curl https://www.apple.com/library/test/success.html` from the room) proves DNS + TLS still work
  sealed; offline (curl 6/7/28) → `INCONCLUSIVE network`, exit stays 0 only if every hermetic case passed, and the
  report line says so.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// Live gate — clean-room Seatbelt profile (Slice 0). Renders the profile for a real pair under the daemon cache root
// (~/Library/Caches/houge-daemon or HOUGE_DAEMON_TMP_DIR), then runs the probe set from
// docs/superpowers/research/2026-10-12-in-loop-decisions/13-cleanroom-probe.md through the real sandbox-exec.
// PASS = positive controls work AND negative probes fail with the expected code AND "Operation not permitted" where a
// file op is denied (a sandbox that did not apply, or a profile sandbox-exec refused, FAILS). Network: an unsandboxed
// curl control runs first; sandboxed DNS/TLS failing while the control works is a FAIL, both failing is INCONCLUSIVE
// (rerun once; ship only with the diagnosis written in the report — standing pre-ruling, tasks/todo.md).
// Run after npm run build:   node scripts/live-gate-cleanroom-profile.mjs [--keep]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const REPO = resolve(new URL("..", import.meta.url).pathname);
const keep = process.argv.includes("--keep");
let fails = 0; const notes = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`); if (!ok) { fails++; process.exitCode = 1; } };
const denied = (r) => r.status !== 0 && /Operation not permitted/.test(r.stderr);

const { validateCleanroomDirs, writeCleanroomProfile, cleanroomEnv } = await import(join(DIST, "omp/cleanroom.js"));
const { renderSeatbelt } = await import(join(DIST, "omp/seatbelt.js"));
const { daemonTmpRoot } = await import(join(DIST, "run/daemon-tmp.js"));

// Sweep what an interrupted earlier run left behind, then make this run's dirs and plants.
const cacheRoot = daemonTmpRoot();
for (const d of readdirSync(cacheRoot)) if (d.startsWith("cleanroom-gate-")) rmSync(join(cacheRoot, d), { recursive: true, force: true });
for (const dir of [tmpdir(), "/private/tmp", homedir()]) for (const f of readdirSync(dir)) if (/^\.?hg-planted-/.test(f)) rmSync(join(dir, f), { force: true });
const base = mkdtempSync(join(cacheRoot, "cleanroom-gate-"));
const room = join(base, "room"); const home = join(base, "home"); mkdirSync(room); mkdirSync(home);
const planted = [join(tmpdir(), `hg-planted-${process.pid}`), `/private/tmp/hg-planted-${process.pid}`, join(homedir(), `.hg-planted-${process.pid}`)];
for (const f of planted) writeFileSync(f, "X-Planted: yes");
const cleanup = () => { if (keep) { console.log(`kept: ${base} and ${planted.join(", ")}`); return; } rmSync(base, { recursive: true, force: true }); for (const f of planted) rmSync(f, { force: true }); };
process.on("SIGINT", () => { cleanup(); process.exit(130); });

try {
  const dirs = validateCleanroomDirs({ room, home, cacheRoot });
  const profile = writeCleanroomProfile(dirs);
  const env = cleanroomEnv(dirs);
  const run = (script) => spawnSync("/usr/bin/env", ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    "/usr/bin/sandbox-exec", "-f", profile, "/bin/bash", "-c", script], { cwd: dirs.room, encoding: "utf8", timeout: 20_000 });

  check("profile written as sidecar in the home", existsSync(profile), profile);
  const ctl = run("/bin/echo ok && /bin/pwd && /bin/echo x > f && /bin/cat f");
  check("positive: binary starts, getcwd clean, room writable", ctl.status === 0 && !/getcwd/.test(ctl.stderr) && ctl.stdout.includes(dirs.room), ctl.stderr.trim());
  const seen = Object.fromEntries(run("/usr/bin/env").stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const wantKeys = [...Object.keys(env), "PWD", "SHLVL", "_"].sort().join(",");
  check("positive: child env is the six fixed names plus bash's PWD/SHLVL/_ with known values", Object.keys(seen).sort().join(",") === wantKeys && seen.PWD === dirs.room && seen.SHLVL === "1" && seen.HOME === dirs.home, Object.keys(seen).sort().join(","));

  for (const f of ["/private/etc/hosts", ...planted]) check(`negative: ${f} unreadable (exists: ${existsSync(f)})`, existsSync(f) && denied(run(`/bin/cat "${f}"`)));
  check("negative: /private/tmp unlistable", denied(run("/bin/ls /private/tmp")));
  const okh = run("/bin/echo 'X-Ok: 1' > ok.txt && /usr/bin/curl -sS --max-time 2 -H @ok.txt http://127.0.0.1:1/");
  check("control: curl -H @<room file> reads it and reaches the connect (exit 7)", okh.status === 7, `exit ${okh.status}`);
  for (const f of ["/private/etc/hosts", ...planted]) {
    const h = run(`/usr/bin/curl -sS --max-time 2 -H @"${f}" http://127.0.0.1:1/`);
    check(`negative: curl -H @${f} fails at file read (exit 26, not 7)`, h.status === 26, `exit ${h.status}`);
    const d = run(`/usr/bin/curl -sS --max-time 2 --data-binary @"${f}" http://127.0.0.1:1/`);
    check(`negative: curl -d @${f} cannot read the body file (exit 26)`, d.status === 26, `exit ${d.status}`);
  }
  check("negative: a .curlrc planted in the room (cwd) is ignored (exit 2, no URL)", run("/bin/echo 'url = \"http://127.0.0.1:1/\"' > .curlrc && /usr/bin/curl -sS --max-time 2").status === 2);
  writeFileSync(join(base, "outside.txt"), "secret"); symlinkSync(join(base, "outside.txt"), join(dirs.room, "link"));
  check("negative: symlink out of the room unreadable", denied(run("/bin/cat link")));
  check("negative: home unwritable (no planted .curlrc)", denied(run(`/bin/echo p > "${dirs.home}/.curlrc"`)) && !existsSync(join(dirs.home, ".curlrc")));
  for (const cmd of ["/bin/launchctl list", "/usr/bin/security help", "/usr/bin/python3 -c 1"]) check(`negative: ${cmd.split(" ")[0]} cannot exec`, denied(run(cmd)));

  // The Alishan property: HTTPS still works from the sealed room (DNS over IPC, TLS roots from /System).
  const URL = "https://www.apple.com/library/test/success.html";
  const curlArgs = `-sS --max-time 10 -o /dev/null -w '%{http_code}' ${URL}`;
  const control = spawnSync("/usr/bin/curl", curlArgs.replace(/'/g, "").split(" ").filter(Boolean), { encoding: "utf8" });
  const net = run(`/usr/bin/curl ${curlArgs}`);
  if (control.status !== 0) { notes.push(`INCONCLUSIVE network: unsandboxed control curl exit ${control.status} (offline?) — rerun once; ship only with the diagnosis in the report`); console.log(notes.at(-1)); }
  else check("network: HTTPS from the room (DNS + TLS) while the unsandboxed control works", net.status === 0 && net.stdout.trim() === "200", `sandboxed exit ${net.status} http ${net.stdout.trim()}`);

  // Effective policy, live: the shell profile can write $HOME but not the room, and cannot list the home.
  const { shell } = renderSeatbelt({ home: homedir(), repo: REPO, data: process.cwd() });
  const shellProfile = join(base, "shell.sb"); writeFileSync(shellProfile, shell);
  const sh = (script) => spawnSync("/usr/bin/sandbox-exec", ["-f", shellProfile, "/bin/sh", "-c", script], { encoding: "utf8" });
  const shellOk = sh(`echo x > "${join(homedir(), `.hg-planted-${process.pid}`)}"`); // $HOME is a shell write root: positive control
  check("effective control: the shell profile parses and can write a $HOME file", shellOk.status === 0, shellOk.stderr.trim());
  check("effective: the shell profile can neither write the room nor list the home", denied(sh(`echo x > "${dirs.room}/from-shell"`)) && denied(sh(`/bin/ls "${dirs.home}"`)) && !existsSync(join(dirs.room, "from-shell")));

  console.log(JSON.stringify({ ok: fails === 0, fails, notes }));
} finally { cleanup(); }
```

- [ ] **Step 2: Build and run**

Run: `npm run build && node scripts/live-gate-cleanroom-profile.mjs`
Expected: every line `PASS`, the network line `PASS`, final JSON `ok: true, fails: 0, notes: []`, exit 0. If the network
line is `INCONCLUSIVE` (unsandboxed control also failed): rerun once; if still inconclusive, the slice may ship only
with that diagnosis written in the report (standing pre-ruling).

- [ ] **Step 3: Commit**

```bash
git add scripts/live-gate-cleanroom-profile.mjs
git commit -m "feat(gate): live gate for the clean-room Seatbelt profile"
```

---

### Task 6: Docs sync

**Files:**
- Modify: `docs/superpowers/specs/2026-10-27-ladder-cleanroom-profile-design.md` — Status line: "Slice 0 built
  <date> (commit); Slice 1 pending; P8 not yet probed — no sealed credit". Add a "Slice 0 rulings" note under
  Rendering API: (1) `renderCleanroom(dirs: CleanroomDirs)` — no `PathContext`, the profile names no repo/data path;
  (2) the profile is a sidecar `<home>/cleanroom.sb`, written after validation (home read-only to the child);
  (3) teardown is Slice 1 (there is no run to tear down yet); (4) the fixed environment is the six names **plus bash's
  own `PWD` (= room), `SHLVL` (= 1) and `_`** — nothing inherited from the daemon; (5) standing-approval eligibility
  consequence for Stage 4A: only self-contained commands qualify (inputs from the command text or the internet,
  output to Telegram); a command reading a local file or writing output for later falls back to asking.
- Modify: `tasks/todo.md` — CURRENT SYSTEM STATE block: one paragraph for Slice 0 (what exists, what does not: no
  runtime caller, no standing behaviour, P8 open), gate result, test counts.
- Modify: `sessions.md` — append one arc entry.
- Modify: `tasks/lessons.md` — only if a ruling in this slice taught something; otherwise leave.
- `docs/reference/configuration.md` — unchanged (no new env var). `README` — unchanged (no user-facing surface).

- [ ] **Step 1: Make the edits, then full verification**

Run: `npm run typecheck && npm test && npm run build && node scripts/live-gate-cleanroom-profile.mjs`
Record: file count / test count / `0 skipped`, gate exit code.

- [ ] **Step 2: Commit and push**

```bash
git add docs/superpowers/specs/2026-10-27-ladder-cleanroom-profile-design.md tasks/todo.md sessions.md
git commit -m "docs(sync): clean-room profile slice 0 shipped"
git push origin main
```

---

## Self-review

**Spec coverage (Slice 0 items):** renderer → T2; per-run profile, no global writer → T4 (sidecar in home, ruled);
path validation (canonical, containment, symlink, overlap, empty) → T1; required SBPL facts incl. `/private/etc/ssl`,
python3 deny → T2; fixed six-variable env → T4; effective-policy overlap test (codex blocker 1) → T3; planted-file,
symlink, `.curlrc`, hosts/home/private-tmp `-d @` probes → T4 + T5; live gate → T5; docs → T6. **Not in Slice 0 by
design:** runtime seam / `executor: "cleanroom"`, teardown, report delivery, P8 loopback/IPC narrowing, wrapper env
enforcement — all Slice 1; the spec's acceptance gate stays closed (no sealed credit).

**Placeholders:** none. **Type consistency:** `CleanroomDirs {room, home}` used identically in T1–T5;
`renderCleanroom(dirs)` takes only `CleanroomDirs` (no `PathContext`) — the spec's signature listed `ctx`; ruled out as
unused (the profile names no repo/data path). `lastRuleFor` is test-local in T3; T5 proves reach live instead.

**Review round 1 (senior on Opus, ran the plan's code; codex read-only) — all closed in this revision:** validator
checks overlap before emptiness (T1); the test-setup `HOUGE_DAEMON_TMP_DIR` leak is neutralised by `withDefaultCacheRoot`
(T3); `noUncheckedIndexedAccess` fix and bash's `PWD`/`SHLVL`/`_` asserted by value, not filtered (T4/T5); spec rule 5
gets a real test over `writeRoots` and rendered policies (T3) and the tautological T2 test is gone; `.curlrc` discovery
live case added (T4/T5); `-d @` probes plant real files and prove they exist (T4/T5); symlink walk accepts either
spelling of the cache root (T1); DNS control before `INCONCLUSIVE`, sweep of stale gate dirs/plants, SIGINT cleanup,
`--keep` prints every kept path, `Operation not permitted` required on denied file ops, shell-profile positive control
(T5); metadata lines de-duplicated (T2); rulings recorded in the spec (T6).
