// The policy matrix's runner harness (spec 2026-10-29 §6 item 3): one temp store and one running run per dist, a stub approval sink and a stub
// adapter, so CapabilityRunner.execute reaches its tool.policy decision for any (capability, contract) cell without running anything.
// Not a corpus (the CLI loads scripts/stage4-corpora/*.mjs only).
import { join } from "node:path";
import { makeRun } from "./stage4-bind-fixture.mjs";
import { mkStore, mkTemp } from "./stage4-diff-lib.mjs";

const BUDGET = { time_minutes: 5, max_tool_calls: 1_000_000, max_agent_delegations: 0 };
const rigs = new WeakMap();

function rigFor(d) {
  if (rigs.has(d)) return rigs.get(d);
  const store = mkStore(d, "bare", join(mkTemp("policy"), "policy.sqlite"));
  const rig = { store, run_id: makeRun(d, store, "user", 1), n: 0, recorder: d.storeRecorder(store) };
  rigs.set(d, rig);
  return rig;
}

const rowsFor = (rig, tool_call_id) => (typeof rig.store.listDecisionsForRun === "function" ? rig.store.listDecisionsForRun(rig.run_id) : [])
  .filter((r) => r.entry_id === "tool.policy" && r.tool_call_id === tool_call_id).map((r) => ({ verdict: r.verdict, reason_code: r.reason_code }));

function runnerFor(d, cap, won) {
  const registry = new d.ToolRegistry();
  registry.register({ name: cap.name, category: cap.category, side_effect_level: cap.side_effect_level, risk_level: cap.risk_level, timeout_ms: 1_000,
    output_limit_bytes: 10_000, execute: async () => ({ ok: true, output: { ran: true } }) });
  const sink = { requestApproval: () => ({ approval_id: "appr_stub" }),
    consumeApprovedApproval: () => { throw new Error("policy matrix never consumes"); },
    standingUse: () => (won ? { ok: true, move_id: "lm_stub" } : { ok: false, code: "lost" }) };
  return new d.CapabilityRunner(registry, sink);
}

/**
 * Runs the cell's call twice with one tool_call_id (the recorder skips a repeat verdict for the same (run, call, entry)): the result and rows of
 * the first call, the row count after it and after the repeat. `won` puts the call in the clean room with a winning standing CAS.
 */
export async function policyRun(d, cap, decisionInput, won) {
  const rig = rigFor(d);
  const tool_call_id = `tc_policy_${++rig.n}`;
  const contract = { objective: "policy matrix", budget: BUDGET, allowed_actions: decisionInput.allowed_actions, forbidden_actions: decisionInput.forbidden_actions,
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" }, approval_gates: decisionInput.approval_gates, stop_condition: "done", contract_hash: "h", eval_hooks: [] };
  const runner = runnerFor(d, cap, won);
  const call = () => runner.execute({ run_id: rig.run_id, requester: { kind: "user", id: "paco" }, contract, capability: cap.name, input: { command: "x" },
    budget: new d.BudgetLedger(BUDGET), recorder: rig.recorder, tool_call_id, action_summary: "policy matrix",
    ...(decisionInput.trust_ask ? { trust_ask: true } : {}), ...(decisionInput.standing ? { standing: decisionInput.standing } : {}) },
  won ? { run_id: rig.run_id, tool_call_id, executor: "cleanroom" } : undefined);
  const result = await call();
  const rows = rowsFor(rig, tool_call_id);
  await call();
  return { result, rows, rowCount: rows.length, repeatCount: rowsFor(rig, tool_call_id).length };
}
