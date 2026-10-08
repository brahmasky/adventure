import { describe, expect, it } from "vitest";
import type { Intent } from "../../src/capabilities/intent.js";
import { formatReplayReport, summarizeReplay } from "../../src/jev/replay-report.js";
import type { ReplayRow } from "../../src/jev/replay.js";

const row = (i: number, jev: string, llm: string, confidence: number, over: Partial<ReplayRow> = {}): ReplayRow => ({
  turn_id: `u${i}`, run_id: `r${i}`, lang: "en", anchor_kind: "classify", status: "ok", recorded_intent: "answer",
  observed_action: "answer", est_tokens: 100, jev_intent: jev, jev_confidence: confidence, jev_model: "jev-1.13.0",
  jev_probabilities: {}, llm_intent: llm as Intent, llm_parsed: true, ...over
});
const agreeing = (n: number, start = 0) => Array.from({ length: n }, (_, i) => row(start + i, "research", "research", 0.9));
const disagreeing = (n: number, start = 1000) => Array.from({ length: n }, (_, i) => row(start + i, "answer", "research", 0.9));

describe("summarizeReplay — the GO/STOP screen", () => {
  it("GO at exactly 75% agreement at confidence ≥ 0.7", () => {
    expect(summarizeReplay([...agreeing(75), ...disagreeing(25)]).verdict).toBe("GO");
  });

  it("STOP just under the bar", () => {
    expect(summarizeReplay([...agreeing(74), ...disagreeing(26)]).verdict).toBe("STOP");
  });

  it("STOP when under 60% of eligible turns reach a matched pair — a biased remnant is not evidence", () => {
    const failed = Array.from({ length: 50 }, (_, i) => row(2000 + i, "x", "x", 0, { status: "jev_failed" }));
    const s = summarizeReplay([...agreeing(40), ...failed]);
    expect(s.verdict).toBe("STOP");
    expect(s.verdictReason).toMatch(/matched/);
  });

  it("an unparsed LLM label never counts as a match (parseIntent defaults to 'answer' silently)", () => {
    const s = summarizeReplay([row(1, "answer", "answer", 0.9, { llm_parsed: false })]);
    expect(s.matched).toBe(0);
  });

  it("low-confidence rows are outside the 0.7 slice; coverage is slice / matched", () => {
    const s = summarizeReplay([...agreeing(6), ...Array.from({ length: 4 }, (_, i) => row(500 + i, "answer", "research", 0.3))]);
    const t07 = s.thresholds.find((t) => t.t === 0.7)!;
    expect(t07).toMatchObject({ slice: 6, agreement: 1, coverage: 0.6 });
  });

  it("dry_run rows are not eligible; per-language split and fallback-anchor count are reported", () => {
    const rows = [...agreeing(3), row(9, "answer", "answer", 0.9, { lang: "zh", anchor_kind: "run_start" }), row(10, "x", "x", 0, { status: "dry_run" })];
    const s = summarizeReplay(rows);
    expect(s.eligible).toBe(4);
    expect(s.fallbackAnchors).toBe(1);
    expect(s.byLang.zh).toMatchObject({ matched: 1, agreementAt07: 1 });
  });

  it("lists at most 20 disagreements, most confident first", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i, "answer", "research", 0.5 + i / 100));
    const s = summarizeReplay(rows);
    expect(s.disagreements).toHaveLength(20);
    expect(s.disagreements[0]!.confidence).toBeCloseTo(0.79);
  });

  it("the printed report states the verdict, counts, cost and that anchors are approximate", () => {
    const text = formatReplayReport([...agreeing(8), ...disagreeing(2)], { spentUsd: 0.0012, estimatedUsd: 0.0012 });
    expect(text).toMatch(/Verdict: GO/);
    expect(text).toMatch(/eligible 10/);
    expect(text).toMatch(/\$0\.0012/);
    expect(text).toMatch(/approximate/);
  });

  it("F2: a run stopped early prints INCOMPLETE, never a GO/STOP verdict, even over rows that would otherwise be GO", () => {
    const text = formatReplayReport([...agreeing(8), ...disagreeing(2)], { spentUsd: 0.0012, estimatedUsd: 0.0012, stopped: "budget" });
    expect(text).toMatch(/INCOMPLETE/);
    expect(text).not.toMatch(/Verdict: GO/);
  });

  // No pin since the request sends `jev-latest`: the run's FIRST reported model is its reference; rows from any other
  // reported model (the alias moved mid-run) are recorded in byModel but never blended into the verdict.
  it("F5: rows from a model other than the run's first reported model are excluded from matched/gate and reported in byModel", () => {
    const pinned = agreeing(10); // jev_model "jev-1.13.0" by default
    const offModel = [row(9000, "research", "research", 0.9, { jev_model: "jev-1.14.0" }), row(9001, "answer", "research", 0.9, { jev_model: "jev-1.14.0" })];
    const s = summarizeReplay([...pinned, ...offModel]);
    expect(s.matched).toBe(10); // the two off-model rows never enter the gate
    expect(s.byModel).toEqual({ "jev-1.13.0": 10, "jev-1.14.0": 2 });
  });

  it("F5: the report prints a By Jev model line and flags rows excluded from the verdict", () => {
    const pinned = agreeing(10);
    const offModel = [row(9000, "research", "research", 0.9, { jev_model: "jev-1.14.0" })];
    const text = formatReplayReport([...pinned, ...offModel], { spentUsd: 0, estimatedUsd: 0 });
    expect(text).toMatch(/By Jev model:/);
    expect(text).toMatch(/1 row\(s\) from a model other than jev-1\.13\.0 \(the run's first reported model\) excluded from the verdict/);
  });

  // The reference is the first model Jev REPORTED, whatever the LLM leg did: an llm_failed row still carries Jev's answer.
  it("F5: the reference model is the first Jev-reported model even when that row's LLM leg failed; byModel counts every Jev answer", () => {
    const rows = [row(1, "research", "research", 0.9, { status: "llm_failed", jev_model: "jev-2.0.0" }), ...agreeing(10, 10)];
    const s = summarizeReplay(rows);
    expect(s.byModel).toEqual({ "jev-2.0.0": 1, "jev-1.13.0": 10 });
    expect(s.matched).toBe(0); // the 1.13.0 rows came after the run started on 2.0.0
    expect(formatReplayReport(rows, { spentUsd: 0, estimatedUsd: 0 })).toMatch(/10 row\(s\) from a model other than jev-2\.0\.0/);
  });

  it("F5: a run wholly on a newer reported model is matched in full — there is no pinned version to fall short of", () => {
    const rows = agreeing(10).map((r) => ({ ...r, jev_model: "jev-2.0.0" }));
    const s = summarizeReplay(rows);
    expect(s.matched).toBe(10);
    expect(formatReplayReport(rows, { spentUsd: 0, estimatedUsd: 0 })).not.toMatch(/excluded from the verdict/);
  });

  it("F4: all-dry-run rows print a DRY RUN pre-flight line, not a verdict", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row(i, "research", "research", 0.9, { status: "dry_run" })),
      row(50, "x", "x", 0, { status: "skipped_no_anchor" }),
      row(51, "x", "x", 0, { status: "skipped_state_too_large" })
    ];
    const text = formatReplayReport(rows, { spentUsd: 0, estimatedUsd: 0.015 });
    expect(text).toMatch(/DRY RUN/);
    expect(text).toMatch(/would dispatch 3/);
    expect(text).not.toMatch(/Verdict:/);
  });
});
