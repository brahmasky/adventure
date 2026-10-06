import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildTypedTaskEvent, type TypedTaskEvent } from "../domain/types.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";
import { JEV_INCIDENT_SUBJECT } from "../jev/jev-incidents.js";
import { jevDisarmMarkerPath, writeJevDisarmMarker } from "../jev/jev-flags.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";

/** Memory lane card taps (ADR 0029 §5.6). Undo is compare-and-set; "Ask Houge anyway" is the override label. */
export const TRIAGE_OVERRIDE_LIMIT = 3;
export const TRIAGE_OVERRIDE_WINDOW_DAYS = 7;
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

/** The override label (spec §5.9) and the drift signal: three in seven days cap the lane at shadow through the persisted marker. */
export function recordTriageOverride(store: RunStore, original_run_id: string, new_run_id: string, env: NodeJS.ProcessEnv, dataDir: string, chat_id: string, now: string = new Date().toISOString()): void {
  const change_id = store.getLessonChangeByRun(original_run_id)?.change_id ?? null;
  store.recordMemoryEvent("triage_override", { run_id: original_run_id, new_run_id, change_id });
  for (const d of store.listJevDecisions(original_run_id)) store.recordJevOutcome(d.decision_id, "paco_correction", "override");
  const since = new Date(Date.parse(now) - TRIAGE_OVERRIDE_WINDOW_DAYS * 86_400_000).toISOString();
  if (store.countRecentLedgerEvents("triage_override", since) >= TRIAGE_OVERRIDE_LIMIT) {
    const path = jevDisarmMarkerPath(env, dataDir);
    mkdirSync(dirname(path), { recursive: true }); // writeJevDisarmMarker does not create the directory
    writeJevDisarmMarker(path, "triage_overrides");
    openAlertedIncident(store, { kind: "triage_overrides", subject: JEV_INCIDENT_SUBJECT, detail: { window_days: TRIAGE_OVERRIDE_WINDOW_DAYS, limit: TRIAGE_OVERRIDE_LIMIT }, chat_id });
  }
}
