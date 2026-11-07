import { saveMemoryPlan, type MemoryPlan } from "../capabilities/memory-save.js";
import { redactForImprove } from "../decisions/egress.js";
import type { RunStore } from "../run/run-store.js";
import { clip, parsed, str } from "./proposal-card.js";

/** Spec 2026-11-07 §5: the /changes line of an applied proposal — id, scope, a 60-code-point excerpt of the stored text and the undo command. */
export const APPLIED_EXCERPT_CHARS = 60;
export type AppliedResult = { change_id: string; lesson_id: number } | { change_id: string; fact_id: number };
export interface ApplyInput { proposal_id: string; target: "lesson" | "fact"; draft_json: string; run_id: string; chat_id: string; now: string }

export function memoryPlanOf(target: "lesson" | "fact", draft: Record<string, unknown>): MemoryPlan {
  return target === "lesson" ? { lesson: draft as unknown as NonNullable<MemoryPlan["lesson"]> } : { fact: draft as unknown as NonNullable<MemoryPlan["fact"]> };
}

export function appliedLine(store: RunStore, target: "lesson" | "fact", result: AppliedResult, draft: Record<string, unknown>): string {
  const text = clip(redactForImprove(store, str(draft.text)), APPLIED_EXCERPT_CHARS);
  return "lesson_id" in result
    ? `📒 Lesson #${result.lesson_id} learned from your correction (${str(draft.scope) || "ask"}): ${text} — undo: /forget ${result.lesson_id}`
    : `🧠 Fact #${(result as { fact_id: number }).fact_id} learned from your correction: ${text} — undo: /forget_memory ${(result as { fact_id: number }).fact_id}`;
}

/**
 * Inside the group's transaction (never through acceptProposal, whose inTransaction would nest): the memory lane's writers,
 * then `accepted` with the ids, then the /changes row keyed by proposal. A capped lesson or a save with no change id applies
 * nothing and returns null (the caller queues the card); a lost transition or a refused log row throws, rolling the group back.
 */
export function applyProposal(store: RunStore, i: ApplyInput): AppliedResult | null {
  const draft = parsed(i.draft_json);
  const saved = saveMemoryPlan(store, memoryPlanOf(i.target, draft), { run_id: i.run_id, chat_id: i.chat_id, source: "improve", now: i.now });
  const result: AppliedResult | null = saved.lesson && !("capped" in saved.lesson) ? { change_id: saved.lesson.change_id, lesson_id: saved.lesson.id }
    : saved.fact ? { change_id: saved.fact.change_id, fact_id: saved.fact.id } : null;
  if (!result) return null;
  if (!store.transitionProposal({ proposal_id: i.proposal_id, from: ["open"], to: "accepted", now: i.now, result_json: JSON.stringify(result) })) throw new Error("apply_lost");
  const r = store.enqueueNotification({ topic: "improve_log", idempotency_key: `improve_applied:${i.proposal_id}`, correlation_id: `improve_proposal:${i.proposal_id}`, text: appliedLine(store, i.target, result, draft), now: i.now });
  if (r.status !== "logged") throw new Error(`apply_log_${r.status}`);
  return result;
}
