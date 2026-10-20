import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";

/**
 * omp's read text format, which the secret mask and the content checks were tested against (live gate 2b-i case 9, probed
 * again on omp 18.12.3, 2026-10-21): a hashline header `[path#HASH]`, then one `N:` (or `N-M:`, `N|`) prefix per line;
 * a paged read ends with a blank line and a bracketed note (`[Showing lines 1-300 of 4000. Use :301 to continue]`), and
 * Houge's own cap appends `[truncated by Houge at 32 KiB]`. The planner always runs with `edit` on, so every text read
 * carries the prefixes (`details.rowPrefixes: true`); a read without them is the mask reading a shape nobody tested.
 * Nothing pins omp's version (ADR 0028, 2026-10-07), so the first succeeded read in an untested shape pages
 * `omp_read_format_drift` once per omp version, and the next conforming read on that version resolves it.
 */
export const OMP_READ_FORMAT_DRIFT = "omp_read_format_drift";
const DRIFT_KINDS: ReadonlySet<string> = new Set([OMP_READ_FORMAT_DRIFT]);
const HEADER = /^\[[^\n]*#[0-9A-Fa-f]+\]$/;
const PREFIXED = /^\d{1,10}(?:-\d{1,10})?[:|]/;
/** A bracketed note line (omp's paging note, Houge's truncation note): never file content. */
const NOTE = /^\[[^\n]*\]$/;
export type ReadFormat = "prefixed" | "unknown";

/** `prefixed` when every line is in the tested shape (notes and blank lines allowed after the header); else `unknown`. */
export function readFormat(text: string): ReadFormat {
  const lines = text.split("\n");
  if (!HEADER.test(lines[0] ?? "")) return "unknown";
  for (const l of lines.slice(1)) if (l !== "" && !PREFIXED.test(l) && !NOTE.test(l)) return "unknown";
  return "prefixed";
}

/** One page per omp version while a drift is open; a conforming read on that version resolves it (the row only, no page). */
export function syncReadFormatDrift(store: RunStore, version: string | null, format: ReadFormat, o: { env: NodeJS.ProcessEnv; now?: string }): void {
  const subject = `omp:${version ?? "unknown"}`;
  const now = o.now ?? new Date().toISOString();
  if (format === "unknown") { openAlertedIncident(store, { kind: OMP_READ_FORMAT_DRIFT, subject, detail: { version }, env: o.env, now }); return; }
  if (store.findOpenIncident(store.incidentFingerprint(OMP_READ_FORMAT_DRIFT, subject))) resolveOpenIncidents(store, DRIFT_KINDS, subject, now);
}
