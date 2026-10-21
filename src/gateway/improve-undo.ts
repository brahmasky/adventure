import { errorCode } from "../domain/error-code.js";
import type { RunStore } from "../run/run-store.js";

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
