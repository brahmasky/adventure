import { describe, expect, it } from "vitest";
import type { CalibrationRow } from "../../src/jev/calibration.js";
import { JEV_REQUEST_MODEL, type JevAnswer, type JevChoiceAnswer } from "../../src/jev/jev-client.js";
import { CATEGORIES, TREE_CATEGORY, TREE_QUESTIONS, type Category, type LastHougeTurn } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import {
  ACK_ROUTE, applyCascade, fallbackRoute, preJudge, routeTree, thinkHarderIn, TREE_BAR_DEFAULTS, TREE_STATUS_ARM_ID, treeArmed,
  treeArmingRows, type Armed, type Route, type RoutePlan
} from "../../src/jev/tree-policy.js";

/** The versioned id a Jev response reports. Calibration keys on it; the request names the moving alias (JEV_REQUEST_MODEL). */
const REPORTED = "jev-1.13.0";

// Spec §2.4 / §9 "Policy as a table": answers → lane, role, effort. Every bar is tested at its edge because a wrong
// side of a bar either swallows a turn into a no-planner lane (memory / status) or under-powers a turn that changes
// the machine. A test that still passed with a bar moved by 0.01 would prove nothing.
const n = CATEGORIES.length;
/** A category answer: the given probabilities, the rest split evenly; confidence by Jev's documented formula unless given. */
function cat(p: Partial<Record<Category, number>>, confidence?: number): JevChoiceAnswer {
  const used = Object.values(p).reduce((a, b) => a + (b ?? 0), 0);
  const rest = CATEGORIES.filter((c) => p[c] === undefined);
  const probabilities = Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? (1 - used) / rest.length]));
  const [choice, pMax] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice, probabilities, confidence: confidence ?? (pMax - 1 / n) / (1 - 1 / n) };
}
/** Exactly these probabilities, every other category 0 (for the cascade's zero / one candidate cases). */
const only = (p: Partial<Record<Category, number>>): JevChoiceAnswer => cat(Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? 0])));
const scope = (ask: number): JevChoiceAnswer =>
  ({ type: "choice", choice: ask >= 0.5 ? "ask" : "research", probabilities: { ask, research: 1 - ask }, confidence: Math.abs(2 * ask - 1) });
const score = (s: number): JevAnswer => ({ type: "score", score: s, probabilities: { "0": 0.25, "1": 0.25, "2": 0.25, "3": 0.25 }, confidence: 0.5 });
const noul = (p: number): JevAnswer => ({ type: "noul", noul: p });
interface A { category: JevChoiceAnswer; sets_rule?: number; ask?: number; breadth?: number; reasoning?: number; actions?: number }
const answers = (a: A): Record<string, JevAnswer> => ({
  category: a.category, sets_rule: noul(a.sets_rule ?? 0.05), rule_scope: scope(a.ask ?? 0.9),
  breadth: score(a.breadth ?? 1), reasoning: score(a.reasoning ?? 1), actions: score(a.actions ?? 0)
});
const ALL: Armed = { category: true, status: true, memory: true, gear: true, rule: true };
type Opts = Partial<{ armed: Partial<Armed>; thinkHarder: boolean; bareAck: boolean }>;
const plan = (a: A, o: Opts = {}): RoutePlan =>
  routeTree(answers(a), { bars: TREE_BAR_DEFAULTS, armed: { ...ALL, ...o.armed }, thinkHarder: o.thinkHarder ?? false, bareAck: o.bareAck ?? false });
const route = (a: A, o: Opts = {}): Route => {
  const p = plan(a, o);
  if (p.kind !== "final") throw new Error(`expected a final route, got a cascade between ${p.between.join("/")}`);
  return p.route;
};

describe("TREE_BAR_DEFAULTS (spec §2.4)", () => {
  it("are the spec's numbers", () => {
    expect(TREE_BAR_DEFAULTS).toEqual({ choice: 0.6, nounYes: 0.8, nounNo: 0.2, memory: 0.85, status: 0.8, minConf: 0.7, minGap: 0.5,
      ruleScope: 0.6, gearLight: 1.2, gearHeavy: 2.5 });
  });
});

