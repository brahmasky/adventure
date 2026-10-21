import type { JevChoiceAnswer } from "../../jev/jev-client.js";
import { IMPROVE_TARGET } from "../../jev/questions/improve.js";
import { criteriaHash } from "../../jev/questions/types.js";
import type { Category } from "../../jev/questions/tree.js";
import type { Lane } from "../../jev/tree-policy.js";
import { DECISION_SIGNALS, type DecisionSignal, type Entry, type ProvisionalBar, type RungAbstain, type RungAnswer, type VerdictEffect } from "../types.js";

/**
 * `improve.route` (2b-ii spec §4; parent §7.4; ADR 0030 decision 8): once a day, over the inbox's grouped signals, what
 * should Houge change? Rule rungs cause the only automatic effect (a recurrence → the skill-authoring job, started by the
 * tick on a rule-rung `skill`/`recurrence` row; plan ruling 1); Jev (one fixed choice question, bar 0.6) and the Tiny pick
 * only propose. Fail-open on `nothing`; every signal is one of its outcomes (§4.4). Always recorded; the row's run is the
 * group's newest run.
 */
export const IMPROVE_ROUTE_ID = "improve.route";
export const IMPROVE_TARGETS = ["nothing", "lesson", "fact", "skill", "schedule", "knowledge", "tool_gap", "ladder"] as const;
export type ImproveTarget = (typeof IMPROVE_TARGETS)[number];
export const IMPROVE_REASONS = ["stale", "stated_rule_owned", "recurrence", "recurrence_lookup", "already_authored", "skill_exists", "expiry_pattern", "deferred_rate",
  "wiki_disarmed", "jev_choice", "tiny_pick", "below_bar", "no_text", "lane_busy", "inapplicable_top", "already_proposed"] as const;
export type ImproveReason = (typeof IMPROVE_REASONS)[number];
export const IMPROVE_BAR_P = 0.6;
export const IMPROVE_JEV_MS = 1_500;
export const IMPROVE_TINY_MS = 8_000;
/** R8: provisional until the sanity run and the 14-day revisit set it from real signal groups. */
export const IMPROVE_BAR: ProvisionalBar = { kind: "provisional", question: IMPROVE_TARGET.id, criteriaHash: criteriaHash(IMPROVE_TARGET), model: "jev-1.13.0", p: IMPROVE_BAR_P,
  source: "2b-ii spec R8: provisional 0.6 on improve_target; the sanity run (§9.3) and the 14-day revisit (§11) calibrate it" };

export interface ImproveState {
  signal: DecisionSignal; value: string; scope: string; count: number; count14d: number;
  category: Category | null; lane: Lane | null; capability: string | null;
  /** The newest signal turn's Paco text, redacted (§7), at most PACO_TEXT_CAP characters. */
  pacoText: string;
  /** Code-built: tool names and counts of that turn, never tool text. */
  toolSummary: string;
  lastImprovement: { target: string; ageDays: number } | null;
  recurrence: { clusterId: string; turnIds: string[]; idempotencyKey: string; spanDays: number } | null;
  alreadyAuthored: boolean; skillExists: boolean; wikiArmed: boolean;
  scheduleHint: { schedule_id: string; hour: number } | null;
  /** Unconsumed for IMPROVE_STALE_DAYS: consumed as nothing/stale (ruling 10). */
  stale: boolean;
  /** R3: the correcting run has a memory_save_triggers row — memory.kind already saved the stated rule. */
  statedRuleSaved: boolean;
  /** The only text the Jev rung and the Tiny pick may read. */
  redacted: { pacoText: string };
}
export interface ImproveDetail { top?: string; p?: number; top2?: [ImproveTarget, ImproveTarget]; jev?: Record<string, number>; pick?: string }
/** The Jev copy: the state minus pacoText, plus the applicable list (one fixed question, codex D15). */
export interface ImproveJevState { signal: string; value: string; scope: string; count: number; count_14d: number; category: string | null; lane: string | null; capability: string | null;
  paco_text: string; tools: string; last_improvement: string; applicable: ImproveTarget[] }
type Rule = RungAnswer<ImproveTarget, ImproveDetail> | RungAbstain<ImproveTarget, ImproveDetail>;
const nothing = (reason: ImproveReason): Rule => ({ verdict: "nothing", reason });
const LOOKUP: ReadonlySet<string> = new Set(["lookup", "research"]);
const EPS = 1e-9;

/** §4.3 rule 1, in this order; the first that fires decides. */
export function improveRule(s: ImproveState): Rule {
  if (s.stale) return nothing("stale");
  if (s.signal === "correction" && s.statedRuleSaved) return nothing("stated_rule_owned");
  if (s.recurrence) return recurrenceRule(s);
  if (s.signal === "approval_expired" && s.scheduleHint) return { verdict: "schedule", reason: "expiry_pattern" };
  if (s.redacted.pacoText.trim().length === 0) return nothing("no_text");
  return { abstain: true };
}

