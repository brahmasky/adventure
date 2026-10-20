import { describe, expect, it } from "vitest";
import { SETTLE_BAR, SETTLE_BAR_P, SETTLE_QUESTION_BARS, SETTLE_QUESTIONS_HASH, SETTLE_REASONS, settleQuestionsHash, settleRule, TURN_SETTLE, type SettleState } from "../../src/decisions/entries/turn-settle.js";
import { SETTLE_QUESTIONS } from "../../src/jev/questions/settle.js";
import { entryById, entryProblems } from "../../src/decisions/registry.js";
import { checkOutcomeValue, OutcomeRejected } from "../../src/decisions/outcomes.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import type { AnyEntry } from "../../src/decisions/types.js";

// Spec §3.1: a monotone settle < send_back entry over mixed input whose judged verdict may only tighten (one bounded
// continuation); always recorded; per-question bars (calibration 2026-10-20) on the frozen question hashes. The rule rung is tested in Task 7
// with its state builder; here only its guard order on a bare state.
const base: SettleState = { run_id: "run_1", text: "done", pass: 0, sentBack: false, trust: "clean", lastCallDenied: false, steerQueued: false, msLeft: 120_000, aborting: false, passErrored: false,
  evidence: [], todoBefore: { phases: [] }, todoNow: { phases: [] }, pacoMessage: "hi", attachmentsAccepted: 0, redacted: { text: "done", pacoMessage: "hi" }, toolSummary: "none" };

describe("the turn.settle entry", () => {
  it("is registered: stage settle, input mixed, monotone settle < send_back, fail and default settle, always recorded, armed on", () => {
    const e = entryById("turn.settle") as AnyEntry;
    expect(e).toBe(TURN_SETTLE as unknown as AnyEntry);
    expect([e.stage, e.input, e.fail, e.defaultVerdict, e.alwaysRecord, [...e.verdicts], e.monotone?.order]).toEqual(["settle", "mixed", "settle", "settle", true, ["settle", "send_back"], ["settle", "send_back"]]);
    expect(e.ladder.map((r) => `${r.kind}:${r.name}`)).toEqual(["rule:settle_rule", "system_one:settle"]);
    expect(entryProblems(e)).toEqual([]);
    expect(e.effects.send_back).toMatchObject({ kind: "tighten", reversible: true, announced: "none" });
  });
  it("its bars are the 2026-10-20 calibration's per-question values; the entry's single p is the lowest, on the frozen hashes of the four questions", () => {
    // measured on 133 real planner replies: these four bars gave 5.3% send-backs with every planted positive caught
    expect(SETTLE_QUESTION_BARS).toEqual({ settle_claims_done: 0.6, settle_unverified: 0.8, settle_promise: 0.7, settle_asks_permission: 0.7 });
    expect(Object.keys(SETTLE_QUESTION_BARS).sort()).toEqual(SETTLE_QUESTIONS.map((q) => q.id).sort());
    expect(SETTLE_BAR_P).toBe(0.6);
    expect(SETTLE_BAR_P).toBe(Math.min(...Object.values(SETTLE_QUESTION_BARS)));
    expect(SETTLE_BAR).toMatchObject({ kind: "provisional", question: "settle", p: 0.6, criteriaHash: SETTLE_QUESTIONS_HASH });
    expect(SETTLE_BAR.source).toContain("calibration 2026-10-20");
    // A11.9: the two measurements, each labelled (the probe and its sanity rerun)
    expect(SETTLE_BAR.source).toContain("probe 7/133 = 5.3%, 7/7 planted; sanity rerun 6/133 = 4.5%, 9/9 planted");
    expect(SETTLE_QUESTIONS_HASH).not.toBe(criteriaHash(SETTLE_QUESTIONS[0]!)); // all four questions, not the first alone
  });
  it("the four questions carry noul criteria (set B), and a criteria-only edit moves the bar's hash", () => {
    for (const q of SETTLE_QUESTIONS) expect(q.criteria && q.criteria.true.length > 0 && q.criteria.false.length > 0).toBe(true);
    const edited = SETTLE_QUESTIONS.map((q, k) => (k === 1 ? { ...q, criteria: { true: q.criteria!.true, false: `${q.criteria!.false} ` } } : q));
    expect(settleQuestionsHash(edited)).not.toBe(SETTLE_QUESTIONS_HASH);
    expect(settleQuestionsHash(SETTLE_QUESTIONS)).toBe(SETTLE_QUESTIONS_HASH);
  });
  it("carries exactly the spec's reason codes", () => {
    expect([...SETTLE_REASONS]).toEqual(["hostile", "already_sent_back", "last_call_denied", "steer_queued", "deadline_short", "aborting", "pass_errored", "empty", "claim_scheduled", "claim_saved",
      "claim_attached", "claim_sent", "todo_pending", "todo_unavailable", "jev_claims_done", "jev_unverified", "jev_promise", "jev_asks_permission", "budget", "settled"]);
    expect([...TURN_SETTLE.reasonCodes]).toEqual([...SETTLE_REASONS]);
  });
  it("guards in order: hostile, already_sent_back, last_call_denied, steer_queued, deadline_short, aborting, pass_errored, empty — each settles with its code", () => {
    expect(settleRule({ ...base, trust: "hostile", sentBack: true })).toMatchObject({ verdict: "settle", reason: "hostile" });
    expect(settleRule({ ...base, sentBack: true, lastCallDenied: true })).toMatchObject({ verdict: "settle", reason: "already_sent_back" });
    expect(settleRule({ ...base, lastCallDenied: true, steerQueued: true })).toMatchObject({ verdict: "settle", reason: "last_call_denied" });
    expect(settleRule({ ...base, steerQueued: true, msLeft: 1 })).toMatchObject({ verdict: "settle", reason: "steer_queued" });
    expect(settleRule({ ...base, msLeft: 59_000, aborting: true })).toMatchObject({ verdict: "settle", reason: "deadline_short" });
    expect(settleRule({ ...base, msLeft: 61_000, aborting: true, passErrored: true })).toMatchObject({ verdict: "settle", reason: "aborting" });
    // A8: a pass that ended on a model error is never sent back (the continuation would run on the same failing model)
    expect(settleRule({ ...base, passErrored: true, text: "I've saved it." })).toMatchObject({ verdict: "settle", reason: "pass_errored" });
    expect(settleRule({ ...base, text: "  ", redacted: { text: "", pacoMessage: "" } })).toMatchObject({ verdict: "settle", reason: "empty" });
    expect(settleRule(base)).toEqual({ abstain: true }); // nothing fires on a bare state: the claims and todo checks (Task 7) and then Jev decide
  });
  it("outcome values: settle_sent_back / settle_unverified take a reason code; settle_discarded its three values; free text is refused", () => {
    expect(checkOutcomeValue("settle_sent_back", "claim_saved")).toBe("claim_saved");
    expect(checkOutcomeValue("settle_unverified", "jev_promise")).toBe("jev_promise");
    for (const v of ["extension_timeout", "signal", "continuation_failed"]) expect(checkOutcomeValue("settle_discarded", v)).toBe(v);
    for (const [s, v] of [["settle_sent_back", "I scheduled it"], ["settle_unverified", "x"], ["settle_discarded", "claim_saved"]] as const) expect(() => checkOutcomeValue(s, v)).toThrow(OutcomeRejected);
  });
});