describe("routeTree — gear and effort (the routed role is the visible change of stage A)", () => {
  it.each([
    ["1.2 is light", 1.2, "fast"],
    ["0.8 + 0.4 (1.2000000000000002 in floating point) is still light", 0.8 + 0.4, "fast"],
    ["1.21 is standard", 1.21, "default"],
    ["2.49 is standard", 2.49, "default"],
    ["2.5 is heavy", 2.5, "thinking"]
  ] as const)("max score: %s", (_name, s, role) => {
    expect(route({ category: cat({ answer: 0.9 }), breadth: s, reasoning: 0, actions: 0 }).role).toBe(role);
  });
  it("the gear is the HIGHEST of the three scores, not the reasoning score", () => {
    expect(route({ category: cat({ answer: 0.9 }), breadth: 0, reasoning: 0, actions: 2.6 })).toMatchObject({ role: "thinking", effort: "low" });
  });
  it.each([[1.2, "low"], [1.21, "medium"], [2.49, "medium"], [2.5, "high"]] as const)("effort: reasoning %s → %s", (r, effort) => {
    expect(route({ category: cat({ answer: 0.9 }), breadth: 0, reasoning: r, actions: 0 }).effort).toBe(effort);
  });
  it("gear unarmed: Default with no effort (the list's own effort applies)", () => {
    expect(route({ category: cat({ answer: 0.9 }), breadth: 3 }, { armed: { gear: false } })).toMatchObject({ role: "default", effort: null, reason: "routed" });
  });
  it("think harder: Thinking whatever the gear, the effort reading kept", () => {
    expect(route({ category: cat({ answer: 0.9 }), breadth: 0, reasoning: 0 }, { thinkHarder: true })).toMatchObject({ role: "thinking", effort: "low", thinkHarder: true });
  });
});

describe("routeTree — role floors (spec §3: self_change / machine_task / schedule / mail_calendar never below Default)", () => {
  it.each([
    ["answer", "fast"], ["lookup", "fast"], ["research", "thinking"], ["self_change", "default"], ["machine_task", "default"],
    ["schedule", "default"], ["wiki", "default"], ["mail_calendar", "default"], ["other", "default"]
  ] as const)("%s on a light gear runs on %s", (c, role) => {
    expect(route({ category: cat({ [c]: 0.9 }), breadth: 0, reasoning: 0, actions: 0 })).toMatchObject({ category: c, lane: "planner", role, reason: "routed" });
  });
  it("a heavy gear lifts a Fast-floor category", () => {
    expect(route({ category: cat({ lookup: 0.9 }), breadth: 2.7 }).role).toBe("thinking");
  });
});

describe("routeTree — the choice bar", () => {
  it("p 0.6 counts", () => {
    expect(route({ category: cat({ self_change: 0.6 }) })).toMatchObject({ category: "self_change", reason: "routed", role: "default" });
  });
  it("p 0.59 goes to the cascade between the top two", () => {
    // the rest split evenly: ties keep option order, so "answer" (first in CATEGORIES) is the runner-up
    expect(plan({ category: cat({ self_change: 0.59 }) })).toMatchObject({ kind: "cascade", between: ["self_change", "answer"] });
  });
});

