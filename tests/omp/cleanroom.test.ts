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
