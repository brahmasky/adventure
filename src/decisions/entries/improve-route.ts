import type { JevChoiceAnswer } from "../../jev/jev-client.js";
import { IMPROVE_TARGET } from "../../jev/questions/improve.js";
import { criteriaHash } from "../../jev/questions/types.js";
import type { Category } from "../../jev/questions/tree.js";
import type { Lane } from "../../jev/tree-policy.js";
import type { ImproveSignalRow } from "../../run/run-store.js";
import { LOCKED_ENTRY_IDS } from "../entry-ids.js";
import { DECISION_SIGNALS, type DecisionSignal, type Entry, type ProvisionalBar, type RungAbstain, type RungAnswer, type VerdictEffect } from "../types.js";

/**
 * `improve.route` (2b-ii spec §4; parent §7.4; ADR 0030 decision 8): once a day, over the inbox's grouped signals, what
 * should Houge change? Rule rungs cause the only automatic effect (a recurrence → a grow hint, recorded by the tick on a
 * rule-rung `skill`/`recurrence` row; the planner then decides whether to `grow_submit`, ADR 0035); Jev (one fixed choice question, bar 0.67) and the Tiny pick
 * propose, except a lesson or fact behind `autoApplies` (spec 2026-11-07 §3), which applies with a /changes line. Fail-open on `nothing`; every signal is one of its outcomes (§4.4). Always recorded; the row's run is the
 * group's newest run.
 */
export const IMPROVE_ROUTE_ID = "improve.route";
export const IMPROVE_TARGETS = ["nothing", "lesson", "fact", "skill", "schedule", "knowledge", "tool_gap", "ladder"] as const;
export type ImproveTarget = (typeof IMPROVE_TARGETS)[number];
export const IMPROVE_REASONS = ["stale", "stated_rule_owned", "recurrence", "recurrence_lookup", "already_authored", "skill_exists", "expiry_pattern", "deferred_rate",
  "wiki_disarmed", "jev_choice", "tiny_pick", "below_bar", "no_text", "lane_busy", "inapplicable_top", "already_proposed", "review_bad", "locked_entry"] as const;
export type ImproveReason = (typeof IMPROVE_REASONS)[number];
export const IMPROVE_BAR_P = 0.67;
export const IMPROVE_JEV_MS = 1_500;
/** Paco 2026-11-07: was 8 s; every live pick took 10.4–21.2 s (2026-10-22 to 11-06), so every row failed. The tick is background work. */
export const IMPROVE_TINY_MS = 30_000;
/** R8: provisional until the sanity run and the 14-day revisit set it from real signal groups. */
export const IMPROVE_BAR: ProvisionalBar = { kind: "provisional", question: IMPROVE_TARGET.id, criteriaHash: criteriaHash(IMPROVE_TARGET), p: IMPROVE_BAR_P,
  source: "2b-ii spec R8: 0.67 on improve_target, the sanity run's suggestion (lowest planted jev_choice p 0.72 − 0.05), signed off by Paco 2026-10-22; the 14-day revisit (§11) recalibrates it" };

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
const LOCKED: ReadonlySet<string> = new Set(LOCKED_ENTRY_IDS);

/** §4.3 rule 1, in this order; the first that fires decides. */
export function improveRule(s: ImproveState): Rule {
  if (s.stale) return nothing("stale");
  if (s.signal === "correction" && s.statedRuleSaved) return nothing("stated_rule_owned");
  // the rule rung owns review_bad (scope = the reviewed entry id, as draftFor reads it): an unlocked entry goes to a ladder proposal, a locked one to nothing
  if (s.signal === "review_bad") return LOCKED.has(s.scope) ? nothing("locked_entry") : { verdict: "ladder", reason: "review_bad" };
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
  return IMPROVE_TARGETS.filter((t) => (t !== "knowledge" || s.wikiArmed) && (t !== "skill" || (s.recurrence !== null && !s.skillExists)) && (t !== "schedule" || s.scheduleHint !== null) && (t !== "ladder" || s.signal === "review_bad"));
}

