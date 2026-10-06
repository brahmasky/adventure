import { statfsSync } from "node:fs";
import type { SkipReason } from "../jev/decide.js";
import { JEV_INCIDENT_SUBJECT } from "../jev/jev-incidents.js";
import { resolveApprovalTimeoutMs } from "../omp/omp-config.js";
import { OMP_LESSON_SCOPES, renderLessonSection } from "./lesson-render.js";
import { resolveEpisodicCoreCap, TERMINAL_NOTIFICATION_REPORT_MS, type RunStore } from "./run-store.js";
import { readParkMarker } from "./tombstone.js";

/**
 * The invariant sweep (introspection slice A, ADR 0024): Houge's deterministic self-sensing
 * organ. Every cycle it reads its OWN flight recorder — schedules, runs, the outbox, the
 * heartbeat, the LLM leg ledger (slice 2, audit chokepoint) — and turns violations into durable
 * incidents with an open/resolve lifecycle.
 *
 * Deliberately the least-privileged component in the system: pure SQL reads plus incident
 * bookkeeping. No LLM, no capability, no run creation. It cannot act on what it finds — the
 * worst case of a bug here is a wrong row and a wrong Telegram line, never a wrong ACTION.
 * That is what makes it safe to run unattended on every poll cycle.
 */

/**
 * Default gap between sweeps: 12 h, i.e. twice a day (Paco, 2026-07-20).
 *
 * Note what this knob does NOT control: alert volume. Alerts fire on incident TRANSITIONS,
 * never per sweep, so a persistent violation costs exactly one message whether it is swept
 * twice a day or every five minutes, and a clean database is silent at any cadence. What the
 * interval actually buys is DETECTION LATENCY — how long a stuck run or an undelivered
 * notification sits unnoticed. Twice a day suits the retro-style invariants (failed/overdue
 * schedules, heartbeat gaps); lower it toward 30 min if blocked-work latency starts to matter.
 */
export const DEFAULT_INVARIANT_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Sweep cadence override in MINUTES (`HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES`). */
export function resolveInvariantSweepIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw * 60 * 1000 : DEFAULT_INVARIANT_SWEEP_INTERVAL_MS;
}
/** A run whose lease expired this long ago is stuck, not slow. */
export const STUCK_RUN_GRACE_MS = 10 * 60 * 1000;
/**
 * A queued turn may wait behind a turn paused for Paco's approval (up to HOUGE_OMP_APPROVAL_TIMEOUT_MS): it is stuck
 * only past that wait plus this margin (round 2 N3).
 */
export const QUEUED_TURN_STUCK_MARGIN_MS = 15 * 60 * 1000;
export function queuedTurnStuckMs(env: NodeJS.ProcessEnv): number {
  return resolveApprovalTimeoutMs(env) + QUEUED_TURN_STUCK_MARGIN_MS;
}
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

/**
 * A leg tried this often in the window with zero successes is dead, not unlucky (slice 2, W4).
 * A leg that recovers but is not called again keeps the incident open until its failed rows age
 * out of the window (≤ 24 h) — acceptable at the 12 h sweep cadence. Exception (spec amendment 14):
 * a single `error_kind: "auth"` failure with zero `ok` is enough on its own — a rejected key is
 * deterministic, not unlucky, and a low-volume leg would never reach this floor in the window.
 */
export const LLM_LEG_FAILING_MIN_ATTEMPTS = 3;
export const LLM_LEG_FAILING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Free bytes on the data volume below which the omp session and ledger writes are at risk (spec §8). */
export const DISK_FREE_LOW_BYTES = 2 * 1024 ** 3;

/** The kinds the sweep detects — and therefore the ONLY kinds it may resolve. */
export const SWEEP_INCIDENT_KINDS = [
  "duplicate_schedule", "stuck_run", "undelivered_notification", "overdue_schedule", "failed_schedule",
  "heartbeat_gap", "llm_leg_failing", "disk_free_low", "wall_collapsed", "lesson_dropped", "embeddings_unavailable", "core_overflow",
  "jev_skip_rate"
] as const;
export type IncidentKind = (typeof SWEEP_INCIDENT_KINDS)[number];
const SWEEP_KINDS: ReadonlySet<string> = new Set(SWEEP_INCIDENT_KINDS);

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

/** The omp-runtime invariants' inputs (spec §8): the previous sweep instant and the data volume. */
export interface OmpSweepProbe {
  /** The previous sweep's instant; null on the first sweep. */
  since?: string | null;
  /** The data volume to check; absent → the disk invariant is not evaluated (hermetic callers). */
  dataDir?: string;
  statfs?: (dir: string) => { bavail: number | bigint; bsize: number | bigint };
}

/**
 * `disk_free_low`: free bytes on the data volume under {@link DISK_FREE_LOW_BYTES}. `wall_collapsed`
 * (D10): any `wall_collapse` row since the previous sweep — open while reads keep collapsing onto the
 * planner's family, resolved by the first clean sweep. A statfs failure is not a violation (the
 * sweep senses, it does not guess).
 */
