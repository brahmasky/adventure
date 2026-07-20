import type { RunStore } from "./run-store.js";

/**
 * The invariant sweep (introspection slice A, ADR 0024): Houge's deterministic self-sensing
 * organ. Every cycle it reads its OWN flight recorder — schedules, runs, the outbox, the
 * heartbeat — and turns violations into durable incidents with an open/resolve lifecycle.
 *
 * Deliberately the least-privileged component in the system: pure SQL reads plus incident
 * bookkeeping. No LLM, no capability, no run creation. It cannot act on what it finds — the
 * worst case of a bug here is a wrong row and a wrong Telegram line, never a wrong ACTION.
 * That is what makes it safe to run unattended on every poll cycle.
 */

/** Minimum gap between sweeps — the poll loop ticks ~every 30s; six queries that often is waste. */
export const INVARIANT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** A run whose lease expired this long ago is stuck, not slow. */
export const STUCK_RUN_GRACE_MS = 10 * 60 * 1000;
/** An undelivered notification older than this is a delivery failure, not a queue delay. */
export const UNDELIVERED_NOTIFICATION_GRACE_MS = 15 * 60 * 1000;
/** A schedule this far past its cursor did not fire when it should have. */
export const OVERDUE_SCHEDULE_GRACE_MS = 15 * 60 * 1000;
/** A heartbeat older than this means the daemon was down and has just returned. */
export const HEARTBEAT_GAP_GRACE_MS = 10 * 60 * 1000;
/** Resolve notifications only for incidents that were open at least this long. */
export const INCIDENT_RESOLVE_NOTIFY_MIN_MS = 60 * 60 * 1000;
/**
 * Storm cap: one systemic failure trips many invariants at once (a broken outbox dispatcher
 * makes EVERY queued notification violate the delivery invariant). Open every incident, but
 * alert at most this many per sweep plus one summary line. Incident rows are cheap; Paco's
 * attention is not, and a monitor that spams during an outage gets muted.
 */
export const INCIDENT_ALERTS_PER_SWEEP_MAX = 3;
/**
 * Flap damping: a condition oscillating around its threshold would open→resolve→reopen every
 * sweep. A reopen within this window of the previous resolve still creates the row (recurrence
 * must stay countable) but suppresses its alert.
 */
export const INCIDENT_REOPEN_QUIET_MS = 30 * 60 * 1000;

export type IncidentKind =
  | "duplicate_schedule"
  | "stuck_run"
  | "undelivered_notification"
  | "overdue_schedule"
  | "failed_schedule"
  | "heartbeat_gap";

export interface InvariantViolation {
  kind: IncidentKind;
  subject: string;
  detail: Record<string, unknown>;
}

export interface InvariantSweepResult {
  swept: boolean;
  opened: number;
  resolved: number;
  recurring: number;
  /** Incidents recorded but not alerted (storm cap or flap damping). */
  alerts_suppressed: number;
}

export function resolveInvariantSweepEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_INVARIANT_SWEEP_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function buildIncidentOpenedText(
  kind: string,
  subject: string,
  detail: Record<string, unknown>
): string {
  return `⚠️ Incident opened — ${kind} · ${subject}\n${JSON.stringify(detail)}`;
}

export function buildIncidentResolvedText(kind: string, subject: string, open_minutes: number): string {
  return `✓ Incident resolved — ${kind} · ${subject} (was open ${open_minutes} min)`;
}

export function buildSweepSummaryText(opened: number, suppressed: number): string {
  return (
    `⚠️ Invariant sweep opened ${opened} incidents; ${suppressed} alert(s) suppressed ` +
    `(storm cap / flap damping). Inspect: SELECT * FROM incidents WHERE state='open'`
  );
}

/** Pure detection: compose the store's six invariant queries into a flat violation list. */
export function detectViolations(store: RunStore, now: string): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  for (const row of store.findDuplicateEnabledSchedules()) {
    violations.push({
      kind: "duplicate_schedule",
      subject: row.subject,
      detail: { duplicate_count: row.duplicate_count, schedule_ids: row.schedule_ids }
    });
  }
  for (const row of store.findStuckRuns(new Date(Date.parse(now) - STUCK_RUN_GRACE_MS).toISOString())) {
    violations.push({ kind: "stuck_run", subject: row.subject, detail: { state: row.state } });
  }
  for (const row of store.findUndeliveredNotifications(now, UNDELIVERED_NOTIFICATION_GRACE_MS)) {
    violations.push({
      kind: "undelivered_notification",
      subject: row.subject,
      detail: { intent_type: row.intent_type, attempt_count: row.attempt_count }
    });
  }
  for (const row of store.findOverdueSchedules(now, OVERDUE_SCHEDULE_GRACE_MS)) {
    violations.push({
      kind: "overdue_schedule",
      subject: row.subject,
      detail: { overdue_minutes: row.overdue_minutes }
    });
  }
  for (const row of store.findFailedSchedules()) {
    violations.push({
      kind: "failed_schedule",
      subject: row.subject,
      detail: { consecutive_failures: row.consecutive_failures }
    });
  }
  const gap = store.findHeartbeatGap(now, HEARTBEAT_GAP_GRACE_MS);
  if (gap) {
    violations.push({ kind: "heartbeat_gap", subject: gap.subject, detail: { gap_minutes: gap.gap_minutes } });
  }
  return violations;
}

