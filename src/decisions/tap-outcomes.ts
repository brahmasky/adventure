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

const SAVE_VERDICTS: ReadonlySet<string> = new Set(["rule", "fact", "both"]);

/** The memory.kind row that SAVED in this run: the newest with verdict rule/fact/both (never a fix/other hand-off row). */
export function savedMemoryKindOf(store: RunStore, run_id: string): DecisionRow | undefined {
  return store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "memory.kind" && SAVE_VERDICTS.has(d.verdict)).at(-1);
}

/**
 * Spec 2026-10-15 §9: Undo of a memory save (a lesson's or a fact's) is a label against the run's turn.handler (value: its
 * lane) and memory.kind (value: the same lane, `planner` when the planner's own tool saved). Never throws, like recordTapOutcome.
 */
export function recordSaveUndone(store: RunStore, run_id: string, now: string = new Date().toISOString()): void {
  const handler = decisionOf(store, run_id, "turn.handler");
  if (handler) recordTapOutcome(store, handler.decision_id, "lesson_undone", handler.verdict, now);
  // The row that SAVED: the newest rule/fact/both, never an earlier fix/other hand-off row of the same run.
  const kind = savedMemoryKindOf(store, run_id);
  if (kind) recordTapOutcome(store, kind.decision_id, "lesson_undone", handler?.verdict ?? "planner", now);
}
