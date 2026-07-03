import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LESSON_DECAY_DAYS,
  DEFAULT_LESSON_PRUNE_THRESHOLD,
  DEFAULT_LESSON_REPEAT_DAYS,
  parseRatingHistory,
  resolveLessonDecayDays,
  resolveLessonPruneThreshold,
  resolveLessonRepeatDays,
  RunStore
} from "../../src/run/run-store.js";

// Hermetic: pin every new lesson-signal env var to its default (delete) and restore.
const LESSON_ENV_VARS = [
  "HOUGE_LESSON_DECAY_DAYS",
  "HOUGE_LESSON_PRUNE_THRESHOLD",
  "HOUGE_LESSON_REPEAT_DAYS"
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of LESSON_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of LESSON_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const NOW = "2026-07-03T12:00:00.000Z";
const CHAT = "222";

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

describe("pending rating + session rating storage", () => {
  it("write → get → cancel: the row deactivates but keeps asked_at (the durable cooldown)", () => {
    const store = RunStore.openInMemory();
    try {
      store.writePendingRating({ chat_id: CHAT, asked_at: NOW, window_start: daysAgo(1) });
      expect(store.getPendingRating(CHAT)).toEqual({
        chat_id: CHAT,
        asked_at: NOW,
        window_start: daysAgo(1),
        active: true
      });

      store.cancelPendingRating(CHAT);
      const cancelled = store.getPendingRating(CHAT);
      expect(cancelled?.active).toBe(false);
      expect(cancelled?.asked_at).toBe(NOW);

      // A new ask reactivates the single row.
      store.writePendingRating({ chat_id: CHAT, asked_at: daysAgo(-1), window_start: NOW });
      expect(store.getPendingRating(CHAT)?.active).toBe(true);
    } finally {
      store.close();
    }
  });

  it("recordSessionRating stores the capture (with applied ids) and deactivates the pending", () => {
    const store = RunStore.openInMemory();
    try {
      store.writePendingRating({ chat_id: CHAT, asked_at: daysAgo(0.1), window_start: daysAgo(1) });
      store.recordSessionRating({
        chat_id: CHAT,
        rating: 1,
        comment: "太啰嗦",
        asked_at: daysAgo(0.1),
        captured_at: NOW,
        applied_lesson_ids: [3, 5]
      });

      expect(store.getPendingRating(CHAT)?.active).toBe(false);
      const last = store.getLastSessionRating(CHAT);
      expect(last).toMatchObject({ chat_id: CHAT, rating: 1, comment: "太啰嗦", captured_at: NOW });
      expect(JSON.parse(last!.applied_lesson_ids)).toEqual([3, 5]);
    } finally {
      store.close();
    }
  });

  it("getRatingStatus: an answerable pending wins; else the last capture; else nulls", () => {
    const store = RunStore.openInMemory();
    try {
      expect(store.getRatingStatus(NOW, 120 * 60_000)).toEqual({
        pending_since: null,
        last_rating: null,
        last_rating_at: null
      });

      store.writePendingRating({ chat_id: CHAT, asked_at: daysAgo(0.01), window_start: daysAgo(1) });
      expect(store.getRatingStatus(NOW, 120 * 60_000).pending_since).toBe(daysAgo(0.01));

      // Past the pending window → no longer "pending" even though the row is active.
      expect(store.getRatingStatus(NOW, 60_000).pending_since).toBeNull();

      store.recordSessionRating({
        chat_id: CHAT,
        rating: 2,
        asked_at: daysAgo(0.01),
        captured_at: NOW,
        applied_lesson_ids: []
      });
      expect(store.getRatingStatus(NOW, 120 * 60_000)).toEqual({
        pending_since: null,
        last_rating: 2,
        last_rating_at: NOW
      });
    } finally {
      store.close();
    }
  });
});

describe("rating → lesson signal math", () => {
  it("applyRatingToLessons appends {rating, at}; ≥2 earns +0.25 reuse, ≤1 appends only", () => {
    const store = RunStore.openInMemory();
    try {
      const good = store.addLesson({ scope: "ask", text: "简短回答", source: "user_feedback" });
      const low = store.addLesson({ scope: "ask", text: "用中文", source: "user_feedback" });

      store.applyRatingToLessons([good], 3, NOW);
      store.applyRatingToLessons([low], 1, NOW);

      const goodRow = store.getLesson(good)!;
      expect(goodRow.reuse_value).toBeCloseTo(1.25);
      expect(parseRatingHistory(goodRow.rating_history)).toEqual([{ rating: 3, at: NOW }]);

      const lowRow = store.getLesson(low)!;
      expect(lowRow.reuse_value).toBeCloseTo(1.0);
      expect(parseRatingHistory(lowRow.rating_history)).toEqual([{ rating: 1, at: NOW }]);
    } finally {
      store.close();
    }
  });

  it("flagRatingCulprit: correction + −0.5 reuse + note; demotes at the SECOND low rating, not the first", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addLesson({ scope: "ask", text: "结尾加俏皮话", source: "user_feedback" });

      // Session 1: low rating captured, then the pass names this lesson culprit.
      store.applyRatingToLessons([id], 1, daysAgo(1));
      const first = store.flagRatingCulprit(id, "答非所问", daysAgo(1));
      expect(first.demoted).toBe(false);
      let row = store.getLesson(id)!;
      expect(row.status).toBe("active"); // a single low rating only flags
      expect(row.corrected_count).toBe(1);
      expect(row.reuse_value).toBeCloseTo(0.5);
      expect(parseRatingHistory(row.rating_history)).toEqual([
        { rating: 1, at: daysAgo(1) },
        { at: daysAgo(1), flag: "culprit", reason: "答非所问" }
      ]);

      // Session 2: a second low-rating implication → the pattern demotes (reversibly).
      store.applyRatingToLessons([id], 0, NOW);
      const second = store.flagRatingCulprit(id, "还是不对", NOW);
      expect(second.demoted).toBe(true);
      row = store.getLesson(id)!;
      expect(row.status).toBe("pruned");
      expect(row.corrected_count).toBe(2);
      expect(row.reuse_value).toBeCloseTo(0);
    } finally {
      store.close();
    }
  });

  it("parseRatingHistory degrades garbage to []", () => {
    expect(parseRatingHistory("not json")).toEqual([]);
    expect(parseRatingHistory('{"a":1}')).toEqual([]);
    expect(parseRatingHistory("[1, null]")).toEqual([]);
  });
});

