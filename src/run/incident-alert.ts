import { buildIncidentOpenedText } from "./invariant-sweep.js";
import type { RunStore } from "./run-store.js";

/**
 * Incidents opened OUTSIDE the invariant sweep (omp_version_mismatch, omp_unavailable,
 * turn_outside_planner): the sweep never re-detects them, so nobody would ever be paged. This opens
 * the incident AND sends ONE Telegram alert on the open transition, through the outbox (the
 * telegram adapter renders it with the rich renderer). Throttled exactly like the incident: while
 * an incident with the same kind+subject is open, nothing is opened or sent again.
 */
export interface AlertedIncidentInput {
  kind: string;
  subject: string;
  detail: Record<string, unknown>;
  /** The chat to page; default `HOUGE_TELEGRAM_CHAT_ID` (the operator chat). Absent → the row only. */
  chat_id?: string | null;
  env?: NodeJS.ProcessEnv;
}

/** True when a new incident was opened (and, with a chat, alerted); false when one was already open. */
export function openAlertedIncident(store: RunStore, input: AlertedIncidentInput): boolean {
  if (store.findOpenIncident(store.incidentFingerprint(input.kind, input.subject))) return false;
  const opened = store.openIncident({ kind: input.kind, subject: input.subject, detail: input.detail });
  const chat = input.chat_id ?? (input.env ?? process.env).HOUGE_TELEGRAM_CHAT_ID?.trim();
  if (!chat) return true;
  store.enqueueNotification({
    target: { kind: "telegram", chat_id: chat },
    intent_type: "progress",
    idempotency_key: `incident_opened:${opened.incident_id}`,
    correlation_id: opened.incident_id,
    payload: { text: buildIncidentOpenedText(input.kind, input.subject, input.detail) }
  });
  return true;
}
