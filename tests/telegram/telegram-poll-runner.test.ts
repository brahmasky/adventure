import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramPollOnce } from "../../src/telegram/telegram-poll-runner.js";

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
        // deterministically without ANTHROPIC_API_KEY / live network.
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
      expect(sent.some((text) => text.includes("Queued"))).toBe(true);
      expect(sent.some((text) => text.includes("completed"))).toBe(true);
    } finally {
      store.close();
    }
  });
});