export function improveJevState(s: ImproveState): ImproveJevState {
  return { signal: s.signal, value: s.value, scope: s.scope, count: s.count, count_14d: s.count14d, category: s.category, lane: s.lane, capability: s.capability,
    paco_text: s.redacted.pacoText, tools: s.toolSummary, last_improvement: s.lastImprovement ? `${s.lastImprovement.target} ${s.lastImprovement.ageDays} days ago` : "none",
    applicable: applicableTargets(s) };
}

/**
 * Masking after the answer (codex round 2 N3): the overall top option decides when applicable and at or over the bar; an
 * inapplicable top abstains `inapplicable_top` (no runner-up can clear the bar); an applicable top under the bar abstains
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

/** Ruling R1': a lesson draft that is a near-copy of one an accepted proposal on the pair saved within this many days is a 'lesson did not hold' rewrite (the repeat check finds it, improve/repeat.ts). */
export const LESSON_REWRITE_DAYS = 30;

/** A group's rows as the provenance gate reads them (SignalGroup.rows, improve/groups.ts). */
export type ProvenanceRows = { rows: readonly Pick<ImproveSignalRow, "origin" | "run_id" | "about_run_id">[] };

/**
 * Spec 2026-11-07 §3 (ADR 0034 10.5, R12): a lesson or fact applies on its own only when every row of the group is a
 * correction Paco typed on the memory lane (`memlane_fix`: its correcting run is a new Telegram message of his, never the
 * corrected run — `isTelegramRun` re-checks the run's source here, plan ruling P16) and the proposal is no rewrite — `rewrite` is the repeat check's verdict (a near-copy of a lesson accepted on the pair within LESSON_REWRITE_DAYS, ruling R1'); the tick asks once before the draft with false (provenance only) and again after the check.
 * The no-pile-up check (proposalBlocks) and the chat check live at the commit.
 */
export function autoApplies(g: ProvenanceRows, s: Pick<ImproveState, "signal">, verdict: ImproveTarget, isTelegramRun: (run_id: string) => boolean, rewrite: boolean): boolean {
  if (verdict !== "lesson" && verdict !== "fact") return false;
  if (s.signal !== "correction" || rewrite) return false;
  return g.rows.length > 0 && g.rows.every((r) => r.origin === "memlane_fix" && r.run_id !== null && r.run_id !== r.about_run_id && isTelegramRun(r.run_id));
}

const NONE: VerdictEffect = { kind: "none", reversible: true, announced: "none", what: "recorded; the group's outcome rows attach to this decision" };
const proposal = (what: string): VerdictEffect => ({ kind: "proposal", reversible: true, announced: "card", what });
const applied = (what: string): VerdictEffect => ({ kind: "effect", reversible: true, announced: "changes", what });
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
  pacoWordsOnly: autoApplies,
  effects: {
    nothing: NONE,
    lesson: applied("from a correction Paco typed (autoApplies): saved at the tick, one /changes line with /forget <id>; otherwise a card whose Accept saves it with ↩️ Undo"),
    fact: applied("from a correction Paco typed (autoApplies): saved at the tick, one /changes line with /forget_memory <id>; otherwise a card whose Accept saves it with ↩️ Undo"),
    skill: proposal("a proposal whose Accept records a grow hint; a rule-rung recurrence row records the hint itself (code-made); the planner then decides whether to grow_submit"),
    schedule: proposal("a time shift on a card; Accept applies it, Revert restores the row"),
    knowledge: proposal("recorded only while the wiki is disarmed (R5); a later slice adds the handler"),
    tool_gap: proposal("the self_write_propose focus text for Paco to send as his own message (R7)"),
    ladder: proposal("a ladder_moves row on Accept, no automatic bar or judge change; Revoke ends it (R6)")
  },
  reasonCodes: IMPROVE_REASONS
};
