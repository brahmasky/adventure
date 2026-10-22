import { resolveOpenIncidents } from "../run/incident-alert.js";
import type { JevModelRow, JevModelState, RunStore } from "../run/run-store.js";
import type { CheckMargin } from "./jev-version-check.js";
import { JEV_MODEL_INCIDENT_KINDS, jevModelSubject, marginLines } from "./jev-version-job.js";

/**
 * Paco's controls over the Jev version check (spec 2026-10-22 §2.6): `houge jev models`, `houge jev check [model]`,
 * `houge jev accept <model>`, and the Accept the card's button shares. Each returns its message; the CLI prints it.
 */
export interface ControlResult { ok: boolean; message: string }

/** Accept → `accepted` (everything armed on that model), fenced on the state it was read in; resolves the model's check incident. */
export function acceptJevModel(store: RunStore, row: JevModelRow, from: readonly JevModelState[], via: string, now: string): boolean {
  if (!from.includes(row.state)) return false;
  const accepted = store.setJevModelState(row.model, row.state, "accepted", JSON.stringify({ accepted_from: row.state, via, generation: row.generation }), now);
  if (accepted) resolveOpenIncidents(store, JEV_MODEL_INCIDENT_KINDS, jevModelSubject(row.model), now);
  return accepted;
}

const CLI_ACCEPT_FROM: readonly JevModelState[] = ["checking", "deferred", "drifted", "insufficient"];

export function acceptJevModelCli(store: RunStore, model: string, now: string): ControlResult {
  const row = store.getJevModel(model);
  if (!row) return { ok: false, message: `jev accept: no model ${model} (see houge jev models)` };
  if (row.state === "accepted" || row.state === "trusted") return { ok: true, message: `jev accept: ${model} is already ${row.state}; everything is armed on it` };
  return acceptJevModel(store, row, CLI_ACCEPT_FROM, "cli", now)
    ? { ok: true, message: `jev accept: ${model} accepted; the triage tree arms everything on it` }
    : { ok: false, message: `jev accept: ${model} changed state meanwhile; run houge jev models and try again` };
}

/**
 * `houge jev check [model]`: requests always name the alias, so only the model the alias serves now can be checked; the
 * newest Jev answer in the ledger says which one that is. Queues it (`checking`, detail cleared so the job starts a new
 * generation); the daemon's next tick runs it.
 */
export function requestJevCheck(store: RunStore, model: string | undefined, now: string): ControlResult {
  const served = store.latestJevAttemptModel();
  if (!served) return { ok: false, message: "jev check: no Jev answer recorded yet, so the model behind the alias is unknown; nothing queued" };
  if (model !== undefined && model !== served) {
    return { ok: false, message: `jev check: refused: the alias serves ${served} now, not ${model}; only the served model can be checked (houge jev check ${served})` };
  }
  store.noteJevModel(served, now);
  const row = store.getJevModel(served)!;
  if (row.state === "checking") return { ok: true, message: `jev check: ${served} is already queued or being checked` };
  return store.setJevModelState(served, row.state, "checking", "{}", now)
    ? { ok: true, message: `jev check: ${served} queued (was ${row.state}); the daemon checks it at its next tick, nothing is armed on it until then` }
    : { ok: false, message: `jev check: ${served} changed state meanwhile; try again` };
}

function marginsOf(detail: string | null): Record<string, CheckMargin> | null {
  try { const m = (JSON.parse(detail ?? "null") as { margins?: Record<string, CheckMargin> } | null)?.margins; return m && typeof m === "object" ? m : null; } catch { return null; }
}

/** `houge jev models`: each model's state, attempts and check time, and the margins of its last check (null as n/a). */
export function formatJevModels(store: RunStore): string {
  const rows = store.listJevModels();
  if (rows.length === 0) return "jev models: none seen yet";
  return rows.flatMap((r) => {
    const m = marginsOf(r.detail_json);
    return [`${r.model}  ${r.state}  generation ${r.generation}  attempts ${r.attempts}  checked ${r.checked_at ?? "-"}`, ...(m ? marginLines(m).map((l) => `  ${l}`) : [])];
  }).join("\n");
}
