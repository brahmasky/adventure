import { describe, expect, it } from "vitest";
import {
  agreementByCheck, CHECK_IDS, checkOutcome, DISARMABLE_LANES, judge, laneCountsOf, parseDriftDetail, ROUTE_CHECK_ID, slack,
  type Agreement, type CheckInput, type CheckRun, type CheckVerdict, type DisarmableLane, type LaneLabelCount
} from "../../src/decisions/jev-version-check.js";
import type { JevAnswer } from "../../src/jev/jev-client.js";
import { TREE_QUESTIONS } from "../../src/jev/questions/tree.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";

// Jev version check spec §2.5: a Jev version move is judged by code against Paco's approved anchor. A check that is too
// loose arms a model that routes Paco's turns differently; one that is too tight pages him on Jev's own day-to-day noise.
// These fixtures pin each rule against numbers on both sides of its bar.

const N = 300;
const STATE = { latest_message: "帮我看一下", last_houge_turn: null, quoted_turn: null };
/** Planner categories: a flip changes the category bucket and the route's category field. */
const CATS = ["research", "wiki", "machine_task", "schedule", "self_change"] as const;
const turnId = (i: number): string => `t${String(i).padStart(3, "0")}`;
const run = (f: (i: number) => Record<string, JevAnswer>, n = N): CheckRun =>
  new Map(Array.from({ length: n }, (_, i) => [turnId(i), { state: STATE, answers: f(i) }]));
const base = (i: number): Record<string, JevAnswer> => treeAnswers({ category: CATS[i % CATS.length]! });
const flipped = (i: number): Record<string, JevAnswer> => treeAnswers({ category: CATS[(i + 1) % CATS.length]! });
/** `base` with the category flipped on the first `k` turns. */
const flipFirst = (k: number) => (i: number): Record<string, JevAnswer> => (i < k ? flipped(i) : base(i));

// Task 4's anchor baselines (Paco's import, 2026-10-22): A vs B per check, and the label counts of runs A and B.
const ANCHOR_AB: Record<string, Agreement> = {
  category: { agree: 275, n: 301 }, sets_rule: { agree: 297, n: 301 }, rule_scope: { agree: 295, n: 301 },
  breadth: { agree: 289, n: 301 }, reasoning: { agree: 288, n: 301 }, actions: { agree: 295, n: 301 }, route: { agree: 222, n: 301 }
};
const lanes = (m: [number, number, number], s: [number, number, number], a: [number, number, number], l: [number, number, number]): Record<DisarmableLane, LaneLabelCount> => {
  const c = ([wrong, recall, labelled]: [number, number, number]): LaneLabelCount => ({ wrong, recall, labelled });
  return { memory: c(m), status: c(s), answer: c(a), lookup: c(l) };
};
const ANCHOR_LANES = { A: lanes([0, 11, 25], [0, 2, 8], [3, 6, 23], [0, 7, 14]), B: lanes([0, 9, 25], [0, 1, 8], [3, 6, 23], [0, 7, 14]) };
const full = (n = 301): Record<string, Agreement> => Object.fromEntries(CHECK_IDS.map((id) => [id, { agree: n, n }]));

/** A candidate that is the anchor itself: every agreement at the anchor's level, label counts as run A. */
function input(o: Partial<CheckInput> = {}): CheckInput {
  return { anchorAB: ANCHOR_AB, anchorLanes: ANCHOR_LANES, candVsAnchor: full(), candSelf: full(), candAB: ANCHOR_AB, candLanes: ANCHOR_LANES.A, ...o };
}

