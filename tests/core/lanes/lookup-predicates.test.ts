import { describe, expect, it } from "vitest";
import { validateQuery } from "../../../src/core/lanes/lane-compose.js";
import { QUERY_MAX_CHARS, REWRITE_MAX_CHARS, REWRITE_RECENT_MS, earlierLinesOf, queryCheckOf, stripAddress, thinOf } from "../../../src/core/lanes/lookup-predicates.js";

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
  // Earlier lines can carry text Houge wrote from web sources. Every lookup is rewritten now, so they stay limited to the
  // case that used them before: a short or quoting follow-up to a recent line. A long message stands on its own.
  it("earlierLinesOf: only a short or quoting follow-up to a line at most 30 minutes old gets earlier lines", () => {
    expect(earlierLinesOf("x", false, null)).toBe(false);
    expect(earlierLinesOf("x", true, null)).toBe(false);
    expect(earlierLinesOf("x", false, 0)).toBe(true);
    expect(earlierLinesOf("x", false, REWRITE_RECENT_MS)).toBe(true);
    expect(earlierLinesOf("x", false, REWRITE_RECENT_MS + 1)).toBe(false);
    expect(earlierLinesOf("a".repeat(REWRITE_MAX_CHARS), false, 0)).toBe(true);
    expect(earlierLinesOf("a".repeat(REWRITE_MAX_CHARS + 1), false, 0)).toBe(false);
    expect(earlierLinesOf("a".repeat(REWRITE_MAX_CHARS + 1), true, 0)).toBe(true);
    expect(earlierLinesOf("😀".repeat(REWRITE_MAX_CHARS), false, 0)).toBe(true); // astral chars count as one
    // NaN and a negative age (clock skew) count as recent: unchanged from the old `ageMs > …` comparison.
    expect(earlierLinesOf("x", false, NaN)).toBe(true);
    expect(earlierLinesOf("x", false, -5)).toBe(true);
  });
  // When the rewrite is late, fails or answers SAME, the message itself is searched. Searched with the name, the engine
  // matched "猴哥" and missed the subject (run_9aec9bf6, 2026-11-06).
  it("stripAddress: drops the name only where it addresses Houge, set off by punctuation at the start or end", () => {
    expect(stripAddress("猴哥, 帮忙找找爱的代价 钢琴典谱")).toBe("帮忙找找爱的代价 钢琴典谱");
    expect(stripAddress("Houge: weather in Sydney tomorrow")).toBe("weather in Sydney tomorrow");
    expect(stripAddress("上面的讨论能不能深挖一下，猴哥")).toBe("上面的讨论能不能深挖一下");
    expect(stripAddress("what is new in k3.1, houge?")).toBe("what is new in k3.1");
    // the name as the subject stays: no punctuation sets it off
    expect(stripAddress("猴哥是谁")).toBe("猴哥是谁");
    expect(stripAddress("谁是猴哥")).toBe("谁是猴哥");
    expect(stripAddress("Houge is a daemon on a Mac mini")).toBe("Houge is a daemon on a Mac mini");
    expect(stripAddress("tell me about houge")).toBe("tell me about houge");
    // a message that is only the address stays whole: an empty search is worse
    expect(stripAddress("猴哥！")).toBe("猴哥！");
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
