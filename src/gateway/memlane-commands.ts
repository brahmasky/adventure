import { buildTypedTaskEvent, type TypedTaskEvent } from "../domain/types.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";
import { TRIAGE_OVERRIDE_LIMIT, TRIAGE_OVERRIDE_WINDOW_DAYS, triageOverrideSince, triageOverrideSubject } from "../jev/jev-incidents.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";
import { decisionOf, recordSaveUndone, recordTapOutcome } from "../decisions/tap-outcomes.js";

/** Lane card taps (ADR 0029 §5.6, stage B §6). Undo is compare-and-set; "Dig deeper" is the override label. */
export { TRIAGE_OVERRIDE_LIMIT, TRIAGE_OVERRIDE_WINDOW_DAYS };
export const LESSON_CHANGE_NOT_FOUND = "LESSON_CHANGE_NOT_FOUND";
export const MEMLANE_ASK_NOT_FOUND = "MEMLANE_ASK_NOT_FOUND";
export const LESSON_CHANGE_NOT_FOUND_TEXT = "That lesson change does not exist here, so nothing was undone.";
export const LESSON_CHANGED_SINCE_TEXT = "↩️ Not undone: that lesson has changed since; use /lessons.";
export const LESSON_ALREADY_UNDONE_TEXT = "↩️ Already undone.";
export const MEMLANE_ASK_NOT_FOUND_TEXT = "I can't find that message any more; please send it again.";

const chatOf = (e: TypedTaskEvent): string => (e.notify.kind === "telegram" ? e.notify.chat_id : "");

export function handleMemLaneUndo(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const change_id = typeof event.metadata?.change_id === "string" ? event.metadata.change_id : "";
    const change = store.getLessonChange(change_id);
    if (!change || change.chat_id !== chatOf(event)) {
      replyTo(store, event, "memlane_undo_refused", LESSON_CHANGE_NOT_FOUND_TEXT);
      return { ok: false, error: { code: LESSON_CHANGE_NOT_FOUND, message: "No such lesson change in this chat" } };
    }
    const r = store.undoLessonChange(change_id); // writes lesson_change_undone inside its own transaction
    if (r.status === "undone" && change.run_id) recordSaveUndone(store, change.run_id); // Addition A; spec 2026-10-15 §9
    const text = r.status === "undone"
      ? `↩️ Undone: lesson #${change.new_id} retired, restored #${r.restored.join(", #") || "—"}${r.skipped.length ? ` (left as is: #${r.skipped.join(", #")})` : ""}.`
      : r.status === "changed_since" ? LESSON_CHANGED_SINCE_TEXT : LESSON_ALREADY_UNDONE_TEXT;
    replyTo(store, event, "memlane_undo", text);
    return { ok: true, status: "lesson_change_undone", run_id: "" };
  });
}

/** Chat-bound: the original run must notify THIS chat. Builds the turn event the gateway then admits as an ordinary turn. */
export function memLaneAskTurnEvent(store: RunStore, event: TypedTaskEvent): { ok: true; turnEvent: TypedTaskEvent; original_run_id: string } | { ok: false; result: GatewayIntakeResult } {
  const run_id = typeof event.metadata?.run_id === "string" ? event.metadata.run_id : "";
  let target: ReturnType<RunStore["getRunNotifyTarget"]> | null = null;
  try { target = run_id ? store.getRunNotifyTarget(run_id) : null; } catch { target = null; } // an unknown run throws: it is the same chat-bound refusal
  const text = run_id ? store.userTurnTextForRun(run_id) : undefined;
  if (!text || !target || target.kind !== "telegram" || target.chat_id !== chatOf(event)) {
    replyTo(store, event, "memlane_ask_refused", MEMLANE_ASK_NOT_FOUND_TEXT);
    return { ok: false, result: { ok: false, error: { code: MEMLANE_ASK_NOT_FOUND, message: "No such turn in this chat" } } };
  }
  return { ok: true, original_run_id: run_id, turnEvent: buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: event.requested_by,
    notify: event.notify, idempotency_key: `${event.idempotency_key}:ask`, source_reference: `${event.source_reference}:ask` }) };
}

/**
 * The override label (spec §5.9) and the per-lane correction signal (stage B §6): the tap marks the original verdict
 * `ask_anyway`, and the third tap on ONE lane in seven days opens that lane's `triage_overrides` page. Nothing is disarmed:
 * Paco raises a bar or switches the lane off (HOUGE_JEV_LANES_OFF). A run with no verdict writes `lane: null` and counts nowhere.
 */
export function recordTriageOverride(store: RunStore, original_run_id: string, new_run_id: string, chat_id: string, now: string = new Date().toISOString()): void {
  const change_id = store.getLessonChangeByRun(original_run_id)?.change_id ?? store.getMemoryChangeByRun(original_run_id)?.change_id ?? null;
  const verdict = store.getJevVerdictForRun(original_run_id);
  const lane = verdict?.lane ?? null;
  store.recordMemoryEvent("triage_override", { run_id: original_run_id, new_run_id, change_id, lane });
  for (const d of store.listJevDecisions(original_run_id)) {
    if (d.point === "triage") store.recordJevOutcome(d.decision_id, "paco_correction", "override"); // a run's injection rows are not the front door's
  }
  // Spec §6: the tap is Paco's explicit correction, so it outranks any earlier label on the original turn's verdict.
  if (verdict) store.updateJevVerdict(verdict.verdict_id, { paco_correction: "ask_anyway" });
  if (verdict?.decision_id && lane !== null) recordTapOutcome(store, verdict.decision_id, "dig_deeper", lane, now); // Addition A
  const kind = decisionOf(store, original_run_id, "memory.kind");
  if (kind && lane !== null) recordTapOutcome(store, kind.decision_id, "dig_deeper", lane, now); // spec 2026-10-15 §9
  if (lane === null || store.countRecentTriageOverrides(lane, triageOverrideSince(now)) < TRIAGE_OVERRIDE_LIMIT) return;
  openAlertedIncident(store, { kind: "triage_overrides", subject: triageOverrideSubject(lane), chat_id,
    detail: { lane, window_days: TRIAGE_OVERRIDE_WINDOW_DAYS, limit: TRIAGE_OVERRIDE_LIMIT } });
}
