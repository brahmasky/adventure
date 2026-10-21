import type { Lane, TurnRole } from "../jev/tree-policy.js";
import type { PlannerFailure } from "../run/run-store.js"; // type-only: the store imports this file, no runtime cycle
import { ENTRY_IDS } from "./entry-ids.js";
import { DECISION_SIGNALS, type DecisionSignal } from "./types.js";

/**
 * Spec §5.2 / §7.4: each outcome signal's closed value set. The store calls `checkOutcomeValue` before every insert, so no
 * free text reaches `decision_outcomes`. Lists duplicated from other modules are pinned equal by tests/decisions/outcomes.test.ts.
 */
export const CORRECTION_VALUES = ["answer", "lookup", "research", "memory", "self_change", "machine_task", "schedule", "wiki", "mail_calendar",
  "status", "other"] as const;
export const DIG_DEEPER_VALUES = ["answer", "lookup", "memory", "status", "planner"] as const satisfies readonly Lane[];
/** Compile-time pin: a lane added to `Lane` without a dig-deeper value here fails typecheck (no runtime lane list exists to compare with). */
type DigDeeperCoversEveryLane = Exclude<Lane, (typeof DIG_DEEPER_VALUES)[number]> extends never ? true : never;
export const DIG_DEEPER_COVERS_EVERY_LANE: DigDeeperCoversEveryLane = true;

/** The planner roles (tree-policy TurnRole); `think_harder` records the role the previous turn ran on. */
export const TURN_ROLE_VALUES = ["fast", "default", "thinking"] as const satisfies readonly TurnRole[];

/** turn.settle's reason codes and discarded-judgment values, duplicated because the store imports this file and the entry pulls in src/jev/questions; pinned equal to the entry's lists by tests. */
export const SETTLE_REASON_VALUES = ["hostile", "already_sent_back", "last_call_denied", "steer_queued", "deadline_short", "aborting", "pass_errored", "empty", "claim_scheduled", "claim_saved",
  "claim_attached", "claim_sent", "todo_pending", "todo_unavailable", "jev_claims_done", "jev_unverified", "jev_promise", "jev_asks_permission", "budget", "settled"] as const;
export const SETTLE_DISCARDED_VALUE_LIST = ["extension_timeout", "signal", "continuation_failed"] as const;

/** 2b-ii §2: a tool registry name (the `tool_approvals.capability` column). */
export const APPROVAL_CAPABILITY = /^[a-z][a-z0-9_]{0,39}$/;
/** 2b-ii §2: every `error_type` `finishRun({next: "failed"})` is called with: the PlannerFailure union (which already holds the two literals P1 found, model_error and killed); `other` for anything else. */
export const PLANNER_FAILED_VALUES = ["planner_exit", "lease_lost", "lease_expired", "killed", "no_planner_leg", "model_error", "turn_timeout", "frame_idle",
  "merged_parent_failed", "media_failed", "other"] as const;
/** Compile-time pin: a PlannerFailure member missing above fails typecheck (the list is the union's members, then `other`). */
type PlannerFailedCoversUnion = Exclude<PlannerFailure, (typeof PLANNER_FAILED_VALUES)[number]> extends never ? true : never;
export const PLANNER_FAILED_COVERS_UNION: PlannerFailedCoversUnion = true;

export class OutcomeRejected extends Error {}

type Check = (v: string | number) => boolean;
const ids: ReadonlySet<string> = new Set(ENTRY_IDS);
const oneOf = (xs: readonly string[]): Check => (v) => typeof v === "string" && xs.includes(v);
const intIn = (lo: number, hi: number): Check => (v) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const entryId: Check = (v) => typeof v === "string" && ids.has(v);
const matches = (re: RegExp): Check => (v) => typeof v === "string" && re.test(v);
const NUMERIC_SIGNALS: ReadonlySet<DecisionSignal> = new Set(["rating", "recurrence"]);
/** The inbox stores every value as TEXT; a numeric signal's text comes back as the integer its check needs (a non-number stays text and is refused). */
export function outcomeValueOf(signal: DecisionSignal, text: string): string | number {
  return NUMERIC_SIGNALS.has(signal) && /^-?\d+$/.test(text) ? Number(text) : text;
}

/** `null`: no producer yet. The stage that adds one defines the set here (a protected edit) and its tests. */
const VALUE_CHECKS: Readonly<Record<DecisionSignal, Check | null>> = {
  correction: oneOf(CORRECTION_VALUES), dig_deeper: oneOf(DIG_DEEPER_VALUES),
  lesson_undone: oneOf(DIG_DEEPER_VALUES), think_harder: oneOf(TURN_ROLE_VALUES),
  review_ok: entryId, review_bad: entryId, review_unsure: entryId,
  settle_sent_back: oneOf(SETTLE_REASON_VALUES), settle_unverified: oneOf(SETTLE_REASON_VALUES), settle_discarded: oneOf(SETTLE_DISCARDED_VALUE_LIST),
  rating: intIn(0, 3), recurrence: intIn(1, 10_000),
  approval_denied: matches(APPROVAL_CAPABILITY), approval_expired: matches(APPROVAL_CAPABILITY), planner_failed: oneOf(PLANNER_FAILED_VALUES),
  abandoned: oneOf(DIG_DEEPER_VALUES), lesson_unfollowed: oneOf(DIG_DEEPER_VALUES)
};

/** The stored text of a valid value; throws OutcomeRejected otherwise (the message names the signal, never the value). */
export function checkOutcomeValue(signal: string, value: string | number): string {
  if (!(DECISION_SIGNALS as readonly string[]).includes(signal)) throw new OutcomeRejected("unknown outcome signal");
  const check = VALUE_CHECKS[signal as DecisionSignal];
  if (!check || !check(value)) throw new OutcomeRejected(`value not allowed for ${signal}`);
  return String(value);
}
