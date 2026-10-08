/**
 * Calibration rows (ADR 0029 §3.5). A question is armed for a language ONLY when a row names its exact criteria hash
 * and the reported model, so a criteria or model change disarms it. The decision tree's questions (spec 2026-10-06 §7)
 * arm on Paco's word after the replay; evidence then accrues while armed, and the per-turn bars (tree-policy.ts) still
 * send every unsure turn to the planner on the Default role.
 */
import { readFileSync } from "node:fs";
import type { Lang } from "./intent-question.js";
import { JEV_REQUEST_MODEL } from "./jev-client.js";

/**
 * One arming row. `question_id` is a tree question id (`category`, `sets_rule`, `rule_scope`, `breadth`, `reasoning`,
 * `actions`) or the pseudo-id `category:status` (tree-policy.ts TREE_STATUS_ARM_ID, criteria hash = TREE_CATEGORY's),
 * which arms the status lane: memory and status clear different bars, so neither row implies the other. Both lanes
 * also need the `sets_rule` + `rule_scope` rows (tree-policy.ts treeArmed `rule`), so a stated rule is never swallowed.
 */
export interface CalibrationRow { question_id: string; criteria_hash: string; model: string; lang: "zh" | "en"; approved: string; evidence: string }

/**
 * Empty on purpose (plan 2026-10-07 Decision 6): the lane 1 rows named the retired lane 1 hashes. The tree's rows are
 * committed here on Paco's word after the Task 12 replay (`houge jev replay triage`); until then every turn routes
 * `uncalibrated` → the planner on Default, and the memory and status lanes do not act.
 */
export const CALIBRATED_ROWS: readonly CalibrationRow[] = [];

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
  // A row naming the moving request alias never arms: it would stay armed across an alias move (rows key the versioned id).
  if (model === JEV_REQUEST_MODEL) return undefined;
  return rows.some((r) => r.question_id === questionId && r.criteria_hash === hash && r.model === model && r.lang === effective) ? effective : undefined;
}