describe("appliedLessonIdsForChat — the attribution union", () => {
  it("unions loop_started.applied_artifacts.lesson_ids across the window's runs only", () => {
    const store = RunStore.openInMemory();
    try {
      const seed = (run_id: string, at: string, lesson_ids: number[]): void => {
        store.recordChatTurn({ chat_id: CHAT, run_id, role: "user", text: "q", created_at: at });
        store.recordLoopStarted(run_id, {
          manifest: ["llm_answer"],
          hint: "ask",
          applied_artifacts: { lesson_scopes: ["ask"], lesson_ids, skill_scopes: [] }
        });
      };
      seed("run_in_1", daysAgo(0.2), [1, 2]);
      seed("run_in_2", daysAgo(0.1), [2, 3]);
      seed("run_out", daysAgo(3), [9]); // outside the window

      // A run in another chat never leaks in.
      store.recordChatTurn({ chat_id: "999", run_id: "run_other", role: "user", text: "q", created_at: NOW });
      store.recordLoopStarted("run_other", {
        manifest: [],
        hint: "ask",
        applied_artifacts: { lesson_scopes: [], lesson_ids: [42], skill_scopes: [] }
      });

      expect(store.appliedLessonIdsForChat(CHAT, daysAgo(1))).toEqual([1, 2, 3]);
    } finally {
      store.close();
    }
  });
});

