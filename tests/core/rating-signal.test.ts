import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RATING_ATTRIBUTION_DISCIPLINE } from "../../src/capabilities/session-rating.js";
import { CoreWorker } from "../../src/core/core-worker.js";
import { parseRatingHistory, RunStore } from "../../src/run/run-store.js";

let dirs: string[] = [];
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-rating-signal-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const CHAT = "222";

/** A deterministic fake chain: the attribution pass gets a scripted verdict. */
function fakeLlm(script: {
  attribution?: string;
  calls?: Array<{ system: string; question: string }>;
}) {
  return async (input: Record<string, unknown>) => {
    const system = typeof input.system === "string" ? input.system : "";
    const question = typeof input.question === "string" ? input.question : "";
    script.calls?.push({ system, question });
    const answer =
      system === RATING_ATTRIBUTION_DISCIPLINE
        ? script.attribution ?? '{"culprit_lesson_id":null,"reason":""}'
        : "unexpected";
    return { ok: true as const, output: { question, answer, model: "fake" } };
  };
}

function seedSession(store: RunStore): void {
  store.recordChatTurn({ chat_id: CHAT, run_id: "run_1", role: "user", text: "帮我写周报" });
  store.recordChatTurn({ chat_id: CHAT, run_id: "run_1", role: "assistant", text: "好嘞，这是你的周报……" });
}

describe("CoreWorker.processRatingSignal (⓪·3 S2a)", () => {
  it("a good rating (≥2) is a no-op — no LLM call, no store change", async () => {
    const store = RunStore.openInMemory();
    try {
      const calls: Array<{ system: string; question: string }> = [];
      const worker = new CoreWorker(store, projectRoot(), fakeLlm({ calls }));
      const lesson = store.addLesson({ scope: "ask", text: "简短回答", source: "user_feedback" });

      await worker.processRatingSignal({ chat_id: CHAT, rating: 2, applied_lesson_ids: [lesson] });

      expect(calls).toHaveLength(0);
      expect(store.getLesson(lesson)?.corrected_count).toBe(0);
    } finally {
      store.close();
    }
  });

  it("low rating + culprit verdict → the lesson is flagged (correction, −0.5 reuse, note)", async () => {
    const store = RunStore.openInMemory();
    try {
      const lesson = store.addLesson({ scope: "ask", text: "结尾加俏皮话", source: "user_feedback" });
      seedSession(store);
      const calls: Array<{ system: string; question: string }> = [];
      const worker = new CoreWorker(
        store,
        projectRoot(),
        fakeLlm({ attribution: `{"culprit_lesson_id":${lesson},"reason":"跑题"}`, calls })
      );

      await worker.processRatingSignal({ chat_id: CHAT, rating: 1, applied_lesson_ids: [lesson] });

      const row = store.getLesson(lesson)!;
      expect(row.corrected_count).toBe(1);
      expect(row.reuse_value).toBeCloseTo(0.5);
      expect(row.status).toBe("active"); // one low rating only flags
      expect(parseRatingHistory(row.rating_history)).toEqual([
        expect.objectContaining({ flag: "culprit", reason: "跑题" })
      ]);
      // Exactly ONE bounded attribution call; the transcript and lesson rode as DATA.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.question).toContain(`#${lesson}: 结尾加俏皮话`);
      expect(calls[0]?.question).toContain("帮我写周报");
    } finally {
      store.close();
    }
  });

  it("a 'none' verdict and garbage both leave every lesson untouched", async () => {
    const store = RunStore.openInMemory();
    try {
      const lesson = store.addLesson({ scope: "ask", text: "用中文", source: "user_feedback" });
      seedSession(store);

      const none = new CoreWorker(store, projectRoot(), fakeLlm({}));
      await none.processRatingSignal({ chat_id: CHAT, rating: 0, applied_lesson_ids: [lesson] });
      expect(store.getLesson(lesson)?.corrected_count).toBe(0);

      const garbage = new CoreWorker(store, projectRoot(), fakeLlm({ attribution: "呃这个嘛……" }));
      await garbage.processRatingSignal({ chat_id: CHAT, rating: 0, applied_lesson_ids: [lesson] });
      expect(store.getLesson(lesson)?.corrected_count).toBe(0);
    } finally {
      store.close();
    }
  });

  it("no applied lessons → no attribution call (nothing to attribute to)", async () => {
    const store = RunStore.openInMemory();
    try {
      seedSession(store);
      const calls: Array<{ system: string; question: string }> = [];
      const worker = new CoreWorker(store, projectRoot(), fakeLlm({ calls }));
      await worker.processRatingSignal({ chat_id: CHAT, rating: 0, applied_lesson_ids: [] });
      expect(calls).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("comments are NOT lessoned here — the gateway forwards them as the turn (no double-lesson)", async () => {
    const store = RunStore.openInMemory();
    try {
      const prior = store.addLesson({ scope: "ask", text: "长篇详细回答", source: "user_feedback" });
      seedSession(store);
      const calls: Array<{ system: string; question: string }> = [];
      const worker = new CoreWorker(store, projectRoot(), fakeLlm({ calls }));

      // The daemon passes only the signal — the comment already ran as a normal turn.
      await worker.processRatingSignal({ chat_id: CHAT, rating: 1, applied_lesson_ids: [prior] });

      // Exactly the attribution pass — no distill, no reconcile, no lesson write.
      expect(calls.map((c) => c.system)).toEqual([RATING_ATTRIBUTION_DISCIPLINE]);
      expect(store.getLesson(prior)?.status).toBe("active");
      expect(store.listLessons("ask")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("accumulate-before-acting end to end: the second low-rated culprit session demotes", async () => {
    const store = RunStore.openInMemory();
    try {
      const lesson = store.addLesson({ scope: "ask", text: "结尾加俏皮话", source: "user_feedback" });
      seedSession(store);
      const worker = new CoreWorker(
        store,
        projectRoot(),
        fakeLlm({ attribution: `{"culprit_lesson_id":${lesson},"reason":"没用"}` })
      );

      // Session 1: the capture path appended the low rating, then the pass flags.
      store.applyRatingToLessons([lesson], 1, "2026-07-01T12:00:00.000Z");
      await worker.processRatingSignal({ chat_id: CHAT, rating: 1, applied_lesson_ids: [lesson] });
      expect(store.getLesson(lesson)?.status).toBe("active");

      // Session 2: same again → the pattern acts.
      store.applyRatingToLessons([lesson], 0, "2026-07-02T12:00:00.000Z");
      await worker.processRatingSignal({ chat_id: CHAT, rating: 0, applied_lesson_ids: [lesson] });
      expect(store.getLesson(lesson)?.status).toBe("pruned");
    } finally {
      store.close();
    }
  });
});
