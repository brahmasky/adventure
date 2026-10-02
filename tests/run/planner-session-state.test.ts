import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { lessonSetFingerprint } from "../../src/run/lesson-render.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const CHAT = "42";
const t = (h: number) => `2026-10-01T0${h}:00:00.000Z`;
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

function finish(run_id: string): string {
  const worker = `w:${run_id}`;
  if (!store.claimRun(run_id, worker, 60)) throw new Error("claim failed");
  store.finishRun({ run_id, expected_worker_id: worker, next: "completed", report_ref: "r", duration_ms: 0, tool_calls: 0 });
  return run_id;
}
function scheduled(goal: string): string {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "schedule", type: "turn", program: "turn", goal, requested_by: { kind: "schedule", id: "sch_t" },
    notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `schedule:sch_t:${goal}`, source_reference: "scheduled_tasks.sch_t"
  }));
  if (!intake.ok) throw new Error("intake failed");
  return intake.run_id;
}
/** The gateway allows 5 Telegram commands a minute; this fixture builds more, so forget the audit rows first. */
function telegramRun(message: string): string {
  (store as unknown as { db: { prepare(sql: string): { run(): unknown } } }).db.prepare("DELETE FROM telegram_command_audit").run();
  return createQueuedTurnRun(store, message);
}
const said = (run_id: string, text: string, at: string) => {
  store.recordChatTurn({ chat_id: CHAT, run_id, role: "user", text, created_at: at });
  store.recordChatTurn({ chat_id: CHAT, run_id, role: "assistant", text: `reply ${text}`, created_at: at });
};

describe("planner_session_state (memory A1 §6)", () => {
  it("records a reset: fingerprint, a pending seed and one ledger row; the seed is claimed once", () => {
    expect(store.getPlannerSessionState(CHAT)).toBeUndefined();
    store.recordPlannerSessionReset(CHAT, "fp1", t(1));
    expect(store.getPlannerSessionState(CHAT)).toEqual({ chat_id: CHAT, lesson_fingerprint: "fp1", seed_pending: 1, updated_at: t(1) });
    expect(store.getLedgerEvents().filter((e) => e.event_type === "planner_session_reset").map((e) => e.payload)).toEqual([{ reason: "lesson_change", chat_id: CHAT }]);
    expect(store.claimSessionSeed(CHAT)).toBe(true);
    expect(store.claimSessionSeed(CHAT)).toBe(false);
    store.recordPlannerSessionReset(CHAT, "fp2", t(2));
    expect(store.getPlannerSessionState(CHAT)).toMatchObject({ lesson_fingerprint: "fp2", seed_pending: 1 });
  });

  it("the seed source: every user turn of the last 3 qualifying RUNS — schedule-born, unfinished and current runs excluded", () => {
    said(finish(telegramRun("m1")), "m1", t(1));
    said(finish(telegramRun("m2")), "m2", t(2));
    said(finish(scheduled("digest")), "digest", t(3));
    said(telegramRun("unfinished"), "unfinished", t(4));
    said(finish(telegramRun("m3")), "m3", t(5));
    const steered = finish(telegramRun("m4a"));
    said(steered, "m4a", t(6));
    store.recordChatTurn({ chat_id: CHAT, run_id: steered, role: "user", text: "m4b", created_at: t(6).replace(":00:00.000Z", ":30:00.000Z") });
    const current = telegramRun("now");
    said(current, "now", t(7));
    // a LIMIT on turns would return m3, m4a, m4b and lose m2
    expect(store.recentTelegramUserTurns(CHAT, current, 3).map((r) => r.text)).toEqual(["m2", "m3", "m4a", "m4b"]);
  });
});

describe("lessonSetFingerprint — the lesson SET, never the rendered bytes (spec §6)", () => {
  it("changes on a text edit, a theme change or a new lesson; not on a rating or a touch", () => {
    const a = store.addLesson({ scope: "ask", text: "answer briefly", source: "loop" });
    const fp0 = lessonSetFingerprint(store);
    store.applyRatingToLessons([a], 3, t(1));
    store.touchApplied([a]);
    expect(lessonSetFingerprint(store)).toBe(fp0);
    store.updateLessonText(a, "answer very briefly");
    const fp1 = lessonSetFingerprint(store);
    expect(fp1).not.toBe(fp0);
    expect(store.setLessonTheme(a, "format")).toBe(true);
    const fp2 = lessonSetFingerprint(store);
    expect(fp2).not.toBe(fp1);
    store.addLesson({ scope: "research", text: "cite sources", source: "loop" });
    expect(lessonSetFingerprint(store)).not.toBe(fp2);
  });

  it("changes on an avoid edit and when a lesson is retired", () => {
    const a = store.addLesson({ scope: "ask", text: "answer briefly", avoid: "rambling", source: "loop" });
    const b = store.addLesson({ scope: "ask", text: "cite sources", source: "loop" });
    const fp0 = lessonSetFingerprint(store);
    (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db.prepare("UPDATE lessons SET avoid = ? WHERE id = ?").run("padding", a);
    const fp1 = lessonSetFingerprint(store);
    expect(fp1).not.toBe(fp0);
    store.supersedeLesson(b, a);
    expect(lessonSetFingerprint(store)).not.toBe(fp1);
  });
});