export function detectOmpViolations(store: RunStore, probe: OmpSweepProbe): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  if (probe.dataDir) {
    try {
      const fs = (probe.statfs ?? statfsSync)(probe.dataDir);
      const free = Number(fs.bavail) * Number(fs.bsize);
      if (free < DISK_FREE_LOW_BYTES) out.push({ kind: "disk_free_low", subject: "data_volume", detail: { free_mb: Math.floor(free / 1024 ** 2) } });
    } catch (error) {
      console.warn(`[invariant-sweep] statfs failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const collapses = store.countWallCollapsesSince(probe.since ?? null);
  if (collapses > 0) out.push({ kind: "wall_collapsed", subject: "reader", detail: { collapses } });
  return out;
}

/** Undelivered notifications. A terminal row counts for at least two sweep intervals, so none slips between sweeps. */
function undeliveredViolations(store: RunStore, now: string, env: NodeJS.ProcessEnv): InvariantViolation[] {
  const terminalWindowMs = Math.max(TERMINAL_NOTIFICATION_REPORT_MS, 2 * resolveInvariantSweepIntervalMs(env));
  return store.findUndeliveredNotifications(now, UNDELIVERED_NOTIFICATION_GRACE_MS, terminalWindowMs).map((row) => ({
    kind: "undelivered_notification",
    subject: row.subject,
    detail: { intent_type: row.intent_type, attempt_count: row.attempt_count }
  }));
}

/**
 * Memory A1 invariants: `lesson_dropped` (an active ask/research lesson the omp prompt cannot fit under its char
 * cap) and `core_overflow` (a chat holding more active core facts than HOUGE_EPISODIC_CORE_CAP).
 */
function memoryViolations(store: RunStore, env: NodeJS.ProcessEnv): InvariantViolation[] {
  const dropped = renderLessonSection(store, OMP_LESSON_SCOPES, env).skipped.map((s): InvariantViolation => ({
    kind: "lesson_dropped", subject: `lesson:${s.lesson_id}`, detail: { ...s }
  }));
  const cap = resolveEpisodicCoreCap(env);
  const overflow = store.listCoreOverflow(cap).map((r): InvariantViolation => ({
    kind: "core_overflow", subject: `chat:${r.chat_id}`, detail: { core_count: r.core_count, cap }
  }));
  return [...dropped, ...overflow];
}

/** Window and floor for `embeddings_unavailable`: turns that attempted an embedding, in the last 12 h. */
export const EMBEDDINGS_WINDOW_MS = 12 * 60 * 60 * 1000;
export const EMBEDDINGS_MIN_TURNS = 3;

/**
 * Embedding outage over the window. Evidence = a `loop_started` row carrying `retrieval` telemetry (written only when
 * a query embedding was attempted: a memory flag was on); rows without it are ignored. Open when at least
 * {@link EMBEDDINGS_MIN_TURNS} such turns exist and none obtained an embedding (`facts.embedding` is false only for
 * "no query embedding obtained"); any success resolves it.
 */
export function checkEmbeddingsAvailable(
  store: RunStore, now: string, windowMs = EMBEDDINGS_WINDOW_MS
): { open: boolean; turns: number; without: number } {
  const since = new Date(Date.parse(now) - windowMs).toISOString();
  const row = store.countEmbeddingTurns(since, now);
  return { open: row.turns >= EMBEDDINGS_MIN_TURNS && row.without === row.turns, turns: row.turns, without: row.without };
}

function embeddingsViolations(store: RunStore, now: string): InvariantViolation[] {
  const r = checkEmbeddingsAvailable(store, now);
  return r.open ? [{ kind: "embeddings_unavailable", subject: "embeddings", detail: { turns: r.turns, without: r.without } }] : [];
}

/** Window, floor and rate for `jev_skip_rate` (ADR 0029 §3.7): triage calls in the last 24 h. Paco sends a few text turns a day. */
export const JEV_SKIP_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const JEV_SKIP_RATE_MIN_ATTEMPTS = 3;
export const JEV_SKIP_RATE_MAX = 0.5;
/** Skips that are not a Jev call at all: the flag is off, the turn is gated out, Paco overrode it, or the state was too big to send. */
export const JEV_NOT_ATTEMPT_REASONS: readonly SkipReason[] = ["disabled", "posture", "modality", "override", "state_too_large"];
/** Failures that open no incident per call (jev-incidents.ts); auth/429/529/bad question/no key/fuse already page on their own. */
export const JEV_SILENT_SKIP_REASONS: readonly SkipReason[] = ["timeout", "parse", "transport", "error"];

/**
 * A silently dead Jev layer: at least {@link JEV_SKIP_RATE_MIN_ATTEMPTS} triage calls in the window and at least half of
 * them failed silently. Triage then falls through to the planner every turn and Houge looks normal; this makes it loud.
 * Once open it stays open until an answered call lands: failed rows ageing out of the window prove nothing.
 */
export function checkJevSkipRate(
  store: RunStore, now: string, windowMs = JEV_SKIP_RATE_WINDOW_MS
): { open: boolean; attempts: number; failed: number } {
  const since = new Date(Date.parse(now) - windowMs).toISOString();
  const r = store.countJevCalls("triage", since, now, JEV_NOT_ATTEMPT_REASONS, JEV_SILENT_SKIP_REASONS);
  if (r.attempts >= JEV_SKIP_RATE_MIN_ATTEMPTS && r.failed / r.attempts >= JEV_SKIP_RATE_MAX) return { open: true, ...r };
  const open = store.findOpenIncident(store.incidentFingerprint("jev_skip_rate", JEV_INCIDENT_SUBJECT));
  return { open: open !== undefined && !store.hasAnsweredJevCallSince("triage", open.first_seen_at), ...r };
}

function jevViolations(store: RunStore, now: string): InvariantViolation[] {
  const r = checkJevSkipRate(store, now);
  return r.open ? [{ kind: "jev_skip_rate", subject: JEV_INCIDENT_SUBJECT, detail: { point: "triage", attempts: r.attempts, failed: r.failed } }] : [];
}

/** Pure detection: compose the store's seven invariant queries into a flat violation list. */
export function detectViolations(
  store: RunStore,
  now: string,
  env: NodeJS.ProcessEnv = process.env,
  probe: OmpSweepProbe = {}
): InvariantViolation[] {
  const violations: InvariantViolation[] = [
    ...detectOmpViolations(store, probe), ...memoryViolations(store, env), ...embeddingsViolations(store, now), ...jevViolations(store, now)
  ];

  for (const row of store.findDuplicateEnabledSchedules()) {
    violations.push({
      kind: "duplicate_schedule",
      subject: row.subject,
      detail: { duplicate_count: row.duplicate_count, schedule_ids: row.schedule_ids }
    });
  }
  const queuedTurnBefore = new Date(Date.parse(now) - queuedTurnStuckMs(env)).toISOString();
  for (const row of store.findStuckRuns(new Date(Date.parse(now) - STUCK_RUN_GRACE_MS).toISOString(), queuedTurnBefore)) {
    violations.push({ kind: "stuck_run", subject: row.subject, detail: { state: row.state } });
  }
  violations.push(...undeliveredViolations(store, now, env));
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
  for (const row of store.findFailingLlmLegs(now, LLM_LEG_FAILING_WINDOW_MS, LLM_LEG_FAILING_MIN_ATTEMPTS)) {
    violations.push({ kind: "llm_leg_failing", subject: row.subject, detail: { attempts: row.attempts, ok: row.ok, last_error_kind: row.last_error_kind } });
  }
  const gap = store.findHeartbeatGap(now, HEARTBEAT_GAP_GRACE_MS);
  if (gap) {
    // A heartbeat that stopped because the operator PARKED the daemon (ADR 0018 kill switch) is
    // not an incident — it is the kill switch working. The park path leaves a marker precisely
    // so this sweep can tell the two apart after the tombstone is gone; the daemon removes the
    // marker on its first good cycle, so a later crash is reported normally.
    const park = readParkMarker(env);
    if (park) {
      console.log(
        `[invariant-sweep] heartbeat gap of ${gap.gap_minutes} min spans a deliberate park` +
          `${park.parked_at ? ` (parked_at ${park.parked_at})` : ""} — not an incident`
      );
    } else {
      violations.push({ kind: "heartbeat_gap", subject: gap.subject, detail: { gap_minutes: gap.gap_minutes } });
    }
  }
  return violations;
}

export interface InvariantSweepInput {
  store: RunStore;
  now: string;
  env?: NodeJS.ProcessEnv | undefined;
  /** Telegram chat for alerts; omit and the sweep still records incidents silently. */
  chat_id?: string | undefined;
  /** The data volume for `disk_free_low` (the daemon passes houge.sqlite's directory). */
  dataDir?: string;
  statfs?: OmpSweepProbe["statfs"];
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
  // The previous instant is read BEFORE the claim moves it: `wall_collapsed` counts rows since then.
  const since = input.store.getInvariantSweepState()?.last_swept_at ?? null;
  if (!input.store.claimInvariantSweep(input.now, resolveInvariantSweepIntervalMs(env))) return result;
  result.swept = true;

  const violations = detectViolations(input.store, input.now, env, {
    since, ...(input.dataDir ? { dataDir: input.dataDir } : {}), ...(input.statfs ? { statfs: input.statfs } : {})
  });
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
    // Only the sweep's own kinds: an incident opened elsewhere (omp_version_mismatch, …) is never
    // re-detected here, so "not seen this sweep" says nothing about it being over.
    if (seen.has(open.fingerprint) || !SWEEP_KINDS.has(open.kind)) continue;
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
