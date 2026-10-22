import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agreementOf, answerBucket, laneLabelCounts, laneOfKey, routeEffectKey } from "../../src/decisions/jev-version-check.js";
import { TREE_ACTIONS, TREE_CATEGORY, TREE_SETS_RULE } from "../../src/jev/questions/tree.js";
import { choiceAns, noulAns, scoreAns, treeAnswers } from "../helpers/jev-tree-answers.js";
import { CATEGORIES } from "../../src/jev/questions/tree.js";

// The agreement formulas (spec §2.5) live in one module so the anchor baselines (Task 4) and the candidate check (Task 5)
// cannot drift apart: a bucket is what two runs are compared on, a route key is the full route effect.
const CASES = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "jev-anchor", "route-cases.json"), "utf8")) as
  Array<{ name: string; state: Record<string, unknown>; category: string; setsRule: number; actions?: number; lane: string }>;

describe("answerBucket", () => {
  it("a choice is its top option, a noul its zone across today's bars, a score its level bucket", () => {
    expect(answerBucket(TREE_CATEGORY, choiceAns(CATEGORIES, "memory", 0.9))).toBe("memory");
    expect([0.9, 0.5, 0.1].map((p) => answerBucket(TREE_SETS_RULE, noulAns(p)))).toEqual(["yes", "unsure", "no"]);
    expect([0, 1, 2, 3].map((l) => answerBucket(TREE_ACTIONS, scoreAns(l)))).toEqual(["light", "light", "standard", "heavy"]);
  });
  it("a missing answer or another type has no bucket (it never counts as agreement)", () => {
    expect(answerBucket(TREE_CATEGORY, undefined)).toBeNull();
    expect(answerBucket(TREE_CATEGORY, noulAns(0.5))).toBeNull();
  });
});

describe("agreementOf", () => {
  it("counts only pairs where both sides answered", () => {
    expect(agreementOf([["a", "a"], ["a", "b"], [null, "a"], ["c", null]])).toEqual({ agree: 1, n: 2 });
  });
});

describe("routeEffectKey", () => {
  for (const c of CASES) {
    it(`${c.name}: lands in lane ${c.lane}`, () => {
      expect(laneOfKey(routeEffectKey(c.state, treeAnswers({ category: c.category, setsRule: c.setsRule, ...(c.actions !== undefined ? { actions: c.actions } : {}) })))).toBe(c.lane);
    });
  }
  it("two answer sets with the same top option but another save or role are different route effects", () => {
    const s = CASES[0]!.state;
    expect(routeEffectKey(s, treeAnswers({ category: "memory", setsRule: 0.95 }))).not.toBe(routeEffectKey(s, treeAnswers({ category: "memory", setsRule: 0.95, actions: 3 })));
  });
});

describe("laneLabelCounts", () => {
  it("counts wrong routes into a lane and labelled turns routed to their lane, unlabelled turns not at all", () => {
    const k = (lane: string): string => `x/${lane}/default/-/-/`;
    const c = laneLabelCounts([
      { routeKey: k("memory"), label: "memory" }, { routeKey: k("memory"), label: "answer" }, { routeKey: k("planner"), label: "memory" },
      { routeKey: k("memory"), label: undefined }
    ]);
    expect(c.memory).toEqual({ wrong: 1, recall: 1, labelled: 2 });
    expect(c.answer).toEqual({ wrong: 0, recall: 0, labelled: 1 });
  });
});