function recurrenceRule(s: ImproveState): Rule {
  if (s.alreadyAuthored) return nothing("already_authored");
  if (s.skillExists) return nothing("skill_exists");
  if (s.category !== null && LOOKUP.has(s.category)) return { verdict: "knowledge", reason: s.wikiArmed ? "recurrence_lookup" : "wiki_disarmed" };
  return { verdict: "skill", reason: "recurrence" };
}

/** §4.3: the targets Houge can act on today (sent in the state, applied to the answer). */
export function applicableTargets(s: ImproveState): ImproveTarget[] {
  return IMPROVE_TARGETS.filter((t) => (t !== "knowledge" || s.wikiArmed) && (t !== "skill" || (s.recurrence !== null && !s.skillExists)) && (t !== "schedule" || s.scheduleHint !== null));
}

export function improveJevState(s: ImproveState): ImproveJevState {
  return { signal: s.signal, value: s.value, scope: s.scope, count: s.count, count_14d: s.count14d, category: s.category, lane: s.lane, capability: s.capability,
    paco_text: s.redacted.pacoText, tools: s.toolSummary, last_improvement: s.lastImprovement ? `${s.lastImprovement.target} ${s.lastImprovement.ageDays} days ago` : "none",
    applicable: applicableTargets(s) };
}

/**
 * Masking after the answer (codex round 2 N3): the overall top option decides when applicable and at or over the bar; an
 * inapplicable top abstains `inapplicable_top` (no runner-up can clear 0.6); an applicable top under the bar abstains
 * `below_bar` with the two best applicable options for the Tiny pick. `p` is always the overall top's probability.
 */
export function jevVerdictOf(a: JevChoiceAnswer, s: ImproveState): Rule {
  const ranked = Object.entries(a.probabilities).filter(([o]) => (IMPROVE_TARGETS as readonly string[]).includes(o)).sort((x, y) => y[1] - x[1]);
  const top = ranked[0];
  if (!top) return { abstain: true };
  const [option, p] = top;
  const applicable = applicableTargets(s);
  const detail: ImproveDetail = { jev: a.probabilities, top: option, p };
  // ruling 18: an answer, not an abstention — the runner would drop the reason; `nothing` is passive, and the row's p is the top's
  if (!applicable.includes(option as ImproveTarget)) return { verdict: "nothing", reason: "inapplicable_top", p, detail };
  if (p + EPS >= IMPROVE_BAR_P) return { verdict: option as ImproveTarget, reason: "jev_choice", p, detail };
  const best = ranked.map(([o]) => o as ImproveTarget).filter((o) => applicable.includes(o)).slice(0, 2);
  return { abstain: true, reason: "below_bar", detail: { ...detail, top2: [best[0]!, best[1] ?? best[0]!] } };
}

const NONE: VerdictEffect = { kind: "none", reversible: true, announced: "none", what: "recorded; the group's outcome rows attach to this decision" };
const proposal = (what: string): VerdictEffect => ({ kind: "proposal", reversible: true, announced: "card", what });
export const IMPROVE_ROUTE: Entry<ImproveState, ImproveTarget, ImproveDetail> = {
  id: IMPROVE_ROUTE_ID, version: 1, stage: "after_turn", input: "mixed",
  question: "What, if anything, should Houge change so this signal does not recur?",
  verdicts: IMPROVE_TARGETS,
  ladder: [
    { kind: "rule", name: "improve_rule", decide: improveRule },
    // the client's own 1.5 s bound fires first; this outer bound only stops a hung executor
    { kind: "system_one", name: "improve_target", questions: [IMPROVE_TARGET], bars: IMPROVE_BAR, timeoutMs: IMPROVE_JEV_MS + 500, recordedP: IMPROVE_TARGET.id },
    { kind: "model", name: "improve_pick", role: "tiny", prompt: { id: "improve.route.pick", version: 1 }, timeoutMs: IMPROVE_TINY_MS }
  ],
  fail: "nothing", defaultVerdict: "nothing", alwaysRecord: true, outcomes: DECISION_SIGNALS,
  armed: { rule: "on", system_one: "on", model: "on" },
  effects: {
    nothing: NONE,
    lesson: proposal("a lesson draft on a card; Accept saves it with ↩️ Undo"),
    fact: proposal("a fact draft on a card; Accept saves it with ↩️ Undo"),
    skill: proposal("a proposal whose Accept queues the authoring job; a rule-rung recurrence row is queued by the tick itself (code-made; the job's cards announce it)"),
    schedule: proposal("a time shift on a card; Accept applies it, Revert restores the row"),
    knowledge: proposal("recorded only while the wiki is disarmed (R5); a later slice adds the handler"),
    tool_gap: proposal("the self_write_propose focus text for Paco to send as his own message (R7)"),
    ladder: proposal("a ladder_moves row on Accept, no automatic bar or judge change; Revoke ends it (R6)")
  },
  reasonCodes: IMPROVE_REASONS
};