export interface InvariantSweepInput {
  store: RunStore;
  now: string;
  env?: NodeJS.ProcessEnv | undefined;
  /** Telegram chat for alerts; omit and the sweep still records incidents silently. */
  chat_id?: string | undefined;
}

/**
 * One sweep: detect → open new / touch recurring → resolve cleared. Notifies ONLY on the
 * open transition (and on resolve for incidents that were open >= 1h), so a persistent
 * violation costs exactly one message no matter how many cycles it survives. The ledger
 * records every transition regardless — the audit trail is complete, the human channel is
 * damped (see the storm cap and flap-damping constants above).
 */
export function runInvariantSweep(input: InvariantSweepInput): InvariantSweepResult {
  const env = input.env ?? process.env;
  const result: InvariantSweepResult = {
    swept: false,
    opened: 0,
    resolved: 0,
    recurring: 0,
    alerts_suppressed: 0
  };
  if (!resolveInvariantSweepEnabled(env)) return result;
  // The latch is claimed BEFORE detection on purpose: if detection throws, the daemon's
  // try/catch swallows it and the next sweep waits a full interval — a crash degrades to
  // "sweeps less often", never to "sweeps every 30s in a hot loop".
  if (!input.store.claimInvariantSweep(input.now, INVARIANT_SWEEP_INTERVAL_MS)) return result;
  result.swept = true;

  const violations = detectViolations(input.store, input.now);
  const seen = new Set<string>();
  let alertsSent = 0;

  for (const violation of violations) {
    const fingerprint = input.store.incidentFingerprint(violation.kind, violation.subject);
    seen.add(fingerprint);
    const existing = input.store.findOpenIncident(fingerprint);
    if (existing) {
      input.store.touchIncident(existing.incident_id, input.now);
      result.recurring += 1;
      continue;
    }

    // Flap damping: a reopen inside the quiet window records the row but stays silent.
    const flapping =
      input.store.findRecentlyResolvedIncident(
        fingerprint,
        new Date(Date.parse(input.now) - INCIDENT_REOPEN_QUIET_MS).toISOString()
      ) !== undefined;

    // openIncident appends the incident_opened ledger event itself (store-side, so the
    // redaction pass applies).
    const opened = input.store.openIncident({
      kind: violation.kind,
      subject: violation.subject,
      detail: violation.detail,
      now: input.now
    });
    result.opened += 1;

    if (!input.chat_id || flapping) {
      if (flapping) result.alerts_suppressed += 1;
      continue;
    }
    // Storm cap: alert on the first N, then count the rest for one summary line.
    if (alertsSent >= INCIDENT_ALERTS_PER_SWEEP_MAX) {
      result.alerts_suppressed += 1;
      continue;
    }
    input.store.enqueueNotification({
      target: { kind: "telegram", chat_id: input.chat_id },
      intent_type: "progress",
      idempotency_key: `incident_opened:${opened.incident_id}`,
      correlation_id: opened.incident_id,
      payload: { text: buildIncidentOpenedText(violation.kind, violation.subject, violation.detail) }
    });
    alertsSent += 1;
  }

  // One summary line for everything the caps swallowed — silence about a storm would be
  // worse than the storm. Keyed on the sweep instant, so it is idempotent on replay.
  if (input.chat_id && result.alerts_suppressed > 0) {
    input.store.enqueueNotification({
      target: { kind: "telegram", chat_id: input.chat_id },
      intent_type: "progress",
      idempotency_key: `incident_sweep_summary:${input.now}`,
      correlation_id: `invariant-sweep:${input.now}`,
      payload: { text: buildSweepSummaryText(result.opened, result.alerts_suppressed) }
    });
  }

  for (const open of input.store.listOpenIncidents()) {
    if (seen.has(open.fingerprint)) continue;
    // resolveIncident appends the incident_resolved ledger event itself.
    if (!input.store.resolveIncident(open.incident_id, input.now)) continue;
    const open_minutes = Math.floor((Date.parse(input.now) - Date.parse(open.first_seen_at)) / 60000);
    if (input.chat_id && open_minutes * 60000 >= INCIDENT_RESOLVE_NOTIFY_MIN_MS) {
      input.store.enqueueNotification({
        target: { kind: "telegram", chat_id: input.chat_id },
        intent_type: "progress",
        idempotency_key: `incident_resolved:${open.incident_id}`,
        correlation_id: open.incident_id,
        payload: { text: buildIncidentResolvedText(open.kind, open.subject, open_minutes) }
      });
    }
    result.resolved += 1;
  }

  return result;
}
