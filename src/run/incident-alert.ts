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
  /** An EVENT, not a condition (turn_outside_planner): resolved right after its alert is queued. */
  event?: boolean;
}

/** True when a new incident was opened (and, with a chat, alerted); false when one was already open. */
export function openAlertedIncident(store: RunStore, input: AlertedIncidentInput): boolean {
  if (store.findOpenIncident(store.incidentFingerprint(input.kind, input.subject))) return false;
  const opened = store.openIncident({ kind: input.kind, subject: input.subject, detail: input.detail });
  const chat = input.chat_id ?? (input.env ?? process.env).HOUGE_TELEGRAM_CHAT_ID?.trim();
  if (chat) alertOpened(store, chat, opened.incident_id, input);
  if (input.event) store.resolveIncident(opened.incident_id, new Date().toISOString());
  return true;
}

function alertOpened(store: RunStore, chat: string, incident_id: string, input: AlertedIncidentInput): void {
  store.enqueueNotification({
    target: { kind: "telegram", chat_id: chat },
    intent_type: "progress",
    idempotency_key: `incident_opened:${incident_id}`,
    correlation_id: incident_id,
    payload: { text: buildIncidentOpenedText(input.kind, input.subject, input.detail) }
  });
}

/** The omp-check conditions a later PASSING version check clears (silently: the next refusal alerts again). */
export const OMP_CHECK_INCIDENT_KINDS: ReadonlySet<string> = new Set(["omp_version_mismatch", "omp_unavailable"]);

/** Resolve every open omp_version_mismatch / omp_unavailable row. Returns how many were resolved. */
export function resolveOmpCheckIncidents(store: RunStore, now = new Date().toISOString()): number {
  let resolved = 0;
  for (const open of store.listOpenIncidents()) {
    if (OMP_CHECK_INCIDENT_KINDS.has(open.kind) && store.resolveIncident(open.incident_id, now)) resolved += 1;
  }
  return resolved;
}
