import type { DecisionRow, RunStore } from "../run/run-store.js";
import { message } from "./decide.js";
import type { DecisionSignal } from "./types.js";

/**
 * Paco's taps as outcome rows (Addition A): Dig deeper, Undo, 认真想 beside the digest's ✅/❌. A tap never fails on this:
 * a refused value or a decision the run never recorded (pre-ladder turns) is logged with the signal only, and the tap's
 * own effect (the Undo, the re-run) has already happened.
 */
export function recordTapOutcome(store: RunStore, decision_id: string, signal: DecisionSignal, value: string, now: string = new Date().toISOString()): boolean {
  try {
    return store.insertDecisionOutcome({ decision_id, signal, value, source: "paco", created_at: now }).inserted;
  } catch (e) {
    console.error(`decisions: ${signal} outcome not written (${message(e)})`);
    return false;
  }
}

export function decisionOf(store: RunStore, run_id: string, entry_id: string): DecisionRow | undefined {
  return store.listDecisionsForRun(run_id).find((d) => d.entry_id === entry_id);
}
