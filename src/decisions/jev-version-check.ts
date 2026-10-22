/**
 * The Jev version check (spec 2026-10-22 §2): a Jev version move is checked by code against Paco's approved reference
 * turns; the triage tree arms on a call only when the model Jev REPORTED for that call has a state that allows it.
 * This file holds the arming read (Task 3); the check itself joins it later. Protected (src/decisions/): the gate.
 */
import { errorCode } from "../domain/error-code.js";
import type { Lang } from "../jev/intent-question.js";
import { JEV_REQUEST_MODEL } from "../jev/jev-client.js";
import { TREE_QUESTIONS } from "../jev/questions/tree.js";
import type { JevModelRow } from "../run/run-store.js";

/** The lanes a failed label check (§2.5 c) can disarm one by one. */
export const DISARMABLE_LANES = ["memory", "status", "answer", "lookup"] as const;
export type DisarmableLane = (typeof DISARMABLE_LANES)[number];

/**
 * `jev_models.detail_json` of a `drifted` model (§2.5 d), written by the check: the tree questions that failed checks a/b,
 * whether the route check failed (then the whole tree is unarmed), and the lanes check c disarmed.
 */
export interface JevDriftDetail { failed_questions: string[]; route_failed: boolean; lanes_disarmed: string[] }

/** One call's arming from its model's check state: the tree questions it may act on, and the lanes it may not. */
export interface ModelArming { questions: ReadonlySet<string>; lanesDisarmed: ReadonlySet<DisarmableLane> }
export const NOT_ARMED: ModelArming = Object.freeze({ questions: new Set<string>(), lanesDisarmed: new Set<DisarmableLane>() });
const TREE_IDS: readonly string[] = TREE_QUESTIONS.map((q) => q.id);

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The drift detail, validated; null when it is not one (a hand-edited or half-written row arms nothing). */
export function parseDriftDetail(json: string | null): JevDriftDetail | null {
  let v: unknown;
  try { v = JSON.parse(json ?? ""); } catch { return null; }
  if (typeof v !== "object" || v === null) return null;
  const d = v as Record<string, unknown>;
  if (!isStrings(d.failed_questions) || typeof d.route_failed !== "boolean" || !isStrings(d.lanes_disarmed)) return null;
  return { failed_questions: d.failed_questions, route_failed: d.route_failed, lanes_disarmed: d.lanes_disarmed };
}

/**
 * A model's row → its arming: trusted / accepted arm every question; drifted arms all but its failed questions and lanes,
 * none when the route check failed; checking, deferred, insufficient and no row arm nothing (fail closed).
 */
export function armingOf(row: JevModelRow | undefined): ModelArming {
  if (row?.state === "trusted" || row?.state === "accepted") return { questions: new Set(TREE_IDS), lanesDisarmed: new Set() };
  if (row?.state !== "drifted") return NOT_ARMED;
  const d = parseDriftDetail(row.detail_json);
  if (d === null) {
    console.error(`jev: drifted model ${row.model}: detail unreadable; tree unarmed`);
    return NOT_ARMED;
  }
  if (d.route_failed) return NOT_ARMED;
  return { questions: new Set(TREE_IDS.filter((id) => !d.failed_questions.includes(id))),
    lanesDisarmed: new Set(DISARMABLE_LANES.filter((l) => d.lanes_disarmed.includes(l))) };
}

/**
 * Spec §2.3: the one read that arms the tree. The model is the one Jev REPORTED for this call (the decision's), never
 * the request alias. `lang`: zh's verdict covers zh and mixed, and en inherits it (30 anchor turns, §7), so the model's
 * one state serves every language. Any store error leaves the tree unarmed, logged with its code.
 */
export function treeArmingFor(store: { getJevModel(model: string): JevModelRow | undefined }, decision: { model: string }, lang: Lang): ModelArming {
  const model = decision.model;
  if (!model || model === JEV_REQUEST_MODEL) return NOT_ARMED;
  try {
    return armingOf(store.getJevModel(model));
  } catch (e) {
    console.error(`jev: model check state read failed (${lang}): ${errorCode(e)}; tree unarmed`);
    return NOT_ARMED;
  }
}
