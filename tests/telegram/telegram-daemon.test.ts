import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evolutionLaneSettled,
  resetEvolutionLaneForTests,
  tryStartEvolutionPipeline
} from "../../src/core/evolution-lane.js";
import { parseRatingHistory, RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";
import {
  RATING_ACK_COMMENT_TEXT,
  RATING_ACK_TEXT,
  RATING_ASK_TEXT,
  RATING_ATTRIBUTION_DISCIPLINE
} from "../../src/capabilities/session-rating.js";
import { INTENT_DISCIPLINE } from "../../src/capabilities/intent.js";
import { RADAR_EXTRACT_DISCIPLINE } from "../../src/capabilities/idea-radar.js";
import { LESSON_CONSOLIDATE_DISCIPLINE } from "../../src/capabilities/lesson-consolidate.js";
import { LOOP_DISCIPLINE } from "../../src/prompt/composer.js";

let dirs: string[] = [];
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-daemon-"));
  dirs.push(dir);
  return dir;
}
// This suite drives turns down the inner loop (ADR 0013 — the only `turn` path). The
// scheduler flag (B10b) shapes the per-cycle tick — pin it to its default (tests arm it
// locally), hermetic against a daemon env that would flip it.
// HOUGE_RADAR_ENABLED is pinned too: an ambient armed radar flag would make idle cycles
// fetch REAL sources (the radar test arms it locally with an injected radarFetch).
// HOUGE_RADAR_PANEL_ENABLED likewise: an ambient armed panel flag would make idle cycles
// call REAL judge seats (the panel test arms it locally with injected panelSeats).
const PINNED_ENV = [
  "HOUGE_SCHEDULER_ENABLED",
  "HOUGE_SCHEDULER_MAX_PER_CHAT",
  "HOUGE_RADAR_ENABLED",
  "HOUGE_RADAR_PANEL_ENABLED"
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

function askUpdate(update_id: number, text: string) {
  return {
    update_id,
    message: { message_id: update_id, text, from: { id: 111 }, chat: { id: 222 } }
  };
}

/**
 * A loop-aware LLM fake (the only `turn` path is the inner loop, ADR 0013): the classifier
 * picks `answer`, and the single compose step emits a `final` action. `finalAnswer` defaults
 * to echoing the turn's user message (parsed out of the compose DATA channel) so a turn's
 * reply carries it — preserving the daemon-level "each turn's text shows up in its reply"
 * coverage. Non-loop calls (ask-chain, rating attribution, …) echo the question.
 */
function loopReply(input: Record<string, unknown>, finalAnswer?: string) {
  const system = typeof input.system === "string" ? input.system : "";
  const question = typeof input.question === "string" ? input.question : "";
  if (system.includes(INTENT_DISCIPLINE)) {
    return { ok: true as const, output: { question, answer: '{"intent":"answer"}', model: "fake" } };
  }
  if (system.includes(LOOP_DISCIPLINE)) {
    const echoed = /User message \(untrusted data\):\n(.+)/.exec(question)?.[1] ?? question;
    const answer = JSON.stringify({ action: "final", answer: finalAnswer ?? `A:${echoed}` });
    return { ok: true as const, output: { question, answer, model: "fake" } };
  }
  return { ok: true as const, output: { question, answer: `A:${question}`, model: "fake" } };
}

const okAnswer = (input: Record<string, unknown>) => loopReply(input);

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
        // Shutdown arrives WHILE the run is executing (on its first LLM call — the
        // classifier); the loop still composes a `final` answer and the run completes.
        llmAdapter: async (input) => {
          controller.abort();
          return loopReply(input, "graceful-answer");
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

describe("runTelegramDaemon — ⓪·3g background evolution lane", () => {
  beforeEach(() => resetEvolutionLaneForTests());
  afterEach(async () => {
    await evolutionLaneSettled();
    resetEvolutionLaneForTests();
  });

  /** Occupy the lane with a controllable fake pipeline whose outcome lands in the outbox. */
  function occupyLane(store: RunStore): { release: () => void; resolved: () => boolean } {
    let release!: () => void;
    let resolved = false;
    const started = tryStartEvolutionPipeline({
      current: { run_id: "run_bg", tool: "self_write_propose", started_at: new Date().toISOString() },
      capMs: 60_000,
      run: () =>
        new Promise((resolve) => {
          release = () => {
            resolved = true;
            resolve({ text: "🐒 Fixed the background thing" });
          };
        }),
      onTimeout: () => ({ text: "timeout" }),
      onError: (d) => ({ text: d }),
      // Mirror production wiring: the outcome is a DURABLE outbox notification.
      deliver: (outcome) => {
        store.enqueueNotification({
          target: { kind: "telegram", chat_id: "222" },
          intent_type: "final_report",
          idempotency_key: "lane:test:completion",
          correlation_id: "lane:test",
          payload: { text: outcome.text }
        });
      }
    });
    expect(started).toBe(true);
    return { release, resolved: () => resolved };
  }

  it("keeps answering messages while a pipeline is in flight (the deaf-lane fix)", async () => {
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    const sent: string[] = [];
    let calls = 0;
    let answeredWhileInFlight = false;
    try {
      const lane = occupyLane(store);
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
            if (calls === 1) return [askUpdate(90, "hello while busy")];
            // By the second poll the message got a full answer WHILE the pipeline
            // was still un-resolved — the poll loop never blocked on the lane.
            answeredWhileInFlight = sent.some((t) => t.includes("hello while busy")) && !lane.resolved();
            lane.release();
            controller.abort();
            return [];
          },
          sendMessage: async ({ text }) => {
            sent.push(text);
            return { message_id: sent.length };
          }
        }
      });
      expect(answeredWhileInFlight).toBe(true);
    } finally {
      store.close();
    }
  });

  it("shutdown AWAITS the in-flight pipeline and flushes its completion notification before exiting", async () => {
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    const sent: string[] = [];
    try {
      const lane = occupyLane(store);
      let sawShutdownWait = false;
      await runTelegramDaemon({
        store,
        projectRoot: projectRoot(),
        allowlist: ALLOWLIST,
        stopSignal: controller.signal,
        longPollTimeoutSeconds: 0,
        llmAdapter: async (input) => okAnswer(input),
        telegramClient: {
          getUpdates: async () => {
            // Abort with the pipeline STILL in flight; release it a beat later —
            // the daemon must wait for it rather than exit.
            controller.abort();
            setTimeout(() => {
              sawShutdownWait = !lane.resolved();
              lane.release();
            }, 20);
            return [];
          },
          sendMessage: async ({ text }) => {
            sent.push(text);
            return { message_id: sent.length };
          }
        }
      });
      // The release fired while the pipeline was still pending (the daemon was waiting on it) …
      expect(sawShutdownWait).toBe(true);
      // … the daemon only returned after the pipeline resolved …
      expect(lane.resolved()).toBe(true);
      // … and its completion notification was dispatched before exit.
      expect(sent.some((t) => t.includes("🐒 Fixed the background thing"))).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("runTelegramDaemon — reload-marker boot confirmation (⓪·2c U2)", () => {
  const SHA = "abcdef1234567890abcdef1234567890abcdef12";

  /** Run one daemon pass that aborts on the first getUpdates; collect sent messages. */
  async function bootOnce(
    store: RunStore,
    resolveHead: () => string,
    resolveDistStale?: () => boolean
  ): Promise<string[]> {
    const controller = new AbortController();
    const sent: string[] = [];
    await runTelegramDaemon({
      store,
      projectRoot: projectRoot(),
      allowlist: ALLOWLIST,
      stopSignal: controller.signal,
      longPollTimeoutSeconds: 0,
      resolveHead,
      ...(resolveDistStale ? { resolveDistStale } : {}),
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

  it("stale dist at boot (src newer than dist) → the confirmation carries the rebuild warning", async () => {
    const store = RunStore.openInMemory();
    try {
      store.writeReloadMarker({ sha: SHA, subject: "s", branch: "b" });
      const sent = await bootOnce(store, () => SHA, () => true);
      const confirmation = sent.find((t) => t.includes("重启成功"));
      expect(confirmation).toBeDefined();
      expect(confirmation).toContain("运行中的代码可能是旧的");
      expect(confirmation).toContain("重新 build 并重启");
    } finally {
      store.close();
    }
  });

  it("fresh dist at boot → no stale warning (probe injected false)", async () => {
    const store = RunStore.openInMemory();
    try {
      store.writeReloadMarker({ sha: SHA, subject: "s", branch: "b" });
      const sent = await bootOnce(store, () => SHA, () => false);
      const confirmation = sent.find((t) => t.includes("重启成功"));
      expect(confirmation).toBeDefined();
      expect(confirmation).not.toContain("可能是旧的");
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

describe("runTelegramDaemon — the signal path (⓪·3 S2)", () => {
  const RATING_ENV_VARS = [
    "HOUGE_RATING_ENABLED",
    "HOUGE_RATING_MIN_TURNS",
    "HOUGE_SESSION_LULL_MINUTES",
    "HOUGE_RATING_COOLDOWN_HOURS",
    "HOUGE_RATING_PENDING_MINUTES",
    "HOUGE_LESSON_DECAY_DAYS",
    "HOUGE_LESSON_PRUNE_THRESHOLD",
    "HOUGE_LESSON_REPEAT_DAYS"
  ] as const;
  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv = {};
    for (const key of RATING_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of RATING_ENV_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function minutesAgo(minutes: number): string {
    return new Date(Date.now() - minutes * 60_000).toISOString();
  }

  /** One idle daemon pass (getUpdates aborts immediately); collect sent messages. */
  async function idleCycle(store: RunStore, llmAdapter = async (input: Record<string, unknown>) => okAnswer(input)): Promise<string[]> {
    const controller = new AbortController();
    const sent: string[] = [];
    await runTelegramDaemon({
      store,
      projectRoot: projectRoot(),
      allowlist: ALLOWLIST,
      stopSignal: controller.signal,
      longPollTimeoutSeconds: 0,
      llmAdapter,
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

  it("session lull + substance → the rating ask rides the poll loop and is delivered", async () => {
    const store = RunStore.openInMemory();
    try {
      for (let i = 0; i < 3; i += 1) {
        store.recordChatTurn({
          chat_id: "222",
          run_id: `run_${i}`,
          role: "user",
          text: `q${i}`,
          created_at: minutesAgo(40 - i)
        });
      }
      const sent = await idleCycle(store);
      expect(sent).toContain(RATING_ASK_TEXT);
      expect(store.getPendingRating("222")?.active).toBe(true);
    } finally {
      store.close();
    }
  });

  it("mid-conversation (no lull) → no ask; the daemon behaves exactly as before", async () => {
    const store = RunStore.openInMemory();
    try {
      for (let i = 0; i < 3; i += 1) {
        store.recordChatTurn({
          chat_id: "222",
          run_id: `run_${i}`,
          role: "user",
          text: `q${i}`,
          created_at: minutesAgo(3 - i)
        });
      }
      const sent = await idleCycle(store);
      expect(sent).not.toContain(RATING_ASK_TEXT);
      expect(store.getPendingRating("222")).toBeNull();
      expect(store.getPollHeartbeat()?.last_success_at).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it("the decay tick rides the poll loop (idempotent for the rest of the day)", async () => {
    const store = RunStore.openInMemory();
    try {
      await idleCycle(store);
      // The daemon's cycle already ran today's tick.
      expect(store.runLessonDecayTick(new Date().toISOString()).ran).toBe(false);
    } finally {
      store.close();
    }
  });

  it("a signal-path store error NEVER crashes the loop — the heartbeat still lands", async () => {
    const store = RunStore.openInMemory();
    try {
      (store as unknown as { runLessonDecayTick: () => never }).runLessonDecayTick = () => {
        throw new Error("db locked");
      };
      await idleCycle(store);
      expect(store.getPollHeartbeat()?.last_success_at).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it("the lesson-consolidate tick is wired into the signal path (armed → merges dupes)", async () => {
    const saved = process.env.HOUGE_LESSON_CONSOLIDATE_ENABLED;
    process.env.HOUGE_LESSON_CONSOLIDATE_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const a = store.addLesson({ scope: "ask", text: "be concise", source: "user_feedback" });
      const b = store.addLesson({ scope: "ask", text: "keep it short", source: "user_feedback" });
      // The tick's llmAnswer rides the injected daemon adapter; answer the consolidate call with
      // a valid clusters JSON, and fall back to okAnswer for every other (loop/intent) call.
      const clusters = JSON.stringify({ clusters: [{ ids: [a, b], text: "be concise; keep it short merged", avoid: null }] });
      await idleCycle(store, async (input) => {
        const system = typeof input.system === "string" ? input.system : "";
        if (system.includes(LESSON_CONSOLIDATE_DISCIPLINE)) {
          return { ok: true as const, output: { question: "", answer: clusters, model: "fake" } };
        }
        return okAnswer(input);
      });
      // 2 dupes collapsed to 1, and the tick emitted its ledger event.
      expect(store.getActiveLessons("ask")).toHaveLength(1);
      expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_consolidate_tick")).toHaveLength(1);
    } finally {
      store.close();
      if (saved === undefined) delete process.env.HOUGE_LESSON_CONSOLIDATE_ENABLED;
      else process.env.HOUGE_LESSON_CONSOLIDATE_ENABLED = saved;
    }
  });

  it("the idea-radar tick is wired into the signal path (armed → card inserted + ledger)", async () => {
    const saved = process.env.HOUGE_RADAR_ENABLED;
    process.env.HOUGE_RADAR_ENABLED = "1";
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    try {
      // Hermetic sources: only the Algolia URLs answer (injected radarFetch — no real network).
      const hnBody = JSON.stringify({
        hits: [{ objectID: "9001", title: "Show HN: cron for humans", points: 10, num_comments: 3 }]
      });
      const radarFetch = async (input: { url: string }) =>
        input.url.includes("hn.algolia.com")
          ? ({
              ok: true as const,
              result: { url: input.url, status: 200, content_type: "application/json", content: hnBody, truncated: false, bytes: 1 }
            })
          : ({ ok: false as const, error: "offline in tests" });
      const extract = JSON.stringify({
        cards: [{ verdict: "new", title: "Cron for humans", summary: "s", item_refs: ["hn_front:9001"] }]
      });
      await runTelegramDaemon({
        store,
        projectRoot: projectRoot(),
        allowlist: ALLOWLIST,
        stopSignal: controller.signal,
        longPollTimeoutSeconds: 0,
        radarFetch,
        llmAdapter: async (input) => {
          const system = typeof input.system === "string" ? input.system : "";
          if (system.includes(RADAR_EXTRACT_DISCIPLINE)) {
            return { ok: true as const, output: { question: "", answer: extract, model: "fake" } };
          }
          return okAnswer(input);
        },
        telegramClient: {
          getUpdates: async () => {
            controller.abort();
            return [];
          },
          sendMessage: async () => ({ message_id: 1 })
        }
      });
      // The tick rode the cycle: card landed, marker stamped, ledger event emitted.
      expect(store.listActiveIdeas(10).map((c) => c.slug)).toEqual(["cron-for-humans"]);
      expect(store.getRadarLastRun()).not.toBeNull();
      expect(store.getLedgerEvents().filter((e) => e.event_type === "idea_radar_tick")).toHaveLength(1);
    } finally {
      store.close();
      if (saved === undefined) delete process.env.HOUGE_RADAR_ENABLED;
      else process.env.HOUGE_RADAR_ENABLED = saved;
    }
  });

  it("the idea-panel tick is wired into the signal path (armed → latch + snapshot + ledger)", async () => {
    const saved = process.env.HOUGE_RADAR_PANEL_ENABLED;
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    try {
      // Seed the thin-board floor (3 active cards, distinct momenta).
      for (const [slug, n] of [["a", 3], ["b", 2], ["c", 1]] as const) {
        store.insertIdeaCard({
          slug,
          title: `Idea ${slug}`,
          summary: `summary ${slug}`,
          sources: {
            hn_front: Array.from({ length: n }, (_, i) => ({
              id: `hn_front:${slug}-${i}`,
              url: `https://news.ycombinator.com/item?id=${slug}${i}`,
              title: `item ${slug}-${i}`
            }))
          },
          now: "2026-07-20T10:00:00.000Z"
        });
      }
      // Hermetic seats (prod builds pinned kimi/gemini adapters + real spawns; tests inject):
      // two judges vote → quorum holds; codex + chair fail → mean-score fallback publishes.
      const scores = JSON.stringify({
        scores: [1, 2, 3].map((card) => ({ card, score: 5, reason: `r${card}` }))
      });
      await runTelegramDaemon({
        store,
        projectRoot: projectRoot(),
        allowlist: ALLOWLIST,
        stopSignal: controller.signal,
        longPollTimeoutSeconds: 0,
        panelSeats: {
          judges: {
            kimi: async () => ({ ok: true, answer: scores }),
            gemini: async () => ({ ok: true, answer: scores })
          },
          codexJudge: async () => ({ ok: false, unavailable: true }),
          chair: async () => ({ ok: false, unavailable: true })
        },
        llmAdapter: async (input) => okAnswer(input),
        telegramClient: {
          getUpdates: async () => {
            controller.abort();
            return [];
          },
          sendMessage: async () => ({ message_id: 1 })
        }
      });
      // The tick rode the cycle: weekly latch stamped, snapshot upserted, ledger event emitted.
      expect(store.getPanelLastRun()).not.toBeNull();
      const snapshot = store.getLatestShortlist();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.cards).toHaveLength(3);
      const events = store.getLedgerEvents().filter((e) => e.event_type === "idea_panel_tick");
      expect(events).toHaveLength(1);
    } finally {
      store.close();
      if (saved === undefined) delete process.env.HOUGE_RADAR_PANEL_ENABLED;
      else process.env.HOUGE_RADAR_PANEL_ENABLED = saved;
    }
  });

  /** Pending ask + one in-window run that applied the lesson (attribution seed). */
  function seedPendingSession(store: RunStore, lesson: number): void {
    store.writePendingRating({ chat_id: "222", asked_at: minutesAgo(10), window_start: minutesAgo(120) });
    store.recordChatTurn({ chat_id: "222", run_id: "run_w1", role: "user", text: "q", created_at: minutesAgo(60) });
    store.recordLoopStarted("run_w1", {
      manifest: ["llm_answer"],
      hint: "ask",
      applied_artifacts: { lesson_scopes: ["ask"], lesson_ids: [lesson], skill_scopes: [] }
    });
  }

  /** Run the daemon over one update; the attribution pass names `lesson` culprit. */
  async function captureCycle(store: RunStore, lesson: number, text: string): Promise<string[]> {
    const controller = new AbortController();
    const sent: string[] = [];
    let calls = 0;
    await runTelegramDaemon({
      store,
      projectRoot: projectRoot(),
      allowlist: ALLOWLIST,
      stopSignal: controller.signal,
      longPollTimeoutSeconds: 0,
      llmAdapter: async (input) => {
        if (input.system === RATING_ATTRIBUTION_DISCIPLINE) {
          return {
            ok: true,
            output: { question: input.question, answer: `{"culprit_lesson_id":${lesson},"reason":"没用"}`, model: "fake" }
          };
        }
        return okAnswer(input);
      },
      telegramClient: {
        getUpdates: async () => {
          calls += 1;
          if (calls === 1) return [askUpdate(70, text)];
          controller.abort();
          return [];
        },
        sendMessage: async ({ text: out }) => {
          sent.push(out);
          return { message_id: sent.length };
        }
      }
    });
    return sent;
  }

  it("captures a bare-digit rating end-to-end: code-owned ack delivered, culprit flagged", async () => {
    const store = RunStore.openInMemory();
    try {
      const lesson = store.addLesson({ scope: "ask", text: "结尾加俏皮话", source: "user_feedback" });
      seedPendingSession(store, lesson);
      const sent = await captureCycle(store, lesson, "1");

      // The code-owned ack was delivered — never a model answer; no run for the digit.
      expect(sent).toContain(RATING_ACK_TEXT);
      expect(store.getLastSessionRating("222")).toMatchObject({ rating: 1, comment: null });
      const row = store.getLesson(lesson)!;
      expect(row.corrected_count).toBe(1);
      expect(row.reuse_value).toBeCloseTo(0.5); // low capture adds no credit; the culprit flag pays −0.5
      expect(parseRatingHistory(row.rating_history).some((e) => e.flag === "culprit")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("a processRatingSignal THROW never crashes the poll loop (⓪·3f P2): rating already durable, ack sent, heartbeat lands", async () => {
    const store = RunStore.openInMemory();
    try {
      const lesson = store.addLesson({ scope: "ask", text: "结尾加俏皮话", source: "user_feedback" });
      seedPendingSession(store, lesson);
      const controller = new AbortController();
      const sent: string[] = [];
      let calls = 0;
      const result = await runTelegramDaemon({
        store,
        projectRoot: projectRoot(),
        allowlist: ALLOWLIST,
        stopSignal: controller.signal,
        longPollTimeoutSeconds: 0,
        // The attribution follow-up throws OUTRIGHT (not ok:false) — the worst case.
        llmAdapter: async (input) => {
          if (input.system === RATING_ATTRIBUTION_DISCIPLINE) throw new Error("attribution chain exploded");
          return okAnswer(input);
        },
        telegramClient: {
          getUpdates: async () => {
            calls += 1;
            if (calls === 1) return [askUpdate(80, "1")];
            controller.abort();
            return [];
          },
          sendMessage: async ({ text }) => {
            sent.push(text);
            return { message_id: sent.length };
          }
        }
      });

      // The rating was captured + acked BEFORE the follow-up threw — nothing lost.
      expect(sent).toContain(RATING_ACK_TEXT);
      expect(store.getLastSessionRating("222")).toMatchObject({ rating: 1, comment: null });
      // The attribution pass never landed: no culprit flag, no correction.
      const row = store.getLesson(lesson)!;
      expect(row.corrected_count).toBe(0);
      expect(parseRatingHistory(row.rating_history).some((e) => e.flag === "culprit")).toBe(false);
      // The loop survived: the cycle finished cleanly and the OK heartbeat landed.
      expect(result.cycles).toBeGreaterThanOrEqual(1);
      expect(result.consecutive_failures).toBe(0);
      expect(store.getPollHeartbeat()?.last_success_at).not.toBeNull();
      expect(store.getPollHeartbeat()?.last_error).toBeNull();
    } finally {
      store.close();
    }
  });

  it("digit + comment end-to-end: the comment runs as the turn (real answer, no ack) AND the culprit is flagged", async () => {
    const store = RunStore.openInMemory();
    try {
      const lesson = store.addLesson({ scope: "ask", text: "结尾加俏皮话", source: "user_feedback" });
      seedPendingSession(store, lesson);
      const sent = await captureCycle(store, lesson, "1 帮我查一下明天的天气");

      // The piggy-backed request got a REAL answer (the fake chain echoes the question);
      // no code-owned ack was sent — the swallow case is dead.
      expect(sent).not.toContain(RATING_ACK_TEXT);
      expect(sent).not.toContain(RATING_ACK_COMMENT_TEXT);
      expect(sent.some((t) => t.includes("帮我查一下明天的天气"))).toBe(true);
      // The chat record shows the comment text (what the model saw).
      const userTurns = store.getRecentChatTurns("222", 10).filter((t) => t.role === "user");
      expect(userTurns.at(-1)?.text).toBe("帮我查一下明天的天气");
      // The rating + comment were banked and the attribution follow-up still ran.
      expect(store.getLastSessionRating("222")).toMatchObject({ rating: 1, comment: "帮我查一下明天的天气" });
      const row = store.getLesson(lesson)!;
      expect(row.corrected_count).toBe(1);
      expect(parseRatingHistory(row.rating_history).some((e) => e.flag === "culprit")).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("runTelegramDaemon — scheduler tick (B10b, ADR 0017)", () => {
  /** One idle daemon pass (getUpdates aborts immediately); collect sent messages. */
  async function idleSchedulerCycle(store: RunStore): Promise<string[]> {
    const controller = new AbortController();
    const sent: string[] = [];
    await runTelegramDaemon({
      store,
      projectRoot: projectRoot(),
      allowlist: ALLOWLIST,
      stopSignal: controller.signal,
      longPollTimeoutSeconds: 0,
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

  it("fires a due schedule end-to-end: run executes and the report reaches the chat the same cycle", async () => {
    process.env.HOUGE_SCHEDULER_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const task = store.addScheduledTask({
        chat_id: "222", // the allowlisted chat
        goal: "AI周报：搜HN/X本周AI新闻并总结",
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: new Date(Date.now() - 60_000).toISOString() // due
      });

      const sent = await idleSchedulerCycle(store);

      // The scheduled goal ran as a turn and its answer was DELIVERED this cycle.
      expect(sent.some((t) => t.includes("AI周报"))).toBe(true);
      // The fire is audited and the cursor advanced into the future (no refire loop).
      const fired = store.getLedgerEvents().filter((e) => e.event_type === "schedule_fired");
      expect(fired.length).toBe(1);
      expect(fired[0]!.payload.schedule_id).toBe(task.schedule_id);
      const after = store.getScheduledTask(task.schedule_id)!;
      expect(Date.parse(after.next_run_at)).toBeGreaterThan(Date.now());
      expect(after.state).toBe("enabled");
    } finally {
      store.close();
    }
  });

  it("flag OFF (default): the same due schedule never fires — the daemon tick is inert", async () => {
    const store = RunStore.openInMemory();
    try {
      store.addScheduledTask({
        chat_id: "222",
        goal: "AI周报：搜HN/X本周AI新闻并总结",
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: new Date(Date.now() - 60_000).toISOString()
      });

      const sent = await idleSchedulerCycle(store);

      expect(sent).toEqual([]);
      expect(store.getLedgerEvents().filter((e) => e.event_type === "schedule_fired")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("park marker retirement (ADR 0018 revival)", () => {
  it("clears the park marker on the first successful cycle — so the NEXT gap is reported for real", async () => {
    // The parked process leaves houge.parked so the post-revival sweep can classify the heartbeat
    // gap as deliberate. Once the daemon has demonstrably completed a cycle, that evidence must
    // go, or a later crash would be misread as another park.
    const { clearParkMarker, readParkMarker, writeParkMarker } = await import("../../src/run/tombstone.js");
    const markerDir = mkdtempSync(join(tmpdir(), "houge-daemon-park-"));
    const saved = process.env.HOUGE_PARK_MARKER_PATH;
    process.env.HOUGE_PARK_MARKER_PATH = join(markerDir, "houge.parked");
    writeParkMarker({ parked_at: "2026-09-04T11:41:08.000Z", by: "paco" });
    expect(readParkMarker()).not.toBeNull();

    const store = RunStore.openInMemory();
    const controller = new AbortController();
    let calls = 0;
    try {
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
            if (calls >= 2) controller.abort(); // one full successful cycle, then stop
            return [];
          },
          sendMessage: async () => ({ message_id: 1 })
        }
      });

      expect(store.getPollHeartbeat()?.last_success_at).not.toBeNull();
      expect(readParkMarker()).toBeNull();
    } finally {
      store.close();
      clearParkMarker();
      if (saved === undefined) delete process.env.HOUGE_PARK_MARKER_PATH;
      else process.env.HOUGE_PARK_MARKER_PATH = saved;
      rmSync(markerDir, { recursive: true, force: true });
    }
  });
});

describe("runTelegramDaemon — the audit chokepoint (slice 2)", () => {
  it("slice 2: the daemon's own chain records llm_attempt rows for a turn (run-scoped)", async () => {
    // No injected llmAdapter: the turn rides CoreWorker's REAL chain. pi has no binary-path
    // override (PI_BINARY is the constant "pi", resolved through the child's PATH — which
    // cli-spawn's env allowlist always passes through), so the stub is a `pi` executable in a
    // temp dir prepended to PATH. It drains stdin (the question) and emits one message_end line
    // in the shape parsePiJsonl/extractPiUsage read.
    const dir = mkdtempSync(join(tmpdir(), "houge-pi-stub-"));
    const stub = join(dir, "pi");
    writeFileSync(
      stub,
      "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '" +
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            model: "stub",
            content: [{ type: "text", text: "stub answer" }],
            usage: { input: 3, output: 2, cacheRead: 0 }
          }
        }) +
        "'\n",
      { mode: 0o755 }
    );
    const saved = { p: process.env.HOUGE_LLM_PROVIDERS, path: process.env.PATH };
    process.env.HOUGE_LLM_PROVIDERS = "pi";
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    let calls = 0;
    try {
      await runTelegramDaemon({
        store,
        projectRoot: projectRoot(),
        allowlist: ALLOWLIST,
        stopSignal: controller.signal,
        longPollTimeoutSeconds: 0,
        telegramClient: {
          getUpdates: async () => {
            calls += 1;
            if (calls === 1) return [askUpdate(50, "question one")];
            controller.abort();
            return [];
          },
          sendMessage: async () => ({ message_id: 1 })
        }
      });
      const attempts = store.getLedgerEvents().filter((e) => e.event_type === "llm_attempt");
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((e) => typeof e.run_id === "string")).toBe(true);
      expect(attempts.every((e) => e.payload.provider === "pi" && e.payload.outcome === "ok")).toBe(true);
    } finally {
      store.close();
      if (saved.p === undefined) delete process.env.HOUGE_LLM_PROVIDERS;
      else process.env.HOUGE_LLM_PROVIDERS = saved.p;
      if (saved.path === undefined) delete process.env.PATH;
      else process.env.PATH = saved.path;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
