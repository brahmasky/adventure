import { openAlertedIncident } from "../run/incident-alert.js";
import type { ImproveTickRow, RunStore } from "../run/run-store.js";

/**
 * Spec 2026-11-07 §7: the faults page that replaces the digest's Watch alarm. Read from improve_ticks rows (one per local
 * date with its final result and accumulated counts, never from the ledger: a resumed date emits several events), judged
 * once per tick date at its end, on that date's row only, in date order. Text: kinds, counts and dates only.
 */
export const IMPROVE_DEGRADED_KIND = "improve_tick_degraded";
export const IMPROVE_DEGRADED_SUBJECT = "improve";
export const DEGRADED_RUN = 3;
export const DEGRADED_LOOKBACK_DAYS = 14;
export type DateHealth = "bad" | "healthy" | "neutral";
const n = (row: ImproveTickRow, k: string): number => (typeof row.detail[k] === "number" ? (row.detail[k] as number) : 0);

/** failed, a stuck previous date, or nothing decided while an outage count was above 0 → bad; done ∧ (decided ∨ no group) ∧ embedder up → healthy; else (stopped; budget deferrals) neutral. */
export function judgeTickDate(row: ImproveTickRow, previous: ImproveTickRow | undefined): DateHealth {
  if (row.result === "failed" || previous?.result === "running") return "bad";
  if (row.result !== "done") return "neutral";
  const decided = n(row, "decided");
  if (decided === 0 && (n(row, "deferred_outage") > 0 || n(row, "record_failed") > 0 || n(row, "embed_unavailable") > 0)) return "bad";
  return (decided > 0 || n(row, "groups") === 0) && n(row, "embed_unavailable") === 0 ? "healthy" : "neutral";
}

/** The run of consecutive bad dates ending at the newest row: neutral dates are skipped, a healthy one ends the run. */
export function badRun(rows: readonly ImproveTickRow[]): number {
  let run = 0;
  for (let k = rows.length - 1; k >= 0; k -= 1) {
    const h = judgeTickDate(rows[k]!, rows[k - 1]);
    if (h === "healthy") break;
    if (h === "bad") run += 1;
  }
  return run;
}

export interface DegradedDeps { store: RunStore; now: string; env: NodeJS.ProcessEnv; chatId: string | null }

/** Opens at once on a failed or stuck date, or on the third bad date with no healthy date between them (a neutral date is skipped: it neither counts nor resets, P19); resolves on a healthy date. Only the newest date is judged, so an older bad date never reopens a page a newer healthy date resolved. */
export function evaluateImproveDegraded(d: DegradedDeps, date: string): "opened" | "resolved" | "none" {
  const since = new Date(Date.parse(d.now) - DEGRADED_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = d.store.listImproveTicksSince(since);
  const row = rows.at(-1);
  if (!row || row.local_date !== date) return "none";
  const health = judgeTickDate(row, rows.at(-2));
  const fingerprint = d.store.incidentFingerprint(IMPROVE_DEGRADED_KIND, IMPROVE_DEGRADED_SUBJECT);
  if (health === "healthy") {
    const open = d.store.findOpenIncident(fingerprint);
    if (!open) return "none";
    d.store.resolveIncident(open.incident_id, d.now);
    return "resolved";
  }
  if (health === "neutral") return "none";
  const run = badRun(rows);
  if (row.result !== "failed" && rows.at(-2)?.result !== "running" && run < DEGRADED_RUN) return "none";
  const detail = { date, result: row.result, run, decided: n(row, "decided"), deferred_outage: n(row, "deferred_outage"), record_failed: n(row, "record_failed"), embed_unavailable: n(row, "embed_unavailable") };
  return openAlertedIncident(d.store, { kind: IMPROVE_DEGRADED_KIND, subject: IMPROVE_DEGRADED_SUBJECT, detail, now: d.now, env: d.env, chat_id: d.chatId }) ? "opened" : "none";
}
