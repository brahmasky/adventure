import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_DIR_NAME } from "../../src/run/db-backup.js";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";

let dirs: string[] = [];
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-daemon-backup-"));
  dirs.push(dir);
  return dir;
}

// HERMETICITY (PINNED_ENV cardinal rule): pin every flag the backup tick + the rest of
// the signal path read (delete = code default) so an armed daemon .env can never flip
// these assertions.
const PINNED_ENV = [
  "HOUGE_BACKUP_ENABLED",
  "HOUGE_BACKUP_INTERVAL_HOURS",
  "HOUGE_BACKUP_KEEP",
  "HOUGE_INNER_LOOP_ENABLED",
  "HOUGE_SCHEDULER_ENABLED",
  "HOUGE_EPISODIC_ENABLED",
  "HOUGE_WIKI_ENABLED",
  "HOUGE_RATING_ENABLED"
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of PINNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of PINNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};

/** Run the daemon for one idle cycle (then abort) against the given project root. */
async function daemonCycle(store: RunStore, root: string): Promise<void> {
  const controller = new AbortController();
  await runTelegramDaemon({
    store,
    projectRoot: root,
    allowlist: ALLOWLIST,
    stopSignal: controller.signal,
    longPollTimeoutSeconds: 0,
    llmAdapter: async (input) => ({
      ok: true as const,
      output: { question: input.question, answer: "A", model: "fake" }
    }),
    telegramClient: {
      getUpdates: async () => {
        controller.abort();
        return [];
      },
      sendMessage: async () => ({ message_id: 1 })
    }
  });
}

describe("runTelegramDaemon — the DB backup tick (backlog #3, ADR 0021)", () => {
  it("armed: the backup tick rides the poll loop — snapshot lands, latch consumed", async () => {
    process.env.HOUGE_BACKUP_ENABLED = "1";
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      await daemonCycle(store, root);
      expect(store.getLastBackupAt()).not.toBeNull();
      expect(existsSync(join(root, BACKUP_DIR_NAME))).toBe(true);
      expect(
        store.getLedgerEvents().filter((e) => e.event_type === "db_backup_completed").length
      ).toBe(1);
    } finally {
      store.close();
    }
  });

  it("disarmed (default OFF): zero behavior — no snapshot dir, latch untouched", async () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      await daemonCycle(store, root);
      expect(store.getLastBackupAt()).toBeNull();
      expect(existsSync(join(root, BACKUP_DIR_NAME))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("a backup failure NEVER crashes the loop — the heartbeat still lands", async () => {
    process.env.HOUGE_BACKUP_ENABLED = "1";
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      (store as unknown as { vacuumInto: () => never }).vacuumInto = () => {
        throw new Error("db locked");
      };
      await daemonCycle(store, root);
      expect(store.getPollHeartbeat()?.last_success_at).not.toBeNull();
      expect(store.getLastBackupAt()).toBeNull();
      expect(
        store.getLedgerEvents().filter((e) => e.event_type === "db_backup_failed").length
      ).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
    }
  });
});
