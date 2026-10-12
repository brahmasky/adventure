import { describe, expect, it } from "vitest";
import type { AnyEntry } from "../../src/decisions/types.js";
import { REGISTRY } from "../../src/decisions/registry.js";
import { checkDecisionSkipRates, DECISION_SKIP_RATE_EXCLUDED, detectViolations } from "../../src/run/invariant-sweep.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Spec §5.2: a silently dead judge on any entry must be loud. The rate comes from decisions rows whose first failure was on
// the Jev rung (fallback_rung = 'system_one', codex W6), per entry (not jev_decisions, which counts answers per run). turn.handler
// and turn.gear keep the pinned triage check for stage 1 (one Jev call, one page), so they are measured here but never paged twice.
const NOW = "2026-10-12T12:00:00.000Z";
const judged: AnyEntry = { ...(REGISTRY[0] as AnyEntry), id: "tool.injection" };
const row = (entry_id: string, o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id, entry_version: 1, run_id: null, tool_call_id: null, stage: "post_tool",
  rung: "system_one", verdict: "planner", p: 0.7, reason_code: null, fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: "2026-10-12T11:00:00.000Z", ...o });

describe("per-entry jev_skip_rate", () => {
  it("opens for an entry whose Jev rung failed silently at least half the time (>= 3 attempts)", () => {
    const store = RunStore.openInMemory();
    store.insertDecision(row("tool.injection", { rung: "fail", fallback_reason: "timeout", fallback_rung: "system_one" }));
    store.insertDecision(row("tool.injection", { rung: "fail", fallback_reason: "outage", fallback_rung: "system_one" }));
    store.insertDecision(row("tool.injection", {}));
    expect(checkDecisionSkipRates(store, NOW, [judged])).toEqual([{ entry: "tool.injection", open: true, attempts: 3, failed: 2 }]);
    store.close();
  });
  it("stays open until a Jev answer lands after it opened (ageing out proves nothing)", () => {
    const store = RunStore.openInMemory();
    store.openIncident({ kind: "jev_skip_rate", subject: "decision:tool.injection", detail: {}, now: "2026-10-10T00:00:00.000Z" });
    expect(checkDecisionSkipRates(store, NOW, [judged])[0]?.open).toBe(true);
    store.insertDecision(row("tool.injection", { created_at: "2026-10-12T11:30:00.000Z" }));
    expect(checkDecisionSkipRates(store, NOW, [judged])[0]?.open).toBe(false);
    store.close();
  });
  it("never pages turn.handler or turn.gear (the pinned triage check owns that page in stage 1)", () => {
    const store = RunStore.openInMemory();
    for (let k = 0; k < 4; k += 1) store.insertDecision(row("turn.handler", { rung: "fail", fallback_reason: "outage", fallback_rung: "system_one", stage: "pre_model" }));
    expect(DECISION_SKIP_RATE_EXCLUDED.has("turn.handler")).toBe(true);
    expect(checkDecisionSkipRates(store, NOW).find((r) => r.entry === "turn.handler")?.open).toBe(true);
    expect(detectViolations(store, NOW).filter((v) => v.subject.startsWith("decision:"))).toEqual([]);
    store.close();
  });
});
