import type { Entry, RungAnswer } from "../types.js";

export type SecretRedactVerdict = "clean" | "masked";
/** The three report wrappers that redact through truncateForChat (spec §2.2 R1a–c); nothing else is counted. */
export type RedactSeam = "final_report" | "failure_report" | "evolution_report";

function rule(s: { masked: boolean; seam: RedactSeam }): RungAnswer<SecretRedactVerdict> {
  return s.masked ? { verdict: "masked", reason: s.seam } : { verdict: "clean" };
}

export const SECRET_REDACT: Entry<{ masked: boolean; seam: RedactSeam }, SecretRedactVerdict> = {
  id: "secret.redact", version: 1, stage: "settle", input: "tool", locked: true,
  question: "Did this outbound report carry a known secret value (ADR 0015) that was masked before it was cut?",
  verdicts: ["clean", "masked"],
  ladder: [{ kind: "rule", name: "brokerValues", decide: rule }],
  fail: "masked", defaultVerdict: "clean", outcomes: [], armed: { rule: "on" },
  effects: { clean: { kind: "none", reversible: true, announced: "none" }, masked: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["final_report", "failure_report", "evolution_report"],
};
