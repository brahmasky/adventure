import type { Entry, RungAnswer } from "../types.js";

export type FetchSsrfVerdict = "allowed" | "blocked";

function rule(s: { allowed: boolean }): RungAnswer<FetchSsrfVerdict> {
  return s.allowed ? { verdict: "allowed" } : { verdict: "blocked" };
}

export const FETCH_SSRF: Entry<{ allowed: boolean }, FetchSsrfVerdict> = {
  id: "fetch.ssrf", version: 1, stage: "pre_tool", input: "tool", locked: true,
  question: "Is this fetch permitted under the SSRF gate?",
  verdicts: ["allowed", "blocked"],
  ladder: [{ kind: "rule", name: "ssrfGate", decide: rule }],
  fail: "blocked", defaultVerdict: "allowed", outcomes: [], armed: { rule: "on" },
  effects: { allowed: { kind: "none", reversible: true, announced: "none" }, blocked: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [],
};
