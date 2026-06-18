import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramPollOnce } from "../../src/telegram/telegram-poll-runner.js";

const SAVED_RUNS_CAP = process.env.HOUGE_GLOBAL_MAX_RUNS_24H;
afterEach(() => {
  if (SAVED_RUNS_CAP === undefined) delete process.env.HOUGE_GLOBAL_MAX_RUNS_24H;
  else process.env.HOUGE_GLOBAL_MAX_RUNS_24H = SAVED_RUNS_CAP;
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
            message: { message_id: 1, text: "/ask summarize rules", from: { id: 111 }, chat: { id: 222 } }
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
              message: { message_id: 1, text: "/ask first", from: { id: 111 }, chat: { id: 222 } }
            },
            {
              update_id: 41,
              message: { message_id: 2, text: "/ask second", from: { id: 111 }, chat: { id: 222 } }
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
});
