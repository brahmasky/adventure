import { isBareAck } from "../omp/bare-ack.js";
import { calibratedLang, type CalibrationRow } from "./calibration.js";
import type { Lang } from "./intent-question.js";
import type { JevAnswer, JevChoiceAnswer } from "./jev-client.js";
import {
  CATEGORIES, TREE_ACTIONS, TREE_BREADTH, TREE_CATEGORY, TREE_QUESTIONS, TREE_REASONING, TREE_RULE_SCOPE, TREE_SETS_RULE, type Category,
  type LastHougeTurn
} from "./questions/tree.js";
import { criteriaHash, type Question } from "./questions/types.js";

/**
 * The tree's routing policy (spec §2.4): Jev's probabilities in, a lane and a model role out. Pure: code owns every bar
 * (ADR 0013); Jev never applies one and never produces allow/deny, which is why this lives in src/jev/, not src/policy/.
 */
export type TurnRole = "fast" | "default" | "thinking";
export type Effort = "low" | "medium" | "high";
export type Lane = "memory" | "status" | "planner";
export type PreJudge = { kind: "ack_answer" } | { kind: "judge"; thinkHarder: boolean };

/** Bump when a bar or a routing rule changes; stamped on every decision row's threshold_used. */
export const TREE_THRESHOLD_VERSION = "2026-10-07.1";

const GREETINGS: ReadonlySet<string> = new Set(["谢谢", "thanks", "thank you", "hi", "你好"]);
const TRAILING = /[。！!.~～\s]+$/u;
const THINK_HARDER = /think harder|认真想|ultrathink/i;

/** `think harder` / `认真想` / `ultrathink` anywhere in the message (spec §2.1). */
export function thinkHarderIn(text: string): boolean {
  return THINK_HARDER.test(text);
}

/** Spec §2.1: an ack or greeting right after a plain answer, quoting nothing, is settled by code (no Jev call). */
export function preJudge(i: { text: string; lastHougeTurn: LastHougeTurn; quoted: boolean }): PreJudge {
  const ack = isBareAck(i.text) || GREETINGS.has(i.text.trim().replace(TRAILING, "").toLowerCase());
  if (ack && !i.quoted && i.lastHougeTurn?.kind === "answer") return { kind: "ack_answer" };
  return { kind: "judge", thinkHarder: thinkHarderIn(i.text) };
}

export interface TreeBars { choice: number; nounYes: number; nounNo: number; memory: number; status: number; minConf: number;
  minGap: number; ruleScope: number; gearLight: number; gearHeavy: number }
export const TREE_BAR_DEFAULTS: TreeBars = { choice: 0.6, nounYes: 0.8, nounNo: 0.2, memory: 0.85, status: 0.8, minConf: 0.7, minGap: 0.5,
  ruleScope: 0.6, gearLight: 1.2, gearHeavy: 2.5 };

export interface Armed { category: boolean; status: boolean; memory: boolean; gear: boolean; rule: boolean }
/** The status lane's own arming key: the category question's hash under a distinct id, so a `category` row never arms status. */
export const TREE_STATUS_ARM_ID = "category:status";

/**
 * Each decision arms on its own rows (lessons.md 2026-10-06): `rule` on sets_rule + rule_scope, gear on its three
 * scores; the memory lane needs category AND rule. The status lane also needs `rule` at route time (statusBranch).
 */
export function treeArmed(lang: Lang, model: string, rows: readonly CalibrationRow[]): Armed {
  const on = (qs: readonly Question[]): boolean => qs.every((q) => calibratedLang(q.id, criteriaHash(q), model, lang, rows) !== undefined);
  const category = on([TREE_CATEGORY]);
  const rule = on([TREE_SETS_RULE, TREE_RULE_SCOPE]);
  return {
    category,
    status: calibratedLang(TREE_STATUS_ARM_ID, criteriaHash(TREE_CATEGORY), model, lang, rows) !== undefined,
    memory: category && rule,
    gear: on([TREE_BREADTH, TREE_REASONING, TREE_ACTIONS]),
    rule
  };
}

