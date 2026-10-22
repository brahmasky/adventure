/**
 * The Jev version check (spec 2026-10-22 §2): a Jev version move is checked by code against Paco's approved reference
 * turns; the triage tree arms on a call only when the model Jev REPORTED for that call has a state that allows it.
 * This file holds the arming (the model's check state, the calibration rows and the lane dependencies, all applied here:
 * Paco's middle path 2026-10-22) and the check's maths. Protected (src/decisions/): the gate. tree-policy.ts only routes
 * on the `Armed` computed here and stays self-writable.
 */
import { errorCode } from "../domain/error-code.js";
import { calibratedLang, type CalibrationRow } from "../jev/calibration.js";
import type { Lang } from "../jev/intent-question.js";
import { JEV_REQUEST_MODEL, type JevAnswer } from "../jev/jev-client.js";
import { isBareAck } from "../omp/bare-ack.js";
import {
  TREE_ACTIONS, TREE_BREADTH, TREE_CATEGORY, TREE_QUESTIONS, TREE_REASONING, TREE_RULE_SCOPE, TREE_SETS_RULE, type LastHougeTurn
} from "../jev/questions/tree.js";
import { criteriaHash, type Question } from "../jev/questions/types.js";
import {
  preJudge, routeTree, thinkHarderIn, ACK_ROUTE, TREE_BAR_DEFAULTS, type Armed, type LaneSwitch, type TreeBars
} from "../jev/tree-policy.js";
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
 * none when the route check failed; checking, deferred, insufficient and no row arm nothing (fail closed). An unreadable
 * drift detail arms nothing and is logged once per model and check generation.
 */
/** The models (by check generation) whose unreadable detail is already on stderr: one line each, not one per turn. */
const unreadableLogged = new Set<string>();

