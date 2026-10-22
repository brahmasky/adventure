import { resolveOpenIncidents } from "../run/incident-alert.js";
import type { JevAnchorRow, JevModelRow, JevModelState, RunStore } from "../run/run-store.js";
import type { CheckMargin } from "./jev-version-check.js";
import { JEV_MODEL_INCIDENT_KINDS, jevModelSubject, marginLines } from "./jev-version-job.js";

/**
 * Paco's controls over the Jev version check (spec 2026-10-22 §2.6): `houge jev models`, `houge jev check [model]`,
 * `houge jev accept <model>`, and the Accept the card's button shares. Each returns its message; the CLI prints it.
 */
export interface ControlResult { ok: boolean; message: string }

/**
 * Accept → `accepted` (everything armed on that model), fenced on the state it was read in; resolves the model's check
 * incident. Final fix C (controller ruling): an Accept on a `drifted` or `insufficient` model also makes it the reference,
 * in the same transaction; a model Accepted from `checking` or `deferred` (CLI) arms without re-anchoring.
 */
export function acceptJevModel(store: RunStore, row: JevModelRow, from: readonly JevModelState[], via: string, now: string): boolean {
  if (!from.includes(row.state)) return false;
  const accepted = store.inTransaction(() => {
    if (!store.setJevModelState(row.model, row.state, "accepted", JSON.stringify({ accepted_from: row.state, via, generation: row.generation }), now)) return false;
    if (REANCHOR_FROM.includes(row.state)) reanchor(store, row, via, now);
    return true;
  });
  if (accepted) resolveOpenIncidents(store, JEV_MODEL_INCIDENT_KINDS, jevModelSubject(row.model), now);
  return accepted;
}

const REANCHOR_FROM: readonly JevModelState[] = ["drifted", "insufficient"];
const ANCHOR_RUNS = ["A", "B"] as const;

/**
 * Paco's Accept makes the accepted model the reference (adversarial 1): its run A and run B answers from the current check
 * generation replace the anchor's A and B answers, turn by turn, only where it answered every question of both runs (the
 * other turns keep their answers). Same turns, stored states and criteria hashes; Paco's labels are never replaced (they
 * stay the absolute reference for check c). A model that passed its own check never comes here: no silent ratchet.
 */
function reanchor(store: RunStore, row: JevModelRow, via: string, now: string): void {
  const answered = new Map<string, Record<string, unknown>>();
  for (const r of store.listJevCheckRuns(row.model, row.generation, "tree")) if (r.outcome === "answered") answered.set(r.run, JSON.parse(r.detail_json) as Record<string, unknown>);
  const byTurn = new Map<string, JevAnchorRow[]>();
  for (const a of ANCHOR_RUNS.flatMap((run) => store.anchorAnswers(run))) byTurn.set(a.turn_id, [...(byTurn.get(a.turn_id) ?? []), a]);
  let turns = 0;
  for (const [turn, rows] of byTurn) {
    const next = rows.map((a) => ({ a, answer: answered.get(`${a.run}:${turn}`)?.[a.question_id] }));
    if (next.length === 0 || next.some((n) => n.answer === undefined)) continue;
    for (const { a, answer } of next) store.replaceAnchorAnswer({ turn_id: turn, question_id: a.question_id, run: a.run, answer_json: JSON.stringify(answer), model: row.model });
    turns += 1;
  }
  store.setAnchorMeta("anchor_model", JSON.stringify({ model: row.model, generation: row.generation, via, at: now, turns }));
}

const CLI_ACCEPT_FROM: readonly JevModelState[] = ["checking", "deferred", "drifted", "insufficient"];

/** The CLI's account of a re-anchor (final fix C1): how many anchor turns now hold this model's answers. */
function reanchoredLine(store: RunStore, model: string): string {
  try {
    const m = JSON.parse(store.getAnchorMeta("anchor_model") ?? "null") as { model?: string; turns?: number } | null;
    return m?.model === model ? `; ${m.turns ?? 0} anchor turns now hold its answers (Paco's labels unchanged)` : "";
  } catch { return ""; }
}

export function acceptJevModelCli(store: RunStore, model: string, now: string): ControlResult {
  const row = store.getJevModel(model);
  if (!row) return { ok: false, message: `jev accept: no model ${model} (see houge jev models)` };
  if (row.state === "accepted" || row.state === "trusted") return { ok: true, message: `jev accept: ${model} is already ${row.state}; everything is armed on it` };
  return acceptJevModel(store, row, CLI_ACCEPT_FROM, "cli", now)
    ? { ok: true, message: `jev accept: ${model} accepted; the triage tree arms everything on it${reanchoredLine(store, model)}` }
    : { ok: false, message: `jev accept: ${model} changed state meanwhile; run houge jev models and try again` };
}

/**
 * `houge jev check [model]`: requests always name the alias, so only the model the alias serves now can be checked; the
 * newest Jev answer in the ledger says which one that is. Queues it (`checking`, detail cleared so the job starts a new
 * generation); the daemon's next tick runs it.
 */
export function requestJevCheck(store: RunStore, model: string | undefined, now: string): ControlResult {
  const latest = store.latestJevAttemptModel();
  if (!latest) return { ok: false, message: "jev check: no Jev answer recorded yet, so the model behind the alias is unknown; nothing queued" };
  const served = latest.model;
  if (model !== undefined && model !== served) {
    return { ok: false, message: `jev check: refused: the alias serves ${served} (as of ${latest.at}, the newest Jev answer), not ${model}; only the served model can be checked (houge jev check ${served})` };
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
