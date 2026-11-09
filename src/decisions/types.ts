import type { Question } from "../jev/questions/types.js";

/**
 * The decision ladder's shapes (ADR 0030, spec §4). One entry per decision; a ladder of deciders tried in order
 * (code rule → Jev → model → Paco); the runner decides, then records. Ids, closed enums and numbers only reach the ledger.
 */
export const DECISION_STAGES = ["intake", "pre_model", "pre_tool", "post_tool", "supervision", "settle", "after_turn", "inbound"] as const;
export type DecisionStage = (typeof DECISION_STAGES)[number];
export const RUNG_KINDS = ["rule", "system_one", "model", "paco"] as const;
export type RungKind = (typeof RUNG_KINDS)[number];
/** The rung a decision names: one of the four, or `fail` when no rung answered and the entry's `fail` verdict stands. */
export type DecidedBy = RungKind | "fail";
/** Every rung runs armed (R13): the type admits nothing else. */
export type ArmedMode = "on";
/** How a recorded row's non-rule rungs ran; `shadow` only on rows older builds wrote; `late` is a verdict that arrived after its caller stopped waiting (stage 2b). */
export type RecordedArmedMode = "on" | "shadow" | "late";
export const FALLBACK_REASONS = ["timeout", "outage", "parse", "threw", "stale_bar", "budget"] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];
/** Spec §7.4's outcome signals, plus `review_ok` (✅ is a label calibration needs). Values are validated per signal in outcomes.ts. */
export const DECISION_SIGNALS = ["correction", "dig_deeper", "review_ok", "review_bad", "review_unsure", "approval_denied", "approval_expired", "rating",
  "settle_sent_back", "planner_failed", "recurrence", "abandoned", "lesson_unfollowed", "lesson_undone", "think_harder", "settle_unverified", "settle_discarded"] as const;
export type DecisionSignal = (typeof DECISION_SIGNALS)[number];
/** Reason codes the runner itself produces; recordable for every entry (record.ts). */
export const RUNNER_REASON_CODES = ["no_executor", "floor_held"] as const;

/** Spec §4.1 (R12): what the entry's judges read. `mixed` is treated as `tool`. */
export type InputSource = "paco" | "tool" | "mixed";
/** What a verdict causes: nothing, a reply, a tightening (withhold, add a tap, send back once), a proposal for Paco's tap, or an effect. */
export type EffectKind = "none" | "reply" | "tighten" | "proposal" | "effect";
/** How Paco learns of it: a code-built card (with its Undo / Dig deeper), a `/changes` row naming the undo command (spec 2026-11-07 §4), a listing in `/inbox` with a should-have-pinged tap (a pull surface, accepted only under ADR 0034 rule 2.6), or not at all. The turn's reply is not an announcement (Paco 2026-10-12). */
export type Announce = "card" | "changes" | "inbox" | "none";
/**
 * Spec §4.1 (R12): each verdict's effect, declared. registry.ts `entryProblems` fails a Jev or model rung that can cause an
 * effect that is not reversible or not announced, and anything but `none` / `tighten` / `proposal` over tool input.
 */
export interface VerdictEffect { kind: EffectKind; reversible: boolean; announced: Announce; what?: string }

/** Spec §4.2: a bar from an external measurement, kept in registry code; monotone or fail-open entries only. */
export interface ProvisionalBar { kind: "provisional"; question: string; criteriaHash: string; p: number; source: string }
/** ADR 0029's calibrated rows (calibration.ts), named by question id; `p` is the entry's single probability bar, when it has one. */
export interface CalibratedBar { kind: "calibrated"; questionIds: readonly string[]; p?: number }
export type BarRef = ProvisionalBar | CalibratedBar;
export interface PromptRef { id: string; version: number }

/** The noise band's one re-ask (stage 2a, Addition B): the mean decided, or the second call failed and the first answer stood. */
export interface Reask { kind: "mean" | "max" | "failed"; pFirst: number }
export interface RungAnswer<V, D = never> { verdict: V; reason?: string; p?: number; detail?: D; pIndex?: number; reask?: Reask }
/** "Not mine to decide": the walk goes on. `floor` is the initial monotone verdict (spec §4.1). */
export interface RungAbstain<V, D = never> { abstain: true; floor?: V; reason?: string; detail?: D; reask?: Reask }
/** A thrown rung, a timeout, an outage: an abstention that names why (`decisions.fallback_reason`). */
export interface RungFailed<D = never> { failed: FallbackReason; reason?: string; detail?: D }
export type RungResult<V, D = never> = RungAnswer<V, D> | RungAbstain<V, D> | RungFailed<D>;

