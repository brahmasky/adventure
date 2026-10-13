import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A hook the mocked lstatSync runs right after the real lstat, i.e. inside the lstat -> open window.
const hook = vi.hoisted(() => ({ afterLstat: undefined as undefined | (() => void) }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    lstatSync: ((...args: Parameters<typeof real.lstatSync>) => {
      const st = real.lstatSync(...args);
      hook.afterLstat?.();
      return st;
    }) as typeof real.lstatSync
  };
});
const { NEEDS_LOCKED_FILE, SENTINEL_UNREADABLE, takeNeedsLockedFile } = await import("../../src/core/self-write-locked.js");

let wt = "";
beforeEach(() => { wt = mkdtempSync(join(tmpdir(), "houge-sentinel-race-")); });
afterEach(() => { hook.afterLstat = undefined; rmSync(wt, { recursive: true, force: true }); });

describe("takeNeedsLockedFile lstat -> open race", () => {
  // The writer controls the path: a small file at lstat time can be swapped for a huge one before open.
  it("enforces the size cap on the opened fd, not only on the earlier lstat (why: closes the swap window)", () => {
    const file = join(wt, NEEDS_LOCKED_FILE);
    writeFileSync(file, "small");
    hook.afterLstat = () => { hook.afterLstat = undefined; writeFileSync(file, "x".repeat(5000)); };
    expect(takeNeedsLockedFile(wt)).toBe(SENTINEL_UNREADABLE);
  });
});
