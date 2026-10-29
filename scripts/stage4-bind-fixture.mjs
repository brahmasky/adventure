// The binding fixture shared by the binding corpus (spec 2026-10-29 §6 item 4), a plain-JS port of bindFixture in
// tests/capabilities/approval-bind-matrix.test.ts: a fresh temp-file RunStore per item, a running run leased to w1, the dist's real
// omp sink, a CapabilityRunner over a stub registry. Not a corpus (the CLI loads scripts/stage4-corpora/*.mjs only).
// Every attempt records its own approval-row state before and after the call: that pair is the verdict oracle, never the final result.
import { join } from "node:path";
import { mkStore, mkTemp } from "./stage4-diff-lib.mjs";

export const W = "w1";
export const CHAT = "555";
export const LEASE_S = 86_400 * 400;
export const PACO = { kind: "user", id: "paco" };
export const OTHER = { kind: "user", id: "mallory" };
export const SCHEDULE = { kind: "schedule", id: "sch_1" };
export const INPUT = { command: "curl -X POST https://example.test/post" };
export const INPUT_ONE_BYTE = { command: "curl -X POST https://example.test/posu" };
export const META = { side_effect_level: "external_write", risk_level: "medium" };
const BUDGET = { time_minutes: 5, max_tool_calls: 50, max_agent_delegations: 0 };

export const contract = (forbidden = []) => ({
  objective: "bind matrix", budget: BUDGET, allowed_actions: ["shell_external"], forbidden_actions: forbidden,
  output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" }, approval_gates: ["external_write"],
  stop_condition: "done", contract_hash: "h", eval_hooks: []
});

export function makeRun(d, store, source, n, claim = true) {
  const ev = source === "schedule"
    ? d.buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "post it", requested_by: SCHEDULE, notify: { kind: "telegram", chat_id: CHAT },
        idempotency_key: `schedule:sch_1:${n}`, source_reference: "scheduled_tasks.sch_1" })
    : d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: "post it", requested_by: PACO, notify: { kind: "telegram", chat_id: CHAT },
        idempotency_key: `telegram:${n}`, source_reference: `telegram:update:${n}:message:1` });
  const r = new d.Gateway(store).intake(ev);
  if (!r.ok) throw new Error(`bind fixture intake failed: ${JSON.stringify(r)}`);
  if (claim) store.claimRun(r.run_id, W, LEASE_S);
  return r.run_id;
}

const rawRows = (store, sql) => store.db.prepare(sql).all();
const parseJsonCols = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
  if (!k.endsWith("_json") || typeof v !== "string") return [k, v];
  try { return [k, JSON.parse(v)]; } catch { return [k, v]; }
}));
const DECISION_COLS = "entry_id, tool_call_id, stage, rung, verdict, reason_code, armed_mode, fallback_reason";
const UUID_ID = /\b([a-z]+)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/** Random uuid ids -> `kind#n` in order of first appearance; the same id gets the same label everywhere, so ownership survives. */
export function scrubIds(value, roots = []) {
  const seen = new Map();
  const text = roots.reduce((t, r) => t.split(r).join("<root>"), JSON.stringify(value)).replace(UUID_ID, (m, kind) => {
    if (!seen.has(m)) seen.set(m, `${kind}#${[...seen.values()].filter((x) => x.startsWith(`${kind}#`)).length + 1}`);
    return seen.get(m);
  });
  return JSON.parse(text);
}

function makeRegistry(d, adapter) {
  const registry = new d.ToolRegistry();
  const wait = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, output: { ran: true } }), 300));
  registry.register({ name: "shell_external", category: "tool", ...META, timeout_ms: 40, output_limit_bytes: 10_000,
    execute: () => adapter.mode === "ok" ? Promise.resolve({ ok: true, output: { ran: true } })
      : adapter.mode === "fail" ? Promise.resolve({ ok: false, error: "adapter boom" }) : wait() });
  return registry;
}

/** One fixture per item: opts = { source: "user" | "schedule", approver, sink: false, forbid: true }. Close it with f.close(). */
export function bindFixture(d, name, opts = {}) {
  const store = mkStore(d, "bare", join(mkTemp(`bind-${name}`), "bind.sqlite"));
  const source = opts.source ?? "user";
  const f = { d, store, opts, seq: 0, adapter: { mode: "ok" }, attempts: [] };
  f.run_id = makeRun(d, store, source, ++f.seq);
  f.requester = source === "schedule" ? SCHEDULE : PACO;
  f.sink = d.createToolApprovalSink({ store, worker_id: W, tool_call_id: "tc_sink", approvalTimeoutMs: 60_000, ...(opts.approver ? { approver: opts.approver } : {}) });
  f.runner = new d.CapabilityRunner(makeRegistry(d, f.adapter), opts.sink === false ? undefined : f.sink);
  f.recorder = d.storeRecorder(store);
  f.fp = d.actionFingerprint("shell_external", META, INPUT);
  f.close = () => { try { store.close(); } catch { /* a closed handle is not a finding */ } };
  return f;
}