describe("routeTree — memory (a wrong `memory` swallows the turn: the strictest bars)", () => {
  const raw = (p: Partial<Record<Category, number>>, confidence: number): JevChoiceAnswer =>
    ({ type: "choice", choice: "memory", probabilities: Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? 0])), confidence });
  it.each([
    ["p 0.85 + sets_rule 0.8: the memory lane saves and ends at the card", { category: cat({ memory: 0.85 }), sets_rule: 0.8 },
      { category: "memory", lane: "memory", save: { scope: "ask" }, reason: "routed" }],
    ["p 0.84 + a rule: planner below_bar, the rule still saves first", { category: cat({ memory: 0.84 }), sets_rule: 0.8 },
      { lane: "planner", role: "default", effort: null, save: { scope: "ask" }, reason: "below_bar" }],
    ["sets_rule 0.79 is unsure = no: a correction for the planner, nothing saved", { category: cat({ memory: 0.9 }), sets_rule: 0.79 },
      { lane: "planner", role: "default", effort: null, save: null, reason: "correction" }],
    ["sets_rule 0.21 is unsure: a correction", { category: cat({ memory: 0.9 }), sets_rule: 0.21 }, { save: null, reason: "correction" }],
    ["sets_rule 0.2 is no: a correction", { category: cat({ memory: 0.9 }), sets_rule: 0.2 }, { save: null, reason: "correction" }],
    ["confidence 0.69 is under the floor", { category: cat({ memory: 0.9 }, 0.69), sets_rule: 0.9 }, { lane: "planner", reason: "below_bar" }],
    ["confidence 0.7 clears", { category: cat({ memory: 0.9 }, 0.7), sets_rule: 0.9 }, { lane: "memory" }],
    // Jev's probabilities sum to 1, so at p ≥ 0.85 the gap floor cannot bind; it is defensive and still enforced
    ["gap 0.49 (an unnormalised answer) is under the floor", { category: raw({ memory: 0.85, other: 0.36 }, 0.9), sets_rule: 0.9 }, { reason: "below_bar" }],
    ["gap 0.85 − 0.35 (0.4999… in floating point) clears", { category: raw({ memory: 0.85, other: 0.35 }, 0.9), sets_rule: 0.9 }, { lane: "memory" }]
  ] as const)("%s", (_name, a, expected) => {
    expect(route(a as A)).toMatchObject(expected);
  });
  it("memory unarmed: planner, Default, uncalibrated, nothing saved", () => {
    expect(route({ category: cat({ memory: 0.95 }), sets_rule: 0.95 }, { armed: { memory: false } }))
      .toMatchObject({ category: "memory", lane: "planner", role: "default", save: null, reason: "uncalibrated" });
  });
  it("rule unarmed: the memory lane never acts, even on a hand-built Armed that says memory", () => {
    // the lane exists to save a rule; without the rule rows it would save on an answer nobody calibrated
    expect(route({ category: cat({ memory: 0.95 }), sets_rule: 0.95 }, { armed: { rule: false } }))
      .toMatchObject({ category: "memory", lane: "planner", save: null, reason: "uncalibrated" });
  });
});

describe("routeTree — sets_rule with any category (save, then that category's handler)", () => {
  it("a rule on a lookup saves first and the planner runs on the lookup's role", () => {
    expect(route({ category: cat({ lookup: 0.9 }), sets_rule: 0.95, breadth: 0, reasoning: 0 }))
      .toMatchObject({ category: "lookup", lane: "planner", role: "fast", save: { scope: "ask" }, reason: "routed" });
  });
  it("unsure saves nothing", () => {
    expect(route({ category: cat({ lookup: 0.9 }), sets_rule: 0.5 }).save).toBeNull();
  });
  it("rule rows unarmed: the turn still routes, nothing saves (an unread answer is never acted on)", () => {
    expect(route({ category: cat({ lookup: 0.9 }), sets_rule: 0.95, breadth: 0, reasoning: 0 }, { armed: { rule: false, memory: false } }))
      .toMatchObject({ category: "lookup", role: "fast", save: null, reason: "routed" });
  });
  it.each([
    ["memory, rule_scope research 0.6 overrides the default ask", { category: cat({ memory: 0.9 }), sets_rule: 0.9, ask: 0.4 }, "research"],
    ["memory, research 0.59 is under the bar: the default ask", { category: cat({ memory: 0.9 }), sets_rule: 0.9, ask: 0.41 }, "ask"],
    ["research, ask 0.59 is under the bar: the default research", { category: cat({ research: 0.9 }), sets_rule: 0.9, ask: 0.59 }, "research"],
    ["research, ask 0.6 overrides the default research", { category: cat({ research: 0.9 }), sets_rule: 0.9, ask: 0.6 }, "ask"]
  ] as const)("rule_scope: %s", (_name, a, s) => {
    expect(route(a as A).save).toEqual({ scope: s });
  });
});

