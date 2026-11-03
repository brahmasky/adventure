import { buildIncidentOpenedText } from "./invariant-sweep.js";
import { formatInstantInZone, resolveDisplayZone } from "./schedule-spec.js";
import type { IncidentRow, RunStore } from "./run-store.js";
import type { RoutedIncidentKind } from "./incident-route.js";

/**
 * Incidents opened OUTSIDE the invariant sweep (omp_unavailable,
 * turn_outside_planner): the sweep never re-detects them, so nobody would ever be paged. This opens
 * the incident AND sends ONE Telegram alert on the open transition, through the outbox (the
 * telegram adapter renders it with the rich renderer). Throttled exactly like the incident: while
 * an incident with the same kind+subject is open, nothing is opened or sent again.
 * `hostile_schedule_turn` is an event (spec 2026-11-02 §5).
 */
export interface AlertedIncidentInput {
  kind: RoutedIncidentKind;
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
    topic: "incident_page",
    target: { kind: "telegram", chat_id: chat },
    intent_type: "progress",
    idempotency_key: `incident_opened:${incident_id}`,
    correlation_id: incident_id,
    payload: { text: buildIncidentOpenedText(input.kind, input.subject, input.detail) }
  });
}

/**
 * The omp-check conditions a later PASSING version check clears (silently: the next refusal alerts again).
 * `omp_version_mismatch` is no longer opened (no pinned version since 2026-10-07); it stays here so a row a pre-unpin
 * build left open resolves at the first passing check.
 */
export const OMP_CHECK_INCIDENT_KINDS: ReadonlySet<string> = new Set(["omp_version_mismatch", "omp_unavailable"]);

/**
 * The one subject of an omp check condition, whoever saw it (a planner start or a one-shot seat): `omp:<check kind>`.
 * One fingerprint, so one condition pages once (N5).
 */
export function ompCheckSubject(check: { kind: string }): string {
  return `omp:${check.kind}`;
}

/** Resolve every open omp-check row (omp_unavailable, and a legacy omp_version_mismatch). Returns how many were resolved. */
export function resolveOmpCheckIncidents(store: RunStore, now = new Date().toISOString()): number {
  return resolveOpenIncidents(store, OMP_CHECK_INCIDENT_KINDS, undefined, now);
}

/** The planner-supervisor conditions that page Paco once while open (B3). */
export const SUPERVISOR_ALERT_KINDS = new Set([
  "planner_crash_loop", "planner_start_failed", "wrapper_mismatch", "sandbox_unavailable", "omp_unavailable",
  "planner_session_reset_failed"
] as const satisfies readonly RoutedIncidentKind[]);
export type SupervisorAlertKind = typeof SUPERVISOR_ALERT_KINDS extends ReadonlySet<infer K> ? K : never;
/** Narrowing membership: core-worker's `kind: string` also carries row-only planner kinds that are not in the route table. */
export function isSupervisorAlertKind(k: string): k is SupervisorAlertKind { return (SUPERVISOR_ALERT_KINDS as ReadonlySet<string>).has(k); }
/**
 * The supervisor conditions a successful planner start in the same chat clears (the omp-check kinds clear on versionOk).
 * planner_session_reset_failed is not one: a degraded start serves the resumed session with the reset still failing, so
 * only sessionResetOk (a transcript on the current lesson set) clears it.
 */
export const START_CONDITION_KINDS: ReadonlySet<string> = new Set([
  "planner_crash_loop", "planner_start_failed", "wrapper_mismatch", "sandbox_unavailable"
]);
export const SESSION_RESET_KINDS: ReadonlySet<string> = new Set(["planner_session_reset_failed"]);

/** Resolve the open incidents of `kinds` (only `subject`'s, when given). Returns how many were resolved. */
export function resolveOpenIncidents(store: RunStore, kinds: ReadonlySet<string>, subject?: string, now = new Date().toISOString()): number {
  let resolved = 0;
  for (const open of store.listOpenIncidents()) {
    if (!kinds.has(open.kind) || (subject !== undefined && open.subject !== subject)) continue;
    if (store.resolveIncident(open.incident_id, now)) resolved += 1;
  }
  return resolved;
}

/**
 * Spec 2026-11-02 §5: the alerted kinds a daily reminder repeats until fixed, each with the action that fixes it. Left out
 * on purpose: undelivered_notification and every delivery-health kind (a reminder would multiply during an outage),
 * trust_tap_budget (per day, rolls over itself), omp_contract_drift and planner_no_leg (each re-detects or pages on its own path).
 */
export const REMIND_KINDS: ReadonlyMap<string, string> = new Map([
  ["role_unresolved", "tap the card, or `/models set <key> <pattern>`"],
  ["static_list_stale", "re-pin `STATIC_ROLE_LISTS`"],
  ["model_catalog_unavailable", "check `omp --profile houge models`"],
  ["planner_session_reset_failed", "send `/fresh`, or check the omp session dir"]
]);
export const REMIND_AFTER_MS = 24 * 60 * 60_000;

const age = (ms: number): string => `${Math.floor(ms / 86_400_000)}d${Math.floor((ms % 86_400_000) / 3_600_000)}h`;

/** Code-owned text: kinds, subjects (role keys, selectors, chat ids), ages and action lines; null when nothing qualifies. */
export function reminderText(open: ReadonlyArray<Pick<IncidentRow, "incident_id" | "kind" | "subject" | "first_seen_at">>, now: string): string | null {
  const t = Date.parse(now);
  const due = open.filter((i) => REMIND_KINDS.has(i.kind) && t - Date.parse(i.first_seen_at) > REMIND_AFTER_MS)
    .sort((a, b) => Date.parse(a.first_seen_at) - Date.parse(b.first_seen_at) || (a.incident_id < b.incident_id ? -1 : a.incident_id > b.incident_id ? 1 : 0)); // deterministic for one millisecond
  if (due.length === 0) return null;
  return ["🔔 **Still open** (daily reminder)", ...due.map((i) => `- ${i.kind} · ${i.subject} · open ${age(t - Date.parse(i.first_seen_at))} — ${REMIND_KINDS.get(i.kind)}`)].join("\n");
}

/**
 * The daily reminder (spec §5, plan P23): one message a display-zone day, keyed `incident_remind:<date>`. The outbox answers
 * `duplicate` (same text) or `conflict` (a later text the same day) for a second send: both mean "already sent today".
 */
export function runIncidentReminder(i: { store: RunStore; chatId: string | null; env: NodeJS.ProcessEnv; now: string }): "sent" | "none" | "already" | "no_chat" {
  if (!i.chatId) return "no_chat";
  const text = reminderText(i.store.listOpenIncidents(), i.now);
  if (text === null) return "none";
  const date = formatInstantInZone(i.now, resolveDisplayZone(i.env)).slice(0, 10);
  const r = i.store.enqueueNotification({ topic: "incident_reminder", target: { kind: "telegram", chat_id: i.chatId }, intent_type: "progress",
    idempotency_key: `incident_remind:${date}`, correlation_id: "incident-remind", payload: { text } });
  return r.status === "queued" ? "sent" : "already";
}
