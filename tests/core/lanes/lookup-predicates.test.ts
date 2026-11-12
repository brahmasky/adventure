import { describe, expect, it } from "vitest";
import { validateQuery } from "../../../src/core/lanes/lane-compose.js";
import { QUERY_MAX_CHARS, REWRITE_RECENT_MS, queryCheckOf, recentContextOf, thinOf } from "../../../src/core/lanes/lookup-predicates.js";

// Spec R6 §4.1: validateQuery is a thin wrapper of queryCheckOf; it must return byte-identical results for every input,
// or the lane would search a different query than the merge base does.

/** lane-compose.ts:78–82 at the merge base, verbatim. */
function oldValidateQuery(raw: string, message: string): string {
  const q = raw.trim().replace(/^["'`“”「]+|["'`“”」]+$/g, "").trim();
  if (q.length === 0 || /^same[.!。]?$/i.test(q) || q.includes("\n") || q.length > 120 || /https?:\/\/|www\./i.test(q)) return message;
  return q;
}

const RAWS = ["", "SAME", "same.", "SAME!", "same。", "\"same\"", "「Sydney weather」", "a\nb", "x".repeat(120), "x".repeat(121), "see https://x.y", "www.x.y", "Sydney weather tomorrow"];

describe("lookup predicates (spec R6 §4.1, §4.2)", () => {
  it("the constants are today's", () => {
    expect([REWRITE_RECENT_MS, QUERY_MAX_CHARS]).toEqual([30 * 60_000, 120]);
  });
  it("validateQuery equals the merge-base body over every raw answer", () => {
    for (const r of RAWS) expect(validateQuery(r, "MSG"), JSON.stringify(r).slice(0, 20)).toBe(oldValidateQuery(r, "MSG"));
  });
  it("recentContextOf: earlier lines are used only when Paco's previous line is at most 30 minutes old", () => {
    expect(recentContextOf(null)).toBe(false);
    expect(recentContextOf(0)).toBe(true);
    expect(recentContextOf(30 * 60_000)).toBe(true);
    expect(recentContextOf(30 * 60_000 + 1)).toBe(false);
    // NaN and a negative age (clock skew) count as recent: unchanged from the old `ageMs > …` comparison.
    expect(recentContextOf(NaN)).toBe(true);
    expect(recentContextOf(-5)).toBe(true);
  });
  it("queryCheckOf classifies the model's answer: same, invalid, or the stripped query", () => {
    expect(queryCheckOf("")).toEqual({ kind: "invalid" });
    expect(queryCheckOf("same。")).toEqual({ kind: "same" });
    expect(queryCheckOf("SAME!")).toEqual({ kind: "same" });
    expect(queryCheckOf("a\nb")).toEqual({ kind: "invalid" });
    expect(queryCheckOf("x".repeat(120))).toEqual({ kind: "query", q: "x".repeat(120) });
    expect(queryCheckOf("x".repeat(121))).toEqual({ kind: "invalid" });
    expect(queryCheckOf("see https://x.y")).toEqual({ kind: "invalid" });
    expect(queryCheckOf("「Sydney」")).toEqual({ kind: "query", q: "Sydney" });
  });
  it("thinOf: answered wins, then a listable URL decides thin vs no_url", () => {
    expect(thinOf({ answered: true, url: true })).toBe("answered");
    expect(thinOf({ answered: true, url: false })).toBe("answered");
    expect(thinOf({ answered: false, url: false })).toBe("no_url");
    expect(thinOf({ answered: false, url: true })).toBe("thin");
  });
});