describe("routeTree — status (its own arming row; a wrong status swallows the turn)", () => {
  it("p 0.8 → the status lane", () => {
    expect(route({ category: cat({ status: 0.8 }) })).toMatchObject({ category: "status", lane: "status", reason: "routed", save: null });
  });
  it("p 0.79 → planner below_bar", () => {
    expect(route({ category: cat({ status: 0.79 }) })).toMatchObject({ category: "status", lane: "planner", role: "default", reason: "below_bar" });
  });
  it("status row unarmed, category armed: planner uncalibrated", () => {
    expect(route({ category: cat({ status: 0.9 }) }, { armed: { status: false } })).toMatchObject({ lane: "planner", reason: "uncalibrated" });
  });
  it("status + rule armed, category and gear unarmed: the lane acts; under its bar it is the plain fallback", () => {
    const statusOnly = { armed: { category: false, memory: false, gear: false } };
    expect(route({ category: cat({ status: 0.8 }) }, statusOnly).lane).toBe("status");
    expect(route({ category: cat({ status: 0.79 }) }, statusOnly)).toEqual(fallbackRoute("uncalibrated", false));
  });
  it("status armed but the rule rows not: the lane does NOT act (a stated rule would be swallowed by a code reply)", () => {
    // F6: sets_rule = yes with any category saves (spec §3); unarmed, we cannot read it, so the planner answers
    expect(route({ category: cat({ status: 0.95 }), sets_rule: 0.95 }, { armed: { rule: false, memory: false } }))
      .toMatchObject({ category: "status", lane: "planner", role: "default", save: null, reason: "uncalibrated" });
    expect(route({ category: cat({ status: 0.95 }) }, { armed: { rule: false, memory: false, category: false } }))
      .toEqual(fallbackRoute("uncalibrated", false));
  });
  it("a rule inside a status question saves and goes to the planner (the lane answers status and nothing else)", () => {
    expect(route({ category: cat({ status: 0.9 }), sets_rule: 0.9 })).toMatchObject({ category: "status", lane: "planner", save: { scope: "ask" }, reason: "routed" });
  });
  it("status under the choice bar cascades without status", () => {
    expect(plan({ category: cat({ status: 0.5, lookup: 0.3 }) })).toMatchObject({ kind: "cascade", between: ["lookup", "answer"] });
  });
});

describe("routeTree — the bare-ack guard (an ack never enters memory or status)", () => {
  it.each([
    ["memory with a rule", { category: cat({ memory: 0.95 }), sets_rule: 0.95 }],
    ["status", { category: cat({ status: 0.95 }) }]
  ] as const)("%s → planner bare_ack_guard, nothing saved", (_n, a) => {
    expect(route(a as A, { bareAck: true })).toMatchObject({ lane: "planner", role: "default", save: null, reason: "bare_ack_guard" });
  });
  it("an ack on a non-lane category is routed but never saves", () => {
    expect(route({ category: cat({ lookup: 0.9 }), sets_rule: 0.95 }, { bareAck: true })).toMatchObject({ reason: "routed", save: null });
  });
});

describe("routeTree — unarmed and malformed", () => {
  it("category and status unarmed: the Default fallback, no category", () => {
    expect(route({ category: cat({ answer: 0.9 }) }, { armed: { category: false, status: false } })).toEqual(fallbackRoute("uncalibrated", false));
  });
  it("no category answer: the Default fallback", () => {
    expect(routeTree({}, { bars: TREE_BAR_DEFAULTS, armed: ALL, thinkHarder: true, bareAck: false })).toEqual({ kind: "final", route: fallbackRoute("uncalibrated", true) });
  });
});

