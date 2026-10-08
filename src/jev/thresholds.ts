import { CALIBRATED_ROWS, calibratedLang, type CalibrationRow } from "./calibration.js";
import type { Lang } from "./intent-question.js";
import type { JevChoiceAnswer } from "./jev-client.js";
import { TRIAGE_COMPLETE, TRIAGE_LANE, TRIAGE_SCOPE } from "./questions/triage.js";
import { criteriaHash, type Question } from "./questions/types.js";

/** Bump when a start value changes; stored on every decision row so a replay knows which bars judged it. */
export const THRESHOLD_VERSION = "2026-10-04.1";

export interface TriageBars { minConf: number; minMemory: number; minGap: number; minPure: number; minStatus: number }
export const TRIAGE_BAR_DEFAULTS: TriageBars = { minConf: 0.7, minMemory: 0.85, minGap: 0.5, minPure: 0.8, minStatus: 0.8 };

function unit(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return raw !== undefined && Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Env overrides (spec §5.4): a bad calibration is an .env edit, not a revert. */
export function resolveTriageBars(env: NodeJS.ProcessEnv): TriageBars {
  return {
    ...TRIAGE_BAR_DEFAULTS,
    minConf: unit(env.HOUGE_JEV_TRIAGE_MIN_CONF, TRIAGE_BAR_DEFAULTS.minConf),
    minPure: unit(env.HOUGE_JEV_TRIAGE_MIN_PURE, TRIAGE_BAR_DEFAULTS.minPure),
    minStatus: unit(env.HOUGE_JEV_TRIAGE_MIN_STATUS, TRIAGE_BAR_DEFAULTS.minStatus)
  };
}

export type TriageDecision =
  | { kind: "fallthrough"; reason: "uncalibrated" | "below_bar" | "none" }
  | { kind: "status" }
  | { kind: "memory"; complete: "pure" | "mixed"; scope: "ask" | "research" };

const p = (a: JevChoiceAnswer, option: string): number => a.probabilities[option] ?? 0;

/**
 * The status lane's own arming key (spec §5.9: memory may arm while status stays shadow). Same criteria hash as
 * TRIAGE_LANE — status reads that one answer — but a distinct `question_id`, so a `lane` row arms memory only.
 */
export const TRIAGE_STATUS_ARM_ID = "lane:status";

/**
 * The rows that can arm a lane today: a current triage question (or the `lane:status` pseudo-row) at its current criteria
 * hash. The alias-move page (jev-incidents.ts) reads only these, so a stale-hash or unrelated row neither clears nor
 * raises it.
 */
export function armingRows(rows: readonly CalibrationRow[]): CalibrationRow[] {
  const live = new Set([TRIAGE_LANE, TRIAGE_COMPLETE, TRIAGE_SCOPE].map((q) => `${q.id}\u0000${criteriaHash(q)}`));
  live.add(`${TRIAGE_STATUS_ARM_ID}\u0000${criteriaHash(TRIAGE_LANE)}`);
  return rows.filter((r) => live.has(`${r.question_id}\u0000${r.criteria_hash}`));
}

/** Lane-specific arming: status needs the `lane:status` row; memory needs `lane`, `complete` and `scope`. */
function statusArmed(lang: Lang, model: string, rows: readonly CalibrationRow[]): boolean {
  return calibratedLang(TRIAGE_STATUS_ARM_ID, criteriaHash(TRIAGE_LANE), model, lang, rows) !== undefined;
}

function armedFor(qs: Question[], lang: Lang, model: string, rows: readonly CalibrationRow[]): boolean {
  return qs.every((q) => calibratedLang(q.id, criteriaHash(q), model, lang, rows) !== undefined);
}

/** Pure: probabilities in, decision out. Thresholds are the caller's (code-owned); Jev never applies them. */
export function triageVerdict(answers: Record<string, JevChoiceAnswer>, bars: TriageBars, lang: Lang, model: string, rows: readonly CalibrationRow[] = CALIBRATED_ROWS): TriageDecision {
  const lane = answers.lane; const complete = answers.complete; const scope = answers.scope;
  if (!lane) return { kind: "fallthrough", reason: "uncalibrated" };
  if (p(lane, "status") >= bars.minStatus && statusArmed(lang, model, rows)) return { kind: "status" };
  if (!complete || !scope || !armedFor([TRIAGE_LANE, TRIAGE_COMPLETE, TRIAGE_SCOPE], lang, model, rows)) return { kind: "fallthrough", reason: "uncalibrated" };
  const memory = p(lane, "memory");
  if (memory < bars.minMemory || lane.confidence < bars.minConf || memory - p(lane, "none") < bars.minGap) {
    return { kind: "fallthrough", reason: lane.choice === "none" ? "none" : "below_bar" };
  }
  const scopeChoice: "ask" | "research" = p(scope, "research") > p(scope, "ask") ? "research" : "ask";
  return { kind: "memory", complete: p(complete, "pure") >= bars.minPure ? "pure" : "mixed", scope: scopeChoice };
}
