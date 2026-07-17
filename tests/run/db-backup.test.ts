import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_DIR_NAME,
  BACKUP_FILE_PATTERN,
  backupFileName,
  DEFAULT_BACKUP_INTERVAL_HOURS,
  DEFAULT_BACKUP_KEEP,
  resolveBackupEnabled,
  resolveBackupIntervalHours,
  resolveBackupKeep,
  runDbBackupTick
} from "../../src/run/db-backup.js";
import { RunStore } from "../../src/run/run-store.js";

// HERMETICITY (PINNED_ENV cardinal rule): pin every backup flag (delete = code default)
// so an armed daemon .env can never flip these assertions.
const PINNED_ENV = [
  "HOUGE_BACKUP_ENABLED",
  "HOUGE_BACKUP_INTERVAL_HOURS",
  "HOUGE_BACKUP_KEEP"
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of PINNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

let dirs: string[] = [];
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-db-backup-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const key of PINNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const NOW = "2026-07-17T12:00:00.000Z";

function hoursAgo(hours: number): string {
  return new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
}

function snapshotNames(root: string): string[] {
  const dir = join(root, BACKUP_DIR_NAME);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("the three backup resolvers (defaults / overrides / garbage)", () => {
  it("resolveBackupEnabled: default OFF; 1/true/yes/on arm; garbage stays off", () => {
    expect(resolveBackupEnabled({})).toBe(false);
    for (const value of ["1", "true", "yes", "on", " TRUE "]) {
      expect(resolveBackupEnabled({ HOUGE_BACKUP_ENABLED: value })).toBe(true);
    }
    for (const value of ["0", "false", "off", "banana", ""]) {
      expect(resolveBackupEnabled({ HOUGE_BACKUP_ENABLED: value })).toBe(false);
    }
  });

  it("resolveBackupIntervalHours: default 24; positive override wins; <=0/garbage -> default", () => {
    expect(resolveBackupIntervalHours({})).toBe(DEFAULT_BACKUP_INTERVAL_HOURS);
    expect(resolveBackupIntervalHours({ HOUGE_BACKUP_INTERVAL_HOURS: "6" })).toBe(6);
    expect(resolveBackupIntervalHours({ HOUGE_BACKUP_INTERVAL_HOURS: "0.5" })).toBe(0.5);
    for (const value of ["0", "-3", "banana", ""]) {
      expect(resolveBackupIntervalHours({ HOUGE_BACKUP_INTERVAL_HOURS: value })).toBe(
        DEFAULT_BACKUP_INTERVAL_HOURS
      );
    }
  });

  it("resolveBackupKeep: default 7; min 1; garbage/fractional -> default", () => {
    expect(resolveBackupKeep({})).toBe(DEFAULT_BACKUP_KEEP);
    expect(resolveBackupKeep({ HOUGE_BACKUP_KEEP: "1" })).toBe(1);
    expect(resolveBackupKeep({ HOUGE_BACKUP_KEEP: "30" })).toBe(30);
    for (const value of ["0", "-1", "2.5", "banana", ""]) {
      expect(resolveBackupKeep({ HOUGE_BACKUP_KEEP: value })).toBe(DEFAULT_BACKUP_KEEP);
    }
  });
});

describe("runDbBackupTick — the interval latch", () => {
  it("last backup 23h ago: no fire (default 24h interval)", () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      store.advanceBackupLatch(hoursAgo(23));
      const result = runDbBackupTick({ store, projectRoot: root, now: NOW });
      expect(result).toEqual({ ran: false });
      expect(snapshotNames(root)).toEqual([]);
      expect(store.getLastBackupAt()).toBe(hoursAgo(23));
    } finally {
      store.close();
    }
  });

  it("last backup 25h ago: fires, advances the latch, emits db_backup_completed", () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      store.advanceBackupLatch(hoursAgo(25));
      const result = runDbBackupTick({ store, projectRoot: root, now: NOW });
      expect(result.ran).toBe(true);
      expect(result.ran && result.ok).toBe(true);
      expect(store.getLastBackupAt()).toBe(NOW);
      expect(snapshotNames(root)).toEqual([backupFileName(NOW)]);

      const completed = store.getLedgerEvents().filter((e) => e.event_type === "db_backup_completed");
      expect(completed.length).toBe(1);
      expect(completed[0]?.payload).toMatchObject({
        path: join(BACKUP_DIR_NAME, backupFileName(NOW)),
        kept_count: 1
      });
      expect(completed[0]?.payload.bytes).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("a NULL latch (never backed up) fires immediately", () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      const result = runDbBackupTick({ store, projectRoot: root, now: NOW });
      expect(result.ran && result.ok).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("runDbBackupTick — the snapshot itself", () => {
  it("the snapshot is a real openable database with row parity to the source", () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      store.recordChatTurn({ chat_id: "222", run_id: "run_a", role: "user", text: "first" });
      store.recordChatTurn({ chat_id: "222", run_id: "run_a", role: "assistant", text: "second" });
      store.addLesson({ scope: "ask", text: "a durable lesson", source: "user_feedback" });

      const result = runDbBackupTick({ store, projectRoot: root, now: NOW });
      expect(result.ran && result.ok).toBe(true);

      const restored = RunStore.open(join(root, BACKUP_DIR_NAME, backupFileName(NOW)));
      try {
        expect(restored.getRecentChatTurns("222", 10).map((t) => t.text)).toEqual([
          "first",
          "second"
        ]);
        expect(restored.getActiveLessons("ask").map((l) => l.text)).toEqual(["a durable lesson"]);
      } finally {
        restored.close();
      }
    } finally {
      store.close();
    }
  });

  it("no .tmp file survives a successful tick", () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      runDbBackupTick({ store, projectRoot: root, now: NOW });
      expect(snapshotNames(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("runDbBackupTick — retention keeps the newest K by filename", () => {
  it("prunes older snapshots beyond HOUGE_BACKUP_KEEP", () => {
    process.env.HOUGE_BACKUP_KEEP = "2";
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      const days = ["2026-07-14T12:00:00.000Z", "2026-07-15T12:30:00.000Z", "2026-07-16T13:00:00.000Z"];
      for (const day of days) {
        // Each fire is >24h after the previous latch value.
        const result = runDbBackupTick({ store, projectRoot: root, now: day });
        expect(result.ran && result.ok).toBe(true);
      }
      expect(snapshotNames(root)).toEqual([backupFileName(days[1]!), backupFileName(days[2]!)]);
      const last = store
        .getLedgerEvents()
        .filter((e) => e.event_type === "db_backup_completed")
        .at(-1);
      expect(last?.payload.kept_count).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("runDbBackupTick — retention can never evict the snapshot just written (verifier MAJOR 2)", () => {
  it("a foreign future-dated file does not prune the fresh snapshot, and the tick still succeeds", () => {
    process.env.HOUGE_BACKUP_KEEP = "1";
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      // A hostile/foreign file that matches the pattern and sorts NEWER than any real stamp.
      const backupsDir = join(root, BACKUP_DIR_NAME);
      const result0 = runDbBackupTick({ store, projectRoot: root, now: NOW });
      expect(result0.ran && result0.ok).toBe(true);
      writeFileSync(join(backupsDir, "houge-99991231T235959Z.sqlite"), "garbage text, not sqlite");

      const later = "2026-07-18T13:00:00.000Z";
      const result = runDbBackupTick({ store, projectRoot: root, now: later });
      expect(result.ran && result.ok).toBe(true);
      // The fresh snapshot SURVIVES even though the foreign name sorts newer.
      expect(snapshotNames(root)).toContain(backupFileName(later));
      // The latch advanced only because the verified file really exists.
      expect(store.getLastBackupAt()).toBe(later);
    } finally {
      store.close();
    }
  });
});

describe("runDbBackupTick — fail-open (a broken backup never breaks the daemon)", () => {
  it("a corrupt snapshot fails the integrity gate: failed event, no final file, no tmp, latch unchanged", () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      // Deliberately corrupt: the "snapshot" written to tmp is not a SQLite database.
      (store as unknown as { vacuumInto: (path: string) => void }).vacuumInto = (path) => {
        writeFileSync(path, "definitely not a sqlite file");
      };
      const result = runDbBackupTick({ store, projectRoot: root, now: NOW });
      expect(result.ran).toBe(true);
      expect(result.ran && !result.ok).toBe(true);

      expect(snapshotNames(root)).toEqual([]); // neither final nor tmp left behind
      expect(store.getLastBackupAt()).toBeNull(); // latch NOT advanced -> retries next tick
      const failed = store.getLedgerEvents().filter((e) => e.event_type === "db_backup_failed");
      expect(failed.length).toBe(1);
      expect(typeof failed[0]?.payload.reason).toBe("string");
    } finally {
      store.close();
    }
  });

  it("a throwing vacuumInto never escapes the tick; tmp is not left behind", () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      (store as unknown as { vacuumInto: () => never }).vacuumInto = () => {
        throw new Error("disk full");
      };
      let result;
      expect(() => {
        result = runDbBackupTick({ store, projectRoot: root, now: NOW });
      }).not.toThrow();
      expect(result).toMatchObject({ ran: true, ok: false, reason: "disk full" });
      expect(snapshotNames(root)).toEqual([]);
      expect(store.getLastBackupAt()).toBeNull();
    } finally {
      store.close();
    }
  });

  it("a persistent failure emits at most one ledger event per throttle hour (no 30s spam)", () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      (store as unknown as { vacuumInto: () => never }).vacuumInto = () => {
        throw new Error("disk full");
      };
      runDbBackupTick({ store, projectRoot: root, now: "2026-07-17T12:00:00.000Z" });
      runDbBackupTick({ store, projectRoot: root, now: "2026-07-17T12:00:30.000Z" });
      runDbBackupTick({ store, projectRoot: root, now: "2026-07-17T12:59:00.000Z" });
      let failed = store.getLedgerEvents().filter((e) => e.event_type === "db_backup_failed");
      expect(failed.length).toBe(1); // 30s and 59min retries: throttled

      runDbBackupTick({ store, projectRoot: root, now: "2026-07-17T13:01:00.000Z" });
      failed = store.getLedgerEvents().filter((e) => e.event_type === "db_backup_failed");
      expect(failed.length).toBe(2); // past the 1h throttle: a fresh event
    } finally {
      store.close();
    }
  });
});

describe("backup filenames", () => {
  it("backupFileName stamps a UTC second-resolution name the retention pattern matches", () => {
    const name = backupFileName(NOW);
    expect(name).toBe("houge-20260717T120000Z.sqlite");
    expect(BACKUP_FILE_PATTERN.test(name)).toBe(true);
    expect(BACKUP_FILE_PATTERN.test(`${name}.tmp`)).toBe(false);
  });

  it("backupFileName rejects a non-ISO instant — the stamp is a path segment (verifier note)", () => {
    for (const hostile of ["a/../../../../x", "", "garbage", "2026-07-17"]) {
      expect(() => backupFileName(hostile)).toThrow(/not a UTC ISO instant/);
    }
  });
});
