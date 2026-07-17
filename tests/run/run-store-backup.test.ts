import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-store-backup-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const NOW = "2026-07-17T12:00:00.000Z";

describe("backup_state migration (2026-07-17-backup-state)", () => {
  it("seeds the single latch row NULL (first armed tick fires immediately)", () => {
    const store = RunStore.openInMemory();
    try {
      expect(store.getLastBackupAt()).toBeNull();
    } finally {
      store.close();
    }
  });

  it("is idempotent across a double open of the same database file", () => {
    const path = join(tempDir(), "houge.sqlite");
    const first = RunStore.open(path);
    first.advanceBackupLatch(NOW);
    first.close();

    // Re-opening re-runs migrate(); the latch row must survive untouched.
    const second = RunStore.open(path);
    try {
      expect(second.getLastBackupAt()).toBe(NOW);
    } finally {
      second.close();
    }
  });
});

describe("the backup latch (get/advance)", () => {
  it("advanceBackupLatch stamps the row getLastBackupAt reads back", () => {
    const store = RunStore.openInMemory();
    try {
      store.advanceBackupLatch(NOW);
      expect(store.getLastBackupAt()).toBe(NOW);
    } finally {
      store.close();
    }
  });
});

describe("vacuumInto — the WAL-safe snapshot primitive", () => {
  it("writes an openable, row-parity snapshot of the live database", () => {
    const store = RunStore.openInMemory();
    const snapshotPath = join(tempDir(), "snap.sqlite");
    try {
      store.recordChatTurn({ chat_id: "222", run_id: "run_b", role: "user", text: "hello" });
      store.vacuumInto(snapshotPath);
      expect(existsSync(snapshotPath)).toBe(true);

      const restored = RunStore.open(snapshotPath);
      try {
        const turns = restored.getRecentChatTurns("222", 10);
        expect(turns.length).toBe(1);
        expect(turns[0]?.text).toBe("hello");
      } finally {
        restored.close();
      }
    } finally {
      store.close();
    }
  });

  it("refuses an existing path (the tmp+rename contract's foundation)", () => {
    const store = RunStore.openInMemory();
    const snapshotPath = join(tempDir(), "snap.sqlite");
    try {
      store.vacuumInto(snapshotPath);
      expect(() => store.vacuumInto(snapshotPath)).toThrow();
    } finally {
      store.close();
    }
  });
});

describe("the two backup ledger recorders", () => {
  it("db_backup_completed lands with its full payload (schema-validated)", () => {
    const store = RunStore.openInMemory();
    try {
      store.recordDbBackupCompleted({
        path: "backups/houge-20260717T120000Z.sqlite",
        bytes: 4096,
        kept_count: 3,
        duration_ms: 42
      });
      const events = store.getLedgerEvents().filter((e) => e.event_type === "db_backup_completed");
      expect(events.length).toBe(1);
      expect(events[0]?.payload).toMatchObject({ bytes: 4096, kept_count: 3 });
    } finally {
      store.close();
    }
  });

  it("db_backup_failed lands with its reason (schema-validated)", () => {
    const store = RunStore.openInMemory();
    try {
      store.recordDbBackupFailed({ reason: "disk full" });
      const events = store.getLedgerEvents().filter((e) => e.event_type === "db_backup_failed");
      expect(events.length).toBe(1);
      expect(events[0]?.payload).toMatchObject({ reason: "disk full" });
    } finally {
      store.close();
    }
  });
});
