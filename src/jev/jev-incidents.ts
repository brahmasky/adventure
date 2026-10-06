import { JEV_PROVIDER } from "../llm/metered-pricing.js";
import { openAlertedIncident } from "../run/incident-alert.js";
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
