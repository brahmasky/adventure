import { LESSON_CAPPED_HINT } from "./lesson-write.js";
import type { RunStore } from "../run/run-store.js";

/**
 * 2b-ii §5.3 (ruling 8): an accepted lesson or fact proposal lands through the memory lane's own store writers under the
 * origin run — saveReconciledLesson / saveReconciledFact with verdict ADD, the lesson_changes Undo row, the memory_changes
 * add row and the lesson_saved / fact_saved events — so Undo, recordSaveUndone and the cards work unchanged.
 */
export interface MemoryPlan { lesson?: { scope: string; text: string; avoid?: string }; fact?: { text: string; evidence: { line: number; quote: string }; source_turn_ids: string[] } }
export interface MemorySaveCtx { run_id: string; chat_id: string; source: "improve"; now: string }
export type MemorySaved = { lesson?: { id: number; change_id: string } | { capped: true }; fact?: { id: number; change_id: string } };
export { LESSON_CAPPED_HINT };

/** Inside the caller's transaction (the tap's), nothing here opens one. */
export function saveMemoryPlan(store: RunStore, plan: MemoryPlan, ctx: MemorySaveCtx): MemorySaved {
  const out: MemorySaved = {};
  if (plan.lesson) {
    const s = store.saveReconciledLesson({ scope: plan.lesson.scope, text: plan.lesson.text, ...(plan.lesson.avoid ? { avoid: plan.lesson.avoid } : {}) }, { verdict: "ADD" }, ctx.source, ctx.now);
    if (s.id === undefined) out.lesson = { capped: true };
    else {
      const change = store.insertLessonChange({ run_id: ctx.run_id, chat_id: ctx.chat_id, new_id: s.id, superseded_id: s.supersededId ?? null, pruned_ids: s.prunedIds, created_at: ctx.now });
      store.appendRunLedgerEvent(ctx.run_id, "lesson_saved", "core", { lesson_id: s.id, change_id: change.change_id, source: ctx.source });
      out.lesson = { id: s.id, change_id: change.change_id };
    }
  }
  if (plan.fact) {
    const f = store.saveReconciledFact({ chat_id: ctx.chat_id, fact: plan.fact.text, participants: ["paco"], source_turn_ids: plan.fact.source_turn_ids, is_core: false, salience: 1.0 }, { verdict: "ADD" }, ctx.now);
    if (f.id !== undefined && f.verb !== "drop") {
      const change = store.insertFactAddChange({ new_id: f.id, superseded_id: f.supersededId ?? null, pruned_ids: f.prunedIds, run_id: ctx.run_id, chat_id: ctx.chat_id, now: ctx.now });
      store.appendRunLedgerEvent(ctx.run_id, "fact_saved", "core", { fact_id: f.id, verb: f.verb, change_id: change.change_id });
      out.fact = { id: f.id, change_id: change.change_id };
    }
  }
  return out;
}
