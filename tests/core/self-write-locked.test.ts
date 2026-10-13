import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NEEDS_LOCKED_FILE, SENTINEL_UNREADABLE, planDenial, takeNeedsLockedFile } from "../../src/core/self-write-locked.js";
import { checkSelfWriteDiff, parseDiffRaw } from "../../src/capabilities/self-write-guard.js";

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

// Final review 2026-10-13: the plan once bucketed on the display string (`old -> new`), so a rename landed in the
// bucket of its SOURCE side. These feed the REAL guard's denials, so the bucket follows what the guard checked.
describe("planDenial buckets a rename on both of its real paths", () => {
  const plan = (raw: string) => {
    const g = checkSelfWriteDiff(parseDiffRaw(raw));
    if (g.allowed) throw new Error("expected a denial");
    return planDenial(g.denied, 1, 3, false);
  };
  it("a rename out of tests/ into src/policy/ is a LOCKED denial, listed once (why: the writer must be told it is locked)", () => {
    expect(plan(":100644 100644 a a R100\ttests/c.ts\tsrc/policy/x.ts\n")).toEqual({ kind: "refine_locked", locked: ["tests/c.ts -> src/policy/x.ts"], tests: [] });
  });
  it("a rename from a locked source into an unlocked path is a LOCKED denial (why: either side on the locked surface counts)", () => {
    expect(plan(":100644 100644 a a R100\tsrc/omp/x.ts\tsrc/prompt/x.ts\n")).toEqual({ kind: "refine_locked", locked: ["src/omp/x.ts -> src/prompt/x.ts"], tests: [] });
  });
  it("moving a source file into tests/ is a TEST edit, not a locked one (why: it must not burn the single locked retry)", () => {
    expect(plan(":100644 100644 a a R100\tsrc/a.ts\ttests/b.ts\n")).toEqual({ kind: "refine_tests", tests: ["src/a.ts -> tests/b.ts"] });
  });
});