export function approvedRow(f, x = {}) {
  const input = x.input ?? INPUT;
  const row = f.store.createToolApproval({
    run_id: x.run_id ?? f.run_id, worker_id: x.worker_id ?? W, tool_call_id: `tc_row_${++f.seq}`, capability: x.capability ?? "shell_external",
    input_hash: f.d.stableHash(input), action_fingerprint: f.d.actionFingerprint("shell_external", META, input), requester: x.requester ?? (f.opts.approver ?? f.requester),
    summary: "HTTP write", side_effect_level: "external_write", expires_at: new Date(Date.now() + 86_400_000).toISOString()
  });
  const state = x.state ?? "approved";
  if (state === "approved" || state === "consumed") f.store.resolveToolApprovalForTest(row.approval_id, "approved");
  if (state === "denied") f.store.resolveToolApprovalForTest(row.approval_id, "denied");
  const run = (sql, ...a) => f.store.db.prepare(sql).run(...a);
  if (state === "consumed") run(`UPDATE tool_approvals SET state = 'consumed' WHERE approval_id = ?`, row.approval_id);
  if (x.expires_in_ms !== undefined) run(`UPDATE tool_approvals SET expires_at = ? WHERE approval_id = ?`, new Date(Date.now() + x.expires_in_ms).toISOString(), row.approval_id);
  return row.approval_id;
}

export const otherRun = (f) => makeRun(f.d, f.store, "user", ++f.seq, false);
export const poke = (f, sql, ...a) => f.store.db.prepare(sql).run(...a);

const bindRows = (f) => f.store.listDecisionsForRun(f.run_id).filter((r) => r.entry_id === "approval.bind")
  .map((r) => ({ entry_id: r.entry_id, verdict: r.verdict, reason_code: r.reason_code, tool_call_id: r.tool_call_id }));
const stateOf = (f, id) => f.store.getToolApproval(id)?.state ?? null;

/**
 * One resume through the runner. mode: "omp" (consume through the omp sink), "p2" (contract now denies), "p3" (no sink), "first" (no approval id),
 * "throw" (the sink throws), "standing" (a standing selector, no approval id). Records the approval row's state before and after THIS call.
 */
export async function attempt(f, approved_approval_id, x = {}) {
  const mode = x.mode ?? (f.opts.forbid ? "p2" : f.opts.sink === false ? "p3" : "omp");
  const before = approved_approval_id ? stateOf(f, approved_approval_id) : null;
  const rows0 = bindRows(f).length;
  const input = { run_id: f.run_id, requester: x.requester ?? f.requester, contract: contract(f.opts.forbid ? ["shell_external"] : []), capability: "shell_external", input: INPUT,
    budget: new f.d.BudgetLedger(BUDGET), recorder: f.recorder, tool_call_id: x.tool_call_id ?? "tc_run", action_summary: "HTTP write",
    ...(approved_approval_id ? { approved_approval_id, budget_reserved: true } : {}), ...(x.standing_trial ? { standing_trial: x.standing_trial } : {}), ...(x.standing ? { standing: x.standing } : {}) };
  let result = null;
  let threw = null;
  try { result = await f.runner.execute(input, x.ctx); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  const rec = { mode, tool_call_id: input.tool_call_id, before, after: approved_approval_id ? stateOf(f, approved_approval_id) : null, result, threw, newBind: bindRows(f).slice(rows0) };
  f.attempts.push(rec);
  return rec;
}

/** Every table the spec compares, as stable rows: approvals (both), standing rows and uses, the run's ledger, incidents, decisions. */
export function dump(f) {
  const t = (sql) => rawRows(f.store, sql).map(parseJsonCols);
  return {
    tool_approvals: t(`SELECT * FROM tool_approvals ORDER BY rowid`), approvals: t(`SELECT * FROM approvals ORDER BY rowid`),
    standing_approvals: t(`SELECT * FROM standing_approvals ORDER BY rowid`), standing_uses: t(`SELECT * FROM standing_uses ORDER BY rowid`),
    ledger: t(`SELECT event_type, actor, sequence, payload_json FROM ledger_events ORDER BY rowid`), incidents: t(`SELECT * FROM incidents ORDER BY rowid`),
    decisions: t(`SELECT ${DECISION_COLS} FROM decisions ORDER BY rowid`)
  };
}
