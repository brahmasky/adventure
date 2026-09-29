import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramPollOnce } from "../../src/telegram/telegram-poll-runner.js";

// PINNED_ENV hermeticity (the daemon file's pattern): save, DELETE before each test so a value
// leaked from the daemon's .env never arms a flag here, restore after.
const PINNED_ENV = [
  "HOUGE_GLOBAL_MAX_RUNS_24H",
  "HOUGE_MEDIA_INGEST_ENABLED",
  "HOUGE_LLM_MEDIA_PROVIDERS"
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
});

describe("runTelegramPollOnce", () => {
  it("polls one update, creates a run, executes worker, dispatches outbox, and sends Telegram messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-poll-"));
    writeFileSync(join(root, "AGENTS.md"), "Rules");
    const store = RunStore.openInMemory();
    const sent: string[] = [];
    try {
      const result = await runTelegramPollOnce({
        store,
        projectRoot: root,
        // Amendment 1: inject a fake llm adapter so the `/ask` run completes
        // deterministically without any provider credentials / live network.
        llmAdapter: async (input) => ({
          ok: true,
          output: {
            question: input.question,
            answer: "Houge is a deterministic agent harness.",
            model: "fake-model"
          }
        }),
        allowlist: {
          users: [{ telegram_user_id: 111, identity_id: "paco" }],
          chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
        },
        telegramClient: {
          getUpdates: async () => [{
            update_id: 30,
            message: { message_id: 1, text: "summarize the rules", from: { id: 111 }, chat: { id: 222 } }
          }],
          sendMessage: async ({ text }) => {
            sent.push(text);
            return { message_id: sent.length };
          }
        }
      });

      expect(result).toMatchObject({ processed_updates: 1, worker_status: "completed" });
      // No "Queued" progress noise — the only user-facing message is the answer.
      expect(sent.some((text) => text.includes("Queued"))).toBe(false);
      expect(sent.some((text) => text.includes("Houge is a deterministic agent harness."))).toBe(true);
      expect(sent.every((text) => !text.includes("report.md"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("does not crash the batch when the global budget breaker refuses an over-cap /ask, and ships the fuse alert", async () => {
    // Regression: GLOBAL_BUDGET_FUSE must be a HANDLED deterministic denial in
    // the poll loop (offset advances, batch continues, fuse alert dispatched) —
    // not a thrown error that stalls the daemon. Unit tests of the Gateway and
    // poll runner in isolation miss this seam; only the live round-trip hits it.
    process.env.HOUGE_GLOBAL_MAX_RUNS_24H = "1";
    const store = RunStore.openInMemory();
    const sent: string[] = [];
    try {
      const result = await runTelegramPollOnce({
        store,
        projectRoot: mkdtempSync(join(tmpdir(), "houge-poll-fuse-")),
        llmAdapter: async (input) => ({
          ok: true,
          output: { question: input.question, answer: "answer one", model: "fake-model" }
        }),
        allowlist: {
          users: [{ telegram_user_id: 111, identity_id: "paco" }],
          chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
        },
        telegramClient: {
          getUpdates: async () => [
            {
              update_id: 40,
              message: { message_id: 1, text: "first question", from: { id: 111 }, chat: { id: 222 } }
            },
            {
              update_id: 41,
              message: { message_id: 2, text: "second question", from: { id: 111 }, chat: { id: 222 } }
            }
          ],
          sendMessage: async ({ text }) => {
            sent.push(text);
            return { message_id: sent.length };
          }
        }
      });

      // Both updates were processed (the over-cap one did NOT throw / stall).
      expect(result.processed_updates).toBe(2);
      // The first /ask was answered.
      expect(sent.some((text) => text.includes("answer one"))).toBe(true);
      // The breaker's fuse alert was actually delivered to the chat.
      expect(sent.some((text) => text.includes("global budget fuse tripped"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("flag ON in env: a bare voice note becomes a turn run (the runner reads the flag per poll)", async () => {
    process.env.HOUGE_MEDIA_INGEST_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const result = await runTelegramPollOnce({
        store,
        projectRoot: mkdtempSync(join(tmpdir(), "houge-poll-media-")),
        // The injected worker never sees the real ingest step here; this pins the runner seam only.
        llmAdapter: async (input) => ({ ok: true, output: { question: input.question, answer: "ok", model: "fake-model" } }),
        allowlist: {
          users: [{ telegram_user_id: 111, identity_id: "paco" }],
          chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
        },
        telegramClient: {
          getUpdates: async () => [{ update_id: 31, message: { message_id: 1, voice: { file_id: "v", file_unique_id: "u", duration: 3 }, from: { id: 111 }, chat: { id: 222 } } }],
          sendMessage: async () => ({ message_id: 1 })
        }
      });
      expect(result.processed_updates).toBe(1);
      // The newest run is the media turn; the store has no public "list runs", so read the row directly (test-only).
      const newest = (store as unknown as { db: { prepare(sql: string): { get<T>(): T | undefined } } }).db
        .prepare("SELECT run_id FROM runs ORDER BY created_at DESC LIMIT 1").get<{ run_id: string }>();
      expect(store.getRunMetadata(newest!.run_id).media).toMatchObject({ kind: "voice" });
    } finally {
      store.close();
    }
  });

  it("hands the client's downloadFile to the worker: flag ON → a voice update reaches the downloader; flag OFF → it does not and today's acknowledgement is sent", async () => {
    for (const flag of ["true", "false"]) {
      process.env.HOUGE_MEDIA_INGEST_ENABLED = flag;
      const store = RunStore.openInMemory();
      const sent: string[] = [];
      const downloadFile = vi.fn(async () => ({ bytes: new Uint8Array([1]) }));
      try {
        await runTelegramPollOnce({
          store,
          projectRoot: mkdtempSync(join(tmpdir(), "houge-poll-media-")),
          llmAdapter: async (input) => ({ ok: true, output: { question: input.question, answer: "ok", model: "fake-model" } }),
          allowlist: { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }] },
          telegramClient: {
            getUpdates: async () => [{ update_id: 32, message: { message_id: 1, voice: { file_id: "v", file_unique_id: "u", duration: 3 }, from: { id: 111 }, chat: { id: 222 } } }],
            sendMessage: async ({ text }) => { sent.push(text); return { message_id: sent.length }; },
            downloadFile
          }
        });
        if (flag === "true") {
          // The injected LLM adapter means no real media leg: the download happens, then the run fails leg_failed — loudly.
          expect(downloadFile).toHaveBeenCalledTimes(1);
          expect(sent.some((t) => /couldn't transcribe/.test(t))).toBe(true);
        } else {
          expect(downloadFile).not.toHaveBeenCalled();
          expect(sent.some((t) => t.includes("我暂时看不了图片内容"))).toBe(true);
        }
      } finally {
        store.close();
      }
    }
  });
});
