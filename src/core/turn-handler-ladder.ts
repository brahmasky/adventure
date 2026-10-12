import { safeReason } from "../domain/error-code.js";
import type { CalibrationRow } from "../jev/calibration.js";
import { topProbOf, type Decision, type SkipReason } from "../jev/decide.js";
import type { JevTriageMode } from "../jev/jev-flags.js";
import type { Lang } from "../jev/intent-question.js";
import { routeTree, TREE_BAR_DEFAULTS, treeArmed, type Armed, type LaneSwitch, type Route, type RoutePlan } from "../jev/tree-policy.js";
import { isBareAck } from "../omp/bare-ack.js";
import { isSkipReason, type TurnHandlerVerdict } from "../decisions/entries/turn-handler.js";
import type { DecideResult, FallbackReason, RungOutcome, RungResult } from "../decisions/types.js";

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

export interface PlanInput { userText: string; mode: JevTriageMode; lang: Lang; thinkHarder: boolean; rows: readonly CalibrationRow[]; lanesOff: ReadonlySet<LaneSwitch> }

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
    armed = i.mode === "arm" ? treeArmed(i.lang, d.model, i.rows, i.lanesOff) : UNARMED; // d.model: the REPORTED id
    plan = routeTree(d.answers, { ...opts, armed });
  } catch (e) {
    console.error(`triage: threw: ${safeReason(e)}`); // today's line (the old triageTurn catch logged this throw); the ledger keeps only `threw`
    return { failed: "threw", reason: "error" };
  }
  if (plan.kind === "cascade") return { abstain: true, detail: { d, armed, plan } };
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
  return { verdict: route.lane, reason: route.reason, ...(category ? { p: topProbOf(category) } : {}), detail: { d, armed, plan, route } };
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
