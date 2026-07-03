import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";

let dirs: string[] = [];
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-daemon-"));
  dirs.push(dir);
  return dir;
}
// This suite drives turns down the LEGACY enum path — hermetic against a daemon env
// that arms the inner loop (ADR 0013): pin the flag to its default (off).
let prevLoopFlag: string | undefined;
beforeEach(() => {
  prevLoopFlag = process.env.HOUGE_INNER_LOOP_ENABLED;
  delete process.env.HOUGE_INNER_LOOP_ENABLED;
});
afterEach(() => {
  if (prevLoopFlag === undefined) delete process.env.HOUGE_INNER_LOOP_ENABLED;
  else process.env.HOUGE_INNER_LOOP_ENABLED = prevLoopFlag;
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
  it("loops over multiple poll batches, answering each turn, and records the heartbeat", async () => {
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
            if (calls === 1) return [askUpdate(50, "question one")];
            if (calls === 2) return [askUpdate(51, "question two")];
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
      // The reply is the LLM answer (here echoing the composed question); each turn's
      // message text shows up in its reply.
      expect(sent.some((t) => t.includes("question one"))).toBe(true);
      expect(sent.some((t) => t.includes("question two"))).toBe(true);
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
            return calls === 1 ? [askUpdate(60, "a question")] : [];
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

describe("runTelegramDaemon — reload-marker boot confirmation (⓪·2c U2)", () => {
  const SHA = "abcdef1234567890abcdef1234567890abcdef12";

  /** Run one daemon pass that aborts on the first getUpdates; collect sent messages. */
  async function bootOnce(store: RunStore, resolveHead: () => string): Promise<string[]> {
    const controller = new AbortController();
    const sent: string[] = [];
    await runTelegramDaemon({
      store,
      projectRoot: projectRoot(),
      allowlist: ALLOWLIST,
      stopSignal: controller.signal,
      longPollTimeoutSeconds: 0,
      resolveHead,
      llmAdapter: async (input) => okAnswer(input),
      telegramClient: {
        getUpdates: async () => {
          controller.abort();
          return [];
        },
        sendMessage: async ({ text }) => {
          sent.push(text);
          return { message_id: sent.length };
        }
      }
    });
    return sent;
  }

  it("marker present → boot confirmation delivered at startup: ✅ 重启成功 + short sha + subject", async () => {
    const store = RunStore.openInMemory();
    try {
      store.writeReloadMarker({ sha: SHA, subject: "fix clock skill", branch: "houge/selfwrite/run_9" });
      const sent = await bootOnce(store, () => SHA);
      const confirmations = sent.filter((t) => t.includes("重启成功"));
      expect(confirmations).toHaveLength(1);
      expect(confirmations[0]).toBe("✅ 重启成功 — 现在运行 abcdef1「fix clock skill」");
      expect(confirmations[0]).not.toContain("不一致");
    } finally {
      store.close();
    }
  });

  it("exactly-once: consumption deletes the marker, so a second restart stays silent", async () => {
    const store = RunStore.openInMemory();
    try {
      store.writeReloadMarker({ sha: SHA, subject: "s", branch: "b" });
      const first = await bootOnce(store, () => SHA);
      expect(first.some((t) => t.includes("重启成功"))).toBe(true);
      const second = await bootOnce(store, () => SHA);
      expect(second.some((t) => t.includes("重启成功"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("HEAD no longer matching the marker (reset after merge) still notifies, with the mismatch note", async () => {
    const store = RunStore.openInMemory();
    try {
      store.writeReloadMarker({ sha: SHA, subject: "s", branch: "b" });
      const sent = await bootOnce(store, () => "0000000000000000000000000000000000000000");
      const confirmation = sent.find((t) => t.includes("重启成功"));
      expect(confirmation).toBeDefined();
      expect(confirmation).toContain("（当前 HEAD 与合并记录不一致）");
    } finally {
      store.close();
    }
  });

  it("no marker → no message", async () => {
    const store = RunStore.openInMemory();
    try {
      const sent = await bootOnce(store, () => SHA);
      expect(sent.some((t) => t.includes("重启成功"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("a marker store error NEVER crashes startup — the daemon still polls", async () => {
    const store = RunStore.openInMemory();
    try {
      (store as unknown as { consumeReloadMarker: () => never }).consumeReloadMarker = () => {
        throw new Error("db locked");
      };
      const sent = await bootOnce(store, () => SHA);
      expect(sent.some((t) => t.includes("重启成功"))).toBe(false);
      // The loop ran (heartbeat recorded) despite the marker error.
      expect(store.getPollHeartbeat()?.last_success_at).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
