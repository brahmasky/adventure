import { describe, expect, it } from "vitest";
import { buildDecisionDigest, reaskLines, trustLines, unsureOf } from "../../src/decisions/digest.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Spec §8.1 + R6: the new judges are armed at ship on provisional bars, so the digest is the net. Paco cannot see a judged
// passage, so tool.injection is counted (withheld by code or Jev, framed, near the bar, judgements lost), never offered for a
// blind tap (Ruling 19); the trust lines say how many turns asked for more taps; the noise band's re-asks are counted.
const NOW = "2026-10-13T10:00:00.000Z";
const AT = "2026-10-13T09:00:00.000Z";
const D = (o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id: "tool.injection", entry_version: 1, run_id: "run_1", tool_call_id: "tc", stage: "post_tool",
  rung: "system_one", verdict: "pass", p: 0.1, reason_code: "jev_passed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 5, created_at: AT, ...o });

function seeded() {
  const s = RunStore.openInMemory();
  s.insertDecision(D({ verdict: "withhold", p: 0.58, reason_code: "jev_withheld", reask: "max", p_first: 0.52 })); // near, above
  s.insertDecision(D({ p: 0.42 }));                                                                                   // near, below
  s.insertDecision(D({ p: 0.2 }));                                                                                    // sure pass
  s.insertDecision(D({ verdict: "withhold", rung: "rule", p: null, reason_code: "floor_held" }));                    // the floor withheld
  s.insertDecision(D({ verdict: "frame", rung: "rule", p: null, reason_code: "floor_held" }));                       // framed, kept local
  s.insertDecision(D({ rung: "fail", p: null, reason_code: "jev_skipped", fallback_reason: "outage", fallback_rung: "system_one" })); // judgement lost
  s.insertDecision(D({ entry_id: "turn.trust", verdict: "untrusted", rung: "rule", p: null, reason_code: "wall_read", run_id: "run_2" }));
  s.insertDecision(D({ entry_id: "turn.trust", verdict: "hostile", rung: "rule", p: null, reason_code: "injection_withheld", run_id: "run_3" }));
  s.bumpTrustTapBudget("2026-10-13", AT); s.bumpTrustTapBudget("2026-10-13", AT);
  return s;
}

describe("digest — injection and trust (stage 2a)", () => {
  it("offers no tool.injection verdict for a blind tap", () => {
    expect(unsureOf(seeded().listDecisionsBetween("2026-10-12T10:00:00.000Z", NOW))).toEqual([]);
  });
  it("counts withholds by rung, frames, near-bar verdicts, lost judgements, raised turns and today's trust taps", () => {
    const s = seeded();
    const rows = s.listDecisionsBetween("2026-10-12T10:00:00.000Z", NOW);
    expect(trustLines(s, rows, NOW, {})).toEqual([
      "· tool.injection: 6 tool results · withheld 2 (code 1 · Jev 1) · framed 1 (kept local) · near the bar 2 · judgement lost 1",
      "· turns: untrusted 1 · hostile 1 · trust taps today 2 of 3"
    ]);
    expect(reaskLines(rows)).toEqual(["· tool.injection: re-asked 1 (mean 0 · max 1 · failed 0)"]);
  });
  it("renders both sections in the digest message", () => {
    const d = buildDecisionDigest(seeded(), NOW, {});
    expect(d?.text).toContain("**Injection & trust (24 h)**");
    expect(d?.text).toContain("**Noise band (24 h)**");
    expect(d?.offered).toEqual([]);
  });
});

describe("digest — stage 2a additions never disturb stage 1", () => {
  it("a day with only stage 1 activity renders no injection, trust or noise sections", () => {
    const s = RunStore.openInMemory();
    s.insertDecision(D({ entry_id: "fetch.ssrf", stage: "pre_tool", rung: "rule", verdict: "allow", p: null, reason_code: null }));
    const text = buildDecisionDigest(s, NOW, {})?.text ?? "";
    expect(text).toContain("**Counts (24 h)**");
    expect(text).not.toContain("Injection & trust");
    expect(text).not.toContain("Noise band");
  });
  it("counts a turn once at its highest level and separates hostile by unjudged outside text", () => {
    const s = RunStore.openInMemory();
    const T = (verdict: string, reason_code: string, run_id: string): void => { s.insertDecision(D({ entry_id: "turn.trust", verdict, rung: "rule", p: null, reason_code, run_id })); };
    T("untrusted", "wall_read", "run_a"); T("hostile", "unjudged_outside", "run_a"); // one turn, raised twice: hostile only
    T("untrusted", "wall_read", "run_b");
    const lines = trustLines(s, s.listDecisionsBetween("2026-10-12T10:00:00.000Z", NOW), NOW, {});
    expect(lines).toEqual(["· turns: untrusted 1 · hostile 1 (1 by unjudged outside text) · trust taps today 0 of 3"]);
  });
  it("shows a lone trust-tap count even when no turn rose", () => {
    const s = RunStore.openInMemory(); s.bumpTrustTapBudget("2026-10-13", AT);
    expect(trustLines(s, [], NOW, {})).toEqual(["· turns: untrusted 0 · hostile 0 · trust taps today 1 of 3"]);
  });
});

describe("digest — stale bar (stage 2a, golden set)", () => {
  it("flags an open decision_bar_stale incident even on a day with no decisions", () => {
    const s = RunStore.openInMemory();
    expect(buildDecisionDigest(s, NOW, {})).toBeNull();
    s.openIncident({ kind: "decision_bar_stale", subject: "tool.injection", detail: { model: "jev-1.14.0", bar_model: "jev-1.13.0" }, now: AT });
    const d = buildDecisionDigest(s, NOW, {});
    expect(d?.text).toContain("tool.injection: the bar was measured on jev-1.13.0, Jev now reports jev-1.14.0");
  });
});

describe("digest — turn.settle unsure band (2b-i)", () => {
  it("offers a Jev settle judgement in [0.6, 0.75) (the lowest per-question bar + 0.15), never one past the band, under it, or a settled row", () => {
    const s = RunStore.openInMemory();
    const settle = (o: Partial<DecisionInsert>) => D({ entry_id: "turn.settle", stage: "settle", tool_call_id: null, ...o });
    s.insertDecision(settle({ run_id: "run_a", reason_code: "jev_claims_done", verdict: "send_back", p: 0.6 }));
    s.insertDecision(settle({ run_id: "run_b", reason_code: "jev_promise", verdict: "send_back", p: 0.76 }));
    s.insertDecision(settle({ run_id: "run_c", reason_code: "settled", verdict: "settle", p: 0.65 }));
    s.insertDecision(settle({ run_id: "run_d", reason_code: "jev_promise", verdict: "send_back", p: 0.55 }));
    expect(unsureOf(s.listDecisionsBetween("2026-10-12T10:00:00.000Z", NOW)).map((r) => r.run_id)).toEqual(["run_a"]);
  });
});
