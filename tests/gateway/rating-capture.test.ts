import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { parseRatingHistory, RunStore } from "../../src/run/run-store.js";
import {
  RATING_ACK_COMMENT_TEXT,
  RATING_ACK_TEXT
} from "../../src/capabilities/session-rating.js";

// Hermetic: pin the capture window env var to its default.
let savedPending: string | undefined;
beforeEach(() => {
  savedPending = process.env.HOUGE_RATING_PENDING_MINUTES;
  delete process.env.HOUGE_RATING_PENDING_MINUTES;
});
afterEach(() => {
  if (savedPending === undefined) delete process.env.HOUGE_RATING_PENDING_MINUTES;
  else process.env.HOUGE_RATING_PENDING_MINUTES = savedPending;
});

const NOW = "2026-07-03T12:00:00.000Z";
const CHAT = "222";

function minutesAgo(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

function turnEvent(text: string, key: string) {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "turn",
    program: "turn",
    goal: text,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: `telegram:${key}`,
    source_reference: `telegram:update:${key}`
  });
}

/** Read an outbox payload text by idempotency key (test-only raw peek). */
function notificationText(store: RunStore, idempotency_key: string): string | undefined {
  const db = (store as unknown as {
    db: { prepare(sql: string): { get<T>(...v: unknown[]): T | undefined } };
  }).db;
  const row = db
    .prepare("SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?")
    .get<{ payload_json: string }>(idempotency_key);
  return row ? (JSON.parse(row.payload_json) as { text: string }).text : undefined;
}

/** A pending ask + one in-window run that applied the given lessons. */
function seedPendingWithAppliedLessons(store: RunStore, lessonIds: number[]): void {
  store.writePendingRating({ chat_id: CHAT, asked_at: minutesAgo(40), window_start: minutesAgo(120) });
  store.recordChatTurn({ chat_id: CHAT, run_id: "run_w1", role: "user", text: "q", created_at: minutesAgo(60) });
  store.recordLoopStarted("run_w1", {
    manifest: ["llm_answer"],
    hint: "ask",
    applied_artifacts: { lesson_scopes: ["ask"], lesson_ids: lessonIds, skill_scopes: [] }
  });
}