describe("saveReconciledLesson — correction wiring + escalation (S2b)", () => {
  it("SUPERSEDE records a correction on the target: corrected_count +1, reuse −0.5", () => {
    const store = RunStore.openInMemory();
    try {
      const target = store.addLesson({ scope: "ask", text: "always answer in English", source: "user_feedback" });
      const result = store.saveReconciledLesson(
        { scope: "ask", text: "用中文回答" },
        { verdict: "SUPERSEDE", id: target },
        "user_feedback",
        NOW
      );
      expect(result.verb).toBe("supersede");
      expect(result.escalate).toBeUndefined(); // first correction — no escalation
      const old = store.getLesson(target)!;
      expect(old.status).toBe("superseded");
      expect(old.corrected_count).toBe(1);
      expect(old.reuse_value).toBeCloseTo(0.5);
    } finally {
      store.close();
    }
  });

  it("UPDATE does not count as a correction", () => {
    const store = RunStore.openInMemory();
    try {
      const target = store.addLesson({ scope: "ask", text: "keep answers short", source: "user_feedback" });
      store.saveReconciledLesson(
        { scope: "ask", text: "and use bullet points" },
        { verdict: "UPDATE", id: target, text: "keep answers short, in bullet points" },
        "user_feedback",
        NOW
      );
      const old = store.getLesson(target)!;
      expect(old.corrected_count).toBe(0);
      expect(old.reuse_value).toBeCloseTo(1.0);
    } finally {
      store.close();
    }
  });

  it("escalates when the target's lineage holds a supersede within HOUGE_LESSON_REPEAT_DAYS", () => {
    const store = RunStore.openInMemory();
    try {
      const root = store.addLesson({ scope: "ask", text: "v1", source: "user_feedback", created_at: daysAgo(10) });
      // First supersede 2 days ago (inside the 7-day default window).
      const mid = store.saveReconciledLesson(
        { scope: "ask", text: "v2" },
        { verdict: "SUPERSEDE", id: root },
        "user_feedback",
        daysAgo(2)
      );
      // The repeat: superseding the chain again today → the memory layer looks ineffective.
      const repeat = store.saveReconciledLesson(
        { scope: "ask", text: "v3" },
        { verdict: "SUPERSEDE", id: mid.id! },
        "user_feedback",
        NOW
      );
      expect(repeat.escalate).toBe(true);
    } finally {
      store.close();
    }
  });

  it("does NOT escalate when the prior supersede is older than the repeat window", () => {
    const store = RunStore.openInMemory();
    try {
      const root = store.addLesson({ scope: "ask", text: "v1", source: "user_feedback", created_at: daysAgo(20) });
      const mid = store.saveReconciledLesson(
        { scope: "ask", text: "v2" },
        { verdict: "SUPERSEDE", id: root },
        "user_feedback",
        daysAgo(8) // outside the 7-day default window
      );
      const repeat = store.saveReconciledLesson(
        { scope: "ask", text: "v3" },
        { verdict: "SUPERSEDE", id: mid.id! },
        "user_feedback",
        NOW
      );
      expect(repeat.escalate).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("escalates on corrected_count ≥ 2 even without a recent supersede in the lineage", () => {
    const store = RunStore.openInMemory();
    try {
      const target = store.addLesson({ scope: "ask", text: "v1", source: "user_feedback", created_at: daysAgo(30) });
      store.recordCorrection(target); // e.g. a prior low-rating culprit flag
      const result = store.saveReconciledLesson(
        { scope: "ask", text: "v2" },
        { verdict: "SUPERSEDE", id: target },
        "user_feedback",
        NOW
      );
      expect(result.escalate).toBe(true);
    } finally {
      store.close();
    }
  });

  it("honors HOUGE_LESSON_REPEAT_DAYS", () => {
    const store = RunStore.openInMemory();
    try {
      process.env.HOUGE_LESSON_REPEAT_DAYS = "30";
      const root = store.addLesson({ scope: "ask", text: "v1", source: "user_feedback", created_at: daysAgo(40) });
      const mid = store.saveReconciledLesson(
        { scope: "ask", text: "v2" },
        { verdict: "SUPERSEDE", id: root },
        "user_feedback",
        daysAgo(8) // outside 7, inside 30
      );
      const repeat = store.saveReconciledLesson(
        { scope: "ask", text: "v3" },
        { verdict: "SUPERSEDE", id: mid.id! },
        "user_feedback",
        NOW
      );
      expect(repeat.escalate).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("runLessonDecayTick — the daily forgetting pass", () => {
  it("decays unused lessons by 20%, prunes below the threshold, and summarizes in one ledger event", () => {
    const store = RunStore.openInMemory();
    try {
      const staleStrong = store.addLesson({ scope: "ask", text: "stale strong", source: "user_feedback", created_at: daysAgo(30) });
      const staleWeak = store.addLesson({ scope: "ask", text: "stale weak", source: "migration", created_at: daysAgo(30) });
      const fresh = store.addLesson({ scope: "ask", text: "fresh", source: "user_feedback", created_at: daysAgo(30) });
      store.touchApplied([fresh], daysAgo(1)); // recently used → untouched
      // Push the weak one near the floor so one decay crosses the prune threshold.
      store.flagRatingCulprit(staleWeak, "", daysAgo(20)); // 1.0 → 0.5
      store.flagRatingCulprit(staleWeak, "", daysAgo(20)); // 0.5 → 0.0 (still active: only one low rating entry — none, actually)

      const result = store.runLessonDecayTick(NOW);
      expect(result.ran).toBe(true);
      expect(result.lessons_decayed).toBe(2);
      expect(result.pruned_ids).toEqual([staleWeak]);

      expect(store.getLesson(staleStrong)?.reuse_value).toBeCloseTo(0.8);
      expect(store.getLesson(staleStrong)?.status).toBe("active");
      expect(store.getLesson(staleWeak)?.status).toBe("pruned"); // 0.0 * 0.8 = 0 < 0.2
      expect(store.getLesson(fresh)?.reuse_value).toBeCloseTo(1.0);

      const events = store.getLedgerEvents().filter((e) => e.event_type === "lesson_decay_tick");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ lessons_decayed: 2, pruned_ids: [staleWeak] });
    } finally {
      store.close();
    }
  });

  it("is idempotent per day: a second tick the same day is a no-op; the next day runs again", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addLesson({ scope: "ask", text: "stale", source: "migration", created_at: daysAgo(30) });
      expect(store.runLessonDecayTick(NOW).ran).toBe(true);
      expect(store.getLesson(id)?.reuse_value).toBeCloseTo(0.8);

      expect(store.runLessonDecayTick(NOW).ran).toBe(false);
      expect(store.runLessonDecayTick(new Date(Date.parse(NOW) + 3_600_000).toISOString()).ran).toBe(false);
      expect(store.getLesson(id)?.reuse_value).toBeCloseTo(0.8);

      const nextDay = new Date(Date.parse(NOW) + 25 * 3_600_000).toISOString();
      expect(store.runLessonDecayTick(nextDay).ran).toBe(true);
      expect(store.getLesson(id)?.reuse_value).toBeCloseTo(0.64);
    } finally {
      store.close();
    }
  });

  it("never-applied migration lessons decay from created_at; recent creations do not", () => {
    const store = RunStore.openInMemory();
    try {
      const old = store.addLesson({ scope: "ask", text: "old migrated", source: "migration", created_at: daysAgo(15) });
      const young = store.addLesson({ scope: "ask", text: "young migrated", source: "migration", created_at: daysAgo(10) });
      const result = store.runLessonDecayTick(NOW); // default 14-day cutoff
      expect(result.lessons_decayed).toBe(1);
      expect(store.getLesson(old)?.reuse_value).toBeCloseTo(0.8);
      expect(store.getLesson(young)?.reuse_value).toBeCloseTo(1.0);
    } finally {
      store.close();
    }
  });

  it("honors HOUGE_LESSON_DECAY_DAYS and HOUGE_LESSON_PRUNE_THRESHOLD", () => {
    const store = RunStore.openInMemory();
    try {
      process.env.HOUGE_LESSON_DECAY_DAYS = "5";
      process.env.HOUGE_LESSON_PRUNE_THRESHOLD = "0.9";
      const id = store.addLesson({ scope: "ask", text: "stale", source: "user_feedback", created_at: daysAgo(6) });
      const result = store.runLessonDecayTick(NOW);
      expect(result.lessons_decayed).toBe(1);
      // 1.0 * 0.8 = 0.8 < 0.9 → pruned under the raised threshold.
      expect(result.pruned_ids).toEqual([id]);
      expect(store.getLesson(id)?.status).toBe("pruned");
    } finally {
      store.close();
    }
  });

  it("resolver defaults are pinned", () => {
    expect(resolveLessonDecayDays(process.env)).toBe(DEFAULT_LESSON_DECAY_DAYS);
    expect(resolveLessonPruneThreshold(process.env)).toBe(DEFAULT_LESSON_PRUNE_THRESHOLD);
    expect(resolveLessonRepeatDays(process.env)).toBe(DEFAULT_LESSON_REPEAT_DAYS);
    expect(resolveLessonDecayDays({ HOUGE_LESSON_DECAY_DAYS: "3" } as NodeJS.ProcessEnv)).toBe(3);
    expect(resolveLessonPruneThreshold({ HOUGE_LESSON_PRUNE_THRESHOLD: "0.4" } as NodeJS.ProcessEnv)).toBe(0.4);
    expect(resolveLessonRepeatDays({ HOUGE_LESSON_REPEAT_DAYS: "0" } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_LESSON_REPEAT_DAYS
    );
  });
});
