import { afterEach, describe, expect, it, vi } from "vitest";
import { cat, treeSays, triageHarness } from "../helpers/triage-harness.js";
import { treeBarsFor, treeNear } from "../../src/core/turn-handler-ladder.js";
import { TREE_CATEGORY, TREE_QUESTIONS } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";

// Addition B on the front door: a category p within its reviewed band of the 0.6 choice bar asks Jev once more and decides
// on the mean; the decisions row says so; the raw jev_decisions row keeps the first call (calibration never sees a mean).
vi.mock("../../src/decisions/noise-band.js", async (orig) => {
  const m = await orig<typeof import("../../src/decisions/noise-band.js")>();
  const { criteriaHash } = await import("../../src/jev/questions/types.js");
  const { TREE_CATEGORY } = await import("../../src/jev/questions/tree.js");
  return { ...m, NOISE_BANDS: [{ question: "category", criteriaHash: criteriaHash(TREE_CATEGORY), model: "jev-1.13.0", band: 0.1, evidence: "test", approved: "test" }] };
});
afterEach(() => { vi.unstubAllEnvs(); });

const handlerRow = (h: ReturnType<typeof triageHarness>, run_id: string) => h.store.listDecisionsForRun(run_id).find((d) => d.entry_id === "turn.handler");

describe("turn.handler with a noise band", () => {
  it("near the bar: two Jev calls, the row records the mean re-ask and the first call's p; the raw row keeps the first call", async () => {
    const f = vi.fn().mockImplementationOnce(treeSays({ category: cat({ other: 0.65 }) })).mockImplementationOnce(treeSays({ category: cat({ other: 0.55 }) }));
    const h = triageHarness(f);
    const { run_id, input } = h.turn("帮我整理一下这周的待办");
    await h.worker.triageTurn(input);
    expect(f).toHaveBeenCalledTimes(2);
    expect(handlerRow(h, run_id)).toMatchObject({ entry_version: 2, reask: "mean", p_first: 0.65 });
    expect(handlerRow(h, run_id)?.p).toBeCloseTo(0.6, 9); // the decision used the mean of 0.65 and 0.55, not either call
    expect(h.store.listJevDecisions(run_id).find((r) => r.question_id === "category")?.top_prob).toBe(0.65);
  });
  it("far from the bar: one call, no re-ask", async () => {
    const f = vi.fn(treeSays({ category: cat({ other: 0.9 }) }));
    const h = triageHarness(f);
    const { run_id, input } = h.turn("帮我整理一下这周的待办");
    await h.worker.triageTurn(input);
    expect(f).toHaveBeenCalledTimes(1);
    expect(handlerRow(h, run_id)?.reask).toBeNull();
  });
  it("a failed second call keeps the first answer and says so", async () => {
    const f = vi.fn().mockImplementationOnce(treeSays({ category: cat({ other: 0.65 }) })).mockImplementationOnce(async () => { throw new TypeError("fetch failed"); });
    const h = triageHarness(f);
    const { run_id, input } = h.turn("帮我整理一下这周的待办");
    await h.worker.triageTurn(input);
    expect(handlerRow(h, run_id)).toMatchObject({ reask: "failed", p_first: 0.65 });
    expect(handlerRow(h, run_id)?.p).toBe(0.65); // the first answer stood
  });
});

describe("treeNear — every bar the lane rules use, confidence and gap included (senior W7)", () => {
  it("a category far from the choice bar but with confidence near minConf (0.7) re-asks under a confidence band", () => {
    const hash = criteriaHash(TREE_CATEGORY);
    const bands = [{ question: "category:confidence", criteriaHash: hash, model: "jev-1.13.0", band: 0.05, evidence: "t", approved: "t" }];
    const answer = (confidence: number) => ({ category: { type: "choice" as const, choice: "answer", probabilities: { answer: 0.9, other: 0.1 }, confidence } });
    expect(treeNear(TREE_QUESTIONS, bands)(answer(0.72), "jev-1.13.0")).toBe(true);
    expect(treeNear(TREE_QUESTIONS, bands)(answer(0.9), "jev-1.13.0")).toBe(false);
    const gap = [{ ...bands[0]!, question: "category:gap", band: 0.05 }];
    expect(treeNear(TREE_QUESTIONS, gap)({ category: { type: "choice", choice: "answer", probabilities: { answer: 0.74, other: 0.26 }, confidence: 0.9 } }, "jev-1.13.0")).toBe(true);
  });
});

describe("treeBarsFor (the bars each tree answer is compared against, tree-policy.ts)", () => {
  it("category: the choice bar, plus the lane bar of a memory or status choice", () => {
    expect(treeBarsFor("category", { type: "choice", choice: "other", probabilities: { other: 0.7 }, confidence: 0.5 })).toEqual([0.6]);
    expect(treeBarsFor("category", { type: "choice", choice: "memory", probabilities: { memory: 0.7 }, confidence: 0.5 })).toEqual([0.6, 0.85]);
    expect(treeBarsFor("sets_rule", { type: "noul", noul: 0.5 })).toEqual([0.8, 0.2]);
    expect(treeBarsFor("actions", { type: "score", score: 1, probabilities: { 0: 1 }, confidence: 1 })).toEqual([1.2, 2.5, 0.5, 1.5, 1.5]);
  });
});
