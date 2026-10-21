import type { DecisionSignal } from "./types.js";
import { errorCode } from "../domain/error-code.js";
import { OutcomeRejected } from "./outcomes.js";
import type { ImproveSignalInsert, JevVerdictRow, RunStore } from "../run/run-store.js";

/**
 * The improvement producers (2b-ii §2). A producer writes an inbox row, never a decision_outcomes row (a failed run or a
 * pre-ladder turn may have no decision). It never throws into its caller (recordTapOutcome's contract): what cannot be
 * inserted becomes an `improve_signal_skipped {signal, code}` event, counted per family by the digest's Watch line.
 */
export type SkipCode = "no_run" | "no_capability" | "refused" | "store_error";

export function recordImproveSignal(store: RunStore, s: ImproveSignalInsert): boolean {
  try {
    return store.insertImproveSignal(s) > 0;
  } catch (e) {
    const code: SkipCode = e instanceof OutcomeRejected ? "refused" : "store_error";
    console.error(`[improve] signal skipped: ${s.signal} (${code}${code === "store_error" ? `: ${errorCode(e)}` : ""})`);
    skipImproveSignal(store, s.signal, code, s.about_run_id ?? s.run_id);
    return false;
  }
}

export function skipImproveSignal(store: RunStore, signal: DecisionSignal, code: SkipCode, run_id: string | null = null): void {
  try {
    store.recordMemoryEvent("improve_signal_skipped", { signal, code, ...(run_id ? { run_id } : {}) }, "improve");
  } catch (e) {
    console.error(`[improve] signal skipped: ${signal} (${code}); the event was not written: ${errorCode(e)}`);
  }
}

/** CORRECTION_VALUES is the category list; a verdict without one (P1: 6 of 32) is `other`. */
export const correctionValue = (category: string | null): string => category ?? "other";

/** One correction row on the corrected turn (`about`), by the correcting run (null for a rating, which has none). */
export function recordCorrection(store: RunStore, i: { about: JevVerdictRow; run_id: string | null; chat_id: string; now?: string }): boolean {
  return recordImproveSignal(store, { signal: "correction", value: correctionValue(i.about.category), run_id: i.run_id, chat_id: i.chat_id, about_run_id: i.about.run_id,
    ...(i.now ? { created_at: i.now } : {}) });
}

/** R11: a denial on a schedule-born run is never a signal; an expiry on one is (the schedule target's only evidence). Readers inside the catch: the contract is never-throw (codex B5). */
function approvalSignal(store: RunStore, signal: "approval_denied" | "approval_expired", i: { run_id: string; approval_id: string; chat_id?: string; now?: string }): boolean {
  try {
    const capability = store.getToolApproval(i.approval_id)?.capability;
    if (!capability) { skipImproveSignal(store, signal, "no_capability", i.run_id); return false; }
    if (signal === "approval_denied" && store.runSource(i.run_id) === "schedule") return false;
    const chat_id = i.chat_id ?? chatOfRun(store, i.run_id);
    return recordImproveSignal(store, { signal, value: capability, run_id: i.run_id, chat_id, about_run_id: i.run_id,
      source_outcome_id: `${signal === "approval_denied" ? "deny" : "exp"}:${i.approval_id}`, ...(i.now ? { created_at: i.now } : {}) });
  } catch (e) {
    console.error(`[improve] signal skipped: ${signal} (store_error: ${errorCode(e)})`);
    skipImproveSignal(store, signal, "store_error", i.run_id);
    return false;
  }
}
export const recordApprovalDenied = (store: RunStore, i: { run_id: string; approval_id: string; chat_id: string; now?: string }): boolean => approvalSignal(store, "approval_denied", i);
export const recordApprovalExpired = (store: RunStore, i: { run_id: string; approval_id: string; now?: string }): boolean => approvalSignal(store, "approval_expired", i);

function chatOfRun(store: RunStore, run_id: string): string | null {
  try { const t = store.getRunNotifyTarget(run_id); return t.kind === "telegram" ? t.chat_id : null; } catch { return null; }
}