describe("slack(n, p) = max(0.05, 2.7 · sqrt(p(1−p)/n))", () => {
  it("is the floor when the sample is large or the rate is extreme", () => {
    expect(slack(301, 1)).toBe(0.05);
    expect(slack(301, 0.9136)).toBe(0.05); // 2.7 · 0.0162 = 0.0437 < 0.05
  });
  it("grows past the floor on a noisy check or a small sample", () => {
    expect(slack(301, 0.7375)).toBeCloseTo(2.7 * Math.sqrt((0.7375 * 0.2625) / 301), 10); // ≈ 0.0685, the route check
    expect(slack(30, 0.5)).toBeCloseTo(2.7 * Math.sqrt(0.25 / 30), 10);
  });
  it("no sample is no bound: NaN, so any comparison against it is false (the judge fails such a check, never passes it on no evidence)", () => {
    expect(slack(0, 0.9)).toBeNaN();
    expect(slack(-1, 0.9)).toBeNaN();
    expect(0.5 >= 0.9 - slack(0, 0.9)).toBe(false); // a caller that forgot the n guard still cannot pass on no evidence
  });
  it("the slack follows the observed side's n: diverging n gives a different bound", () => {
    expect(slack(30, 0.8)).toBeGreaterThan(slack(300, 0.8));
  });
});

describe("agreementByCheck: six questions and the route, over the turns both runs have", () => {
  it("counts one bucket per question and one route effect per turn", () => {
    const g = agreementByCheck(run(base), run(flipFirst(30)));
    expect(Object.keys(g).sort()).toEqual([...CHECK_IDS].sort());
    expect(g.category).toEqual({ agree: 270, n: 300 });
    expect(g[ROUTE_CHECK_ID]).toEqual({ agree: 270, n: 300 });
    for (const q of TREE_QUESTIONS.filter((x) => x.id !== "category")) expect(g[q.id]).toEqual({ agree: 300, n: 300 });
  });
  it("a turn only one run has is not compared", () => {
    expect(agreementByCheck(run(base), run(base, 250)).category).toEqual({ agree: 250, n: 250 });
  });
  // The route check sees what no question sees: the same top option on either side of the memory lane's bar.
  it("the same buckets with another route effect agree on every question and disagree on the route", () => {
    const mem = (p: number) => (): Record<string, JevAnswer> => treeAnswers({ category: "memory", p, setsRule: 0.95 });
    const g = agreementByCheck(run(mem(0.9), 10), run(mem(0.7), 10));
    expect(g.category).toEqual({ agree: 10, n: 10 });
    expect(g[ROUTE_CHECK_ID]).toEqual({ agree: 0, n: 10 });
  });
});

describe("laneCountsOf: Paco's labels against one run's routes", () => {
  it("counts wrong routes into a lane and labelled turns routed to it", () => {
    const r = run((i) => treeAnswers({ category: i < 2 ? "memory" : "research", setsRule: 0.95 }), 4);
    const c = laneCountsOf(r, (t) => (t === "t000" || t === "t002" ? "memory" : t === "t001" ? "answer" : undefined));
    expect(c.memory).toEqual({ wrong: 1, recall: 1, labelled: 2 });
  });
});

describe("judge check a: close to the anchor (agreement with the anchor ≥ the candidate's own self-agreement − slack)", () => {
  const cand = (k: number): CheckInput => {
    const anchorA = run(base);
    const candA = run(flipFirst(k));
    const candA2 = run((i) => (i >= N - 6 ? flipped(i) : flipFirst(k)(i))); // self-agreement 294/300 = 0.98 on category
    return input({ candVsAnchor: agreementByCheck(candA, anchorA), candSelf: agreementByCheck(candA, candA2) });
  };
  it("a 10 % category flip fails category (and the route, which carries the category)", () => {
    const v = judge(cand(30));
    expect(v.failed_questions).toEqual(["category"]);
    expect(v.route_failed).toBe(true);
    expect(v.pass).toBe(false);
    expect(v.margins.category!.a).toBeLessThan(0);
  });
  it("a 3 % flip is inside Jev's own noise and passes", () => {
    const v = judge(cand(9));
    expect(v).toMatchObject({ pass: true, failed_questions: [], route_failed: false, lanes_disarmed: [] });
    expect(v.margins.category!.a).toBeGreaterThanOrEqual(0);
  });
});