/**
 * The rows that can arm a tree decision today: a tree question, or the status pseudo-row, at its current criteria hash.
 * The alias-move page (`checkJevModelCalibrated`, jev-incidents.ts) reads only these, so a retired lane 1 row or a
 * stale-hash row neither raises nor clears it (it replaces lane 1's `armingRows`, which Task 12 deletes with thresholds.ts).
 */
export function treeArmingRows(rows: readonly CalibrationRow[]): CalibrationRow[] {
  const live = new Set(TREE_QUESTIONS.map((q) => `${q.id}\u0000${criteriaHash(q)}`));
  live.add(`${TREE_STATUS_ARM_ID}\u0000${criteriaHash(TREE_CATEGORY)}`);
  return rows.filter((r) => live.has(`${r.question_id}\u0000${r.criteria_hash}`));
}

/** `lane_limits` has no writer in stage A (memory and status have no limits, spec §3); it is kept for stage B. */
export type RouteReason = "routed" | "uncalibrated" | "below_bar" | "bare_ack_guard" | "lane_limits" | "correction"
  | "cascade" | "cascade_failed" | "ack_rule" | "jev_skipped";
export type RuleScope = "ask" | "research";
export interface Route { category: Category | null; lane: Lane; role: TurnRole; effort: Effort | null;
  save: { scope: RuleScope } | null; reason: RouteReason; cascade: "tiny" | null; thinkHarder: boolean }
/** `ruleScope`: the confident rule_scope override (null = the picked category's default), applied by applyCascade. */
export type RoutePlan = { kind: "final"; route: Route }
  | { kind: "cascade"; between: readonly [Category, Category]; base: Route; ruleScope: RuleScope | null };

/** Spec §3's role floor per category; null for the two lanes that do not run the planner. */
export const ROLE_FLOOR: Readonly<Record<Category, TurnRole | null>> = {
  answer: "fast", lookup: "fast", research: "thinking", memory: null, self_change: "default", machine_task: "default",
  schedule: "default", wiki: "default", mail_calendar: "default", status: null, other: "default"
};

/** Any failure, skip or unarmed question (spec §2.4): the planner on the Default role as resolved, the list's effort. */
export function fallbackRoute(reason: RouteReason, thinkHarder: boolean): Route {
  return { category: null, lane: "planner", role: thinkHarder ? "thinking" : "default", effort: null, save: null, reason, cascade: null, thinkHarder };
}

/** Spec §2.1: an acknowledgement of a plain answer is `answer` on the Fast role. */
export const ACK_ROUTE: Route = { category: "answer", lane: "planner", role: "fast", effort: "low", save: null, reason: "ack_rule", cascade: null, thinkHarder: false };

/** Probabilities and expected levels arrive as floats (0.85 − 0.35 = 0.4999…); a bar compares within this tolerance. */
const EPS = 1e-9;
const atLeast = (x: number, bar: number): boolean => x + EPS >= bar;
const atMost = (x: number, bar: number): boolean => x - EPS <= bar;
const RANK: Readonly<Record<TurnRole, number>> = { fast: 0, default: 1, thinking: 2 };
const higher = (a: TurnRole, b: TurnRole | null): TurnRole => (b !== null && RANK[b] > RANK[a] ? b : a);
const isCategory = (c: string): c is Category => (CATEGORIES as readonly string[]).includes(c);
const choiceOf = (a: JevAnswer | undefined): JevChoiceAnswer | null => (a?.type === "choice" ? a : null);
const scoreOf = (a: JevAnswer | undefined): number | null => (a?.type === "score" ? a.score : null);
const noulOf = (a: JevAnswer | undefined): number | null => (a?.type === "noul" ? a.noul : null);
/** High → low; a stable sort, so ties keep the question's option order. */
const ranked = (a: JevChoiceAnswer): Array<[string, number]> => Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
const final = (route: Route): RoutePlan => ({ kind: "final", route });
const NO_OPTION: [string, number] = ["", 0];

