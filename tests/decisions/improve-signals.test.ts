import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { correctionValue, recordApprovalDenied, recordApprovalExpired, recordCorrection, recordImproveSignal, skipImproveSignal } from "../../src/decisions/improve-signals.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Spec 2b-ii §2: a producer never throws into its caller; what it cannot insert becomes an improve_signal_skipped event the
// Watch line counts per family, so a silent producer is visible. The four worker/gateway/bridge call sites are pinned by grep
// (the live gate's cases 3 and 5 exercise two of them end to end).
const NOW = "2026-10-21T10:00:00.000Z";
const skipped = (s: RunStore) => s.listLedgerEventsByTypeSince("improve_signal_skipped", "2026-01-01T00:00:00.000Z").map((e) => e.payload);
const verdictOf = (s: RunStore, run_id: string, category: "lookup" | null) => {
  s.insertJevVerdict({ run_id, category, breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "planner", role: "default", effort: null, cascade: null,
    save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null, quoted_turn_id: null });
  return s.getJevVerdictForRun(run_id)!;
};

describe("recordImproveSignal", () => {
  it("inserts a row and returns true; a refused value writes improve_signal_skipped {signal, code: refused} and returns false; nothing throws", () => {
    const s = RunStore.openInMemory();
    expect(recordImproveSignal(s, { signal: "rating", value: 2, run_id: null, chat_id: "555", about_run_id: "run_a", created_at: NOW })).toBe(true);
    expect(recordImproveSignal(s, { signal: "rating", value: 9, run_id: null, chat_id: "555", about_run_id: "run_a", created_at: NOW })).toBe(false);
    expect(skipped(s)).toEqual([{ signal: "rating", code: "refused", run_id: "run_a" }]);
    skipImproveSignal(s, "correction", "no_run");
    expect(skipped(s).at(-1)).toEqual({ signal: "correction", code: "no_run" });
  });
  it("correctionValue maps a null category to other", () => {
    expect(correctionValue(null)).toBe("other");
    expect(correctionValue("lookup")).toBe("lookup");
  });
  it("recordCorrection labels the corrected turn with its category and the correcting run", () => {
    const s = RunStore.openInMemory();
    const a = createQueuedTurnRun(s, "a");
    const v = verdictOf(s, a, "lookup");
    expect(recordCorrection(s, { about: v, run_id: "run_b", chat_id: "555", now: NOW })).toBe(true);
    expect(s.listUnconsumedSignals(5).map((r) => [r.signal, r.value, r.run_id, r.about_run_id, r.chat_id])).toEqual([["correction", "lookup", "run_b", a, "555"]]);
  });
  it("recordApprovalDenied / recordApprovalExpired take the capability from the approval row; a missing row is no_capability", () => {
    const s = RunStore.openInMemory();
    const a = createQueuedTurnRun(s, "a");
    const id = s.createToolApproval({ run_id: a, worker_id: "planner:555", tool_call_id: "c1", capability: "shell_external", input_hash: "h", action_fingerprint: "f",
      requester: { kind: "user", id: "paco" }, summary: "ls", side_effect_level: "external_write", expires_at: "2026-10-21T11:00:00.000Z" }).approval_id;
    expect(recordApprovalDenied(s, { run_id: a, approval_id: id, chat_id: "555", now: NOW })).toBe(true);
    expect(recordApprovalExpired(s, { run_id: a, approval_id: id, now: NOW })).toBe(true);
    expect(recordApprovalExpired(s, { run_id: a, approval_id: "appr_missing", now: NOW })).toBe(false);
    expect(s.listUnconsumedSignals(5).map((r) => [r.signal, r.value, r.about_run_id, r.chat_id])).toEqual([["approval_denied", "shell_external", a, "555"], ["approval_expired", "shell_external", a, "555"]]);
    expect(skipped(s)).toEqual([{ signal: "approval_expired", code: "no_capability", run_id: a }]);
  });
  it("the call sites exist: the memory lane's fix hand-off, the ask-anyway tap, the escalation end, the low rating, the rating capture, the denial, the expiry", () => {
    const worker = readFileSync("src/core/core-worker.ts", "utf8"); const gateway = readFileSync("src/gateway/gateway.ts", "utf8");
    const memlane = readFileSync("src/gateway/memlane-commands.ts", "utf8"); const bridge = readFileSync("src/omp/bridge-handler.ts", "utf8");
    expect((worker.match(/recordCorrection\(/g) ?? []).length).toBeGreaterThanOrEqual(2);   // saveThenRoute (fix) and ompRouteEnd (escalation)
    expect(memlane).toContain("recordCorrection(");                                          // ask_anyway
    expect((gateway.match(/recordCorrection\(/g) ?? []).length).toBeGreaterThanOrEqual(1);   // low_rating
    expect(gateway).toContain("signal: \"rating\"");
    expect(gateway).toContain("recordApprovalDenied(");
    expect(bridge.indexOf("recordApprovalExpired(")).toBeGreaterThan(bridge.indexOf("expireToolApproval("));
  });
});
