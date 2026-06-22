import { describe, expect, it } from "vitest";
import {
  buildGateBQuestion,
  GATE_B_DISCIPLINE,
  resolveGateBEnabled,
  resolveGateBPasses,
  resolveGateBThreshold,
  verifySkill
} from "../../src/capabilities/anchor-verify.js";
import type { AnchorLlm } from "../../src/capabilities/anchor-verify.js";

const GOOD = {
  when: "comparing numbers across multiple sources",
  body: "1. List each figure with its source. 2. Verify each. 3. Check no part exceeds its whole."
};
const BAD = {
  when: "answering a factual question",
  body: "1. Run one web search. 2. Take the FIRST result as truth. 3. State it confidently."
};

/** An llm that returns all-pass criteria for the good skill, all-fail for the bad one. */
function discriminatingLlm(): AnchorLlm {
  return async (_system, question) => {
    const allPass = '{"criteria":[{"text":"checks a primary source","ok":1},{"text":"sanity-checks figures","ok":1}]}';
    const allFail = '{"criteria":[{"text":"checks a primary source","ok":0},{"text":"avoids single unverified source","ok":0}]}';
    return question.includes("List each figure") ? allPass : allFail;
  };
}

describe("GATE_B_DISCIPLINE", () => {
  it("is independent, procedure-level, strict JSON (ported from the spike)", () => {
    expect(GATE_B_DISCIPLINE).toContain("INDEPENDENT skill auditor");
    expect(GATE_B_DISCIPLINE.toLowerCase()).toContain("quality criteria");
    expect(GATE_B_DISCIPLINE).toContain('{"criteria"');
  });
});

describe("buildGateBQuestion (D2 independence)", () => {
  it("passes ONLY the when + body — never the author's anchors", () => {
    const q = buildGateBQuestion(GOOD);
    expect(q).toContain(GOOD.when);
    expect(q).toContain("List each figure");
    expect(q).not.toContain("anchors");
  });
});

describe("verifySkill (3-pass ensemble)", () => {
  it("scores a good skill high (passed) and a bad skill low (not passed)", async () => {
    const llm = discriminatingLlm();
    const good = await verifySkill(GOOD, { passes: 3, threshold: 0.15 }, llm);
    const bad = await verifySkill(BAD, { passes: 3, threshold: 0.15 }, llm);
    expect(good.score).toBe(1);
    expect(good.passed).toBe(true);
    expect(bad.score).toBe(0);
    expect(bad.passed).toBe(false);
    // Failing criteria deduped across passes, for guided-refine.
    expect(bad.failing.length).toBeGreaterThan(0);
    expect(new Set(bad.failing).size).toBe(bad.failing.length);
  });

  it("averages 3 passes (mean of per-pass scores)", async () => {
    let call = 0;
    // pass 1: 1/2 ok; pass 2: 2/2 ok; pass 3: 0/2 ok → per-pass 0.5, 1.0, 0.0 → mean 0.5
    const oks = [
      '{"criteria":[{"text":"a","ok":1},{"text":"b","ok":0}]}',
      '{"criteria":[{"text":"a","ok":1},{"text":"b","ok":1}]}',
      '{"criteria":[{"text":"a","ok":0},{"text":"b","ok":0}]}'
    ];
    const llm: AnchorLlm = async () => oks[call++];
    const r = await verifySkill(GOOD, { passes: 3, threshold: 0.15 }, llm);
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.scoredPasses).toBe(3);
  });

  it("threshold boundary: score exactly at threshold passes", async () => {
    const llm: AnchorLlm = async () => '{"criteria":[{"text":"a","ok":1},{"text":"b","ok":0},{"text":"c","ok":0},{"text":"d","ok":0}]}';
    const r = await verifySkill(GOOD, { passes: 1, threshold: 0.25 }, llm);
    expect(r.score).toBeCloseTo(0.25, 5);
    expect(r.passed).toBe(true);
  });

  it("tolerates a parse failure on a pass (no throw; pass skipped) + one retry", async () => {
    let call = 0;
    const llm: AnchorLlm = async () => {
      call += 1;
      // pass 1 attempt 1: garbage, attempt 2: valid; pass 2: garbage twice (skipped); pass 3: valid
      if (call === 1) return "not json at all";
      if (call === 2) return '{"criteria":[{"text":"a","ok":1}]}';
      if (call === 3 || call === 4) return "still not json";
      return '{"criteria":[{"text":"a","ok":1}]}';
    };
    const r = await verifySkill(GOOD, { passes: 3, threshold: 0.15 }, llm);
    expect(r.scoredPasses).toBe(2); // pass 2 skipped
    expect(r.unscored).toBe(false);
    expect(r.score).toBe(1);
  });

  it("a thrown llm error is tolerated, never propagated", async () => {
    const llm: AnchorLlm = async () => {
      throw new Error("boom");
    };
    const r = await verifySkill(GOOD, { passes: 3, threshold: 0.15 }, llm);
    expect(r.unscored).toBe(true);
    expect(r.scoredPasses).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("every pass unparseable → unscored (caller falls back to advisory)", async () => {
    const llm: AnchorLlm = async () => "no json here";
    const r = await verifySkill(GOOD, { passes: 3, threshold: 0.15 }, llm);
    expect(r.unscored).toBe(true);
    expect(r.passed).toBe(false);
  });
});

describe("resolvers", () => {
  it("default passes 3 / threshold 0.15 / enabled on", () => {
    expect(resolveGateBPasses({})).toBe(3);
    expect(resolveGateBThreshold({})).toBe(0.15);
    expect(resolveGateBEnabled({})).toBe(true);
  });
  it("env overrides", () => {
    expect(resolveGateBPasses({ HOUGE_GATE_B_PASSES: "5" } as NodeJS.ProcessEnv)).toBe(5);
    expect(resolveGateBThreshold({ HOUGE_GATE_B_THRESHOLD: "0.3" } as NodeJS.ProcessEnv)).toBe(0.3);
    expect(resolveGateBEnabled({ HOUGE_GATE_B_ENABLED: "off" } as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveGateBEnabled({ HOUGE_GATE_B_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
