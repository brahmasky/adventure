import { describe, expect, it } from "vitest";
import { applicableTargets, IMPROVE_BAR, IMPROVE_BAR_P, IMPROVE_REASONS, IMPROVE_ROUTE, IMPROVE_TARGETS, improveJevState, improveRule, jevVerdictOf, type ImproveState } from "../../src/decisions/entries/improve-route.js";
import { IMPROVE_TARGET } from "../../src/jev/questions/improve.js";
import { entryById, entryProblems } from "../../src/decisions/registry.js";
import { criteriaHash, optionsOf } from "../../src/jev/questions/types.js";
import { DECISION_SIGNALS, type AnyEntry } from "../../src/decisions/types.js";

// Spec 2b-ii §4: one entry over mixed input, no monotone order, fail-open on `nothing`, every signal an outcome, a
// provisional 0.6 bar on one fixed choice question (escape first), a Tiny pick below it. Rule order is the spec's §4.3 list.
const base: ImproveState = { signal: "correction", value: "answer", scope: "answer", count: 1, count14d: 2, category: "answer", lane: "answer", capability: null,
  pacoText: "please keep answers shorter", toolSummary: "none", lastImprovement: null, recurrence: null, alreadyAuthored: false, skillExists: false, wikiArmed: false,
  scheduleHint: null, stale: false, statedRuleSaved: false, redacted: { pacoText: "please keep answers shorter" } };
const rec = { clusterId: "rec_abc", turnIds: ["t1", "t2", "t3"], idempotencyKey: "answer:t1", spanDays: 1 };
const answer = (probabilities: Record<string, number>) => ({ type: "choice" as const, choice: Object.keys(probabilities)[0]!, probabilities, confidence: 0.5 });

describe("the improve.route entry", () => {
  it("is registered: stage after_turn, input mixed, no monotone order, fail and default nothing, always recorded, three rungs, outcomes = every signal", () => {
    const e = entryById("improve.route") as AnyEntry;
    expect(e).toBe(IMPROVE_ROUTE as unknown as AnyEntry);
    expect([e.stage, e.input, e.fail, e.defaultVerdict, e.alwaysRecord, e.monotone]).toEqual(["after_turn", "mixed", "nothing", "nothing", true, undefined]);
    expect([...e.verdicts]).toEqual(["nothing", "lesson", "fact", "skill", "schedule", "knowledge", "tool_gap", "ladder"]);
    expect(e.ladder.map((r) => `${r.kind}:${r.name}`)).toEqual(["rule:improve_rule", "system_one:improve_target", "model:improve_pick"]);
    expect([...e.outcomes]).toEqual([...DECISION_SIGNALS]);
    expect(entryProblems(e)).toEqual([]);
    for (const v of IMPROVE_TARGETS.filter((t) => t !== "nothing")) expect(e.effects[v]).toMatchObject({ kind: "proposal", reversible: true, announced: "card" });
    expect([...e.reasonCodes]).toEqual([...IMPROVE_REASONS]);
  });
  it("the one fixed question: escape first, eight options, the bar hashes it at 0.6", () => {
    expect(optionsOf(IMPROVE_TARGET)).toEqual([...IMPROVE_TARGETS]);
    expect(IMPROVE_BAR).toMatchObject({ kind: "provisional", question: "improve_target", criteriaHash: criteriaHash(IMPROVE_TARGET), p: IMPROVE_BAR_P });
    expect(IMPROVE_BAR_P).toBe(0.6);
  });
  it("rule order: stale → stated_rule_owned → recurrence (already_authored / skill_exists / lookup → knowledge / skill) → expiry pattern → no_text → abstain", () => {
    expect(improveRule({ ...base, stale: true, statedRuleSaved: true })).toMatchObject({ verdict: "nothing", reason: "stale" });
    expect(improveRule({ ...base, statedRuleSaved: true, recurrence: rec })).toMatchObject({ verdict: "nothing", reason: "stated_rule_owned" });
    expect(improveRule({ ...base, signal: "recurrence", recurrence: rec, alreadyAuthored: true })).toMatchObject({ verdict: "nothing", reason: "already_authored" });
    expect(improveRule({ ...base, signal: "recurrence", recurrence: rec, skillExists: true })).toMatchObject({ verdict: "nothing", reason: "skill_exists" });
    expect(improveRule({ ...base, signal: "recurrence", recurrence: rec, category: "lookup" })).toMatchObject({ verdict: "knowledge", reason: "wiki_disarmed" });
    expect(improveRule({ ...base, signal: "recurrence", recurrence: rec, category: "research", wikiArmed: true })).toMatchObject({ verdict: "knowledge", reason: "recurrence_lookup" });
    expect(improveRule({ ...base, signal: "recurrence", recurrence: rec })).toMatchObject({ verdict: "skill", reason: "recurrence" });
    expect(improveRule({ ...base, signal: "approval_expired", value: "shell_external", capability: "shell_external", scheduleHint: { schedule_id: "s1", hour: 11 } })).toMatchObject({ verdict: "schedule", reason: "expiry_pattern" });
    expect(improveRule({ ...base, signal: "planner_failed", pacoText: "", redacted: { pacoText: "" } })).toMatchObject({ verdict: "nothing", reason: "no_text" });
    expect(improveRule(base)).toEqual({ abstain: true });
  });
  it("applicable targets: knowledge only with the wiki armed, skill only with a recurrence and no existing skill, schedule only with a hint", () => {
    expect(applicableTargets(base)).toEqual(["nothing", "lesson", "fact", "tool_gap", "ladder"]);
    expect(applicableTargets({ ...base, wikiArmed: true, recurrence: rec, scheduleHint: { schedule_id: "s1", hour: 11 } })).toEqual([...IMPROVE_TARGETS]);
    expect(applicableTargets({ ...base, recurrence: rec, skillExists: true })).not.toContain("skill");
  });
  it("the Jev copy carries the redacted text, never pacoText, plus the applicable list", () => {
    const s = improveJevState({ ...base, pacoText: "RAW", redacted: { pacoText: "MASKED" } });
    expect(s.paco_text).toBe("MASKED");
    expect(JSON.stringify(s)).not.toContain("RAW");
    expect(s.applicable).toEqual(["nothing", "lesson", "fact", "tool_gap", "ladder"]);
  });
  it("masking after the answer: an applicable top over the bar decides with its p; an inapplicable top abstains inapplicable_top; an applicable top below the bar abstains with the two best applicable options", () => {
    expect(jevVerdictOf(answer({ lesson: 0.7, nothing: 0.2, fact: 0.1 }), base)).toMatchObject({ verdict: "lesson", reason: "jev_choice", p: 0.7 });
    expect(jevVerdictOf(answer({ schedule: 0.7, lesson: 0.2, nothing: 0.1 }), base)).toMatchObject({ verdict: "nothing", reason: "inapplicable_top", p: 0.7, detail: { top: "schedule", p: 0.7 } }); // ruling 18: an answer, so the row keeps the reason
    expect(jevVerdictOf(answer({ lesson: 0.45, fact: 0.3, schedule: 0.15, nothing: 0.1 }), base)).toMatchObject({ abstain: true, reason: "below_bar", detail: { top2: ["lesson", "fact"], p: 0.45 } });
    expect(jevVerdictOf(answer({ nothing: 0.6, lesson: 0.4 }), base)).toMatchObject({ verdict: "nothing", reason: "jev_choice" });
  });
});