describe("judge check b: not noisier than the anchor (candidate A vs B ≥ anchor A vs B − slack)", () => {
  it("a candidate whose permuted run agrees on 240/301 categories (anchor 275) fails category", () => {
    const v = judge(input({ candAB: { ...ANCHOR_AB, category: { agree: 240, n: 301 } } }));
    expect(v.failed_questions).toEqual(["category"]);
    expect(v.route_failed).toBe(false);
    expect(v.margins.category!.b).toBeLessThan(0);
  });
  it("265/301 is within the slack and passes", () => {
    expect(judge(input({ candAB: { ...ANCHOR_AB, category: { agree: 265, n: 301 } } })).pass).toBe(true);
  });
  it("the route check's own noise (222/301) earns a wider slack than the floor", () => {
    expect(judge(input({ candAB: { ...ANCHOR_AB, route: { agree: 205, n: 301 } } })).route_failed).toBe(false); // 0.681 ≥ 0.7375 − 0.0685
    expect(judge(input({ candAB: { ...ANCHOR_AB, route: { agree: 195, n: 301 } } })).route_failed).toBe(true);
  });
  it("a check with no compared turns fails (no zero-denominator pass)", () => {
    const v = judge(input({ candAB: { ...ANCHOR_AB, breadth: { agree: 0, n: 0 } } }));
    expect(v.failed_questions).toEqual(["breadth"]);
    expect(v.margins.breadth!.b).toBeNull();
  });
});

describe("judge: a route failure disarms the whole tree (spec §2.5 d)", () => {
  // Same buckets, another route: memory p 0.9 (lane) vs p 0.7 (planner, below the memory bar) on 30 turns.
  const routeOnly = (): CheckInput => {
    const m = (p: number) => (i: number): Record<string, JevAnswer> => (i < 30 ? treeAnswers({ category: "memory", p, setsRule: 0.95 }) : base(i));
    const cA = run(m(0.7));
    return input({ candVsAnchor: agreementByCheck(cA, run(m(0.9))), candSelf: agreementByCheck(cA, run(m(0.7))) });
  };
  it("route alone → route_failed, no question failed", () => {
    const v = judge(routeOnly());
    expect(v).toMatchObject({ pass: false, route_failed: true, failed_questions: [] });
  });
  it("route with a question failure → route_failed and the question named", () => {
    const i = routeOnly();
    const v = judge({ ...i, candAB: { ...ANCHOR_AB, category: { agree: 200, n: 301 } } });
    expect(v).toMatchObject({ route_failed: true, failed_questions: ["category"] });
  });
});

describe("judge check c: Paco's labels as allowed counts", () => {
  // Spec §2.5 c: the anchor's own run B must pass against its run A.
  it("the anchor's own B run passes check c", () => {
    const v = judge(input({ candLanes: ANCHOR_LANES.B }));
    expect(v.lanes_disarmed).toEqual([]);
    expect(v.recall_drops).toEqual([]);
    expect(v.pass).toBe(true);
  });
  it("wrong routes into a lane above the anchor's + 1 disarm that lane only", () => {
    const v = judge(input({ candLanes: { ...ANCHOR_LANES.A, answer: { wrong: 5, recall: 6, labelled: 23 } } }));
    expect(v.lanes_disarmed).toEqual(["answer"]);
    expect(v.failed_questions).toEqual([]);
    expect(v.route_failed).toBe(false);
    expect(judge(input({ candLanes: { ...ANCHOR_LANES.A, answer: { wrong: 4, recall: 6, labelled: 23 } } })).lanes_disarmed).toEqual([]);
  });
  // Spec §2.5 c / §7 (Rev 3.1 onward): losing recall is the safe direction, so a lane the candidate stops routing to keeps
  // its arming; the numbers go into the outcome notice. (Rev 3's "a lane the anchor used that the candidate never routes
  // to fails" was removed by Rev 3.1.)
  it("zero routes into a lane the anchor used: a recall drop in the notice data, the lane stays armed", () => {
    const v = judge(input({ candLanes: { ...ANCHOR_LANES.A, memory: { wrong: 0, recall: 0, labelled: 25 } } }));
    expect(v.lanes_disarmed).toEqual([]);
    expect(v.pass).toBe(true);
    expect(v.recall_drops).toEqual([{ lane: "memory", anchor: 11, candidate: 0, allowed: 3, labelled: 25 }]);
  });
  it("a recall drop counts against max(2, the anchor's own A-vs-B gap + 1)", () => {
    const m = (recall: number): CheckVerdict => judge(input({ candLanes: { ...ANCHOR_LANES.A, memory: { wrong: 0, recall, labelled: 25 } } }));
    expect(m(8).recall_drops).toEqual([]); // 11 − max(2, 2 + 1) = 8
    expect(m(7).recall_drops).toHaveLength(1);
    const s = (recall: number): CheckVerdict => judge(input({ candLanes: { ...ANCHOR_LANES.A, answer: { wrong: 3, recall, labelled: 23 } } }));
    expect(s(4).recall_drops).toEqual([]); // gap 0 → allowance 2
    expect(s(3).recall_drops).toEqual([{ lane: "answer", anchor: 6, candidate: 3, allowed: 2, labelled: 23 }]);
  });
  it("a lane Paco labelled no turn for has no recall to drop", () => {
    const none = lanes([0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]);
    expect(judge(input({ anchorLanes: { A: none, B: none }, candLanes: none })).recall_drops).toEqual([]);
  });
});

