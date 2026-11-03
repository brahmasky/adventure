import { describe, expect, it } from "vitest";
import { needsRewrite, validateQuery } from "../../../src/core/lanes/lane-compose.js";
import { QUERY_MAX_CHARS, REWRITE_MAX_CHARS, REWRITE_RECENT_MS, queryCheckOf, rewriteFilterOf, thinOf } from "../../../src/core/lanes/lookup-predicates.js";

// Spec R6 §4.1: needsRewrite / validateQuery become thin wrappers of two classifiers; the wrappers must return byte-identical
// results for every input, or the lane would search a different query than the merge base does.

/** lane-compose.ts:63–66 at the merge base (fe788f2), verbatim. */
function oldNeedsRewrite(message: string, quoted: boolean, previousTelegramLineAgeMs: number | null): boolean {
  if (previousTelegramLineAgeMs === null || previousTelegramLineAgeMs > 30 * 60_000) return false;
  return quoted || [...message.trim()].length <= 40;
}
/** lane-compose.ts:78–82 at the merge base, verbatim. */
function oldValidateQuery(raw: string, message: string): string {
  const q = raw.trim().replace(/^["'`“”「]+|["'`“”」]+$/g, "").trim();
  if (q.length === 0 || /^same[.!。]?$/i.test(q) || q.includes("\n") || q.length > 120 || /https?:\/\/|www\./i.test(q)) return message;
  return q;
}

const MESSAGES = ["", "a".repeat(40), "a".repeat(41), "😀".repeat(40), "😀".repeat(41), "  x  "];
const AGES: Array<number | null> = [null, 0, 30 * 60_000, 30 * 60_000 + 1, -5, NaN];
const RAWS = ["", "SAME", "same.", "SAME!", "same。", "\"same\"", "「Sydney weather」", "a\nb", "x".repeat(120), "x".repeat(121), "see https://x.y", "www.x.y", "Sydney weather tomorrow"];

describe("lookup predicates (spec R6 §4.1, §4.2)", () => {
  it("the constants are today's", () => {
    expect([REWRITE_MAX_CHARS, REWRITE_RECENT_MS, QUERY_MAX_CHARS]).toEqual([40, 30 * 60_000, 120]);
  });
  it("needsRewrite equals the merge-base body over every message × quoted × age", () => {
    for (const m of MESSAGES) for (const q of [true, false]) for (const a of AGES) {
      expect(needsRewrite(m, q, a), `m=${JSON.stringify(m).slice(0, 12)} q=${q} a=${a}`).toBe(oldNeedsRewrite(m, q, a));
    }
  });
  it("validateQuery equals the merge-base body over every raw answer", () => {
    for (const r of RAWS) expect(validateQuery(r, "MSG"), JSON.stringify(r).slice(0, 20)).toBe(oldValidateQuery(r, "MSG"));
  });
  it("rewriteFilterOf names the step: no recent line, long message, needed (astral chars count as one; NaN and a negative age pass)", () => {
    expect(rewriteFilterOf("a".repeat(41), false, 0)).toBe("long_message");
    expect(rewriteFilterOf("a".repeat(41), true, 0)).toBe("needed");
    expect(rewriteFilterOf("a".repeat(40), false, 0)).toBe("needed");
    expect(rewriteFilterOf("😀".repeat(40), false, 0)).toBe("needed");
    expect(rewriteFilterOf("😀".repeat(41), false, 0)).toBe("long_message");
    expect(rewriteFilterOf("x", false, null)).toBe("no_recent_line");
    expect(rewriteFilterOf("x", false, 30 * 60_000)).toBe("needed");
    expect(rewriteFilterOf("x", false, 30 * 60_000 + 1)).toBe("no_recent_line");
    expect(rewriteFilterOf("x", false, NaN)).toBe("needed");
    expect(rewriteFilterOf("x", false, -5)).toBe("needed");
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
