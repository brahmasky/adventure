import { describe, expect, it } from "vitest";
import { REVIEW_PREFIX, reviewButtons, settleHealthLine, unsureOf, UNSURE_MAX } from "../../src/decisions/digest.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// The stage-1 helpers survive the 2b-ii digest rebuild: /status and the golden/health paths still read them. These cases
// assert the helpers themselves, never digest text. Ruling R1: only System One judgements are offered (p in [bar, bar + 0.15),
// a judgement route reason); turn.handler's bar is 0.6.
const NOW = "2026-10-12T11:00:00.000Z";
const D = (o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id: "turn.handler", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_model",
  rung: "system_one", verdict: "planner", p: 0.9, reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1,
  created_at: "2026-10-12T05:00:00.000Z", ...o });

describe("unsureOf", () => {
  it("keeps applied System One judgements within 0.15 of the entry's bar (turn.handler: 0.6), newest first, at most 8", () => {
    const store = RunStore.openInMemory();
    store.insertDecision(D({ p: 0.9 }));                                     // sure
    store.insertDecision(D({ p: 0.65, armed_mode: "shadow" }));              // shadow: not applied, not offered
    store.insertDecision(D({ p: 0.65, rung: "rule" }));                      // a rule decided
    store.insertDecision(D({ p: 0.65, rung: "model", reason_code: "cascade" })); // the cascade decided
    store.insertDecision(D({ p: 0.65, reason_code: "uncalibrated" }));       // a fallback route, not a judgement (R1)
    store.insertDecision(D({ p: 0.5, reason_code: "below_bar" }));           // cascadePlan's planner fallback below the bar (R1)
    store.insertDecision(D({ p: 0.55, reason_code: "cascade" }));            // cascadePlan's one-candidate route below the bar (R1)
    store.insertDecision(D({ p: 0.55, reason_code: "routed" }));             // below the bar even with a judgement reason
    store.insertDecision(D({ p: 0.75, reason_code: "routed" }));             // at bar + 0.15: outside the band
    store.insertDecision(D({ entry_id: "turn.gear", p: 0.65 }));             // turn.gear has no single bar
    for (let k = 0; k < 10; k += 1) store.insertDecision(D({ p: 0.6 + k * 0.01, created_at: `2026-10-12T06:0${k}:00.000Z` }));
    const rows = unsureOf(store.listDecisionsBetween("2026-10-11T11:00:00.000Z", NOW));
    expect(rows).toHaveLength(UNSURE_MAX);
    expect(rows[0]?.p).toBeCloseTo(0.69);
    expect(rows[UNSURE_MAX - 1]?.p).toBeCloseTo(0.62);
    expect(rows.every((r) => r.entry_id === "turn.handler" && r.rung === "system_one" && r.armed_mode === "on" && r.reason_code === "routed")).toBe(true);
    store.close();
  });
});

describe("unsureOf (R1)", () => {
  it("offers only judgement routes at p in [bar, bar + 0.15): sub-bar below_bar / cascade fallbacks and unknown reasons are not offered", () => {
    const store = RunStore.openInMemory();
    store.insertDecision(D({ p: 0.5, reason_code: "below_bar" }));
    store.insertDecision(D({ p: 0.55, reason_code: "cascade" }));
    store.insertDecision(D({ p: 0.55, reason_code: "routed" }));
    store.insertDecision(D({ p: 0.65, reason_code: "uncalibrated" }));
    store.insertDecision(D({ p: 0.65, reason_code: "some_future_reason" }));
    store.insertDecision(D({ p: 0.75, reason_code: "routed" }));
    const ok = ["routed", "bare_ack_guard", "lane_limits", "correction", "two_request", "fix", "memory_other"].map((reason_code) => store.insertDecision(D({ p: 0.6, reason_code })));
    const rows = unsureOf(store.listDecisionsBetween("2026-10-11T11:00:00.000Z", NOW));
    expect(rows.map((r) => r.decision_id).sort()).toEqual([...ok].sort());
    store.close();
  });
  // Rev 2 item 11: memory.kind is armed without a calibration sitting, so its Jev answers inside [0.85, 1.0) are the
  // review list Paco labels from; one below its own bar is not a judgement and is not offered.
  it("offers a memory.kind Jev row (jev_kind) at p 0.85 and 0.99, not at 0.84", () => {
    const store = RunStore.openInMemory();
    const mk = (p: number) => store.insertDecision(D({ entry_id: "memory.kind", entry_version: 1, verdict: "fact", p, reason_code: "jev_kind" }));
    const offered = [mk(0.85), mk(0.99)];
    mk(0.84);
    expect(unsureOf(store.listDecisionsBetween("2026-10-11T11:00:00.000Z", NOW)).map((r) => r.decision_id).sort()).toEqual([...offered].sort());
    store.close();
  });
});

describe("settleHealthLine (R0')", () => {
  it("counts budget, todo_unavailable and pass_errored rows per reason; a day without them has no line", () => {
    const store = RunStore.openInMemory();
    const S = (reason_code: string) => D({ entry_id: "turn.settle", stage: "settle", rung: reason_code === "budget" ? "fail" : "rule", verdict: "settle", p: null, reason_code });
    for (const r of ["pass_errored", "pass_errored", "todo_unavailable", "settled"]) store.insertDecision(S(r));
    expect(settleHealthLine(store.listDecisionsBetween("2026-10-11T11:00:00.000Z", NOW))).toBe("· turn.settle unfinished: budget 0 · todo_unavailable 1 · pass_errored 2");
    const clean = RunStore.openInMemory(); clean.insertDecision(S("settled"));
    expect(settleHealthLine(clean.listDecisionsBetween("2026-10-11T11:00:00.000Z", NOW))).toBeNull();
  });
});

describe("reviewButtons", () => {
  it("review buttons carry dec:rv:<id>:<ok|bad> within Telegram's 64-byte callback limit", () => {
    const id = "dec_00000000-0000-0000-0000-000000000000";
    expect(REVIEW_PREFIX).toBe("dec:rv:");
    expect(reviewButtons(id, 3)).toEqual([{ text: "✅ 3", data: `dec:rv:${id}:ok` }, { text: "❌ 3", data: `dec:rv:${id}:bad` }]);
    expect(Buffer.byteLength(`dec:rv:${id}:bad`)).toBeLessThanOrEqual(64);
  });
});

describe("digest callback prefixes", () => {
  it("the digest's literals equal the parser's, so a tap built here parses there", async () => {
    const parser = await import("../../src/triggers/telegram-command-parser.js");
    const digest = await import("../../src/decisions/digest.js");
    expect(digest.DIGEST_PR_PREFIX).toBe(parser.PR_PREFIX);
    expect(digest.DIGEST_LM_PREFIX).toBe(parser.LM_PREFIX);
  });
});