describe("checkOutcome: the state and detail the check writes (spec §2.5 d)", () => {
  it("a pass is trusted, with the margins and any recall drop", () => {
    const o = checkOutcome(judge(input({ candLanes: { ...ANCHOR_LANES.A, memory: { wrong: 0, recall: 0, labelled: 25 } } })));
    expect(o.state).toBe("trusted");
    const d = JSON.parse(o.detail_json) as Record<string, unknown>;
    expect(d.recall_drops).toHaveLength(1);
    expect(Object.keys(d.margins as object).sort()).toEqual([...CHECK_IDS].sort());
  });
  it("a failure is drifted, and the arming read can parse it", () => {
    const o = checkOutcome(judge(input({ candAB: { ...ANCHOR_AB, category: { agree: 240, n: 301 } } })));
    expect(o.state).toBe("drifted");
    expect(parseDriftDetail(o.detail_json)).toEqual({ failed_questions: ["category"], route_failed: false, lanes_disarmed: [] });
  });
  // Task 3 review: a drifted row with nothing failed would arm the whole tree like a trusted one, silently.
  it("never writes a drifted detail that names nothing failed, whatever the verdict claims", () => {
    const empty: CheckVerdict = { pass: false, failed_questions: [], route_failed: false, lanes_disarmed: [], recall_drops: [], margins: {} };
    expect(checkOutcome(empty).state).toBe("trusted");
    const verdicts: CheckVerdict[] = [
      judge(input()), judge(input({ candLanes: ANCHOR_LANES.B })), judge(input({ candAB: { ...ANCHOR_AB, route: { agree: 100, n: 301 } } })),
      judge(input({ candLanes: { ...ANCHOR_LANES.A, lookup: { wrong: 9, recall: 7, labelled: 14 } } })), empty
    ];
    for (const v of verdicts) {
      const o = checkOutcome(v);
      if (o.state !== "drifted") continue;
      const d = parseDriftDetail(o.detail_json)!;
      expect(d.failed_questions.length + d.lanes_disarmed.length + (d.route_failed ? 1 : 0)).toBeGreaterThan(0);
    }
  });
  it("a lane disarm reaches the arming read as a disarmable lane", () => {
    const o = checkOutcome(judge(input({ candLanes: { ...ANCHOR_LANES.A, lookup: { wrong: 9, recall: 7, labelled: 14 } } })));
    expect(o.state).toBe("drifted");
    expect(parseDriftDetail(o.detail_json)!.lanes_disarmed.every((l) => (DISARMABLE_LANES as readonly string[]).includes(l))).toBe(true);
  });
});

