import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NEEDS_LOCKED_FILE, SENTINEL_UNREADABLE, takeNeedsLockedFile } from "../../src/core/self-write-locked.js";

let wt = "";
let outside = "";
beforeEach(() => {
  wt = mkdtempSync(join(tmpdir(), "houge-sentinel-"));
  outside = mkdtempSync(join(tmpdir(), "houge-sentinel-out-"));
});
afterEach(() => {
  rmSync(wt, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
const gone = () => { try { lstatSync(join(wt, NEEDS_LOCKED_FILE)); return false; } catch { return true; } };

// The real reader runs in the daemon on a writer-controlled path: each case guards a way to hurt the daemon or leak.
describe("takeNeedsLockedFile", () => {
  it("a regular file is returned and deleted (why: it must never reach a diff)", () => {
    writeFileSync(join(wt, NEEDS_LOCKED_FILE), "needs src/omp/x.ts");
    expect(takeNeedsLockedFile(wt)).toBe("needs src/omp/x.ts");
    expect(gone()).toBe(true);
  });
  it("a missing file is undefined (why: the normal case must not go terminal)", () => {
    expect(takeNeedsLockedFile(wt)).toBeUndefined();
  });
  it("a symlink is never followed: unreadable marker, link removed, target untouched (why: no arbitrary file read)", () => {
    const target = join(outside, "secret.txt");
    writeFileSync(target, "TOPSECRET");
    symlinkSync(target, join(wt, NEEDS_LOCKED_FILE));
    const out = takeNeedsLockedFile(wt);
    expect(out).toBe(SENTINEL_UNREADABLE);
    expect(out).not.toContain("TOPSECRET");
    expect(gone()).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
  it("an oversize file is not read and is removed (why: no memory blowup)", () => {
    writeFileSync(join(wt, NEEDS_LOCKED_FILE), "x".repeat(5000));
    expect(takeNeedsLockedFile(wt)).toBe(SENTINEL_UNREADABLE);
    expect(gone()).toBe(true);
  });
  it("a directory is removed and unreadable (why: a non-file must not stay for publish)", () => {
    mkdirSync(join(wt, NEEDS_LOCKED_FILE));
    expect(takeNeedsLockedFile(wt)).toBe(SENTINEL_UNREADABLE);
    expect(gone()).toBe(true);
  });
  it("a FIFO is never opened for blocking and is removed (why: it would hang the daemon event loop)", () => {
    execFileSync("mkfifo", [join(wt, NEEDS_LOCKED_FILE)]);
    expect(takeNeedsLockedFile(wt)).toBe(SENTINEL_UNREADABLE);
    expect(gone()).toBe(true);
  });
});
