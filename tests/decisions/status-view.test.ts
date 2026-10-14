import { describe, expect, it } from "vitest";
import { buildDecisionDigest } from "../../src/decisions/digest.js";
import { decisionListText, decisionStatusLines } from "../../src/decisions/status-view.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Paco 2026-10-14: /status answers "what did the ladder do today" on demand, with the digest switchable off. The section
// must count exactly as the digest does (one counting code, so the two never disagree), say how often Jev failed (logged
// skips, no alert by his ruling), what tool.injection did, and how many turns went hostile. `/status decisions` shows the
// last ten rows so he can see one decision without the CLI. Code-built text only: ids, labels, numbers.
const ENV = { HOUGE_DISPLAY_TZ: "Australia/Sydney" };
const NOW = "2026-10-13T10:00:00.000Z";
const AT = "2026-10-13T09:00:00.000Z";
const D = (o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id: "tool.injection", entry_version: 1, run_id: "run_1", tool_call_id: "tc", stage: "post_tool",
  rung: "system_one", verdict: "pass", p: 0.1, reason_code: "jev_passed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 5, created_at: AT, ...o });
const skip = (s: RunStore, skip_reason: string, created_at = AT): string => s.insertJevDecision({ run_id: null, point: "triage", question_id: null,
  criteria_hash: null, model_reported: null, state_hash: null, lang: "en", answers_json: null, confidence: null, top_prob: null, margin: null,
  threshold_version: null, threshold_used: null, decision: null, latency_ms: null, input_tokens: null, status: "skipped", skip_reason, created_at });

function seeded(): RunStore {
  const s = RunStore.openInMemory();
  s.insertDecision(D({ verdict: "withhold", p: 0.58, reason_code: "jev_withheld" }));
  s.insertDecision(D({ verdict: "frame", rung: "rule", p: null, reason_code: "floor_held" }));
  s.insertDecision(D({ rung: "fail", p: null, reason_code: "jev_skipped", fallback_reason: "outage", fallback_rung: "system_one" }));
  s.insertDecision(D({ entry_id: "turn.trust", verdict: "hostile", rung: "rule", p: null, reason_code: "injection_withheld", run_id: "run_3" }));
  s.insertDecision(D({ entry_id: "turn.trust", verdict: "hostile", rung: "rule", p: null, reason_code: "injection_withheld", run_id: "run_3" }));
  s.insertDecision(D({ entry_id: "turn.trust", verdict: "untrusted", rung: "rule", p: null, reason_code: "wall_read", run_id: "run_4" }));
  skip(s, "timeout"); skip(s, "timeout"); skip(s, "parse");
  skip(s, "ack_rule");                                       // the ack rule settled the turn in code: not a Jev failure
  skip(s, "timeout", "2026-10-12T09:00:00.000Z");            // outside the 24 h window
  return s;
}

describe("/status decisions section", () => {
  it("counts by decider label, Jev failures by reason, tool.injection outcomes and hostile turns", () => {
    const s = seeded();
    expect(decisionStatusLines(s, NOW)).toEqual([
      "",
      "🪜 DECISIONS (24h)",
      "· tool.injection 3 — code 1 · Jev 1 · fallback 1",
      "· turn.trust 3 — code 3",
      "Jev failures: 3 (timeout 2 · parse 1)",
      "Injection: withheld 1 · framed 1 · not checked 1",
      "Hostile turns: 1"
    ]);
    s.close();
  });
  it("uses the digest's own count lines, so /status and the digest never disagree", () => {
    const s = seeded();
    const digest = buildDecisionDigest(s, NOW, ENV)!.text;
    for (const line of decisionStatusLines(s, NOW).filter((l) => l.startsWith("· "))) expect(digest).toContain(line);
    s.close();
  });
  it("says none when Jev logged no failure and nothing was injected or raised", () => {
    const s = RunStore.openInMemory();
    s.insertDecision(D({ entry_id: "tool.shell_netread", rung: "rule", verdict: "local", p: null, reason_code: "allowlist" }));
    expect(decisionStatusLines(s, NOW).slice(3)).toEqual(["Jev failures: none", "Injection: withheld 0 · framed 0 · not checked 0", "Hostile turns: 0"]);
    s.close();
  });
  it("is left out when the last 24 h hold no decision (Jev skips alone do not make a section)", () => {
    const s = RunStore.openInMemory();
    s.insertDecision(D({ created_at: "2026-10-12T09:00:00.000Z" }));
    skip(s, "timeout");
    expect(decisionStatusLines(s, NOW)).toEqual([]);
    s.close();
  });
});

describe("/status decisions list", () => {
  it("lists the last 10 rows newest first: local time, entry, decider, verdict, p, short run id", () => {
    const s = RunStore.openInMemory();
    for (let k = 0; k < 11; k += 1) s.insertDecision(D({ p: k / 100, created_at: `2026-10-13T08:${String(10 + k).padStart(2, "0")}:00.000Z` }));
    s.insertDecision(D({ entry_id: "turn.handler", stage: "pre_model", rung: "model", verdict: "planner", p: null, run_id: "run_d355e153-fee8-4446-9f3e-7403aa297b08",
      created_at: "2026-10-13T09:30:00.000Z" }));
    s.insertDecision(D({ entry_id: "tool.shell_netread", rung: "rule", verdict: "local", p: null, run_id: null, created_at: "2026-10-13T09:31:00.000Z" }));
    const lines = decisionListText(s, ENV).split("\n");
    expect(lines).toEqual([
      "🪜 Last 10 decisions",
      "10-13 20:31 · tool.shell_netread · code → local · p – · run –",
      "10-13 20:30 · turn.handler · model → planner · p – · run d355e153",
      "10-13 19:20 · tool.injection · Jev → pass · p 0.10 · run 1",
      "10-13 19:19 · tool.injection · Jev → pass · p 0.09 · run 1",
      "10-13 19:18 · tool.injection · Jev → pass · p 0.08 · run 1",
      "10-13 19:17 · tool.injection · Jev → pass · p 0.07 · run 1",
      "10-13 19:16 · tool.injection · Jev → pass · p 0.06 · run 1",
      "10-13 19:15 · tool.injection · Jev → pass · p 0.05 · run 1",
      "10-13 19:14 · tool.injection · Jev → pass · p 0.04 · run 1",
      "10-13 19:13 · tool.injection · Jev → pass · p 0.03 · run 1"
    ]);
    s.close();
  });
  it("says so when nothing was ever recorded", () => {
    const s = RunStore.openInMemory();
    expect(decisionListText(s, ENV)).toBe("🪜 Last 10 decisions\nNo decisions recorded yet.");
    s.close();
  });
});
