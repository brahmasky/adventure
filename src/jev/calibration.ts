/**
 * Calibration rows (ADR 0029 §3.5). A question is armed for a language ONLY when a row names its exact criteria hash
 * and the reported model, so a criteria or model change disarms it. Lane 1 was armed on Paco's instruction
 * (2026-10-06, ADR 0029 amendment) after the replay sanity check, not after the §5.9 shadow bars: evidence now
 * accrues while armed, and the per-turn confidence bars (thresholds.ts) still send every unsure turn to the planner.
 */
import { readFileSync } from "node:fs";
import type { Lang } from "./intent-question.js";

/**
 * One arming row. `question_id` is a question id (`lane`, `complete`, `scope` arm the memory lane together) or the
 * pseudo-id `lane:status` (thresholds.ts TRIAGE_STATUS_ARM_ID, criteria hash = TRIAGE_LANE's), which arms the status lane
 * on its own: the two lanes clear different §5.9 bars, so neither row implies the other.
 */
export interface CalibrationRow { question_id: string; criteria_hash: string; model: string; lang: "zh" | "en"; approved: string; evidence: string }

const EVIDENCE = "replay 2026-10-06: 293 turns; confident pure 10 (1 missed a schedule edit), status 1/1; permutation 291/293";
export const CALIBRATED_ROWS: readonly CalibrationRow[] = [
  { question_id: "lane", criteria_hash: "828d0f935ce54a65c4a62dd78ca9a83ffbacd3c66dcc7095b05744422fc8e57a", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-06", evidence: EVIDENCE },
  { question_id: "lane", criteria_hash: "828d0f935ce54a65c4a62dd78ca9a83ffbacd3c66dcc7095b05744422fc8e57a", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-06", evidence: EVIDENCE },
  { question_id: "complete", criteria_hash: "7beab74332c0641a800ea8c80085eebb56f98d2503ef53edd39c1890b5bfc316", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-06", evidence: EVIDENCE },
  { question_id: "complete", criteria_hash: "7beab74332c0641a800ea8c80085eebb56f98d2503ef53edd39c1890b5bfc316", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-06", evidence: EVIDENCE },
  { question_id: "scope", criteria_hash: "d3f6c9008b3eaf1e7a4556dd443e422703f8c306932c88de2abf46ff3763e7a4", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-06", evidence: EVIDENCE },
  { question_id: "scope", criteria_hash: "d3f6c9008b3eaf1e7a4556dd443e422703f8c306932c88de2abf46ff3763e7a4", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-06", evidence: EVIDENCE },
  { question_id: "lane:status", criteria_hash: "828d0f935ce54a65c4a62dd78ca9a83ffbacd3c66dcc7095b05744422fc8e57a", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-06", evidence: EVIDENCE },
  { question_id: "lane:status", criteria_hash: "828d0f935ce54a65c4a62dd78ca9a83ffbacd3c66dcc7095b05744422fc8e57a", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-06", evidence: EVIDENCE },
];

/**
 * Arming sequence (spec §5.9; Codex plan review): production rows come ONLY from this constant, added by Paco's commit.
 * `HOUGE_JEV_CALIBRATION_FILE` (a JSON array of CalibrationRow) exists for the live gate and a labelled shadow copy
 * of the DB — it is never set in the daemon's .env (configuration.md says so) and `resolveJevTriageMode` caps `arm`
 * at shadow while it is set outside a gate (`HOUGE_JEV_GATE=1`).
 */
export function calibrationRows(env: NodeJS.ProcessEnv): readonly CalibrationRow[] {
  const file = env.HOUGE_JEV_CALIBRATION_FILE?.trim();
  if (!file) return CALIBRATED_ROWS;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { parsed = undefined; }
  if (Array.isArray(parsed) && parsed.every(isCalibrationRow)) return parsed;
  // Unreadable or malformed = uncalibrated, never silent. The path only: the file's contents never reach a log.
  console.error(`jev: HOUGE_JEV_CALIBRATION_FILE ${file} is unreadable or not an array of calibration rows; no row armed`);
  return [];
}

const ROW_STRINGS = ["question_id", "criteria_hash", "model", "approved", "evidence"] as const;
function isCalibrationRow(v: unknown): v is CalibrationRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return ROW_STRINGS.every((k) => typeof r[k] === "string") && (r.lang === "zh" || r.lang === "en");
}

export function calibratedLang(questionId: string, hash: string, model: string, lang: Lang, rows: readonly CalibrationRow[] = CALIBRATED_ROWS): "zh" | "en" | undefined {
  const effective = lang === "mixed" ? "zh" : lang; // mixed inherits zh until it has ≥ 20 labelled rows (spec §3.4)
  return rows.some((r) => r.question_id === questionId && r.criteria_hash === hash && r.model === model && r.lang === effective) ? effective : undefined;
}
