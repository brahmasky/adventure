import { JEV_PROVIDER } from "../llm/metered-pricing.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";
import type { JevResult } from "./jev-client.js";

/** Jev outage classes (ADR 0029 §3.3). The FIRST failure opens an alerted incident; dedupe/flap damping is openAlertedIncident's. */
export type JevIncidentKind = "jev_auth" | "jev_rate_limited" | "jev_overloaded" | "jev_question_invalid" | "jev_no_key";
export const JEV_INCIDENT_SUBJECT = JEV_PROVIDER; // reuse the provider constant: the metered-name scan forbids a second literal outside src/llm

type JevFailure = Extract<JevResult, { ok: false }>;

export function jevIncidentKind(r: JevFailure): JevIncidentKind | undefined {
  if (r.reason === "no_key") return "jev_no_key";
  if (r.reason === "auth") return "jev_auth";
  if (r.reason === "fused") return undefined; // the metered-fuse latch already alerted (ADR 0019)
  switch (r.error_kind) {
    case "rate_limited": return "jev_rate_limited";
    case "overloaded": return "jev_overloaded";
    case "malformed_question": return "jev_question_invalid";
    default: return undefined; // timeout / parse / transport: per-call noise, visible in the decision rows
  }
}

/** Never puts `detail` (which may echo provider text) into the incident; only enums and ids. */
export function openJevIncident(store: RunStore, r: JevFailure, detail: Record<string, unknown>): void {
  const kind = jevIncidentKind(r);
  if (!kind) return;
  openAlertedIncident(store, { kind, subject: JEV_INCIDENT_SUBJECT, detail: { ...detail, error_kind: r.error_kind ?? null, reason: r.reason } });
}

/** The conditions an ANSWERED call disproves: Jev is reachable, authorised, keyed, under its limits, and the questions valid. */
export const JEV_ANSWERED_RESOLVES: ReadonlySet<string> = new Set<JevIncidentKind>(["jev_auth", "jev_rate_limited", "jev_overloaded", "jev_no_key", "jev_question_invalid"]);

/** Resolve them so the next outage opens (and pages) again: openAlertedIncident dedupes on the OPEN fingerprint. */
export function resolveJevIncidentsOnAnswer(store: RunStore): number {
  return resolveOpenIncidents(store, JEV_ANSWERED_RESOLVES, JEV_INCIDENT_SUBJECT);
}

/** Stage B §6: three Dig deeper taps on one lane in seven days page Paco (one open page per lane per episode). */
export const TRIAGE_OVERRIDE_LIMIT = 3;
export const TRIAGE_OVERRIDE_WINDOW_DAYS = 7;
const TRIAGE_OVERRIDES = "triage_overrides";
const LANE_SUBJECT = new RegExp(`^${JEV_INCIDENT_SUBJECT}:lane:([a-z_]+)$`);

/** The per-lane page's subject; its open fingerprint is the throttle (one page per lane per episode). */
export function triageOverrideSubject(lane: string): string {
  return `${JEV_INCIDENT_SUBJECT}:lane:${lane}`;
}

/** The start of the tap window that ends at `now`. */
export function triageOverrideSince(now: string): string {
  return new Date(Date.parse(now) - TRIAGE_OVERRIDE_WINDOW_DAYS * 86_400_000).toISOString();
}

/**
 * Stage B §6: resolve each open per-lane `triage_overrides` page whose lane is now under the limit in the window, so the
 * next episode pages again. A subject that names no lane is left alone. Called after each tap (gateway), at each triage
 * (core-worker) and from the sweep's effect phase. Returns how many it resolved.
 */
export function resolveQuietTriageOverrides(store: RunStore, now: string = new Date().toISOString()): number {
  let resolved = 0;
  for (const open of store.listOpenIncidents()) {
    const lane = open.kind === TRIAGE_OVERRIDES ? LANE_SUBJECT.exec(open.subject)?.[1] : undefined;
    if (lane === undefined || store.countRecentTriageOverrides(lane, triageOverrideSince(now)) >= TRIAGE_OVERRIDE_LIMIT) continue;
    if (store.resolveIncident(open.incident_id, now)) resolved += 1;
  }
  return resolved;
}

/**
 * `jev_model_uncalibrated` retired (Jev version check): calibration no longer keys on the reported version, so an alias
 * move is not a loss to page. The per-model check (spec 2026-10-22) owns that signal. An incident the old code left open
 * resolves here, so it cannot linger forever with nothing left to clear it.
 */
export const RETIRED_JEV_MODEL_UNCALIBRATED = "jev_model_uncalibrated";
export function resolveRetiredModelIncidents(store: RunStore, now: string = new Date().toISOString()): number {
  let resolved = 0;
  for (const open of store.listOpenIncidents()) {
    if (open.kind === RETIRED_JEV_MODEL_UNCALIBRATED && store.resolveIncident(open.incident_id, now)) resolved += 1;
  }
  return resolved;
}
