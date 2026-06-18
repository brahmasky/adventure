import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * Single-instance guard for the daemon. Two pollers sharing one bot token make
 * Telegram return HTTP 409 Conflict, so a second instance must refuse to start.
 * A PID lockfile (created with O_EXCL so creation is atomic) is the guard; a
 * stale lock left by a crashed process is reclaimed automatically.
 */

export interface SingleInstanceLock {
  /** Remove the lockfile. Safe to call once; further calls are no-ops. */
  release(): void;
}

export type AcquireLockResult =
  | { ok: true; lock: SingleInstanceLock }
  | { ok: false; held_by_pid: number };

export interface AcquireLockOptions {
  /** PID to record (defaults to this process). Injectable for tests. */
  pid?: number;
  /** Liveness probe for the recorded PID. Injectable for tests. */
  isAlive?: (pid: number) => boolean;
}

/** Default liveness probe: signal 0 tests for existence without delivering a signal. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead); EPERM = exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPid(path: string): number | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function writeLock(path: string, pid: number): void {
  const fd = openSync(path, "wx"); // O_CREAT | O_EXCL | O_WRONLY — throws EEXIST if present
  try {
    writeSync(fd, String(pid));
  } finally {
    closeSync(fd);
  }
}

function makeLock(path: string): SingleInstanceLock {
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        unlinkSync(path);
      } catch {
        /* already gone — fine */
      }
    }
  };
}

/**
 * Try to acquire the single-instance lock at `path`. Returns the lock on success,
 * or the live holder's PID if another instance owns it. A lockfile whose recorded
 * PID is dead is treated as stale, removed, and reclaimed.
 */
export function acquireSingleInstanceLock(
  path: string,
  options: AcquireLockOptions = {}
): AcquireLockResult {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeLock(path, pid);
      return { ok: true, lock: makeLock(path) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      const holder = readLockPid(path);
      if (holder !== undefined && isAlive(holder)) {
        return { ok: false, held_by_pid: holder };
      }

      // Stale (dead or unreadable holder) — remove and retry once.
      try {
        unlinkSync(path);
      } catch {
        /* lost the race to another reclaimer — the retry will observe its lock */
      }
    }
  }

  const holder = readLockPid(path);
  return { ok: false, held_by_pid: holder ?? -1 };
}