export function armingOf(row: JevModelRow | undefined): ModelArming {
  if (row?.state === "trusted" || row?.state === "accepted") return { questions: new Set(TREE_IDS), lanesDisarmed: new Set() };
  if (row?.state !== "drifted") return NOT_ARMED;
  const d = parseDriftDetail(row.detail_json);
  if (d === null) {
    const key = `${row.model}#${row.generation}`;
    if (!unreadableLogged.has(key)) console.error(`jev: drifted model ${row.model}: detail unreadable; tree unarmed`);
    unreadableLogged.add(key);
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

/** The status lane's own arming key: the category question's hash under a distinct id, so a `category` row never arms status. */
export const TREE_STATUS_ARM_ID = "category:status";
/** Stage B spec §2: the answer and lookup lanes' own keys, at the category hash; a `category` row alone never arms a lane. */
export const TREE_ANSWER_ARM_ID = "category:answer";
export const TREE_LOOKUP_ARM_ID = "category:lookup";

/**
 * What the tree may act on: each decision arms on its own calibration rows (lessons.md 2026-10-06) AND on the reported
 * model's check state (`arming`, from `treeArmingFor`): `rule` on sets_rule + rule_scope, gear on its three scores, the
 * memory lane on category alone (the rule rows only sharpen its lesson scope, Rev 2.1 item 1). Dependencies (spec §2.3):
 * category disarms memory, status, answer, lookup; rule disarms status, answer, lookup; gear disarms answer, lookup. The
 * status lane needs category (named change 2026-10-22) and rule (statusBranch F6). The answer and lookup lanes arm on their
 * pseudo-rows and are unarmed while listed in `lanesOff` (HOUGE_JEV_LANES_OFF) or disarmed by the model's label check.
 * Computed only here (protected); tree-policy.ts routes on the result.
 */
export function treeArmed(lang: Lang, rows: readonly CalibrationRow[], lanesOff: ReadonlySet<LaneSwitch>, arming: ModelArming): Armed {
  const on = (qs: readonly Question[]): boolean =>
    qs.every((q) => arming.questions.has(q.id) && calibratedLang(q.id, criteriaHash(q), lang, rows) !== undefined);
  const pseudo = (id: string): boolean => calibratedLang(id, criteriaHash(TREE_CATEGORY), lang, rows) !== undefined;
  const lane = (l: DisarmableLane): boolean => !arming.lanesDisarmed.has(l);
  const category = on([TREE_CATEGORY]);
  const rule = on([TREE_SETS_RULE, TREE_RULE_SCOPE]);
  const gear = on([TREE_BREADTH, TREE_REASONING, TREE_ACTIONS]);
  const routed = (id: string, l: LaneSwitch): boolean => pseudo(id) && category && rule && gear && lane(l) && !lanesOff.has(l);
  return {
    category, rule, gear, memory: category && lane("memory"), status: pseudo(TREE_STATUS_ARM_ID) && category && rule && lane("status"),
    answer: routed(TREE_ANSWER_ARM_ID, "answer"), lookup: routed(TREE_LOOKUP_ARM_ID, "lookup")
  };
}

// ── Agreement and label counts (spec §2.2 baselines, §2.5 checks a-c): the one place the formulas live ──

/** Constants of the check (spec §2.5): the anchor's minimum zh turns, slack floor and z, mixed-model retries. */
export const JEV_ANCHOR_MIN_ZH = 100;
export const JEV_CHECK_SLACK_MIN = 0.05;
export const JEV_CHECK_Z = 2.7;
export const JEV_CHECK_MIXED_RETRIES = 3;

/** Every tree lane armed: the route a check compares is the full effect, with today's bars. */
export const CHECK_ARMED: Armed = { category: true, status: true, memory: true, gear: true, rule: true, answer: true, lookup: true };
/** The name a question's bucket is compared under, and the route check's pseudo question id. */
export const ROUTE_CHECK_ID = "route";

const EPS = 1e-9;
const topOption = (a: { probabilities: Record<string, number> }): string =>
  Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "";

/**
 * One answer's comparable bucket (spec §2.5): a choice its top option, a noul its zone across today's bars (yes, no, unsure),
 * a score its level bucket (light, standard, heavy). null when the answer is missing or not the question's type.
 */
export function answerBucket(q: Question, a: JevAnswer | undefined, bars: TreeBars = TREE_BAR_DEFAULTS): string | null {
  if (!a || a.type !== q.type) return null;
  if (a.type === "choice") return topOption(a);
  if (a.type === "noul") return a.noul + EPS >= bars.nounYes ? "yes" : a.noul - EPS <= bars.nounNo ? "no" : "unsure";
  return a.score - EPS <= bars.gearLight ? "light" : a.score + EPS >= bars.gearHeavy ? "heavy" : "standard";
}

/** The Jev state fields the route check reads back (the stored anchor state is what checks send). */
export interface RouteState { latest_message?: unknown; last_houge_turn?: unknown; quoted_turn?: unknown }

/**
 * The full route effect of one turn's answers as a comparable key (spec §2.5): category, lane, role, effort, save scope, a
 * cascade by its pair. The turn's own think-harder, bare-ack and ack-after-answer facts come from its stored state.
 */
export function routeEffectKey(state: RouteState, answers: Record<string, JevAnswer>, bars: TreeBars = TREE_BAR_DEFAULTS): string {
  const text = typeof state.latest_message === "string" ? state.latest_message : "";
  const lastHougeTurn = (state.last_houge_turn ?? null) as LastHougeTurn;
  const pre = preJudge({ text, lastHougeTurn, quoted: state.quoted_turn != null });
  const fields = (r: { category: string | null; lane: string; role: string; effort: string | null; save: { scope: string } | null }, pair = ""): string =>
    [r.category ?? "-", r.lane, r.role, r.effort ?? "-", r.save?.scope ?? "-", pair].join("/");
  if (pre.kind === "ack_answer") return fields(ACK_ROUTE);
  const plan = routeTree(answers, { bars, armed: CHECK_ARMED, thinkHarder: thinkHarderIn(text), bareAck: isBareAck(text) });
  return plan.kind === "final" ? fields(plan.route) : fields(plan.base, `cascade:${plan.between.join("|")}:${plan.ruleScope ?? "-"}`);
}

/** The lane a route key lands in (its second field); a cascade is the planner's. */
export const laneOfKey = (key: string): string => key.split("/")[1] ?? "planner";

/** Agreement between two answer sets over the turns both have: agree count and n. */
export interface Agreement { agree: number; n: number }
export function agreementOf<T>(pairs: ReadonlyArray<readonly [T | null, T | null]>): Agreement {
  let agree = 0; let n = 0;
  for (const [x, y] of pairs) {
    if (x === null || y === null) continue;
    n += 1;
    if (x === y) agree += 1;
  }
  return { agree, n };
}

/** Per lane, over Paco's labelled turns: routes into the lane the label disagrees with, labelled turns routed to their lane. */
export interface LaneLabelCount { wrong: number; recall: number; labelled: number }
export function laneLabelCounts(turns: ReadonlyArray<{ routeKey: string; label: string | undefined }>): Record<DisarmableLane, LaneLabelCount> {
  const out = Object.fromEntries(DISARMABLE_LANES.map((l) => [l, { wrong: 0, recall: 0, labelled: 0 }])) as Record<DisarmableLane, LaneLabelCount>;
  for (const { routeKey, label } of turns) {
    if (label === undefined) continue;
    const routed = laneOfKey(routeKey);
    for (const lane of DISARMABLE_LANES) {
      if (label === lane) { out[lane].labelled += 1; if (routed === lane) out[lane].recall += 1; }
      else if (routed === lane) out[lane].wrong += 1;
    }
  }
  return out;
}