type Gear = { role: TurnRole; effort: Effort | null };
type Zone = "yes" | "no" | "unsure";
type RouteOpts = { bars: TreeBars; armed: Armed; thinkHarder: boolean; bareAck: boolean };
interface Ctx { cat: JevChoiceAnswer; p: number; gear: Gear; zone: Zone; scope: RuleScope | null; o: RouteOpts }
const DEFAULT_GEAR: Gear = { role: "default", effort: null };

function levelOf<T>(x: number, bars: TreeBars, light: T, standard: T, heavy: T): T {
  return atMost(x, bars.gearLight) ? light : atLeast(x, bars.gearHeavy) ? heavy : standard;
}

/** Gear = the highest of the three expected levels; effort from `reasoning` on the same edges (spec §2.4). */
function gearOf(answers: Record<string, JevAnswer>, bars: TreeBars, armed: boolean): Gear {
  const [breadth, reasoning, actions] = [answers.breadth, answers.reasoning, answers.actions].map(scoreOf);
  if (!armed || breadth == null || reasoning == null || actions == null) return DEFAULT_GEAR;
  return { role: levelOf<TurnRole>(Math.max(breadth, reasoning, actions), bars, "fast", "default", "thinking"),
    effort: levelOf<Effort>(reasoning, bars, "low", "medium", "high") };
}

function zoneOf(p: number | null, bars: TreeBars): Zone {
  if (p === null) return "unsure";
  return atLeast(p, bars.nounYes) ? "yes" : atMost(p, bars.nounNo) ? "no" : "unsure";
}

/** `rule_scope`'s top option when it clears its bar (spec §2.4); null = the final category's default decides. */
function confidentScope(a: JevChoiceAnswer | null, bars: TreeBars): RuleScope | null {
  const [opt, p] = (a ? ranked(a)[0] : undefined) ?? NO_OPTION;
  return (opt === "ask" || opt === "research") && atLeast(p, bars.ruleScope) ? opt : null;
}

/** Spec §2.3: the default scope follows the FINAL category (research → research, else ask). */
const scopeFor = (override: RuleScope | null, category: Category | null): RuleScope =>
  override ?? (category === "research" ? "research" : "ask");

/** A rule saves only when `sets_rule` is yes (zone is "no" while the rule rows are unarmed or on a bare ack). */
function saveFor(t: Ctx, category: Category | null): Route["save"] {
  return t.zone === "yes" ? { scope: scopeFor(t.scope, category) } : null;
}

function plannerRoute(category: Category | null, g: Gear, save: Route["save"], reason: RouteReason, thinkHarder: boolean): Route {
  const role = thinkHarder ? "thinking" : category ? higher(g.role, ROLE_FLOOR[category]) : g.role;
  return { category, lane: "planner", role, effort: g.effort, save, reason, cascade: null, thinkHarder };
}

/** A no-planner lane's bar: its own p, lane 1's confidence floor and the p1 − p2 gap floor. */
function clearsLane(t: Ctx, bar: number): boolean {
  const second = ranked(t.cat)[1]?.[1] ?? 0;
  return atLeast(t.p, bar) && atLeast(t.cat.confidence, t.o.bars.minConf) && atLeast(t.p - second, t.o.bars.minGap);
}

/** Below the choice bar: Jev's top two after removing the lanes (a model guess never routes into memory or status). */
function cascadePlan(t: Ctx): RoutePlan {
  const left = ranked(t.cat).filter(([c, p]) => isCategory(c) && c !== "memory" && c !== "status" && p > EPS).map(([c]) => c as Category);
  const [a, b] = left;
  if (a === undefined) return final(plannerRoute(null, DEFAULT_GEAR, saveFor(t, null), "below_bar", t.o.thinkHarder));
  if (b === undefined) return final(plannerRoute(a, t.gear, saveFor(t, a), "cascade", t.o.thinkHarder));
  // base.save only marks that a rule saves; applyCascade fixes its scope from the pick (F5)
  return { kind: "cascade", between: [a, b], base: plannerRoute(null, t.gear, saveFor(t, null), "cascade", t.o.thinkHarder), ruleScope: t.scope };
}

