import { thinOf, type ThinInput } from "../../core/lanes/lookup-predicates.js";
import type { Entry, RungAnswer } from "../types.js";

export type ThinVerdict = "fetch" | "none";

function rule(s: ThinInput): RungAnswer<ThinVerdict> {
  const step = thinOf(s);
  return step === "thin" ? { verdict: "fetch", reason: "thin" } : { verdict: "none", reason: step };
}

export const LOOKUP_THIN: Entry<ThinInput, ThinVerdict> = {
  id: "lookup.thin", version: 1, stage: "pre_model", input: "tool",
  question: "Did the first strict read leave the objective unanswered, so the lane fetches the top listed result and reads again?",
  verdicts: ["fetch", "none"],
  ladder: [{ kind: "rule", name: "thin_read", decide: rule }],
  fail: "none", defaultVerdict: "none", outcomes: [], armed: { rule: "on" }, alwaysRecord: true,
  effects: {
    fetch: { kind: "effect", reversible: true, announced: "none", what: "one fetch of the top listed result through the SSRF floor and a second strict read; http_fetch_performed as today" },
    none: { kind: "none", reversible: true, announced: "none" }
  },
  reasonCodes: ["thin", "answered", "no_url"],
};
