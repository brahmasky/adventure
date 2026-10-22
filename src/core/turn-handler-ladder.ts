import { safeReason } from "../domain/error-code.js";
import type { CalibrationRow } from "../jev/calibration.js";
import { topProbOf, type Decision, type SkipReason } from "../jev/decide.js";
import type { JevTriageMode } from "../jev/jev-flags.js";
import type { Lang } from "../jev/intent-question.js";
import type { JevAnswer, JevChoiceAnswer } from "../jev/jev-client.js";
import { criteriaHash, type Question } from "../jev/questions/types.js";
import { LANE_LIMITS, routeTree, TREE_BAR_DEFAULTS, treeArmed, TWO_REQUEST_ACTIONS, type Armed, type LaneSwitch, type Route, type RoutePlan,
  type TreeBars } from "../jev/tree-policy.js";
import { isBareAck } from "../omp/bare-ack.js";
import { isSkipReason, type TurnHandlerVerdict } from "../decisions/entries/turn-handler.js";
import type { ModelArming } from "../decisions/jev-version-check.js";
import { answerValue, bandFor, nearBar, NOISE_BANDS, type NoiseBand } from "../decisions/noise-band.js";
import type { DecideResult, FallbackReason, Reask, RungOutcome, RungResult } from "../decisions/types.js";

/**
 * The pure half of `turn.handler`'s rungs (spec §4.4, §6.2 "wrap"): today's policy calls, unchanged, shaped as rung
 * results. `CoreWorker` owns the I/O half (the Jev call, the cascade call) and every handler after the decision. Not under
 * the protected src/decisions/ (ADR 0030 consequences): the entry is protected, this glue is as self-writable as tree-policy.ts.
 */
export type AnsweredDecision = Extract<Decision, { status: "answered" }>;
/** What the tree rung hands the cascade rung and the handlers: Jev's answer and rows, the arming, the plan, the route. */
export interface TreeDetail { d: AnsweredDecision; armed: Armed; plan?: RoutePlan; route?: Route; error?: string }
export const UNARMED: Armed = { category: false, status: false, memory: false, gear: false, rule: false, answer: false, lookup: false };
const URL_IN_TEXT = /https?:\/\//i;
type TreeOpts = Omit<Parameters<typeof routeTree>[1], "armed">;

/**
 * Stage B §2's one code rule: a lookup naming a URL is the planner's (its http_fetch path can read a named page; the lane
 * cannot from a one-line query). The route is the policy's own with the lookup lane unarmed (the gear's role), relabelled.
 */
export function urlRule(route: Route, text: string, unlaned: () => RoutePlan): Route {
  if (route.lane !== "lookup" || !URL_IN_TEXT.test(text)) return route;
  const p = unlaned();
  return p.kind === "final" ? { ...p.route, reason: "lane_limits" } : { ...route, lane: "planner", reason: "lane_limits" };
}

/** A Jev skip as the ledger's closed fallback reason; the skip reason itself stays the row's reason code. */
export function fallbackOfSkip(reason: SkipReason): FallbackReason {
  if (reason === "timeout") return "timeout";
  if (reason === "parse" || reason === "malformed_question") return "parse";
  if (reason === "state_too_large") return "budget";
  return "outage";
}

/** The bars routeTree compares each tree answer against (tree-policy.ts:43-44, LANE_LIMITS, TWO_REQUEST_ACTIONS), in the answer's unit. */
export function treeBarsFor(id: string, a: JevAnswer, bars: TreeBars = TREE_BAR_DEFAULTS): number[] {
  if (id === "category" && a.type === "choice") return [bars.choice, ...(a.choice === "memory" ? [bars.memory] : []), ...(a.choice === "status" ? [bars.status] : [])];
  if (id === "sets_rule") return [bars.nounYes, bars.nounNo];
  if (id === "rule_scope") return [bars.ruleScope];
  if (id === "breadth") return [bars.gearLight, bars.gearHeavy, LANE_LIMITS.answer.breadth];
  if (id === "actions") return [bars.gearLight, bars.gearHeavy, LANE_LIMITS.answer.actions, LANE_LIMITS.lookup.actions, TWO_REQUEST_ACTIONS];
  if (id === "reasoning") return [bars.gearLight, bars.gearHeavy];
  return [];
}

/** Derived band keys of `category` (senior W7): the lane rules also compare its confidence (minConf) and top-two gap (minGap). */
export const CATEGORY_CONFIDENCE = "category:confidence";
export const CATEGORY_GAP = "category:gap";
export const gapOf = (a: JevChoiceAnswer): number => { const s = Object.values(a.probabilities).sort((x, y) => y - x); return (s[0] ?? 0) - (s[1] ?? 0); };

/**
 * Addition B: any banded value within its band of a bar the decision uses asks Jev once more (src/jev/decide.ts reaskOnce).
 * `bands` defaults per call, so the reviewed rows are read when the closure runs, not when the module loads.
 */
