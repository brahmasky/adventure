import { cpSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXEMPLAR_NAME } from "../../src/grow/seed.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";
import { growFields, growSetup, mkTmp } from "../helpers/grow.js";
import { pinEnabledFlags, pinOmpEnv } from "../helpers/omp-env.js";

// The daemon's own wiring: the grow boot step and the per-poll grow jobs are called by runTelegramDaemon itself.
// A wiring bug once survived 225 green unit tests, so this goes through the real loop with only Telegram, the model and omp stubbed.
pinOmpEnv();
pinEnabledFlags();
const SEED = join(import.meta.dirname, "..", "..", "grow-seed");
const ALLOWLIST = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }] };
const PINNED = ["HOUGE_GROW_DIR", "HOUGE_BACKUP_ENABLED", "HOUGE_SCHEDULER_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; } vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

type Setup = Awaited<ReturnType<typeof growSetup>>;
/** Two poll cycles (the stop is raised by the second poll, after the first cycle's signal-path tick has started its jobs); the shutdown waits for the grow jobs. */
async function twoCycles(s: Setup, root: string): Promise<void> {
  process.env.HOUGE_GROW_DIR = join(s.dir, "grow");
  const stop = new AbortController(); let polls = 0;
  await runTelegramDaemon({
    store: s.store, projectRoot: root, allowlist: ALLOWLIST, stopSignal: stop.signal, longPollTimeoutSeconds: 0,
    llmAdapter: async (input) => ({ ok: true as const, output: { question: input.question, answer: "A", model: "fake" } }),
    telegramClient: { getUpdates: async () => { if (++polls >= 2) stop.abort(); return []; }, sendMessage: async () => ({ message_id: 1 }) }
  });
}

describe("runTelegramDaemon wires the grow zone", () => {
  it("boot runs the grow boot step: the shipped exemplar is live before the first poll", async () => {
    const s = await growSetup(); const root = mkTmp(); cpSync(SEED, join(root, "grow-seed"), { recursive: true });
    await twoCycles(s, root);
    expect(s.store.getGrowItem(EXEMPLAR_NAME)).toMatchObject({ state: "live", origin: "exemplar" });
  });

  it("a poll cycle runs Paco's queued request: a queued undo is done after one cycle", async () => {
    const s = await growSetup(); const f = growFields(); await s.live(f);
    s.store.enqueueGrowRequest({ idempotency_key: "tg:wire1", kind: "undo", name: f.name, reason: "wrong unit", chat_id: "222", now: "2026-11-10T10:00:00.000Z" });
    await twoCycles(s, mkTmp());
    expect(s.store.dueGrowRequests()).toEqual([]);
    expect(s.store.getGrowItem(f.name)?.state).not.toBe("live");
  });
});