describe("routeTree / applyCascade — the cascade (a model guess never routes into a no-planner lane)", () => {
  it("memory and status removed, one left: taken without a call", () => {
    expect(route({ category: only({ memory: 0.5, status: 0.3, lookup: 0.2 }), breadth: 0, reasoning: 0 }))
      .toMatchObject({ category: "lookup", role: "fast", reason: "cascade", cascade: null });
  });
  it("memory and status removed, none left: planner, Default, below_bar", () => {
    expect(route({ category: only({ memory: 0.55, status: 0.45 }) })).toMatchObject({ category: null, lane: "planner", role: "default", effort: null, reason: "below_bar" });
  });
  it("two left: a cascade between Jev's top two, carrying the confident rule_scope", () => {
    expect(plan({ category: cat({ lookup: 0.5, research: 0.3 }), sets_rule: 0.9, ask: 0.9 }))
      .toMatchObject({ kind: "cascade", between: ["lookup", "research"], ruleScope: "ask", base: { category: null, reason: "cascade", cascade: null } });
    expect(plan({ category: cat({ lookup: 0.5, research: 0.3 }), sets_rule: 0.9, ask: 0.5 })).toMatchObject({ kind: "cascade", ruleScope: null });
  });
  const cascade = (o: Opts = {}) => {
    const p = plan({ category: cat({ lookup: 0.5, research: 0.3 }), breadth: 0, reasoning: 0 }, o);
    if (p.kind !== "cascade") throw new Error("expected a cascade");
    return p;
  };
  it("a pick applies its own floor and marks cascade tiny", () => {
    expect(applyCascade(cascade(), "research")).toMatchObject({ category: "research", role: "thinking", reason: "cascade", cascade: "tiny" });
    expect(applyCascade(cascade(), "lookup")).toMatchObject({ category: "lookup", role: "fast" });
    expect(applyCascade(cascade({ thinkHarder: true }), "lookup").role).toBe("thinking");
  });
  const withRule = (ask: number) => {
    const p = plan({ category: cat({ lookup: 0.5, research: 0.3 }), sets_rule: 0.9, ask }, {});
    if (p.kind !== "cascade") throw new Error("expected a cascade");
    return p;
  };
  it("no pick, or a pick outside the two: planner Default, cascade_failed, NOTHING saved (F5)", () => {
    // spec §2.4: a failure anywhere is the Default planner path; a confident sets_rule must not save on a failed pick
    expect(applyCascade(cascade(), null)).toEqual({ ...fallbackRoute("cascade_failed", false), cascade: "tiny" });
    expect(applyCascade(cascade(), "memory")).toMatchObject({ reason: "cascade_failed", lane: "planner" });
    expect(applyCascade(withRule(0.9), null).save).toBeNull();
    expect(applyCascade(withRule(0.9), "memory").save).toBeNull();
  });
  it("the rule's scope follows the PICKED category, not Jev's first candidate (F5, spec §2.3)", () => {
    // rule_scope at 0.5 is under its bar, so the category default decides: research → research, lookup → ask
    expect(applyCascade(withRule(0.5), "research").save).toEqual({ scope: "research" });
    expect(applyCascade(withRule(0.5), "lookup").save).toEqual({ scope: "ask" });
  });
  it("a confident rule_scope (p ≥ 0.6) still overrides the picked category's default", () => {
    expect(applyCascade(withRule(0.9), "research").save).toEqual({ scope: "ask" });
    expect(applyCascade(withRule(0.4), "lookup").save).toEqual({ scope: "research" });
  });
});

describe("preJudge (spec §2.1: code before the judge)", () => {
  const answer: LastHougeTurn = { kind: "answer", age_s: 30 };
  it.each([
    ["谢谢", answer, false, { kind: "ack_answer" }],
    ["Thanks!", answer, false, { kind: "ack_answer" }],
    ["ok.", answer, false, { kind: "ack_answer" }],
    ["你好", answer, false, { kind: "ack_answer" }],
    ["谢谢", { kind: "proposal", age_s: 30 }, false, { kind: "judge", thinkHarder: false }],
    ["好", { kind: "clarify", age_s: 30 }, false, { kind: "judge", thinkHarder: false }],
    ["好", null, false, { kind: "judge", thinkHarder: false }],
    ["好", answer, true, { kind: "judge", thinkHarder: false }],
    ["thanks for the list, now the prices?", answer, false, { kind: "judge", thinkHarder: false }],
    ["Think Harder about the trip plan", answer, false, { kind: "judge", thinkHarder: true }],
    ["ultrathink: 明天天气怎么样", null, false, { kind: "judge", thinkHarder: true }],
    ["请认真想想这个问题", null, false, { kind: "judge", thinkHarder: true }]
  ] as const)("%j after %j (quoted %s)", (text, last, quoted, expected) => {
    expect(preJudge({ text, lastHougeTurn: last as LastHougeTurn, quoted })).toEqual(expected);
  });
  it("thinkHarderIn is the same token rule", () => {
    expect(thinkHarderIn("THINK HARDER")).toBe(true);
    expect(thinkHarderIn("think about it")).toBe(false);
  });
  it("ACK_ROUTE is answer on Fast, low effort, reason ack_rule", () => {
    expect(ACK_ROUTE).toEqual({ category: "answer", lane: "planner", role: "fast", effort: "low", save: null, reason: "ack_rule", cascade: null, thinkHarder: false });
  });
});