describe("Gateway rating capture (⓪·3 S2a)", () => {
  it("a bare digit with an active pending is captured: stored, attributed, acked — no run", () => {
    const store = RunStore.openInMemory();
    try {
      const lesson = store.addLesson({ scope: "ask", text: "简短回答", source: "user_feedback" });
      seedPendingWithAppliedLessons(store, [lesson]);

      const event = turnEvent("3", "u1");
      const result = new Gateway(store).intake(event, NOW);

      expect(result).toEqual({
        ok: true,
        status: "rating_captured",
        run_id: "",
        chat_id: CHAT,
        rating: 3,
        applied_lesson_ids: [lesson]
      });
      // Bare digit only — consumed, no run created for it.
      expect(store.listRecentRunStatuses(10)).toHaveLength(0);
      // Stored against the window's applied set.
      const captured = store.getLastSessionRating(CHAT);
      expect(captured).toMatchObject({ rating: 3, comment: null, captured_at: NOW });
      expect(JSON.parse(captured!.applied_lesson_ids)).toEqual([lesson]);
      // Positive signal: rating_history + reuse credit on the applied lesson.
      const row = store.getLesson(lesson)!;
      expect(parseRatingHistory(row.rating_history)).toEqual([{ rating: 3, at: NOW }]);
      expect(row.reuse_value).toBeCloseTo(1.25);
      // Code-owned ack through the durable outbox; the pending is consumed.
      expect(notificationText(store, `${event.idempotency_key}:rating`)).toBe(RATING_ACK_TEXT);
      expect(store.getPendingRating(CHAT)?.active).toBe(false);
    } finally {
      store.close();
    }
  });

  it("digit + comment banks the rating AND forwards the comment as the turn — never swallowed", () => {
    const store = RunStore.openInMemory();
    try {
      const lesson = store.addLesson({ scope: "ask", text: "简短回答", source: "user_feedback" });
      seedPendingWithAppliedLessons(store, [lesson]);
      const event = turnEvent("2。今天天气怎么样", "u2");
      const result = new Gateway(store).intake(event, NOW);

      // The turn proceeds normally, carrying the rating signal for the daemon follow-up.
      expect(result).toMatchObject({
        ok: true,
        status: "created",
        rating_signal: { chat_id: CHAT, rating: 2, applied_lesson_ids: [lesson] }
      });
      // The run's message is the COMMENT (digit + separator stripped) — what the model sees.
      expect(store.listRecentRunStatuses(1)[0]!.goal).toBe("今天天气怎么样");
      // The rating + comment are stored; the pending is consumed; the ≥2 credit lands.
      expect(store.getLastSessionRating(CHAT)).toMatchObject({ rating: 2, comment: "今天天气怎么样" });
      expect(store.getPendingRating(CHAT)?.active).toBe(false);
      expect(store.getLesson(lesson)!.reuse_value).toBeCloseTo(1.25);
      // NO code-owned ack — the turn's real answer is the reply.
      expect(notificationText(store, `${event.idempotency_key}:rating`)).toBeUndefined();
      expect(notificationText(store, `${event.idempotency_key}:rating`)).not.toBe(RATING_ACK_COMMENT_TEXT);
    } finally {
      store.close();
    }
  });

  it("digit + newline comment forwards too (the piggy-backed request gets answered)", () => {
    const store = RunStore.openInMemory();
    try {
      seedPendingWithAppliedLessons(store, []);
      const result = new Gateway(store).intake(turnEvent("2\n帮我查一下明天的天气", "u2n"), NOW);

      expect(result).toMatchObject({ ok: true, status: "created" });
      expect(store.listRecentRunStatuses(1)[0]!.goal).toBe("帮我查一下明天的天气");
      expect(store.getLastSessionRating(CHAT)).toMatchObject({ rating: 2, comment: "帮我查一下明天的天气" });
    } finally {
      store.close();
    }
  });

  it("a redelivered digit+comment forwards again without a second capture or re-attribution", () => {
    const store = RunStore.openInMemory();
    try {
      seedPendingWithAppliedLessons(store, []);
      const gateway = new Gateway(store);
      const event = turnEvent("1，太啰嗦了", "u2r");
      const first = gateway.intake(event, NOW);
      const second = gateway.intake(event, NOW);

      expect(first).toMatchObject({ ok: true, status: "created", rating_signal: { rating: 1 } });
      expect(second).toMatchObject({ ok: true, status: "duplicate" });
      expect(second.ok && second.status === "duplicate" ? second.rating_signal : "set").toBeUndefined();
      const db = (store as unknown as {
        db: { prepare(sql: string): { get<T>(...v: unknown[]): T | undefined } };
      }).db;
      expect(db.prepare("SELECT COUNT(*) AS n FROM session_ratings").get<{ n: number }>()?.n).toBe(1);
    } finally {
      store.close();
    }
  });

  it("ANY other message while pending expires it silently and rides the normal turn path", () => {
    const store = RunStore.openInMemory();
    try {
      seedPendingWithAppliedLessons(store, []);
      const result = new Gateway(store).intake(turnEvent("对了帮我查下天气", "u3"), NOW);

      expect(result.ok).toBe(true);
      expect(result.ok && result.status).toBe("created"); // a real run — never hijacked
      expect(store.getPendingRating(CHAT)?.active).toBe(false); // expired silently
      expect(store.getLastSessionRating(CHAT)).toBeNull(); // nothing captured

      // The pending is gone, so a later bare digit is a normal message again.
      const late = new Gateway(store).intake(turnEvent("3", "u4"), NOW);
      expect(late.ok && late.status).toBe("created");
    } finally {
      store.close();
    }
  });

  it("a bare digit with NO pending routes to the normal turn", () => {
    const store = RunStore.openInMemory();
    try {
      const result = new Gateway(store).intake(turnEvent("3", "u5"), NOW);
      expect(result.ok && result.status).toBe("created");
      expect(store.getLastSessionRating(CHAT)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("a stale pending (past HOUGE_RATING_PENDING_MINUTES) no longer captures", () => {
    const store = RunStore.openInMemory();
    try {
      store.writePendingRating({ chat_id: CHAT, asked_at: minutesAgo(121), window_start: minutesAgo(240) });
      const result = new Gateway(store).intake(turnEvent("3", "u6"), NOW);
      expect(result.ok && result.status).toBe("created");
      expect(store.getPendingRating(CHAT)?.active).toBe(true); // untouched — expired by time alone
    } finally {
      store.close();
    }
  });

  it("a redelivered capture event replays the recorded result without a second ack", () => {
    const store = RunStore.openInMemory();
    try {
      seedPendingWithAppliedLessons(store, []);
      const gateway = new Gateway(store);
      const event = turnEvent("2", "u7");
      const first = gateway.intake(event, NOW);
      const second = gateway.intake(event, NOW);

      expect(second).toEqual(first);
      expect(store.countNotificationsByIdempotencyKey(`${event.idempotency_key}:rating`)).toBe(1);
      // Only one capture row.
      const db = (store as unknown as {
        db: { prepare(sql: string): { get<T>(...v: unknown[]): T | undefined } };
      }).db;
      const count = db.prepare("SELECT COUNT(*) AS n FROM session_ratings").get<{ n: number }>();
      expect(count?.n).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("surfacing (⓪·3 S2c)", () => {
  it("/lessons shows the rating count and a ⚠ when the lesson was low-rating-implicated", () => {
    const store = RunStore.openInMemory();
    try {
      const rated = store.addLesson({ scope: "ask", text: "简短回答", source: "user_feedback" });
      const flagged = store.addLesson({ scope: "ask", text: "结尾加俏皮话", source: "user_feedback" });
      store.applyRatingToLessons([rated, flagged], 3, minutesAgo(60));
      store.applyRatingToLessons([flagged], 1, NOW);
      store.flagRatingCulprit(flagged, "答非所问", NOW);

      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "lessons",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: CHAT },
        idempotency_key: "telegram:lessons-1",
        source_reference: "telegram:update:lessons-1"
      });
      const result = new Gateway(store).intake(event, NOW);
      expect(result.ok && result.status).toBe("lessons_returned");

      const text = notificationText(store, "telegram:lessons-1:lessons")!;
      expect(text).toContain("ratings 1");
      expect(text).toContain("ratings 2");
      expect(text).toContain("⚠ flagged");
      // The un-flagged lesson's line carries no warning.
      const ratedLine = text.split("\n").find((line) => line.includes("简短回答"))!;
      expect(ratedLine).toContain("ratings 1");
      expect(ratedLine).not.toContain("⚠ flagged");
    } finally {
      store.close();
    }
  });

  it("/status shows the rating state: pending ask, then the last capture, else none yet", () => {
    const store = RunStore.openInMemory();
    try {
      // The /status overview reads the real clock — use clock-relative timestamps.
      const askedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      const capturedAt = new Date().toISOString();
      const gateway = new Gateway(store);
      const statusEvent = (key: string) =>
        buildTypedTaskEvent({
          source: "telegram",
          type: "status",
          requested_by: { kind: "user", id: "paco" },
          notify: { kind: "telegram", chat_id: CHAT },
          idempotency_key: `telegram:${key}`,
          source_reference: `telegram:update:${key}`
        });

      gateway.intake(statusEvent("s1"), NOW);
      expect(notificationText(store, "telegram:s1:status")).toContain("Rating: none yet");

      store.writePendingRating({ chat_id: CHAT, asked_at: askedAt, window_start: capturedAt });
      gateway.intake(statusEvent("s2"), NOW);
      expect(notificationText(store, "telegram:s2:status")).toContain(
        `Rating: pending ask since ${askedAt}`
      );

      store.recordSessionRating({
        chat_id: CHAT,
        rating: 2,
        asked_at: askedAt,
        captured_at: capturedAt,
        applied_lesson_ids: []
      });
      gateway.intake(statusEvent("s3"), NOW);
      expect(notificationText(store, "telegram:s3:status")).toContain(`Rating: last 2/3 at ${capturedAt}`);
    } finally {
      store.close();
    }
  });
});
