import { ALERT_REOPEN_QUIET_MS, openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { DecisionInsert, RunStore } from "../run/run-store.js";
import { TOOL_INJECTION_ID } from "./entries/tool-injection.js";
import { FRONT_DOOR_ENTRIES } from "./entry-ids.js";
import { message } from "./decide.js";
import { RUNNER_REASON_CODES, type AnyDecideResult, type AnyEntry, type DecisionRecorder } from "./types.js";
import { enqueueUrgentCard } from "./urgent.js";

/** Spec §8.2: an entry falling back to `fail` this many times in this window pages once. */
export const DECISION_FALLBACK_LIMIT = 3;
export const DECISION_FALLBACK_WINDOW_MS = 60 * 60 * 1000;
/**
 * Plan ruling 9: entries whose Jev-rung failures already page through the Jev incidents (openJevIncident and the triage
 * jev_skip_rate). Their Jev failures do not count toward decision_fallback: one call, one page. tool.injection joins them
 * (Paco 2026-10-14, "no alert, just log"): its plain timeouts and outages are logged and counted in the digest only; the
 * turn's trust rise is the safety answer, and 429/auth still page through the Jev incidents.
 */
const JEV_PAGED_ELSEWHERE: ReadonlySet<string> = new Set([...FRONT_DOOR_ENTRIES, TOOL_INJECTION_ID]);
const RECORD_FAILED: ReadonlySet<string> = new Set(["decision_record_failed"]);
const RUNNER_CODES: ReadonlySet<string> = new Set(RUNNER_REASON_CODES);

/** Spec §5.2: a row when the verdict is not the default, a rung past the first rule decided or ran in shadow, Paco took part, or the entry always records. */
export function shouldRecord(entry: AnyEntry, r: AnyDecideResult): boolean {
  if (entry.alwaysRecord || r.verdict !== entry.defaultVerdict || r.armedMode !== "on") return true;
  if (r.rung !== "rule") return true;
  return r.walk.length > 1 || r.walk.some((o) => o.kind === "paco" && o.result !== null);
}

export interface RecorderOptions { env?: NodeJS.ProcessEnv; now?: () => string }

/**
 * The store-backed recorder. Never throws (every failure is logged and becomes an incident) and opens no transaction, so a
 * caller may run it inside its own (Task 8b writes the front door's rows inside settleTriage's).
 */
export function storeRecorder(store: RunStore, o: RecorderOptions = {}): DecisionRecorder {
  return {
    record: (entry, r, ctx) => {
      const now = (o.now ?? (() => new Date().toISOString()))();
      if (clears(entry.id, r)) clearFallback(store, entry.id, now); // only an answer from a rung that counts shows it is back
      if (!shouldRecord(entry, r)) return null;
      let id: string;
      try {
        id = store.insertDecision(rowOf(entry, r, ctx, now));
      } catch (e) {
        recordFailed(store, entry.id, e, o, now);
        return null;
      }
      afterRecord(store, entry.id, r, o, now);
      return id;
    }
  };
}

function rowOf(entry: AnyEntry, r: AnyDecideResult, ctx: { run_id: string | null; tool_call_id: string | null }, now: string): DecisionInsert {
  const known = r.reason !== null && (entry.reasonCodes.includes(r.reason) || RUNNER_CODES.has(r.reason));
  return {
    entry_id: entry.id, entry_version: entry.version, run_id: ctx.run_id, tool_call_id: ctx.tool_call_id, stage: entry.stage, rung: r.rung, verdict: r.verdict,
    p: r.p ?? null, p_index: r.pIndex ?? null, reask: r.reask?.kind ?? null, p_first: r.reask?.pFirst ?? null, reason_code: known ? r.reason : null, fallback_reason: r.fallbackReason, fallback_rung: r.fallbackRung,
    armed_mode: r.armedMode, latency_ms: r.latencyMs, created_at: now
  };
}

function recordFailed(store: RunStore, entry_id: string, e: unknown, o: RecorderOptions, now: string): void {
  console.error(`decisions: ${entry_id} record failed: ${message(e)}`);
  try {
    openAlertedIncident(store, { kind: "decision_record_failed", subject: entry_id, detail: { entry: entry_id }, now, ...(o.env ? { env: o.env } : {}) });
  } catch (e2) {
    console.error(`decisions: decision_record_failed could not open: ${message(e2)}`);
  }
}

/**
 * Senior re-review W1: an answer clears decision_fallback only from a rung whose failures count toward it — any judge for
 * most entries, but only the cascade (model) for an entry whose Jev failures page elsewhere.
 */
function clears(entry_id: string, r: AnyDecideResult): boolean {
  return r.rung === "model" || (r.rung === "system_one" && !JEV_PAGED_ELSEWHERE.has(entry_id));
}

/** A named failure that counts toward decision_fallback (ruling 9): not budget, and not a Jev failure another incident pages. */
function countsAsFallback(entry_id: string, r: AnyDecideResult): boolean {
  if (r.rung !== "fail" || r.fallbackReason === null || r.fallbackReason === "budget") return false;
  return !(JEV_PAGED_ELSEWHERE.has(entry_id) && r.fallbackRung === "system_one");
}

function afterRecord(store: RunStore, entry_id: string, r: AnyDecideResult, o: RecorderOptions, now: string): void {
  try {
    resolveOpenIncidents(store, RECORD_FAILED, entry_id, now);
    if (!countsAsFallback(entry_id, r)) return;
    const since = new Date(Date.parse(now) - DECISION_FALLBACK_WINDOW_MS).toISOString();
    const n = store.countDecisionFallbacks(entry_id, since, JEV_PAGED_ELSEWHERE.has(entry_id));
    if (n >= DECISION_FALLBACK_LIMIT) pageFallback(store, entry_id, n, o, now);
  } catch (e) {
    console.error(`decisions: ${entry_id} incident bookkeeping failed: ${message(e)}`);
  }
}

/**
 * Opens the row with no generic alert (env {}), then sends the code-built urgent card once per open incident. A reopen
 * within ALERT_REOPEN_QUIET_MS of the last resolve records its row and sends nothing (E12's flap damping, as
 * openAlertedIncident does for its own alert).
 */
function pageFallback(store: RunStore, entry_id: string, n: number, o: RecorderOptions, now: string): void {
  const fingerprint = store.incidentFingerprint("decision_fallback", entry_id);
  const flapping = store.findRecentlyResolvedIncident(fingerprint, new Date(Date.parse(now) - ALERT_REOPEN_QUIET_MS).toISOString()) !== undefined;
  const opened = openAlertedIncident(store, { kind: "decision_fallback", subject: entry_id, detail: { entry: entry_id, limit: DECISION_FALLBACK_LIMIT, window_min: 60 }, env: {}, now });
  if (!opened || flapping) return;
  const chat = (o.env ?? process.env).HOUGE_TELEGRAM_CHAT_ID?.trim();
  const incident = store.findOpenIncident(fingerprint);
  if (chat && incident) enqueueUrgentCard(store, { chat_id: chat, key: `decision_fallback:${incident.incident_id}`, text: fallbackCardText(entry_id, n) });
}

/** Resolves an open decision_fallback on a counting rung's answer, recorded or not (spec §8.2 "the next answered call"). */
function clearFallback(store: RunStore, entry_id: string, now: string): void {
  try {
    const open = store.findOpenIncident(store.incidentFingerprint("decision_fallback", entry_id));
    if (open) store.resolveIncident(open.incident_id, now);
  } catch (e) {
    console.error(`decisions: ${entry_id} fallback resolve failed: ${message(e)}`);
  }
}

export function fallbackCardText(entry_id: string, n: number): string {
  return `⚠️ *${entry_id}* fell back to its fail answer ${n} times in the last hour (no rung answered). Houge keeps working on the fail path; the next answer from the failing rung clears this.`;
}
