import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";

let dirs: string[] = [];
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-daemon-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};

function askUpdate(update_id: number, text: string) {
  return {
    update_id,
    message: { message_id: update_id, text, from: { id: 111 }, chat: { id: 222 } }
  };
}

const okAnswer = (input: Record<string, unknown>) => ({
  ok: true as const,
  output: { question: input.question, answer: `A:${input.question}`, model: "fake" }
});

describe("runTelegramDaemon", () => {
  it("loops over multiple poll batches, answering each /ask, and records the heartbeat", async () => {
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    const sent: string[] = [];
    let calls = 0;
    try {
      const result = await runTelegramDaemon({
        store,
        projectRoot: projectRoot(),
        allowlist: ALLOWLIST,
        stopSignal: controller.signal,
        longPollTimeoutSeconds: 0,
        llmAdapter: async (input) => okAnswer(input),
        telegramClient: {
          getUpdates: async () => {
            calls += 1;
            if (calls === 1) return [askUpdate(50, "/ask one")];
            if (calls === 2) return [askUpdate(51, "/ask two")];
            controller.abort(); // stop after two real batches
            return [];
          },
          sendMessage: async ({ text }) => {
            sent.push(text);
            return { message_id: sent.length };
          }
        }
      });

      expect(result.cycles).toBeGreaterThanOrEqual(2);
      expect(sent.some((t) => t.includes("A:one"))).toBe(true);
      expect(sent.some((t) => t.includes("A:two"))).toBe(true);
      expect(store.getPollHeartbeat()?.last_success_at).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it("finishes the in-flight run and flushes its notification when shutdown arrives mid-run", async () => {
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    const sent: string[] = [];
    let calls = 0;
    try {
      const result = await runTelegramDaemon({
        store,
        projectRoot: projectRoot(),
        allowlist: ALLOWLIST,
        stopSignal: controller.signal,
        longPollTimeoutSeconds: 0,
        // Shutdown arrives WHILE the run is executing.
        llmAdapter: async (input) => {
          controller.abort();
          return { ok: true, output: { question: input.question, answer: "graceful-answer", model: "fake" } };
        },
        telegramClient: {
          getUpdates: async () => {
            calls += 1;
            return calls === 1 ? [askUpdate(60, "/ask q")] : [];
          },
          sendMessage: async ({ text }) => {
            sent.push(text);
            return { message_id: sent.length };
          }
        }
      });

      // The in-flight run completed and its answer was dispatched before exit.
      expect(result.cycles).toBe(1);
      expect(sent.some((t) => t.includes("graceful-answer"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("backs off exponentially on repeated Telegram errors and records the last error", async () => {
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    const delays: number[] = [];
    let calls = 0;
    try {
      await runTelegramDaemon({
        store,
        projectRoot: projectRoot(),
        allowlist: ALLOWLIST,
        stopSignal: controller.signal,
        longPollTimeoutSeconds: 0,
        backoff: { baseMs: 1000, maxMs: 60_000 },
        sleep: async (ms) => {
          delays.push(ms);
        },
        llmAdapter: async (input) => okAnswer(input),
        telegramClient: {
          getUpdates: async () => {
            calls += 1;
            if (calls <= 3) throw new Error("Telegram getUpdates failed: HTTP 502");
            controller.abort();
            return [];
          },
          sendMessage: async () => ({ message_id: 1 })
        }
      });

      expect(delays).toEqual([1000, 2000, 4000]);
      expect(store.getPollHeartbeat()?.last_error).toContain("502");
    } finally {
      store.close();
    }
  });
});