describe("treeArmed (each decision arms on its own evidence)", () => {
  const row = (question_id: string, criteria_hash: string, lang: "zh" | "en" = "zh", model = REPORTED): CalibrationRow =>
    ({ question_id, criteria_hash, model, lang, approved: "test", evidence: "test" });
  const all = [...TREE_QUESTIONS.map((q) => row(q.id, criteriaHash(q))), row(TREE_STATUS_ARM_ID, criteriaHash(TREE_CATEGORY))];
  const NONE: Armed = { category: false, status: false, memory: false, gear: false, rule: false };
  it("every row → all armed; mixed inherits zh", () => {
    expect(treeArmed("zh", REPORTED, all)).toEqual({ category: true, status: true, memory: true, gear: true, rule: true });
    expect(treeArmed("mixed", REPORTED, all)).toEqual({ category: true, status: true, memory: true, gear: true, rule: true });
  });
  it("the status pseudo-row arms status only; the category row never arms status", () => {
    expect(treeArmed("zh", REPORTED, [row(TREE_STATUS_ARM_ID, criteriaHash(TREE_CATEGORY))])).toEqual({ ...NONE, status: true });
    expect(treeArmed("zh", REPORTED, all.filter((r) => r.question_id !== TREE_STATUS_ARM_ID)).status).toBe(false);
  });
  it("rule arms on the sets_rule + rule_scope rows alone, without the category row (F6)", () => {
    const ruleRows = TREE_QUESTIONS.filter((q) => q.id === "sets_rule" || q.id === "rule_scope").map((q) => row(q.id, criteriaHash(q)));
    expect(treeArmed("zh", REPORTED, ruleRows)).toEqual({ ...NONE, rule: true });
    expect(treeArmed("zh", REPORTED, all.filter((r) => r.question_id !== "rule_scope")).rule).toBe(false);
  });
  it("memory needs category AND rule; gear needs all three scores", () => {
    expect(treeArmed("zh", REPORTED, all.filter((r) => r.question_id !== "rule_scope")).memory).toBe(false);
    expect(treeArmed("zh", REPORTED, all.filter((r) => r.question_id !== "category")).memory).toBe(false);
    expect(treeArmed("zh", REPORTED, all.filter((r) => r.question_id !== "actions")).gear).toBe(false);
  });
  it("another model, another language, or a stale hash arms nothing", () => {
    expect(treeArmed("zh", "jev-1.14.0", all)).toEqual(NONE);
    expect(treeArmed("en", REPORTED, all)).toEqual(NONE);
    expect(treeArmed("zh", REPORTED, [row("category", "deadbeef")]).category).toBe(false);
  });
  it("rows naming the request alias never arm (they would stay armed across an alias move)", () => {
    expect(treeArmed("zh", JEV_REQUEST_MODEL, all.map((r) => ({ ...r, model: JEV_REQUEST_MODEL })))).toEqual(NONE);
  });
  it("treeArmingRows keeps only a current tree row or the status pseudo-row at its current hash (the alias-move page reads these)", () => {
    const retired = [row("category", "deadbeef"), row("lane", "0123abcd"), row("lane:status", "0123abcd"), row(TREE_STATUS_ARM_ID, "deadbeef")];
    expect(treeArmingRows([...retired, ...all])).toEqual(all);
    expect(treeArmingRows(retired)).toEqual([]);
  });
});
