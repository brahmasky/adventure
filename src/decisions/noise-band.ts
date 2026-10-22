import type { JevAnswer, JevChoiceAnswer, JevScoreAnswer } from "../jev/jev-client.js";

/**
 * The noise band (stage 2a, Addition B, Paco 2026-10-13). Jev answers byte-identical requests with different probabilities
 * (probe 2026-10-13: 0.59–0.65 on one message). A value within the band of a bar it is compared against asks Jev exactly
 * once more and the decision uses the mean. Bands are reviewed values (Paco's commit, like CALIBRATED_ROWS), keyed by question and criteria hash (no model), in the answer's own unit: a choice's top probability, a noul's p(yes), a score's expected level.
 */
export interface NoiseBand { question: string; criteriaHash: string; band: number; evidence: string; approved: string }

/** Empty until Paco commits rows from scripts/measure-jev-noise.mjs. No row → no re-ask (today's behaviour). */
export const NOISE_BANDS: readonly NoiseBand[] = [];

export function bandFor(question: string, criteriaHash: string, bands: readonly NoiseBand[] = NOISE_BANDS): number | undefined {
  return bands.find((b) => b.question === question && b.criteriaHash === criteriaHash)?.band;
}

const EPS = 1e-9;
export function nearBar(x: number, bars: readonly number[], band: number): boolean {
  return bars.some((b) => Math.abs(x - b) <= band + EPS);
}

export function answerValue(a: JevAnswer): number {
  if (a.type === "noul") return a.noul;
  if (a.type === "score") return a.score;
  return a.probabilities[a.choice] ?? 0;
}

const mean2 = (x: number, y: number): number => (x + y) / 2;

function meanDist(a: Record<string, number>, b: Record<string, number>): Record<string, number> | null {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length || keys.some((k) => typeof b[k] !== "number")) return null;
  return Object.fromEntries(keys.map((k) => [k, mean2(a[k]!, b[k]!)]));
}

function meanChoice(a: JevChoiceAnswer, b: JevChoiceAnswer): JevChoiceAnswer | null {
  const probabilities = meanDist(a.probabilities, b.probabilities);
  if (!probabilities) return null;
  const top = Math.max(...Object.values(probabilities));
  const choice = Math.abs((probabilities[a.choice] ?? -1) - top) <= EPS ? a.choice : Object.keys(probabilities).find((k) => Math.abs(probabilities[k]! - top) <= EPS)!;
  return { type: "choice", choice, probabilities, confidence: mean2(a.confidence, b.confidence) };
}

function meanScore(a: JevScoreAnswer, b: JevScoreAnswer): JevScoreAnswer | null {
  const probabilities = meanDist(a.probabilities, b.probabilities);
  return probabilities ? { type: "score", score: mean2(a.score, b.score), probabilities, confidence: mean2(a.confidence, b.confidence) } : null;
}

/** The mean of two answers to the same question; null when their shapes differ (never averaged across types or options). */
export function meanAnswer(a: JevAnswer, b: JevAnswer): JevAnswer | null {
  if (a.type === "noul" && b.type === "noul") return { type: "noul", noul: mean2(a.noul, b.noul) };
  if (a.type === "choice" && b.type === "choice") return meanChoice(a, b);
  if (a.type === "score" && b.type === "score") return meanScore(a, b);
  return null;
}

export function meanAnswers(a: Record<string, JevAnswer>, b: Record<string, JevAnswer>): Record<string, JevAnswer> | null {
  const out: Record<string, JevAnswer> = {};
  for (const [id, x] of Object.entries(a)) {
    const y = b[id];
    const m = y ? meanAnswer(x, y) : null;
    if (!m) return null;
    out[id] = m;
  }
  return out;
}
