import type { MemoryDistill } from "../../capabilities/distill.js";
import type { JevAnswer } from "../../jev/jev-client.js";
import { MEMORY_KIND_OPTIONS, TREE_MEMORY_KIND, type MemoryKindOption } from "../../jev/questions/tree.js";
import { criteriaHash } from "../../jev/questions/types.js";
import type { Entry, ProvisionalBar, RungAbstain, RungAnswer, VerdictEffect } from "../types.js";

/**
 * `memory.kind` (spec 2026-10-15 Rev 3 §3; ADR 0030 amendment 2026-10-17): what Paco wants remembered. Ladder: Jev's
 * `memory_kind` answer from its OWN request (src/jev/memory-kind-ask.ts) at p >= 0.85, then the distill call, which returns the kind
 * with the text. `fail` is `other` (the planner takes the turn). rule/fact/both save first with an Undo card per item
 * (reversible, announced: R12 over Paco's words); fix/other go to the planner. Executors: the save adapter
 * (src/capabilities/lesson-write.ts) and the front door (src/core/core-worker.ts).
 */
export const MEMORY_KIND_ID = "memory.kind";
export type MemoryKindVerdict = MemoryKindOption;
export const MEMORY_KIND_BAR_P = 0.85;
/** Paco's R6: armed at ship on the memory lane's bar, no calibration sitting; a calibrated row may replace it when he commits one. */
export const MEMORY_KIND_BAR: ProvisionalBar = { kind: "provisional", question: TREE_MEMORY_KIND.id, criteriaHash: criteriaHash(TREE_MEMORY_KIND),
  model: "jev-1.13.0", p: MEMORY_KIND_BAR_P, source: "Paco R6 2026-10-17: the memory lane's bar (0.85), armed at ship; ADR 0030 amendment 2026-10-17" };

/** `jev`: memory_kind's answer from its own call (absent on the planner's tool, or when the call failed). `escapes`: may other/fix decide (the memory lane)? */
export interface MemoryKindState { jev: JevAnswer | undefined; escapes: boolean }
/** The model rung's detail: the distill's parsed answer (null when the call itself failed). */
export interface MemoryKindDetail { distill: MemoryDistill | null }

const EPS = 1e-9;

/** Jev's top memory_kind option when it clears the bar; null below it, or without a choice answer. */
export function confidentMemoryKind(a: JevAnswer | undefined): { kind: MemoryKindVerdict; p: number } | null {
  if (a?.type !== "choice") return null;
  const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0];
  if (!top || !(MEMORY_KIND_OPTIONS as readonly string[]).includes(top[0]) || top[1] + EPS < MEMORY_KIND_BAR_P) return null;
  return { kind: top[0] as MemoryKindVerdict, p: top[1] };
}

/**
 * The Jev rung. Below the bar or without an answer it abstains and the distill decides. On a save path (`escapes`
 * false) an `other` or `fix` abstains too, so memory.kind never suppresses a save `sets_rule` called for (spec §3).
 */
export function memoryKindJevRung(s: MemoryKindState): RungAnswer<MemoryKindVerdict, MemoryKindDetail> | RungAbstain<MemoryKindVerdict, MemoryKindDetail> {
  const c = confidentMemoryKind(s.jev);
  if (!c) return { abstain: true };
  if (!s.escapes && (c.kind === "other" || c.kind === "fix")) return { abstain: true };
  return { verdict: c.kind, p: c.p, reason: "jev_kind" };
}

const save = (what: string): VerdictEffect => ({ kind: "effect", reversible: true, announced: "card", what });
const PLANNER: VerdictEffect = { kind: "none", reversible: true, announced: "none", what: "the planner takes the turn (memory_correct and its approval card for a fix)" };

export const MEMORY_KIND: Entry<MemoryKindState, MemoryKindVerdict, MemoryKindDetail> = {
  id: MEMORY_KIND_ID, version: 1, stage: "pre_model", input: "paco",
  question: "What does Paco want remembered: a rule for how Houge answers, a fact about him or his world, both, a fix to something already stored, or nothing?",
  verdicts: MEMORY_KIND_OPTIONS,
  ladder: [
    // its own Jev request; the client's 1.5 s bound fires first, this outer bound only stops a hung executor
    { kind: "system_one", name: "memory_kind", questions: [TREE_MEMORY_KIND], bars: MEMORY_KIND_BAR, timeoutMs: 2_500, recordedP: "memory_kind" },
    // the distill seat's own chain deadline bounds the call; the lesson_write runner budget bounds the whole save
    { kind: "model", name: "distill", role: "tiny", prompt: { id: "memory.kind.distill", version: 1 }, timeoutMs: 120_000 }
  ],
  fail: "other", defaultVerdict: "other", alwaysRecord: true,
  outcomes: ["lesson_undone", "dig_deeper", "review_ok", "review_bad", "review_unsure"],
  armed: { system_one: "on", model: "on" },
  effects: {
    other: PLANNER, fix: PLANNER,
    rule: save("a lesson saves first; the memory card names it with ↩️ Undo"),
    fact: save("an episodic fact saves first (memory_changes add); the memory card names it with ↩️ Undo"),
    both: save("a lesson and a fact save in one transaction; the card carries one ↩️ Undo per item")
  },
  reasonCodes: ["jev_kind", "distill_kind"]
};
