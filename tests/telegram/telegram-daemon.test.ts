import { mkdtempSync, rmSync } from "node:fs";
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
