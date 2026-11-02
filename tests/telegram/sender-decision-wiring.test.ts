import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramPollOnce } from "../../src/telegram/telegram-poll-runner.js";
import { runTelegramDaemon as runDaemon } from "../../src/telegram/telegram-daemon.js";
import { NO_OMP_PROBE, pinOmpEnv, tmpOmpDist, useFakeOmp } from "../helpers/omp-env.js";

pinOmpEnv();
// P11: an armed ambient flag sends unrelated operator alerts, so silence is asserted to the sender's chat (222) only.
const PINNED = ["HOUGE_TELEGRAM_CHAT_ID", "HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS"];
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => { process.env.HOUGE_MODEL_ROLES = "static"; /* the empty-tier card is not under test: exact chat traffic is */ for (const k of PINNED) { savedEnv.set(k, process.env[k]); delete process.env[k]; } });
afterEach(() => { for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } savedEnv.clear(); });

const ALLOW = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] };
const stranger = (update_id: number) => ({ update_id, message: { message_id: update_id, text: "hi", from: { id: 999 }, chat: { id: 222 } } });
const rows = (store: RunStore) => (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
  .prepare("SELECT verdict, reason_code FROM decisions WHERE entry_id = 'intake.sender'").all();

describe("both production poll constructors record intake.sender", () => {
  it("runTelegramPollOnce", async () => {
    const store = RunStore.openInMemory(); const root = mkdtempSync(join(tmpdir(), "hg-sw-")); const sent: Array<{ chat_id: string; text: string }> = [];
    try {
      useFakeOmp({ "*": { rpcText: "x" } }, root);
      await runTelegramPollOnce({ store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) }, allowlist: ALLOW,
        telegramClient: { getUpdates: async () => [stranger(30)], sendMessage: async ({ chat_id, text }) => { sent.push({ chat_id: String(chat_id), text }); return { message_id: 1 }; } } });
      expect(rows(store)).toEqual([{ verdict: "deny", reason_code: "user_not_allowlisted" }]);
      expect(sent.filter((m) => m.chat_id === "222")).toEqual([]);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("runTelegramDaemon", async () => {
    const store = RunStore.openInMemory(); const root = mkdtempSync(join(tmpdir(), "hg-sw-")); const sent: Array<{ chat_id: string; text: string }> = [];
    const controller = new AbortController(); let calls = 0;
    try {
      useFakeOmp({ "*": { rpcText: "x" } }, root);
      await runDaemon({ ...NO_OMP_PROBE, store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) }, allowlist: ALLOW,
        stopSignal: controller.signal, longPollTimeoutSeconds: 0,
        telegramClient: { getUpdates: async () => { calls += 1; if (calls === 1) return [stranger(31)]; controller.abort(); return []; },
          sendMessage: async ({ chat_id, text }) => { sent.push({ chat_id: String(chat_id), text }); return { message_id: 1 }; } } });
      expect(rows(store)).toEqual([{ verdict: "deny", reason_code: "user_not_allowlisted" }]);
      expect(sent.filter((m) => m.chat_id === "222")).toEqual([]);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
