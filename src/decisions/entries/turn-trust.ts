import type { Entry, RungAnswer, VerdictEffect } from "../types.js";

/**
 * `turn.trust` (spec §7.2): how far a turn may be trusted, from what it has read. Code only and locked (ADR 0030 decision 6):
 * no judge ever decides it, and its only effect is to add taps (ADR 0029 decision 2: ask := code_ask ∨ trust_ask).
 */
export type TrustLevel = "clean" | "untrusted" | "hostile";
export const TRUST_ORDER: readonly TrustLevel[] = ["clean", "untrusted", "hostile"];
/**
 * `judge_timeout`: a judgement was lost (Jev down, timed out, partial) — raised in 2a by the bridge, not only by 2b's extension
 * timer (controller ruling 7: an outage must not leave the turn clean). `unjudged_outside` / `unjudged_local`: a passage was
 * framed because it may not leave (plan S8); from outside (a wall tool, network shell output) an attacker can trigger that at
 * will to dodge the judge, so it is hostile; from a local read it is untrusted. `judge_lost_outside`: a judgement was lost on
 * text from outside, which reached the planner inside the not-checked frame (security final I-2): hostile, since a plain
 * write would otherwise run tap-free beside text no judge read. `carried_untrusted` / `carried_hostile`: the turn starts at
 * the level its planner transcript carries from the last dispatched turn (security final I-3: that text is still in context).
 */
export type TrustCause = "wall_read" | "shell_netread" | "judge_timeout" | "injection_withheld" | "unjudged_outside" | "unjudged_local" | "judge_lost_outside"
  | "carried_untrusted" | "carried_hostile";
export const CAUSE_LEVEL: Readonly<Record<TrustCause, TrustLevel>> = { wall_read: "untrusted", shell_netread: "untrusted", judge_timeout: "untrusted",
  injection_withheld: "hostile", unjudged_outside: "hostile", unjudged_local: "untrusted", judge_lost_outside: "hostile",
  carried_untrusted: "untrusted", carried_hostile: "hostile" };
export interface TurnTrustState { current: TrustLevel; cause: TrustCause }

export const rankOf = (l: TrustLevel): number => TRUST_ORDER.indexOf(l);

export function trustRule(s: TurnTrustState): RungAnswer<TrustLevel> {
  const to = CAUSE_LEVEL[s.cause];
  return { verdict: rankOf(to) > rankOf(s.current) ? to : s.current, reason: s.cause };
}

const tighten = (what: string): VerdictEffect => ({ kind: "tighten", reversible: true, announced: "none", what });
export const TURN_TRUST: Entry<TurnTrustState, TrustLevel> = {
  id: "turn.trust", version: 1, stage: "post_tool", input: "tool",
  question: "How far may this turn be trusted, given what it has read?",
  verdicts: TRUST_ORDER,
  ladder: [{ kind: "rule", name: "max", decide: trustRule }],
  // a broken trust rule fails toward asking (mu rule 3: safety gates fail closed to asking the user)
  fail: "hostile", monotone: { order: TRUST_ORDER }, locked: true, defaultVerdict: "clean",
  outcomes: [], armed: { rule: "on" },
  effects: { clean: { kind: "none", reversible: true, announced: "none" },
    untrusted: tighten("lesson_write, schedule_task, self_write_propose and skill_author ask"),
    hostile: tighten("every shell command off the read-only list and every write asks; built-in edit/write redirect to bash") },
  reasonCodes: ["wall_read", "shell_netread", "judge_timeout", "injection_withheld", "unjudged_outside", "unjudged_local", "judge_lost_outside", "carried_untrusted", "carried_hostile"]
};
