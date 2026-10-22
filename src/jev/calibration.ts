/**
 * Calibration rows (ADR 0029 §3.5). A question is armed for a language ONLY when a row names its exact criteria hash
 * (the key is question, hash and language: a Jev version is not part of it; the per-model check gates a new model), so a
 * criteria change disarms it. The decision tree's questions (spec 2026-10-06 §7)
 * arm on Paco's word after the replay; evidence then accrues while armed, and the per-turn bars (tree-policy.ts) still
 * send every unsure turn to the planner on the Default role.
 */
import { readFileSync } from "node:fs";
import type { Lang } from "./intent-question.js";

/**
 * One arming row. `question_id` is a tree question id (`category`, `sets_rule`, `rule_scope`, `breadth`, `reasoning`,
 * `actions`) or a lane pseudo-id at the category question's hash: `category:status`, `category:answer`, `category:lookup`
 * (tree-policy.ts TREE_STATUS_ARM_ID / TREE_ANSWER_ARM_ID / TREE_LOOKUP_ARM_ID). Lanes clear different bars, so no row
 * implies another. Every lane also needs the `sets_rule` + `rule_scope` rows (tree-policy.ts treeArmed `rule`).
 */
export interface CalibrationRow { question_id: string; criteria_hash: string; lang: "zh" | "en"; approved: string; evidence: string }

/**
 * The tree's rows, armed on Paco's word (2026-10-09) after the replay (`houge jev replay triage`) and his labels: all
 * six questions plus the status pseudo-row, zh and en, on jev-1.13.0 (the rows carry no model). Stage B (Paco 2026-10-10, spec 2026-10-10 §1 ruling
 * 1) adds the answer and lookup pseudo-rows. The per-turn bars (tree-policy.ts) still send every unsure turn to the
 * planner; a criteria change disarms.
 */
const EVIDENCE = "tree replay 2026-10-09: 301 turns (zh 271, en 30), 111 labelled by Paco; lane misroutes 0 (memory 7/7, status 2/2); category 181/301; permutation 276/301";
const EVIDENCE_LANES = "stage B lane rules over the 2026-10-09 replay: 78 of 301 turns to the lanes (answer 39, lookup 39); Paco's labels lookup 7/7, answer 6/9; 26 of the 78 move from Default to Fast";
export const CALIBRATED_ROWS: readonly CalibrationRow[] = [
  { question_id: "category", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "sets_rule", criteria_hash: "455d081d81ff7ae67c693a888019570572142aa854d3cb16bf81b7e745a159ae", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "rule_scope", criteria_hash: "02c6caacb4d5a277b13fc3aa1d196a271240a58e17151e2c3f764c81a319cb33", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "breadth", criteria_hash: "c70960d0d6cc4fe6b4019e606492d6738ba909ac6731d4830dd39eb0619ac005", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "reasoning", criteria_hash: "9b2eae10d8d782a999033ed1f25df2c785c128515e49bcfd3721174c8416207b", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "actions", criteria_hash: "37dc583de24e6dabb20f4c3112619788b9485917a9529cac0322866e388f3538", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "category:status", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", lang: "zh", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "category:answer", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", lang: "zh", approved: "Paco 2026-10-10", evidence: EVIDENCE_LANES },
  { question_id: "category:lookup", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", lang: "zh", approved: "Paco 2026-10-10", evidence: EVIDENCE_LANES },
  { question_id: "category", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "sets_rule", criteria_hash: "455d081d81ff7ae67c693a888019570572142aa854d3cb16bf81b7e745a159ae", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "rule_scope", criteria_hash: "02c6caacb4d5a277b13fc3aa1d196a271240a58e17151e2c3f764c81a319cb33", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "breadth", criteria_hash: "c70960d0d6cc4fe6b4019e606492d6738ba909ac6731d4830dd39eb0619ac005", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "reasoning", criteria_hash: "9b2eae10d8d782a999033ed1f25df2c785c128515e49bcfd3721174c8416207b", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "actions", criteria_hash: "37dc583de24e6dabb20f4c3112619788b9485917a9529cac0322866e388f3538", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "category:status", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", lang: "en", approved: "Paco 2026-10-09", evidence: EVIDENCE },
  { question_id: "category:answer", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", lang: "en", approved: "Paco 2026-10-10", evidence: EVIDENCE_LANES },
  { question_id: "category:lookup", criteria_hash: "5eb9baea76fdff263944be72c196da9d90c4ab46ec8bab093a52a99b48d72148", lang: "en", approved: "Paco 2026-10-10", evidence: EVIDENCE_LANES },
];

/**
 * Arming sequence (spec §5.9; Codex plan review): production rows come ONLY from this constant, added by Paco's commit.
 * `HOUGE_JEV_CALIBRATION_FILE` (a JSON array of CalibrationRow; a legacy `model` field is ignored) exists for the live gate and a labelled shadow copy
 * of the DB — it is never set in the daemon's .env (configuration.md says so) and `resolveJevTriageMode` caps `arm`
 * at shadow while it is set outside a gate (`HOUGE_JEV_GATE=1`).
 */
export function calibrationRows(env: NodeJS.ProcessEnv): readonly CalibrationRow[] {
  const file = env.HOUGE_JEV_CALIBRATION_FILE?.trim();
  if (!file) return CALIBRATED_ROWS;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { parsed = undefined; }
  if (Array.isArray(parsed) && parsed.every(isCalibrationRow)) {
    // Rows written before the version left the key carry `model`: ignored, said once (a row's key is question, hash, lang).
    if (parsed.some((r) => "model" in r)) console.error(`jev: HOUGE_JEV_CALIBRATION_FILE ${file}: the \`model\` field on a row is ignored`);
    return parsed;
  }
  // Unreadable or malformed = uncalibrated, never silent. The path only: the file's contents never reach a log.
  console.error(`jev: HOUGE_JEV_CALIBRATION_FILE ${file} is unreadable or not an array of calibration rows; no row armed`);
  return [];
}

const ROW_STRINGS = ["question_id", "criteria_hash", "approved", "evidence"] as const;
function isCalibrationRow(v: unknown): v is CalibrationRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return ROW_STRINGS.every((k) => typeof r[k] === "string") && (r.lang === "zh" || r.lang === "en");
}

export function calibratedLang(questionId: string, hash: string, lang: Lang, rows: readonly CalibrationRow[] = CALIBRATED_ROWS): "zh" | "en" | undefined {
  const effective = lang === "mixed" ? "zh" : lang; // mixed inherits zh until it has ≥ 20 labelled rows (spec §3.4)
  return rows.some((r) => r.question_id === questionId && r.criteria_hash === hash && r.lang === effective) ? effective : undefined;
}
