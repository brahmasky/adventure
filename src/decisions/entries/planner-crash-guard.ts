import type { Entry, RungAnswer } from "../types.js";

/** The planner supervisor's crash latch (spec 2026-11-01 R4 §4.1): CRASH_LIMIT crash exits inside CRASH_WINDOW_MS latch it. */
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 10 * 60_000;
export type CrashGuardVerdict = "spawn" | "halt";
/** Captured in ensureSession with the same `now` the raw crashLooping(now) uses. */
export interface CrashGuardInput { latched: boolean; recent: number }

function rule(s: CrashGuardInput): RungAnswer<CrashGuardVerdict> | CrashGuardVerdict {
  if (s.latched) return { verdict: "halt", reason: "latched" };
  if (s.recent >= CRASH_LIMIT) return { verdict: "halt", reason: "limit_reached" };
  return "spawn";
}

export const PLANNER_CRASH_GUARD: Entry<CrashGuardInput, CrashGuardVerdict> = {
  id: "planner.crash_guard", version: 1, stage: "supervision", input: "tool",
  question: "Before spawning an omp child: is the planner crash-looping, so the spawn is refused until /rearm or a sweep re-arms it?",
  verdicts: ["spawn", "halt"],
  ladder: [{ kind: "rule", name: "crash_looping", decide: rule }],
  fail: "halt", defaultVerdict: "spawn", outcomes: [], armed: { rule: "on" },
  effects: {
    spawn: { kind: "none", reversible: true, announced: "none" },
    halt: { kind: "tighten", reversible: true, announced: "none", what: "no child is spawned; the turn fails crash_loop (a lane turn still completes); /rearm or the next sweep that runs clears it" }
  },
  reasonCodes: ["limit_reached", "latched"],
};
