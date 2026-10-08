import { JEV_REQUEST_MODEL } from "./jev-client.js";
import { existsSync } from "node:fs";
import { JEV_PROVIDER } from "../llm/metered-pricing.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";
import type { CalibrationRow } from "./calibration.js";
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

export const TRIAGE_OVERRIDE_KINDS: ReadonlySet<string> = new Set(["triage_overrides"]);

/**
 * `triage_overrides` is a condition whose durable state is the disarm marker (spec §5.8): it resolves once Paco has deleted
 * the marker, so a later drift episode opens and pages again. While the marker exists it stays open (one page per episode).
 */
export function resolveTriageOverridesIfRearmed(store: RunStore, markerPath: string): number {
  if (existsSync(markerPath)) return 0;
  return resolveOpenIncidents(store, TRIAGE_OVERRIDE_KINDS, JEV_INCIDENT_SUBJECT);
}

export const JEV_MODEL_UNCALIBRATED = "jev_model_uncalibrated";
const UNCALIBRATED_KINDS: ReadonlySet<string> = new Set([JEV_MODEL_UNCALIBRATED]);

/**
 * The request names TypeSafe's moving alias (`jev-latest`); calibration rows key on the REPORTED model. When the alias moves,
 * the new id has no row and every lane falls through to the planner: safe, but the armed lanes are lost silently. So an
 * answered call on a model with no row, while rows exist for another model, opens one alerted incident per model (the open
 * incident is the throttle). No rows at all = nothing armed = nothing lost: no page, and every open one resolves. A model's incident resolves only once
 * rows name THAT model (Paco approved it), never because another model answered: a canary serving two ids behind the alias
 * would otherwise open and resolve on alternating turns and re-page. A row naming the alias never arms (calibratedLang), so
 * it is not counted. The sweep never touches this kind (not in SWEEP_INCIDENT_KINDS).
 */
export function checkJevModelCalibrated(store: RunStore, model: string, rows: readonly CalibrationRow[], env: NodeJS.ProcessEnv = process.env): void {
  const calibrated = [...new Set(rows.map((r) => r.model).filter((m) => m !== JEV_REQUEST_MODEL))].sort();
  if (calibrated.length === 0) { resolveOpenIncidents(store, UNCALIBRATED_KINDS); return; } // nothing armed → nothing lost
  for (const m of calibrated) resolveOpenIncidents(store, UNCALIBRATED_KINDS, m);
  if (calibrated.includes(model)) return;
  openAlertedIncident(store, { kind: JEV_MODEL_UNCALIBRATED, subject: model, env, detail: { model, calibrated_models: calibrated,
    note: `Jev moved to ${model}; the lanes fall back to the planner until new calibration rows are approved for it.` } });
}