export function treeNear(questions: readonly Question[], bands: readonly NoiseBand[] = NOISE_BANDS): (answers: Record<string, JevAnswer>) => boolean {
  return (answers) => questions.some((q) => {
    const a = answers[q.id];
    if (!a) return false;
    const hash = criteriaHash(q);
    const near = (id: string, x: number, bars: readonly number[]): boolean => { const b = bandFor(id, hash, bands); return b !== undefined && nearBar(x, bars, b); };
    if (near(q.id, answerValue(a), treeBarsFor(q.id, a))) return true;
    if (q.id !== "category" || a.type !== "choice") return false;
    return near(CATEGORY_CONFIDENCE, a.confidence, [TREE_BAR_DEFAULTS.minConf]) || near(CATEGORY_GAP, gapOf(a), [TREE_BAR_DEFAULTS.minGap]);
  });
}

/** The decision row's re-ask: the mean (with the first call's category p) or the failed second call. */
export function reaskOf(d: AnsweredDecision): Reask | undefined {
  if (!d.reask) return undefined;
  const first = d.first?.category ?? d.answers.category;
  return { kind: d.reask, pFirst: first ? topProbOf(first) : 0 };
}

/** `arming`: the reported model's check state (treeArmingFor, src/decisions/jev-version-check.ts); arm mode reads it, shadow arms nothing. */
export interface PlanInput { userText: string; mode: JevTriageMode; lang: Lang; thinkHarder: boolean; rows: readonly CalibrationRow[]; lanesOff: ReadonlySet<LaneSwitch>;
  arming: ModelArming }

/**
 * Jev answered: arming, routeTree, urlRule — today's routeAnswered head (core-worker.ts:2782-2792 at 3bff437). Below the bar
 * it abstains with the plan. Ruling 19: a throw in arming or routeTree happened BEFORE today's `held.answered`, so it fails
 * with no detail (skipped `error`); a throw in urlRule happened after it, so it keeps the detail (the answered fallback).
 */
export function planTree(d: AnsweredDecision, i: PlanInput): RungResult<TurnHandlerVerdict, TreeDetail> {
  let opts: TreeOpts;
  let armed: Armed;
  let plan: RoutePlan;
  try {
    opts = { bars: TREE_BAR_DEFAULTS, thinkHarder: i.thinkHarder, bareAck: isBareAck(i.userText) };
    armed = i.mode === "arm" ? treeArmed(i.lang, i.rows, i.lanesOff, i.arming) : UNARMED;
    plan = routeTree(d.answers, { ...opts, armed });
  } catch (e) {
    console.error(`triage: threw: ${safeReason(e)}`); // today's line (the old triageTurn catch logged this throw); the ledger keeps only `threw`
    return { failed: "threw", reason: "error" };
  }
  if (plan.kind === "cascade") { const r = reaskOf(d); return { abstain: true, detail: { d, armed, plan }, ...(r ? { reask: r } : {}) }; }
  return routed(d, i.userText, armed, plan, opts);
}

/** A final plan through urlRule (today: after held.answered, so a throw keeps Jev's answer for the answered fallback). */
function routed(d: AnsweredDecision, text: string, armed: Armed, plan: Extract<RoutePlan, { kind: "final" }>, opts: TreeOpts): RungResult<TurnHandlerVerdict, TreeDetail> {
  let route: Route;
  try {
    route = urlRule(plan.route, text, () => routeTree(d.answers, { ...opts, armed: { ...armed, lookup: false } }));
  } catch (e) {
    return { failed: "threw", reason: "error", detail: { d, armed, plan, error: e instanceof Error ? e.message : String(e) } };
  }
  const category = d.answers.category;
  const r = reaskOf(d);
  return { verdict: route.lane, reason: route.reason, ...(category ? { p: topProbOf(category) } : {}), ...(r ? { reask: r } : {}), detail: { d, armed, plan, route } };
}

function detailOf(r: RungResult<TurnHandlerVerdict, TreeDetail> | null | undefined): TreeDetail | undefined {
  return r && "detail" in r ? r.detail : undefined;
}

/** The detail the handlers need: the cascade's (it carries the picked route) when it ran, else the tree's. */
export function treeDetailOf(r: DecideResult<TurnHandlerVerdict, TreeDetail>): TreeDetail | undefined {
  const walk: readonly RungOutcome<TurnHandlerVerdict, TreeDetail>[] = r.walk;
  return detailOf(walk.find((o) => o.kind === "model")?.result) ?? detailOf(walk.find((o) => o.kind === "system_one")?.result);
}

/** Why the tree gave no answer, as today's skip reason (`error` when it threw or was never reached). */
export function jevSkipReason(r: DecideResult<TurnHandlerVerdict, TreeDetail>): SkipReason {
  const res = r.walk.find((o) => o.kind === "system_one")?.result;
  return res && "failed" in res && isSkipReason(res.reason) ? res.reason : "error";
}
