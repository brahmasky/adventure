import type { SkipReason } from "../../jev/decide.js";
import type { JevTriageMode } from "../../jev/jev-flags.js";
import { TREE_QUESTIONS } from "../../jev/questions/tree.js";
import { TREE_BAR_DEFAULTS, type Lane, type RouteReason } from "../../jev/tree-policy.js";
import type { TurnModality } from "../../media/media-config.js";
import type { Entry, RungAbstain, RungAnswer, VerdictEffect } from "../types.js";

/**
 * `turn.handler` (spec §4.4): which handler takes a Telegram text turn. Ladder: today's code exits and the ack rule →
 * the Jev tree (six questions, one call) → the Tiny cascade below the choice bar; the planner is `fail`. Its judges read
 * Paco's own message, so under R12 a verdict may cause an effect that is reversible and announced: the effect table below
 * declares today's behaviour exactly (move, don't improve). Task 8c (Paco's Q1 ruling) moves every automatic save to the Undo card.
 */
export const TURN_HANDLER_ID = "turn.handler";
export type TurnHandlerVerdict = Lane;
export const TURN_HANDLER_VERDICTS: readonly TurnHandlerVerdict[] = ["answer", "lookup", "memory", "status", "planner"];
export const ROUTE_REASONS = ["routed", "uncalibrated", "below_bar", "bare_ack_guard", "lane_limits", "correction", "cascade", "cascade_failed",
  "ack_rule", "jev_skipped", "two_request"] as const satisfies readonly RouteReason[];
export const SKIP_REASONS = ["no_key", "fused", "auth", "rate_limited", "overloaded", "malformed_question", "timeout", "parse", "transport",
  "state_too_large", "disabled", "posture", "modality", "override", "error", "ack_rule"] as const satisfies readonly SkipReason[];
// Compile-time: the lists above cover their unions exactly (a new reason must be added here, or the build fails).
const ROUTE_COMPLETE: [Exclude<RouteReason, (typeof ROUTE_REASONS)[number]>] extends [never] ? true : false = true;
const SKIP_COMPLETE: [Exclude<SkipReason, (typeof SKIP_REASONS)[number]>] extends [never] ? true : false = true;
void ROUTE_COMPLETE; void SKIP_COMPLETE;

/** Spec §4.1 (R12): what each verdict causes today. tests/decisions/registry.test.ts pins this table. */
export const TURN_HANDLER_EFFECTS: Readonly<Record<TurnHandlerVerdict, VerdictEffect>> = {
  answer: { kind: "effect", reversible: true, announced: "reply",
    what: "answer-lane reply (Dig deeper); on a confident sets_rule the lesson saves first and the card's 📒 line names it, no Undo (until Task 8c)" },
  lookup: { kind: "effect", reversible: true, announced: "reply",
    what: "lookup-lane reply (Dig deeper); on a confident sets_rule the lesson saves first and the card's 📒 line names it, no Undo (until Task 8c)" },
  status: { kind: "reply", reversible: true, announced: "card", what: "status card rendered by code; Dig deeper" },
  memory: { kind: "effect", reversible: true, announced: "card", what: "instant lesson save on a confident sets_rule; memory-lane card with Undo (ADR 0029 §5.5, R12)" },
  planner: { kind: "effect", reversible: true, announced: "reply",
    what: "the planner answers; on a confident sets_rule the lesson saves first and the [memory] note names it in the planner's prompt (planner-supervisor.ts:479; until Task 8c)" }
};

export function isSkipReason(x: unknown): x is SkipReason {
  return typeof x === "string" && (SKIP_REASONS as readonly string[]).includes(x);
}

/** A snapshot for the gate rule. `isAck` is lazy: the tree's clock runs only for a turn that passed the earlier exits (as today). */
export interface TurnHandlerState { mode: JevTriageMode; overridden: boolean; posture: string | null; modality: TurnModality; hasTurnState: boolean; isAck: () => boolean }

/** Today's code exits, in today's order (core-worker.ts:2756-2769 at 3bff437). */
export function turnHandlerGate(s: TurnHandlerState): RungAnswer<TurnHandlerVerdict> | RungAbstain<TurnHandlerVerdict> {
  if (s.mode === "off") return { verdict: "planner", reason: "disabled" };
  if (s.overridden) return { verdict: "planner", reason: "override" };
  if (s.posture !== null) return { verdict: "planner", reason: "posture" };
  if (s.modality !== "text") return { verdict: "planner", reason: "modality" };
  if (!s.hasTurnState) return { verdict: "planner", reason: "error" };
  // shadow never changes behaviour, so the ack rule (which changes the role) acts only when armed
  return s.mode === "arm" ? ackRule(s) : { abstain: true };
}

/** The ack rule. A throw settles skipped `error`, as a throw at that point did at 3bff437 (plan ruling 19), never a judge's turn. */
function ackRule(s: TurnHandlerState): RungAnswer<TurnHandlerVerdict> | RungAbstain<TurnHandlerVerdict> {
  try {
    return s.isAck() ? { verdict: "planner", reason: "ack_rule" } : { abstain: true };
  } catch {
    console.error("triage: ack check threw; settling skipped error");
    return { verdict: "planner", reason: "error" };
  }
}

export const TURN_HANDLER: Entry<TurnHandlerState, TurnHandlerVerdict> = {
  id: TURN_HANDLER_ID, version: 1, stage: "pre_model", input: "paco",
  question: "Which handler takes this Telegram text turn: a no-planner lane, or the planner?",
  verdicts: TURN_HANDLER_VERDICTS,
  ladder: [
    { kind: "rule", name: "gate", decide: turnHandlerGate },
    // The client's own bound is 1.5 s with no retry; this outer bound only stops a hung executor and never fires first.
    { kind: "system_one", name: "tree", questions: TREE_QUESTIONS, bars: { kind: "calibrated", questionIds: TREE_QUESTIONS.map((q) => q.id), p: TREE_BAR_DEFAULTS.choice },
      timeoutMs: 10_000, recordedP: "category" },
    // CASCADE_TIMEOUT_MS (20 s) bounds the pick inside the executor; this outer bound sits above it and never fires first.
    { kind: "model", name: "cascade", role: "tiny", prompt: { id: "turn.handler.cascade", version: 1 }, timeoutMs: 25_000 }
  ],
  fail: "planner", defaultVerdict: "planner", alwaysRecord: true,
  outcomes: ["dig_deeper", "correction", "rating", "review_ok", "review_bad", "review_unsure"],
  armed: { rule: "on", system_one: "on", model: "on" },
  effects: TURN_HANDLER_EFFECTS,
  reasonCodes: [...ROUTE_REASONS, ...SKIP_REASONS]
};
