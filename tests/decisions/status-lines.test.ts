import { describe, expect, it } from "vitest";
import { countLines, improvementLine, injectionCounts, settleHealthLine } from "../../src/decisions/status-lines.js";
import { DIGEST_LM_PREFIX, DIGEST_PR_PREFIX } from "../../src/decisions/digest.js";
import { LM_PREFIX, PR_PREFIX } from "../../src/triggers/telegram-command-parser.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Spec 2026-11-07 §8: the counting code /status reads moved out of the digest unchanged; the digest's diagnostic Watch
// lines (not its alarms) are one /status line, and nothing when there is nothing to say.
const NOW = "2026-10-21T10:00:00.000Z";
const D = (o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id: "turn.handler", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_model", rung: "system_one", verdict: "planner", p: 0.9,
  reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: "2026-10-21T01:00:00.000Z", ...o });
const row = (o: Partial<DecisionInsert>) => ({ ...D(o), created_at: o.created_at ?? "2026-10-21T01:00:00.000Z", decision_id: "dec_x", p_index: null, reask: null, p_first: null });

describe("countLines / settleHealthLine / injectionCounts", () => {
  it("counts per entry by decider label and suffixes only secret.redact; settle health names each reason; injection counts lost judgements", () => {
    const rows = [row({ entry_id: "secret.redact", rung: "rule" }), row({ entry_id: "turn.handler", rung: "fail" }), row({ entry_id: "turn.handler", rung: "system_one" })];
    expect(countLines(rows)).toEqual(["· secret.redact 1 — code 1 (final, failure and evolution reports only)", "· turn.handler 2 — Jev 1 · fallback 1"]);
    expect(settleHealthLine([row({ entry_id: "turn.settle", reason_code: "budget" })])).toBe("· turn.settle unfinished: budget 1 · todo_unavailable 0 · pass_errored 0");
    expect(settleHealthLine(rows)).toBeNull();
    expect(injectionCounts([row({ entry_id: "tool.injection", rung: "fail", fallback_rung: "system_one", verdict: "pass" })])).toMatchObject({ results: 1, lost: 1, withheld: 0 });
  });
  it("the card prefixes equal the parser's, so a card built from them parses there", () => {
    expect(DIGEST_PR_PREFIX).toBe(PR_PREFIX); expect(DIGEST_LM_PREFIX).toBe(LM_PREFIX);
  });
});

describe("improvementLine", () => {
  it("is null on a quiet week with the tick on", () => { expect(improvementLine(RunStore.openInMemory(), NOW, {})).toBeNull(); });
  it("names the tick off, unattached families, silent families, deferrals, wiki-disarmed topics, inapplicable tops and lessons not holding, non-zero parts only", () => {
    const s = RunStore.openInMemory();
    s.insertImproveSignal({ signal: "correction", value: "answer", run_id: null, chat_id: "555", about_run_id: null, created_at: "2026-10-20T00:00:00.000Z" });
    s.recordMemoryEvent("improve_signal_skipped", { signal: "rating", code: "no_run" }, "improve");
    s.beginImproveTick("2026-10-20", "2026-10-20T11:00:00.000Z"); s.finishImproveTick("2026-10-20", "done", { deferred: 2, deferred_outage: 1 }, "2026-10-20T11:00:00.000Z");
    s.insertDecision(D({ entry_id: "improve.route", stage: "after_turn", rung: "rule", verdict: "knowledge", reason_code: "wiki_disarmed", created_at: "2026-10-20T11:00:00.000Z" }));
    s.insertDecision(D({ entry_id: "improve.route", stage: "after_turn", verdict: "nothing", reason_code: "inapplicable_top", created_at: "2026-10-20T11:00:00.000Z" }));
    s.insertImprovementProposal({ decision_id: s.insertDecision(D({ entry_id: "improve.route", stage: "after_turn", verdict: "lesson", created_at: "2026-10-20T11:00:00.000Z" })), target: "lesson", scope: "answer", chat_id: "555", draft_json: "{}", evidence: "lesson did not hold: 2 corrections since (5 d)", created_at: "2026-10-20T11:00:00.000Z" });
    expect(improvementLine(s, NOW, { HOUGE_IMPROVE_ENABLED: "false" }))
      .toBe("Improvement (7 d): tick off · unattached rating 1 · silent review_unsure, lesson_unfollowed, dig_deeper · deferred 2 · deferred on an outage 1 · wiki disarmed 1 · inapplicable top 1 · lessons not holding 1");
    expect(improvementLine(s, "2030-01-01T00:00:00.000Z", {})).toBeNull(); // everything older than 7 days (the skipped-signal ledger event is stamped with the wall clock, so the window is far ahead of it)
  });
});