// Final fix G7 (testing Minor): each rule pinned at its edge, so an EPS, `<` vs `<=`, n/p swap or A/B mix-up mutant fails.
describe("the check's edges (final fix G7)", () => {
  const with1 = (id: string, g: Agreement): Record<string, Agreement> => ({ ...full(), [id]: g });
  it("a margin of exactly 0 passes; one a millionth below fails", () => {
    const at = (agree: number) => judge(input({ candVsAnchor: with1("category", { agree, n: 1_000_000 }), candSelf: with1("category", { agree: 1_000_000, n: 1_000_000 }) }));
    expect(at(950_000).margins.category!.a).toBe(0);
    expect(at(950_000).failed_questions).toEqual([]);
    expect(at(949_999).failed_questions).toEqual(["category"]);
  });
  it("the slack takes the reference's rate: with the observed rate instead the same numbers would pass", () => {
    const v = judge(input({ candVsAnchor: with1("category", { agree: 93, n: 100 }), candSelf: with1("category", { agree: 99, n: 100 }) }));
    expect(v.failed_questions).toEqual(["category"]); // 0.93 < 0.99 − max(0.05, 2.7·sqrt(0.99·0.01/100)) = 0.94
    expect(0.93 >= 0.99 - slack(100, 0.93)).toBe(true); // the swapped formula would have passed it
  });
  it("the slack takes the observed side's n: with the reference's n the same numbers would fail", () => {
    const v = judge(input({ candVsAnchor: with1("category", { agree: 34, n: 50 }), candSelf: with1("category", { agree: 8000, n: 10_000 }) }));
    expect(v.failed_questions).toEqual([]); // 0.68 ≥ 0.8 − slack(50, 0.8) ≈ 0.647
    expect(0.68 >= 0.8 - slack(10_000, 0.8)).toBe(false);
  });
  it("check c on the status lane: anchor + 1 wrong routes passes, + 2 disarms", () => {
    const cand = (wrong: number) => ({ ...ANCHOR_LANES.A, status: { wrong, recall: 2, labelled: 8 } });
    expect(judge(input({ candLanes: cand(1) })).lanes_disarmed).toEqual([]);
    expect(judge(input({ candLanes: cand(2) })).lanes_disarmed).toEqual(["status"]);
  });
  it("check c compares with the anchor's run A only, even when its run B had more wrong routes", () => {
    const anchorLanes = { A: ANCHOR_LANES.A, B: { ...ANCHOR_LANES.B, lookup: { wrong: 5, recall: 7, labelled: 14 } } };
    expect(judge(input({ anchorLanes, candLanes: { ...ANCHOR_LANES.A, lookup: { wrong: 2, recall: 7, labelled: 14 } } })).lanes_disarmed).toEqual(["lookup"]);
  });
  it("the recall allowance uses the anchor's A-vs-B gap either way round (B above A)", () => {
    const anchorLanes = { A: { ...ANCHOR_LANES.A, memory: { wrong: 0, recall: 9, labelled: 25 } }, B: { ...ANCHOR_LANES.B, memory: { wrong: 0, recall: 13, labelled: 25 } } };
    const drops = (recall: number) => judge(input({ anchorLanes, candLanes: { ...anchorLanes.A, memory: { wrong: 0, recall, labelled: 25 } } })).recall_drops;
    expect(drops(4)).toEqual([]); // allowed max(2, |9 − 13| + 1) = 5
    expect(drops(3)).toEqual([{ lane: "memory", anchor: 9, candidate: 3, allowed: 5, labelled: 25 }]);
  });
  it("a question failing both a and b is listed once; the route failing a alone or b alone fails the route", () => {
    const low = { agree: 50, n: 100 };
    const both = judge(input({ candVsAnchor: with1("category", low), candAB: { ...ANCHOR_AB, category: low } }));
    expect(both.failed_questions).toEqual(["category"]);
    expect(judge(input({ candVsAnchor: with1(ROUTE_CHECK_ID, low) })).route_failed).toBe(true);
    expect(judge(input({ candAB: { ...ANCHOR_AB, [ROUTE_CHECK_ID]: low } })).route_failed).toBe(true);
    expect(judge(input({ candAB: { ...ANCHOR_AB, [ROUTE_CHECK_ID]: low } })).failed_questions).toEqual([]);
  });
});
