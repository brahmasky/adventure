import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSingleInstanceLock } from "../../src/telegram/single-instance-lock.js";

let dirs: string[] = [];
function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-lock-"));
  dirs.push(dir);
  return join(dir, "houge.daemon.lock");
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("acquireSingleInstanceLock", () => {
  it("acquires a free lock and records the PID", () => {
    const path = lockPath();
    const result = acquireSingleInstanceLock(path, { pid: 4242 });
    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("4242");
    if (result.ok) result.lock.release();
  });

  it("refuses a second instance while the first (live) holder owns the lock", () => {
    const path = lockPath();
    const first = acquireSingleInstanceLock(path, { pid: 100, isAlive: () => true });
    expect(first.ok).toBe(true);

    const second = acquireSingleInstanceLock(path, { pid: 200, isAlive: () => true });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.held_by_pid).toBe(100);
  });

  it("reclaims a stale lock whose recorded PID is dead", () => {
    const path = lockPath();
    writeFileSync(path, "999999"); // a crashed instance left this behind

    const result = acquireSingleInstanceLock(path, { pid: 7, isAlive: () => false });
    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("7");
    if (result.ok) result.lock.release();
  });

  it("release() removes the lockfile so a later instance can acquire", () => {
    const path = lockPath();
    const first = acquireSingleInstanceLock(path, { pid: 1, isAlive: () => true });
    expect(first.ok).toBe(true);
    if (first.ok) first.lock.release();

    const second = acquireSingleInstanceLock(path, { pid: 2, isAlive: () => true });
    expect(second.ok).toBe(true);
    if (second.ok) second.lock.release();
  });

  it("release() is idempotent", () => {
    const path = lockPath();
    const result = acquireSingleInstanceLock(path, { pid: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      result.lock.release();
      expect(() => result.lock.release()).not.toThrow();
    }
  });
});
