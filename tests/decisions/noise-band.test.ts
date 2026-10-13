import { describe, expect, it } from "vitest";
import { answerValue, bandFor, meanAnswer, meanAnswers, nearBar, NOISE_BANDS, type NoiseBand } from "../../src/decisions/noise-band.js";

// Jev answers byte-identical requests with different probabilities (probe 2026-10-13: 0.59–0.65 on one message). A p that
// close to a bar decides by noise; one more call and the mean halves the variance. The band is a reviewed value keyed like a
// calibration row, so a wording or model move falls out of it (no band → no re-ask, today's behaviour).
const B: NoiseBand = { question: "category", criteriaHash: "h1", model: "jev-1.13.0", band: 0.08, evidence: "e", approved: "Paco test" };

describe("noise band", () => {
  it("ships with no reviewed rows (Ruling 6: Paco commits them after the measurement)", () => {
    expect(NOISE_BANDS).toEqual([]);
  });
  it("is keyed by question, criteria hash and reported model", () => {
    expect(bandFor("category", "h1", "jev-1.13.0", [B])).toBe(0.08);
    expect(bandFor("category", "h2", "jev-1.13.0", [B])).toBeUndefined();
    expect(bandFor("category", "h1", "jev-1.14.0", [B])).toBeUndefined();
  });
  it("near: within the band of any bar, inclusive", () => {
    expect(nearBar(0.65, [0.6], 0.08)).toBe(true);
    expect(nearBar(0.68, [0.6], 0.08)).toBe(true);
    expect(nearBar(0.69, [0.6], 0.08)).toBe(false);
    expect(nearBar(0.21, [0.8, 0.2], 0.05)).toBe(true);
  });
  it("answerValue reads each type in its own unit", () => {
    expect(answerValue({ type: "noul", noul: 0.42 })).toBe(0.42);
    expect(answerValue({ type: "score", score: 1.7, probabilities: { 0: 0, 1: 0.3, 2: 0.7 }, confidence: 0.5 })).toBe(1.7);
    expect(answerValue({ type: "choice", choice: "a", probabilities: { a: 0.65, b: 0.35 }, confidence: 0.3 })).toBe(0.65);
  });
  it("the mean of two choices re-picks the argmax, keeping the first choice on a tie", () => {
    const a = { type: "choice" as const, choice: "a", probabilities: { a: 0.62, b: 0.38 }, confidence: 0.24 };
    const b = { type: "choice" as const, choice: "b", probabilities: { a: 0.38, b: 0.62 }, confidence: 0.24 };
    expect(meanAnswer(a, b)).toMatchObject({ choice: "a", probabilities: { a: 0.5, b: 0.5 } });
    expect(meanAnswer(a, { ...b, probabilities: { a: 0.3, b: 0.7 } })).toMatchObject({ choice: "b" });
  });
  it("refuses to average answers of different shape", () => {
    expect(meanAnswer({ type: "noul", noul: 0.4 }, { type: "score", score: 1, probabilities: { 0: 0, 1: 1 }, confidence: 1 })).toBeNull();
    expect(meanAnswers({ x: { type: "noul", noul: 0.4 } }, {})).toBeNull();
  });
});
