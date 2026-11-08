import { errorCode } from "../domain/error-code.js";
import type { ImprovementProposalRow, LessonUndoResult, MemoryUndoResult, RunStore } from "../run/run-store.js";

/**
 * Final fix D4 (2b-ii): Undo of a lesson or fact an improvement proposal saved. The change row carries the corrected turn's
 * run, but that turn's turn.handler never saved anything, so no `lesson_undone` label goes there (it would mislabel the turn
 * and feed the improve inbox its own reverted output). The proposal moves to `reverted` instead, so it no longer counts as
 * an accepted improvement. True when the change came from a proposal (whatever the move did); false otherwise.
 */
export function revertImproveSave(store: RunStore, change_id: string, now: string = new Date().toISOString()): boolean {
  let p;
  try { p = store.proposalByChange(change_id); } catch (e) { console.error(`[improve] undo lookup failed: ${errorCode(e)}`); return false; }
  if (!p) return false;
  try { store.transitionProposal({ proposal_id: p.proposal_id, from: ["accepted"], to: "reverted", now }); } catch (e) { console.error(`[improve] undo revert failed: ${errorCode(e)}`); }
  return true;
}

/** Spec 2026-11-07 §6: a plain removal (/forget <scope>'s final prune, /forget_memory's retire) moves the proposal that saved the row accepted → reverted in the caller's transaction, found by the saved id; its text then stays a repeat candidate for 14 days (addendum Rev 2.3.1 A). */
export function revertSavedProposal(store: RunStore, kind: "lesson" | "fact", id: number, now: string): boolean {
  const p = store.proposalBySaved(kind, id);
  return p !== undefined && store.transitionProposal({ proposal_id: p.proposal_id, from: ["accepted"], to: "reverted", now });
}

/** The change the proposal's save made (result_json.change_id), or null when it names none (the undo then reads not_found). */
function changeIdOf(p: ImprovementProposalRow): string | null {
  try { const c = (JSON.parse(p.result_json ?? "{}") as { change_id?: unknown }).change_id; return typeof c === "string" ? c : null; } catch { return null; }
}

/** R9: "restored N of M" — M is what the save superseded or pruned; nothing when it set nothing aside. */
const restoredOf = (restored: number, total: number, one: string, many: string): string =>
  (total === 0 ? "" : `; restored ${restored} of ${total} ${total === 1 ? one : many} its save had pruned`);

/**
 * Addendum Rev 2.3.1 B: `/forget <id>` on a lesson an accepted improvement proposal saved undoes that whole change (the lesson
 * goes, what its save pruned at the cap comes back) and reverts the proposal. A refused undo falls back to the status flip,
 * still reverts the proposal, and says nothing was restored. Undefined: no improvement saved it (today's path). Caller's transaction.
 */
export function forgetImprovementLesson(store: RunStore, id: number, now: string): string | undefined {
  const p = store.proposalBySaved("lesson", id);
  if (!p) return undefined;
  const change_id = changeIdOf(p);
  const r: LessonUndoResult = change_id ? store.undoLessonChangeTx(change_id, now) : { status: "not_found" };
  store.transitionProposal({ proposal_id: p.proposal_id, from: ["accepted"], to: "reverted", now });
  if (r.status === "undone") return `Forgotten ✓ — undid lesson #${id}${restoredOf(r.restored.length, (r.change.superseded_id !== null ? 1 : 0) + r.change.pruned_ids.length, "lesson", "lessons")}.`;
  return store.forgetLesson(id)
    ? `Forgotten ✓ — pruned lesson #${id}; what its save had pruned was not restored (${r.status}).`
    : `No active lesson #${id} to forget; its improvement is marked undone.`;
}

/**
 * Addendum Rev 2.3.1 B: `/forget <scope>` — newest first, undo the change of each active improvement-saved lesson in the scope
 * (an undo may restore an older one, which the next round undoes with its own proposal), then prune whatever is still active
 * there, restored rows included: the scope ends empty. The seen set bounds the loop and skips a lesson the join lists twice.
 * Caller's transaction; returns the undo count.
 */
export function forgetScopeWithUndo(store: RunStore, scope: string, now: string): number {
  const seen = new Set<string>();
  for (;;) {
    const next = store.improvementLessonsInScope(scope).find((x) => !seen.has(x.proposal_id));
    if (!next) break;
    seen.add(next.proposal_id);
    forgetImprovementLesson(store, next.lesson_id, now);
  }
  for (const id of store.forgetScope(scope)) revertSavedProposal(store, "lesson", id, now);
  return seen.size;
}

/**
 * Addendum Rev 2.3.1 B: `/forget_memory <id>` on a fact an accepted improvement proposal saved in THIS chat (R7: the undo
 * checks no chat) undoes that whole change and reverts the proposal; the reply is plain (undoing an undo is not offered). A
 * refused undo falls back to the retire and says so; a retire refused (the fact is gone) throws MEMORY_REFUSED, which rolls
 * the caller's whole command back (R8). Undefined: not an improvement fact of this chat (today's path and card).
 */
export function forgetImprovementFact(store: RunStore, id: number, chat_id: string, now: string): string | undefined {
  const p = store.proposalBySaved("fact", id);
  if (!p) return undefined;
  const change_id = changeIdOf(p);
  const change = change_id ? store.getMemoryChange(change_id) : undefined;
  if ((change?.chat_id ?? p.chat_id) !== chat_id) return undefined; // another chat's: today's path refuses it
  // an improvement-saved fact always takes this path: no readable change row is a refused undo (not_found), never today's Undo card
  const r: MemoryUndoResult = change ? store.undoMemoryChangeTx(change.change_id, now) : { status: "not_found" };
  store.transitionProposal({ proposal_id: p.proposal_id, from: ["accepted"], to: "reverted", now });
  if (r.status === "undone") return `Forgotten ✓ — undid memory #${id}${restoredOf(r.restored.length, r.change.old_ids.length + r.change.pruned_ids.length, "memory", "memories")}.`;
  store.retireMemoryRowsTx({ kind: "fact", ids: [id], chat_id, run_id: null, now });
  return `Forgotten ✓ — retired memory #${id}; what its save had pruned was not restored (${r.status}).`;
}
