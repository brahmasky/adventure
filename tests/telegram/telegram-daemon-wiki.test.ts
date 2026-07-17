import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RATING_ACK_TEXT } from "../../src/capabilities/session-rating.js";
import { parseRatingHistory, RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";

let dirs: string[] = [];
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-daemon-wiki-"));
  dirs.push(dir);
  return dir;
}

// HERMETICITY (PINNED_ENV cardinal rule): pin every flag the wiki tick + rating capture
// read (delete = code default) so an armed daemon .env can never flip these assertions.
const PINNED_ENV = [
  "HOUGE_SCHEDULER_ENABLED",
  "HOUGE_EPISODIC_ENABLED",
  "HOUGE_WIKI_ENABLED",
  "HOUGE_WIKI_DECAY_DAYS",
  "HOUGE_WIKI_RETRIEVE_CAP",
  "HOUGE_WIKI_RECENCY_HALFLIFE_DAYS",
  "HOUGE_LESSON_PRUNE_THRESHOLD",
  "HOUGE_RATING_ENABLED",
  "HOUGE_RATING_MIN_TURNS",
  "HOUGE_SESSION_LULL_MINUTES",
  "HOUGE_RATING_COOLDOWN_HOURS",
  "HOUGE_RATING_PENDING_MINUTES"
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

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const okAnswer = (input: Record<string, unknown>) => ({
  ok: true as const,
  output: { question: input.question, answer: `A:${input.question}`, model: "fake" }
});

/** Run the daemon over the given update batches (then abort); collect sent messages. */
async function daemonCycle(store: RunStore, updates: unknown[][] = []): Promise<string[]> {
  const controller = new AbortController();
  const sent: string[] = [];
  let calls = 0;
  await runTelegramDaemon({
    store,
    projectRoot: projectRoot(),
    allowlist: ALLOWLIST,
    stopSignal: controller.signal,
    longPollTimeoutSeconds: 0,
    llmAdapter: async (input) => okAnswer(input),
    telegramClient: {
      getUpdates: async () => {
        calls += 1;
        const batch = updates[calls - 1];
        if (batch) return batch as never;
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

describe("runTelegramDaemon — the wiki decay tick (Phase W W2)", () => {
  it("armed: the decay tick rides the poll loop (idempotent for the rest of the day)", async () => {
    process.env.HOUGE_WIKI_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      await daemonCycle(store);
      // The daemon's cycle already consumed today's tick.
      expect(store.runWikiDecayTick(new Date().toISOString()).ran).toBe(false);
    } finally {
      store.close();
    }
  });

  it("disarmed (default OFF): the tick is inert — the latch is untouched", async () => {
    const store = RunStore.openInMemory();
    try {
      await daemonCycle(store);
      // Nothing consumed the latch: a manual tick still runs — proof the daemon
      // never called runWikiDecayTick while the flag was off.
      expect(store.runWikiDecayTick(new Date().toISOString()).ran).toBe(true);
    } finally {
      store.close();
    }
  });

  it("a wiki-tick store error NEVER crashes the loop — the heartbeat still lands", async () => {
    process.env.HOUGE_WIKI_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      (store as unknown as { runWikiDecayTick: () => never }).runWikiDecayTick = () => {
        throw new Error("db locked");
      };
      await daemonCycle(store);
      expect(store.getPollHeartbeat()?.last_success_at).not.toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("runTelegramDaemon — rating capture credits the applied wiki pages (W2 eval loop)", () => {
  function askUpdate(update_id: number, text: string) {
    return {
      update_id,
      message: { message_id: update_id, text, from: { id: 111 }, chat: { id: 222 } }
    };
  }

  /** Pending ask + one in-window run whose loop_started applied the wiki page. */
  function seedPendingSession(store: RunStore, pageId: number): void {
    store.writePendingRating({ chat_id: "222", asked_at: minutesAgo(10), window_start: minutesAgo(120) });
    store.recordChatTurn({ chat_id: "222", run_id: "run_w2", role: "user", text: "q", created_at: minutesAgo(60) });
    store.recordLoopStarted("run_w2", {
      manifest: ["llm_answer"],
      hint: "ask",
      applied_artifacts: {
        lesson_scopes: [],
        lesson_ids: [],
        skill_scopes: [],
        episodic_fact_ids: [],
        wiki_page_ids: [pageId]
      }
    });
  }

  it("a bare-digit ≥2 rating pays +0.25 reuse to the window's applied pages (rating_history appended)", async () => {
    const store = RunStore.openInMemory();
    try {
      const pageId = store.addWikiPage({
        topic_slug: "asml-q2-2026",
        title: "ASML Q2 2026 earnings",
        created_at: minutesAgo(90)
      });
      seedPendingSession(store, pageId);
      const sent = await daemonCycle(store, [[askUpdate(70, "3")]]);

      expect(sent).toContain(RATING_ACK_TEXT);
      const row = store.getWikiPage(pageId)!;
      expect(row.reuse_value).toBeCloseTo(1.25);
      const history = parseRatingHistory(row.rating_history);
      expect(history.length).toBe(1);
      expect(history[0]).toMatchObject({ rating: 3 });
    } finally {
      store.close();
    }
  });

  it("a LOW rating appends history only — no reuse credit, no penalty (culprit stays lessons-only)", async () => {
    const store = RunStore.openInMemory();
    try {
      const pageId = store.addWikiPage({
        topic_slug: "asml-q2-2026",
        title: "ASML Q2 2026 earnings",
        created_at: minutesAgo(90)
      });
      seedPendingSession(store, pageId);
      await daemonCycle(store, [[askUpdate(71, "1")]]);

      const row = store.getWikiPage(pageId)!;
      expect(row.reuse_value).toBeCloseTo(1.0);
      expect(row.corrected_count).toBe(0);
      expect(parseRatingHistory(row.rating_history)).toMatchObject([{ rating: 1 }]);
    } finally {
      store.close();
    }
  });
});