function statusBranch(t: Ctx): RoutePlan {
  const { o } = t;
  // F6: the lane acts only with the rule rows armed too, so a stated rule is never swallowed by a code reply
  const lane = o.armed.status && o.armed.rule;
  const clears = lane && clearsLane(t, o.bars.status);
  if (clears && o.bareAck) return final(plannerRoute("status", DEFAULT_GEAR, null, "bare_ack_guard", o.thinkHarder));
  if (clears && t.zone !== "yes") {
    return final({ category: "status", lane: "status", role: "default", effort: null, save: null, reason: "routed", cascade: null, thinkHarder: o.thinkHarder });
  }
  if (clears) return final(plannerRoute("status", t.gear, saveFor(t, "status"), "routed", o.thinkHarder)); // a rule is not "nothing else"
  if (!o.armed.category) return final(fallbackRoute("uncalibrated", o.thinkHarder));
  if (!atLeast(t.p, o.bars.choice)) return cascadePlan(t);
  return final(plannerRoute("status", DEFAULT_GEAR, saveFor(t, "status"), lane ? "below_bar" : "uncalibrated", o.thinkHarder));
}

/** Memory at p ≥ the choice bar: a new rule is the lane; a correction (sets_rule no/unsure) is the planner's gated path. */
function memoryBranch(t: Ctx): Route {
  const { o } = t;
  if (!o.armed.memory || !o.armed.rule) return plannerRoute("memory", DEFAULT_GEAR, null, "uncalibrated", o.thinkHarder);
  if (!clearsLane(t, o.bars.memory)) return plannerRoute("memory", DEFAULT_GEAR, saveFor(t, "memory"), "below_bar", o.thinkHarder);
  if (o.bareAck) return plannerRoute("memory", DEFAULT_GEAR, null, "bare_ack_guard", o.thinkHarder);
  if (t.zone !== "yes") return plannerRoute("memory", DEFAULT_GEAR, null, "correction", o.thinkHarder);
  return { category: "memory", lane: "memory", role: "default", effort: null, save: saveFor(t, "memory"), reason: "routed", cascade: null, thinkHarder: o.thinkHarder };
}

export function routeTree(answers: Record<string, JevAnswer>, o: RouteOpts): RoutePlan {
  const cat = choiceOf(answers.category);
  const [top, p] = (cat ? ranked(cat)[0] : undefined) ?? NO_OPTION;
  if (!cat || !isCategory(top) || (!o.armed.category && !o.armed.status)) return final(fallbackRoute("uncalibrated", o.thinkHarder));
  const t: Ctx = { cat, p, gear: gearOf(answers, o.bars, o.armed.gear), scope: confidentScope(choiceOf(answers.rule_scope), o.bars),
    zone: o.armed.rule && !o.bareAck ? zoneOf(noulOf(answers.sets_rule), o.bars) : "no", o };
  if (top === "status") return statusBranch(t);
  if (!o.armed.category) return final(fallbackRoute("uncalibrated", o.thinkHarder));
  if (!atLeast(p, o.bars.choice)) return cascadePlan(t);
  if (top === "memory") return final(memoryBranch(t));
  return final(plannerRoute(top, t.gear, saveFor(t, top), "routed", o.thinkHarder));
}

/**
 * The cascade's pick (spec §2.4; the live Tiny call is Task 10's, plan Decision 14). A pick outside the two, or none, is
 * the Default fallback with nothing saved (a failure anywhere). A valid pick fixes the rule's scope from the picked category.
 */
export function applyCascade(plan: Extract<RoutePlan, { kind: "cascade" }>, pick: Category | null): Route {
  const b = plan.base;
  if (pick === null || !plan.between.includes(pick)) return { ...fallbackRoute("cascade_failed", b.thinkHarder), cascade: "tiny" };
  const save = b.save ? { scope: scopeFor(plan.ruleScope, pick) } : null;
  return { ...b, category: pick, role: b.thinkHarder ? "thinking" : higher(b.role, ROLE_FLOOR[pick]), save, cascade: "tiny" };
}
