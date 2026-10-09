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
 * The tree's rows, armed on Paco's word (2026-10-09) after the replay (`houge jev replay triage`) and his labels: all
 * six questions plus the status pseudo-row, zh and en, on jev-1.13.0. The per-turn bars (tree-policy.ts) still send
 * every unsure turn to the planner on Default; a criteria or model change disarms.
 */
const EVIDENCE = "tree replay 2026-10-09: 301 turns (zh 271, en 30), 111 labelled by Paco; lane misroutes 0 (memory 7/7, status 2/2); category 181/301; permutation 276/301";
export const CALIBRATED_ROWS: readonly CalibrationRow[] = [
  { question_id: "category", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "sets_rule", criteria_hash: "455d081d81ff7ae67c693a888019570572142aa854d3cb16bf81b7e745a159ae", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "rule_scope", criteria_hash: "02c6caacb4d5a277b13fc3aa1d196a271240a58e17151e2c3f764c81a319cb33", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "breadth", criteria_hash: "c70960d0d6cc4fe6b4019e606492d6738ba909ac6731d4830dd39eb0619ac005", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "reasoning", criteria_hash: "9b2eae10d8d782a999033ed1f25df2c785c128515e49bcfd3721174c8416207b", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "actions", criteria_hash: "37dc583de24e6dabb20f4c3112619788b9485917a9529cac0322866e388f3538", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "category:status", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", model: "jev-1.13.0", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "category", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "sets_rule", criteria_hash: "455d081d81ff7ae67c693a888019570572142aa854d3cb16bf81b7e745a159ae", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "rule_scope", criteria_hash: "02c6caacb4d5a277b13fc3aa1d196a271240a58e17151e2c3f764c81a319cb33", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "breadth", criteria_hash: "c70960d0d6cc4fe6b4019e606492d6738ba909ac6731d4830dd39eb0619ac005", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "reasoning", criteria_hash: "9b2eae10d8d782a999033ed1f25df2c785c128515e49bcfd3721174c8416207b", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "actions", criteria_hash: "37dc583de24e6dabb20f4c3112619788b9485917a9529cac0322866e388f3538", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "category:status", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", model: "jev-1.13.0", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
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
  // A row naming the moving request alias never arms: it would stay armed across an alias move (rows key the versioned id).
  if (model === JEV_REQUEST_MODEL) return undefined;
  return rows.some((r) => r.question_id === questionId && r.criteria_hash === hash && r.model === model && r.lang === effective) ? effective : undefined;
}
