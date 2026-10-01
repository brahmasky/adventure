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
  /** Injectable instant (tests); default now. */
  now?: string;
}

/** Flap damping (B3): a condition reopened this soon after it resolved records its row but does not page again. */
export const ALERT_REOPEN_QUIET_MS = 10 * 60_000;

/** True when a new incident was opened (and, with a chat, alerted); false when one was already open. */
export function openAlertedIncident(store: RunStore, input: AlertedIncidentInput): boolean {
  const fingerprint = store.incidentFingerprint(input.kind, input.subject);
  if (store.findOpenIncident(fingerprint)) return false;
  const now = input.now ?? new Date().toISOString();
  const flapping = !input.event && store.findRecentlyResolvedIncident(fingerprint, new Date(Date.parse(now) - ALERT_REOPEN_QUIET_MS).toISOString()) !== undefined;
  const opened = store.openIncident({ kind: input.kind, subject: input.subject, detail: input.detail, now });
  const chat = input.chat_id ?? (input.env ?? process.env).HOUGE_TELEGRAM_CHAT_ID?.trim();
  if (chat && !flapping) alertOpened(store, chat, opened.incident_id, input);
  if (input.event) store.resolveIncident(opened.incident_id, now);
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

/**
 * The one subject of an omp version condition, whoever saw it (a planner start or a one-shot seat): `omp:<version>` for
 * a mismatch, `omp:<check kind>` when omp could not be asked. One fingerprint, so one condition pages once (N5).
 */
export function ompCheckSubject(check: { kind: string; version?: string | null }): string {
  return check.kind === "version_mismatch" ? `omp:${check.version ?? "unknown"}` : `omp:${check.kind}`;
}

/** Resolve every open omp_version_mismatch / omp_unavailable row. Returns how many were resolved. */
export function resolveOmpCheckIncidents(store: RunStore, now = new Date().toISOString()): number {
  return resolveOpenIncidents(store, OMP_CHECK_INCIDENT_KINDS, undefined, now);
}

/** The planner-supervisor conditions that page Paco once while open (B3). */
export const SUPERVISOR_ALERT_KINDS: ReadonlySet<string> = new Set([
  "planner_crash_loop", "planner_start_failed", "wrapper_mismatch", "sandbox_unavailable", "omp_version_mismatch", "omp_unavailable"
]);
/** The supervisor conditions a successful planner start in the same chat clears (the omp-check kinds clear on versionOk). */
export const START_CONDITION_KINDS: ReadonlySet<string> = new Set(["planner_crash_loop", "planner_start_failed", "wrapper_mismatch", "sandbox_unavailable"]);

/** Resolve the open incidents of `kinds` (only `subject`'s, when given). Returns how many were resolved. */
export function resolveOpenIncidents(store: RunStore, kinds: ReadonlySet<string>, subject?: string, now = new Date().toISOString()): number {
  let resolved = 0;
  for (const open of store.listOpenIncidents()) {
    if (!kinds.has(open.kind) || (subject !== undefined && open.subject !== subject)) continue;
    if (store.resolveIncident(open.incident_id, now)) resolved += 1;
  }
  return resolved;
}