export interface RuleRung<S, V, D = never> { kind: "rule"; name: string; decide: (s: S) => V | RungAnswer<V, D> | RungAbstain<V, D> }
/** `questions`: one Jev call may ask several (turn.handler asks six); `recordedP` names whose p the row records (spec §5.2). */
export interface JevRung { kind: "system_one"; name: string; questions: readonly Question[]; bars: BarRef; timeoutMs: number; recordedP?: string }
export interface ModelRung { kind: "model"; name: string; role: "tiny" | "fast"; prompt: PromptRef; timeoutMs: number }
/** Asynchronous; review taps are outcomes, not a rung. */
export interface PacoRung { kind: "paco"; name: string; surface: "card" | "approval" }
export type Rung<S, V, D = never> = RuleRung<S, V, D> | JevRung | ModelRung | PacoRung;

export interface Entry<S, V extends string, D = never> {
  id: string;
  /** Bumped on any wording, rung or bar change. */
  version: number;
  stage: DecisionStage;
  /** What the judges read (R12): Paco's own message, tool-derived input, or both (treated as tool). */
  input: InputSource;
  question: string;
  /** Closed, always including an escape value. */
  verdicts: readonly V[];
  ladder: readonly Rung<S, V, D>[];
  /** What stands when no rung answers (timeout, outage, throw, every rung abstained). */
  fail: V;
  /** Least cautious first; later rungs may only move toward the end. */
  monotone?: { order: readonly V[] };
  locked?: true;
  /** The routine answer: not given a row on its own (spec §5.2). */
  defaultVerdict: V;
  alwaysRecord?: true;
  outcomes: readonly DecisionSignal[];
  /** Every registered entry is armed `on` (R13), by type. */
  armed: Partial<Record<RungKind, ArmedMode>>;
  effects: Readonly<Record<V, VerdictEffect>>;
  /**
   * Spec 2026-11-07 §4 (ADR 0034 2.5): a code-owned provenance predicate, true only when what the effect would store is
   * Paco's own typed words. A `mixed`-input entry whose judge may cause a reversible, announced `effect` must name one;
   * `entryProblems` refuses such an effect without it.
   */
  pacoWordsOnly?: (...args: never[]) => boolean;
  /** ADR 0034 2.6: a runtime gate the caller runs before writing; true only for one item's state and a verdict in the two lanes. */
  perItemRouting?: (...args: never[]) => boolean;
  /** The code-owned reason codes a row may carry (plus RUNNER_REASON_CODES); anything else is recorded as null. */
  reasonCodes: readonly string[];
}
/** Any entry, for the registry and the recorder (a rule's state parameter is contravariant, so `never` accepts all). */
export type AnyEntry = Entry<never, string, unknown>;

/** One rung's turn in the walk. */
export interface RungOutcome<V, D = never> { kind: RungKind; name: string; mode: ArmedMode; result: RungResult<V, D> }
export interface DecideResult<V, D = never> {
  verdict: V;
  rung: DecidedBy;
  p?: number;
  /** The passage or question index of the recorded p; the noise band's re-ask on the deciding (or an earlier abstaining) judge. */
  pIndex?: number;
  reask?: Reask;
  reason: string | null;
  /** The first failure in the walk (null when none failed), and the kind of rung that failed (codex W6). */
  fallbackReason: FallbackReason | null;
  fallbackRung: RungKind | null;
  armedMode: RecordedArmedMode;
  /** The `decisions` row, or null when none was written (routine, or the write failed). */
  decisionId: string | null;
  detail?: D;
  walk: readonly RungOutcome<V, D>[];
  latencyMs: number;
}
export type AnyDecideResult = DecideResult<string, unknown>;

/** Writes the row (or not). Must not throw; the runner still catches, so a recorder bug never changes a decision. */
export interface DecisionRecorder {
  record(entry: AnyEntry, r: AnyDecideResult, ctx: { run_id: string | null; tool_call_id: string | null }): string | null;
}
export interface RungExecutors<S, V, D> {
  system_one?: ((rung: JevRung, s: S, prior: readonly RungOutcome<V, D>[]) => Promise<RungResult<V, D>>) | undefined;
  model?: ((rung: ModelRung, s: S, prior: readonly RungOutcome<V, D>[]) => Promise<RungResult<V, D>>) | undefined;
  paco?: ((rung: PacoRung, s: S, prior: readonly RungOutcome<V, D>[]) => Promise<RungResult<V, D>>) | undefined;
}
export interface DecideCtx<S, V, D> {
  run_id: string | null;
  tool_call_id?: string | null | undefined;
  recorder: DecisionRecorder;
  exec?: RungExecutors<S, V, D> | undefined;
  clock?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
}
