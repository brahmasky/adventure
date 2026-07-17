import { createRequire } from "node:module";
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { RunStore } from "./run-store.js";

/**
 * Periodic DB backup (ROADMAP backlog #3, ADR 0021): snapshot houge.sqlite via
 * SQLite's transactional `VACUUM INTO` — a consistent point-in-time copy regardless
 * of journal mode (rollback-journal today; WAL-safe if that ever changes). Written to a `.tmp` path
 * first, integrity-checked (PRAGMA quick_check on a readonly open), then renamed into
 * place — so a final-named file is never half-written. LOCAL-ONLY: protects against
 * corruption and accidental deletes, not disk death (offsite = future).
 *
 * FAIL-OPEN like the decay ticks: any failure logs + emits `db_backup_failed` and
 * leaves the latch untouched (the next tick retries) — a broken backup must never
 * break the daemon.
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(): Record<string, unknown> | undefined };
    close(): void;
  };
};

/** Master flag — default OFF until the live gate (accepts 1/true/yes/on). */
export function resolveBackupEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_BACKUP_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Hours between snapshots (the interval-latch gate). */
export const DEFAULT_BACKUP_INTERVAL_HOURS = 24;

export function resolveBackupIntervalHours(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_BACKUP_INTERVAL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BACKUP_INTERVAL_HOURS;
}

/** Newest snapshots kept by retention (older ones unlinked); min 1. */
export const DEFAULT_BACKUP_KEEP = 7;

export function resolveBackupKeep(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_BACKUP_KEEP);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_BACKUP_KEEP;
}

/** Snapshot directory under the project root (gitignored). */
export const BACKUP_DIR_NAME = "backups";

/** Final snapshot names: houge-<YYYYMMDDTHHmmss>Z.sqlite (lexicographic = chronological). */
export const BACKUP_FILE_PATTERN = /^houge-\d{8}T\d{6}Z\.sqlite$/;

/** The snapshot filename for a given UTC instant. Throws on a non-ISO input — the
 * stamp becomes a filesystem path segment, so its shape is validated, never trusted. */
export function backupFileName(nowIso: string): string {
  const stamp = nowIso.replace(/[-:]/g, "").slice(0, 15);
  if (!/^\d{8}T\d{6}$/.test(stamp)) {
    throw new Error(`backupFileName: not a UTC ISO instant: ${nowIso}`);
  }
  return `houge-${stamp}Z.sqlite`;
}

/** A still-failing backup retries every poll tick, but emits at most one ledger event per hour. */
export const BACKUP_FAILURE_EVENT_THROTTLE_HOURS = 1;

export interface RunDbBackupTickInput {
  store: RunStore;
  projectRoot: string;
  now: string;
  env?: NodeJS.ProcessEnv;
}

export type DbBackupTickResult =
  | { ran: false }
  | { ran: true; ok: true; path: string; bytes: number; kept_count: number }
  | { ran: true; ok: false; reason: string };

/**
 * One backup tick: interval-gate on the `backup_state` latch, then
 * VACUUM INTO tmp → quick_check → rename → retention → advance latch → ledger event.
 * NEVER throws; the latch only advances on success (failures retry next tick).
 */
export function runDbBackupTick(input: RunDbBackupTickInput): DbBackupTickResult {
  const env = input.env ?? process.env;
  const last = input.store.getLastBackupAt();
  const intervalMs = resolveBackupIntervalHours(env) * 3_600_000;
  if (last && Date.parse(input.now) - Date.parse(last) < intervalMs) {
    return { ran: false };
  }

  const started = Date.now();
  const dir = join(input.projectRoot, BACKUP_DIR_NAME);
  const name = backupFileName(input.now);
  const relativePath = join(BACKUP_DIR_NAME, name);
  const finalPath = join(dir, name);
  const tmpPath = `${finalPath}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    input.store.vacuumInto(tmpPath);
    assertSnapshotIntegrity(tmpPath);
    renameSync(tmpPath, finalPath);
    // Order is the invariant (verifier MAJOR 2): verify the landed file EXISTS, then
    // prune (never the file just written — a foreign future-dated name must not be
    // able to evict it), and only then advance the latch.
    const bytes = statSync(finalPath).size;
    const keptCount = pruneOldSnapshots(dir, resolveBackupKeep(env), name);
    input.store.advanceBackupLatch(input.now);
    input.store.recordDbBackupCompleted({
      path: relativePath,
      bytes,
      kept_count: keptCount,
      duration_ms: Date.now() - started
    });
    return { ran: true, ok: true, path: relativePath, bytes, kept_count: keptCount };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort: the tmp may never have been created.
    }
    try {
      const lastEvent = input.store.getLastBackupFailureEventAt();
      const throttleMs = BACKUP_FAILURE_EVENT_THROTTLE_HOURS * 3_600_000;
      if (!lastEvent || Date.parse(input.now) - Date.parse(lastEvent) >= throttleMs) {
        input.store.recordDbBackupFailed({ reason });
        input.store.markBackupFailureEvent(input.now);
      }
    } catch {
      // The ledger write itself failing must not escape either.
    }
    console.error(`[db-backup] snapshot failed (latch not advanced, retries next tick): ${reason}`);
    return { ran: true, ok: false, reason };
  }
}

/** Open the snapshot readonly and require PRAGMA quick_check = "ok" (corruption gate). */
function assertSnapshotIntegrity(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA quick_check").get();
    const verdict = row ? Object.values(row)[0] : undefined;
    if (verdict !== "ok") {
      throw new Error(`snapshot quick_check failed: ${String(verdict ?? "no result")}`);
    }
  } finally {
    db.close();
  }
}

/**
 * Keep the newest `keep` final-named snapshots (names sort chronologically); unlink
 * older. The just-written snapshot (`spare`) is NEVER pruned regardless of sort
 * position — a foreign future-dated filename must not evict the real backup.
 */
function pruneOldSnapshots(dir: string, keep: number, spare: string): number {
  const snapshots = readdirSync(dir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort()
    .reverse();
  const keepSet = new Set(snapshots.slice(0, keep));
  keepSet.add(spare);
  for (const name of snapshots) {
    if (!keepSet.has(name)) {
      unlinkSync(join(dir, name));
    }
  }
  return Math.min(snapshots.length, keepSet.size);
}
