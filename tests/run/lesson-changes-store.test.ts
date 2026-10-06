import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

const NOW = "2026-10-04T10:00:00.000Z";
function lesson(store: RunStore, text: string, scope = "ask"): number {
  return store.addLesson({ scope, text, theme: "format", source: "loop", created_at: NOW });
}

// Spec §5.6: Undo restores each affected row to its RECORDED prior state, compare-and-set, one transaction.
describe("lesson_changes + undo", () => {
  it("retires the new row, reactivates the superseded one and un-prunes the cap victims", () => {
    const store = RunStore.openInMemory();
    const old = lesson(store, "old rule"); const victim = lesson(store, "weak rule");
    const saved = store.saveReconciledLesson({ scope: "ask", text: "new rule", theme: "format" }, { verdict: "UPDATE", id: old, text: "new rule" }, "lane", NOW, 1);
    expect(saved.id).toBeDefined(); expect(saved.prunedIds).toContain(victim);
    const change = store.insertLessonChange({ run_id: "run_1", chat_id: "555", new_id: saved.id!, superseded_id: old, pruned_ids: saved.prunedIds });
    const r = store.undoLessonChange(change.change_id, NOW);
    expect(r.status).toBe("undone");
    if (r.status !== "undone") return;
    expect(r.restored.sort()).toEqual([old, victim].sort());
    expect(store.getLesson(saved.id!)?.status).toBe("pruned");
    expect(store.getLesson(old)?.status).toBe("active");
    expect(store.getLesson(victim)?.status).toBe("active");
    expect(store.getLessonChange(change.change_id)?.undone_at).toBe(NOW);
    expect(store.getLedgerEvents().some((e) => e.event_type === "lesson_change_undone" && e.payload.change_id === change.change_id)).toBe(true);
    store.close();
  });
  it("refuses when the new row was changed since, and reports already_undone on a second tap", () => {
    const store = RunStore.openInMemory();
    const id = lesson(store, "rule");
    const change = store.insertLessonChange({ run_id: null, chat_id: "555", new_id: id, superseded_id: null, pruned_ids: [] });
    store.saveReconciledLesson({ scope: "ask", text: "newer", theme: "format" }, { verdict: "SUPERSEDE", id }, "loop", NOW, 20); // a later write superseded #id
    expect(store.undoLessonChange(change.change_id, NOW).status).toBe("changed_since");
    const fresh = lesson(store, "x"); const c2 = store.insertLessonChange({ run_id: null, chat_id: "555", new_id: fresh, superseded_id: null, pruned_ids: [] });
    expect(store.undoLessonChange(c2.change_id, NOW).status).toBe("undone");
    expect(store.undoLessonChange(c2.change_id, NOW).status).toBe("already_undone");
    store.close();
  });
  it("leaves a row alone when its status moved since and names it in skipped", () => {
    const store = RunStore.openInMemory();
    const victim = lesson(store, "weak"); const kept = lesson(store, "new");
    const change = store.insertLessonChange({ run_id: null, chat_id: "555", new_id: kept, superseded_id: null, pruned_ids: [victim] });
    store.unpruneLesson(victim); // someone restored it already (status active, not pruned)
    const r = store.undoLessonChange(change.change_id, NOW);
    expect(r.status === "undone" && r.skipped).toEqual([victim]);
    store.close();
  });
  it("unpruneLesson only restores a pruned row", () => {
    const store = RunStore.openInMemory();
    const id = lesson(store, "a");
    expect(store.unpruneLesson(id)).toBe(false);
    store.forgetLesson(id);
    expect(store.unpruneLesson(id)).toBe(true);
    expect(store.getLesson(id)?.status).toBe("active");
    store.close();
  });
  it("helpers: triageOverrideFor, countRecentLedgerEvents, userTurnTextForRun", () => {
    const store = RunStore.openInMemory();
    store.recordChatTurn({ chat_id: "555", run_id: "run_a", role: "user", text: "以后回复短一点" });
    store.recordMemoryEvent("triage_override", { run_id: "run_a", new_run_id: "run_b", change_id: null });
    expect(store.triageOverrideFor("run_b")).toBe(true);
    expect(store.triageOverrideFor("run_a")).toBe(false);
    expect(store.countRecentLedgerEvents("triage_override", "2026-01-01T00:00:00.000Z")).toBe(1);
    expect(store.userTurnTextForRun("run_a")).toBe("以后回复短一点");
    store.close();
  });
});
