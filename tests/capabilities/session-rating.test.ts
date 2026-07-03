import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAttributionQuestion,
  DEFAULT_RATING_COOLDOWN_HOURS,
  DEFAULT_RATING_MIN_TURNS,
  DEFAULT_RATING_PENDING_MINUTES,
  DEFAULT_SESSION_LULL_MINUTES,
  maybeAskSessionRating,
  parseAttributionVerdict,
  parseBareRating,
  RATING_ASK_TEXT,
  resolveRatingCooldownHours,
  resolveRatingEnabled,
  resolveRatingMinTurns,
  resolveRatingPendingMinutes,
  resolveSessionLullMinutes
} from "../../src/capabilities/session-rating.js";
import { RunStore } from "../../src/run/run-store.js";

// Hermetic: pin every rating env var to its default (delete) and restore after.
const RATING_ENV_VARS = [
  "HOUGE_RATING_ENABLED",
  "HOUGE_RATING_MIN_TURNS",
  "HOUGE_SESSION_LULL_MINUTES",
  "HOUGE_RATING_COOLDOWN_HOURS",
  "HOUGE_RATING_PENDING_MINUTES"
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

const NOW = "2026-07-03T12:00:00.000Z";
const CHAT = "222";

function minutesAgo(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

/** Seed `count` user turns ending `lastMinutesAgo` minutes before NOW, one minute apart. */
function seedUserTurns(store: RunStore, count: number, lastMinutesAgo: number): void {
  for (let i = 0; i < count; i += 1) {
    store.recordChatTurn({
      chat_id: CHAT,
      run_id: `run_${i}`,
      role: "user",
      text: `message ${i}`,
      created_at: minutesAgo(lastMinutesAgo + (count - 1 - i))
    });
  }
}

describe("parseBareRating", () => {
  it("captures a bare digit 0–3", () => {
    expect(parseBareRating("3")).toEqual({ rating: 3 });
    expect(parseBareRating(" 0 ")).toEqual({ rating: 0 });
  });

  it("captures a digit plus a short comment after a separator", () => {
    expect(parseBareRating("2 挺好的")).toEqual({ rating: 2, comment: "挺好的" });
    expect(parseBareRating("1，回答太啰嗦了")).toEqual({ rating: 1, comment: "回答太啰嗦了" });
    expect(parseBareRating("3！nice")).toEqual({ rating: 3, comment: "nice" });
  });

  it("a digit + empty separator tail is a rating without a comment", () => {
    expect(parseBareRating("3。")).toEqual({ rating: 3 });
  });

  it("rejects everything else — out-of-range digits, digit-led sentences, prose", () => {
    expect(parseBareRating("4")).toBeNull();
    expect(parseBareRating("30分钟后提醒我")).toBeNull(); // no separator after the digit
    expect(parseBareRating("3x")).toBeNull();
    expect(parseBareRating("好")).toBeNull();
    expect(parseBareRating(`1 ${"x".repeat(121)}`)).toBeNull(); // comment over the cap
    expect(parseBareRating("")).toBeNull();
  });
});

describe("maybeAskSessionRating — trigger matrix", () => {
  it("substance + lull + no prior ask → asks once: durable outbox message + pending row", () => {
    const store = RunStore.openInMemory();
    try {
      seedUserTurns(store, 3, 31); // ≥3 user turns, quiet for 31 min
      expect(maybeAskSessionRating({ store, chatId: CHAT, now: NOW })).toBe(true);

      const pending = store.getPendingRating(CHAT);
      expect(pending).toMatchObject({ chat_id: CHAT, asked_at: NOW, active: true });
      // No prior capture → the window caps at the last 24h.
      expect(pending?.window_start).toBe(new Date(Date.parse(NOW) - 86_400_000).toISOString());
      expect(store.countNotificationsByIdempotencyKey(`rating:ask:${CHAT}:${NOW}`)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("NOT enough substance (2 < 3 user turns) → no ask", () => {
    const store = RunStore.openInMemory();
    try {
      seedUserTurns(store, 2, 31);
      expect(maybeAskSessionRating({ store, chatId: CHAT, now: NOW })).toBe(false);
      expect(store.getPendingRating(CHAT)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("no LULL (last user turn 10 min ago) → no ask", () => {
    const store = RunStore.openInMemory();
    try {
      seedUserTurns(store, 3, 10);
      expect(maybeAskSessionRating({ store, chatId: CHAT, now: NOW })).toBe(false);
    } finally {
      store.close();
    }
  });

  it("COOLDOWN: an ask 10h ago blocks (default 20h); 21h ago with fresh substance allows", () => {
    const store = RunStore.openInMemory();
    try {
      seedUserTurns(store, 3, 31);
      store.writePendingRating({ chat_id: CHAT, asked_at: minutesAgo(10 * 60), window_start: minutesAgo(60) });
      store.cancelPendingRating(CHAT); // expired silently — asked_at must still gate
      expect(maybeAskSessionRating({ store, chatId: CHAT, now: NOW })).toBe(false);

      store.writePendingRating({ chat_id: CHAT, asked_at: minutesAgo(21 * 60), window_start: minutesAgo(60) });
      store.cancelPendingRating(CHAT);
      expect(maybeAskSessionRating({ store, chatId: CHAT, now: NOW })).toBe(true);
    } finally {
      store.close();
    }
  });

  it("substance counts only turns SINCE the last ask", () => {
    const store = RunStore.openInMemory();
    try {
      // 3 turns, but all before the (21h-old) ask → not enough new substance.
      seedUserTurns(store, 3, 22 * 60);
      store.writePendingRating({ chat_id: CHAT, asked_at: minutesAgo(21 * 60), window_start: minutesAgo(60) });
      store.cancelPendingRating(CHAT);
      expect(maybeAskSessionRating({ store, chatId: CHAT, now: NOW })).toBe(false);
    } finally {
      store.close();
    }
  });

  it("HOUGE_RATING_ENABLED=0 → never asks", () => {
    const store = RunStore.openInMemory();
    try {
      process.env.HOUGE_RATING_ENABLED = "0";
      seedUserTurns(store, 3, 31);
      expect(maybeAskSessionRating({ store, chatId: CHAT, now: NOW })).toBe(false);
    } finally {
      store.close();
    }
  });

  it("window_start = the previous capture when it is inside the last 24h", () => {
    const store = RunStore.openInMemory();
    try {
      const captured_at = minutesAgo(2 * 60);
      store.recordSessionRating({
        chat_id: CHAT,
        rating: 3,
        asked_at: minutesAgo(3 * 60),
        captured_at,
        applied_lesson_ids: []
      });
      // Cooldown keys off asks, not captures — no pending row exists, so it passes.
      seedUserTurns(store, 3, 31);
      expect(maybeAskSessionRating({ store, chatId: CHAT, now: NOW })).toBe(true);
      expect(store.getPendingRating(CHAT)?.window_start).toBe(captured_at);
    } finally {
      store.close();
    }
  });

  it("an empty chat (no user turns) never asks", () => {
    const store = RunStore.openInMemory();
    try {
      expect(maybeAskSessionRating({ store, chatId: CHAT, now: NOW })).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("attribution question + verdict", () => {
  it("frames lessons and transcript as reference data, capped", () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn ${i} ${"x".repeat(500)}`
    }));
    const question = buildAttributionQuestion(turns, [
      { id: 7, text: "回复保持简短", avoid: "长篇大论" },
      { id: 9, text: "用中文回答", avoid: null }
    ]);
    expect(question).toContain("#7: 回复保持简短");
    expect(question).toContain("AVOID: 长篇大论");
    expect(question).toContain("#9: 用中文回答");
    expect(question).toContain("reference data");
    expect(question).not.toContain("turn 7 "); // only the last 12 turns ride along
    expect(question).toContain("turn 19");
    // Each turn's text is char-capped.
    expect(question).not.toContain("x".repeat(450));
  });

  it("parses a culprit that is one of the applied ids", () => {
    expect(
      parseAttributionVerdict('{"culprit_lesson_id":7,"reason":"过度简短"}', [7, 9])
    ).toEqual({ culprit_lesson_id: 7, reason: "过度简短" });
  });

  it("accepts prose around the JSON (tolerant extract)", () => {
    expect(
      parseAttributionVerdict('the verdict: {"culprit_lesson_id":9,"reason":"drift"} done', [7, 9])
    ).toEqual({ culprit_lesson_id: 9, reason: "drift" });
  });

  it("null culprit, unknown ids, and garbage all degrade to none", () => {
    expect(parseAttributionVerdict('{"culprit_lesson_id":null,"reason":"no fault"}', [7])).toEqual({
      culprit_lesson_id: null,
      reason: "no fault"
    });
    expect(parseAttributionVerdict('{"culprit_lesson_id":42,"reason":"?"}', [7]).culprit_lesson_id).toBeNull();
    expect(parseAttributionVerdict("not json at all", [7]).culprit_lesson_id).toBeNull();
    expect(parseAttributionVerdict('{"culprit_lesson_id":"7"}', [7]).culprit_lesson_id).toBeNull();
    expect(parseAttributionVerdict("", [7]).culprit_lesson_id).toBeNull();
  });
});

describe("env resolvers — defaults pinned, overrides honored", () => {
  it("defaults: enabled, 3 turns, 30 min lull, 20h cooldown, 120 min pending", () => {
    expect(resolveRatingEnabled(process.env)).toBe(true);
    expect(resolveRatingMinTurns(process.env)).toBe(DEFAULT_RATING_MIN_TURNS);
    expect(resolveSessionLullMinutes(process.env)).toBe(DEFAULT_SESSION_LULL_MINUTES);
    expect(resolveRatingCooldownHours(process.env)).toBe(DEFAULT_RATING_COOLDOWN_HOURS);
    expect(resolveRatingPendingMinutes(process.env)).toBe(DEFAULT_RATING_PENDING_MINUTES);
  });

  it("overrides win; malformed values fall back to defaults", () => {
    expect(resolveRatingEnabled({ HOUGE_RATING_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveRatingMinTurns({ HOUGE_RATING_MIN_TURNS: "5" } as NodeJS.ProcessEnv)).toBe(5);
    expect(resolveSessionLullMinutes({ HOUGE_SESSION_LULL_MINUTES: "10" } as NodeJS.ProcessEnv)).toBe(10);
    expect(resolveRatingCooldownHours({ HOUGE_RATING_COOLDOWN_HOURS: "1" } as NodeJS.ProcessEnv)).toBe(1);
    expect(resolveRatingPendingMinutes({ HOUGE_RATING_PENDING_MINUTES: "abc" } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_RATING_PENDING_MINUTES
    );
    expect(resolveRatingMinTurns({ HOUGE_RATING_MIN_TURNS: "-2" } as NodeJS.ProcessEnv)).toBe(3);
  });

  it("the ask text is the code-owned Houge-voice prompt", () => {
    expect(RATING_ASK_TEXT).toBe("这次聊得怎么样？给猴哥打个分：0–3，可以顺便说一句为什么 🐒");
  });
});
