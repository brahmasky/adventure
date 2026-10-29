// Stage 4B differential, approval-binding matrix (spec 2026-10-29 §6 item 4; the item list is tests/capabilities/approval-bind-matrix.test.ts,
// rebuilt in plain JS). Every omp-sink item runs on a fresh temp-file RunStore through the dist's CapabilityRunner and its real
// createToolApprovalSink; the run-level items go through CoreWorker.executeRun with force_gated_capability. Pair: s4a -> new.
//
// Compared (after id scrubbing): each attempt's result and its approval row before/after, tool_approvals, approvals, standing_approvals,
// standing_uses, ledger event types and payloads, incident rows, decisions. approval.bind rows are filtered out of the comparison by the harness
// (isBindRow) and instead REQUIRED on the new side; the old side must hold none (checked in project: a nonzero count there throws).
// Strip decisions: `bindTotal` is a per-side count (old 0, new N), so it is listed in __strip; the corpus-specific timestamp/hash keys the
// generic STRIP_KEYS lacks are listed in STRIP_HERE (they vary run to run and carry no behaviour). STRIP_KEYS itself is unchanged.
import { DISTS } from "../stage4-diff-lib.mjs";
import { INPUT_ONE_BYTE, OTHER, PACO, approvedRow, attempt, bindFixture, dump, otherRun, poke, scrubIds } from "../stage4-bind-fixture.mjs";
import { RUN_LEVEL_CASES, runLevelFixture } from "../stage4-runlevel-fixture.mjs";

const STRIP_HERE = ["sealing_started_at", "denied_until", "ended_at", "first_seen_at", "last_seen_at", "report_hash", "grant_notification_id", "duration_ms"];
// Run-level only: the fixture's adapter input embeds the random run id and the per-dist temp root, so every hash over it differs per run
// (the consume outcome is still compared: result, error, approval state). The omp items' hashes are deterministic and stay compared.
const RUN_LEVEL_HASHES = ["action_fingerprint", "adapter_input_hash", "input_hash", "output_hash"];
const FUTURE = () => new Date(Date.now() + 86_400_000).toISOString();
const MOVE = { entry_id: "tool.policy", scope: "sa_x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true };
const SCHED = { source: "schedule", approver: PACO };
const CLEANROOM = (f) => ({ run_id: f.run_id, tool_call_id: "tc_run", executor: "cleanroom" });

const standingRow = (f, state, extra = {}) => f.store.insertStandingApprovalForTest({ schedule_id: "sch_1", chat_id: "555", action_fingerprint: f.fp, state, ...extra });
const withMove = (f) => f.store.insertLadderMove(MOVE);
const refuse = (tag, extra, mk) => ({ tags: ["omp", tag, ...extra], opts: {}, run: async (f) => { await attempt(f, mk(f)); } });
const trial = (tag, state, opts, rowExtra = () => ({})) => ({ tags: ["omp", "standing_trial", tag], opts, run: async (f) => {
  const sa = standingRow(f, state, rowExtra(f));
  await attempt(f, approvedRow(f, { requester: PACO }), { standing_trial: { standing_id: sa.standing_id } });
} });

async function standingUse(f) {
  const task = f.store.addScheduledTask({ chat_id: "555", goal: "post it", spec_json: "{}", tz: "UTC", next_run_at: "2099-01-01T00:00:00.000Z" });
  poke(f, `UPDATE scheduled_tasks SET schedule_id = 'sch_1' WHERE schedule_id = ?`, task.schedule_id);
  const sa = standingRow(f, "standing", { move_id: withMove(f), expires_at: FUTURE() });
  await attempt(f, undefined, { mode: "standing", standing: { standing_id: sa.standing_id }, ctx: CLEANROOM(f) });
}

async function secondConsume(f) { const id = approvedRow(f); await attempt(f, id); await attempt(f, id); }
async function adapter(f, mode) { f.adapter.mode = mode; await attempt(f, approvedRow(f)); }
async function throwing(f) {
  const id = approvedRow(f);
  f.sink.consumeApprovedApproval = () => { throw new Error("sink exploded"); };
  await attempt(f, id, { mode: "throw" });
}

const SCENARIOS = {
  happy: { tags: ["omp", "happy"], opts: {}, run: async (f) => { await attempt(f, approvedRow(f)); } },
  unknown_other_run: refuse("unknown_approval", ["other_run"], (f) => approvedRow(f, { run_id: otherRun(f) })),
  unknown_absent: refuse("unknown_approval", ["absent"], () => "appr_does_not_exist"),
  not_approved_pending: refuse("not_approved", [], (f) => approvedRow(f, { state: "pending" })),
  not_approved_denied: refuse("not_approved", [], (f) => approvedRow(f, { state: "denied" })),
  not_approved_consumed: refuse("not_approved", [], (f) => approvedRow(f, { state: "consumed" })),
  expired: refuse("expired", [], (f) => approvedRow(f, { expires_in_ms: -1 })),
  action_mismatch_capability: refuse("action_mismatch", [], (f) => approvedRow(f, { capability: "local_project_write" })),
  action_mismatch_one_byte: refuse("action_mismatch", ["one_byte"], (f) => approvedRow(f, { input: INPUT_ONE_BYTE })),
  owner_mismatch: refuse("owner_mismatch", [], (f) => approvedRow(f, { worker_id: "w2" })),
  requester_mismatch: refuse("requester_mismatch", [], (f) => approvedRow(f, { requester: OTHER })),
  p5_swap_ok: { tags: ["omp", "p5"], opts: SCHED, run: async (f) => { await attempt(f, approvedRow(f, { requester: PACO })); } },
  p5_control: { tags: ["omp", "p5", "requester_mismatch"], opts: { source: "schedule" }, run: async (f) => { await attempt(f, approvedRow(f, { requester: PACO })); } },
  lease_lost_expired: refuse("lease_lost", ["lease_expired"], (f) => { const id = approvedRow(f); poke(f, `UPDATE runs SET lease_expires_at = ? WHERE run_id = ?`, new Date(Date.now() - 1000).toISOString(), f.run_id); return id; }),
  lease_lost_not_running: refuse("lease_lost", ["not_running"], (f) => { const id = approvedRow(f); poke(f, `UPDATE runs SET state = 'waiting_for_approval' WHERE run_id = ?`, f.run_id); return id; }),
  trial_candidate: trial("candidate", "candidate", SCHED),
  trial_streak: trial("streak", "streak", SCHED),
  trial_sealing: trial("sealing", "sealing", SCHED, (f) => ({ move_id: withMove(f), expires_at: FUTURE() })),
  trial_standing: trial("standing", "standing", SCHED, (f) => ({ move_id: withMove(f), expires_at: FUTURE() })),
  trial_ineligible: { tags: ["omp", "standing_trial", "ineligible"], opts: {}, run: async (f) => {
    const sa = standingRow(f, "candidate");
    await attempt(f, approvedRow(f), { standing_trial: { standing_id: sa.standing_id } });
  } },
  second_consume: { tags: ["omp", "second_consume"], opts: {}, run: secondConsume },
  adapter_fail: { tags: ["omp", "adapter_fail"], opts: {}, run: (f) => adapter(f, "fail") },
  adapter_timeout: { tags: ["omp", "adapter_timeout"], opts: {}, run: (f) => adapter(f, "timeout") },
  multi_expired_one_byte: refuse("multi_fault", ["expired"], (f) => approvedRow(f, { expires_in_ms: -1, input: INPUT_ONE_BYTE })),
  multi_owner_requester: refuse("multi_fault", ["owner_mismatch"], (f) => approvedRow(f, { worker_id: "w2", requester: OTHER })),
  multi_pending_expired: refuse("multi_fault", ["not_approved"], (f) => approvedRow(f, { state: "pending", expires_in_ms: -1 })),
  p2: { tags: ["p2"], opts: { forbid: true }, run: async (f) => { await attempt(f, approvedRow(f)); } },
  p3: { tags: ["p3"], opts: { sink: false }, run: async (f) => { await attempt(f, approvedRow(f)); } },
  throwing_sink: { tags: ["throwing_sink"], opts: {}, run: throwing },
  first_call: { tags: ["first_call"], opts: {}, run: async (f) => { await attempt(f, undefined, { mode: "first", tool_call_id: "tc_first" }); } },
  standing_use: { tags: ["standing_use"], opts: SCHED, expectUses: 1, run: standingUse }
};

export const BRANCHES = ["omp", "happy", "unknown_approval", "not_approved", "expired", "action_mismatch", "owner_mismatch", "requester_mismatch", "lease_lost", "p5",
  "standing_trial", "second_consume", "adapter_fail", "adapter_timeout", "multi_fault", "p2", "p3", "throwing_sink", "first_call", "standing_use", "run_level", "run_level_happy"];

function items() {
  const omp = Object.entries(SCENARIOS).map(([name, s]) => ({ key: `omp:${name}`, kind: "omp", ...s }));
  const rl = [["happy", () => undefined], ...RUN_LEVEL_CASES].map(([name, setup]) => ({ key: `runlevel:${name}`, kind: "runlevel", name, setup,
    tags: ["run_level", ...(name === "happy" ? ["run_level_happy"] : [])] }));
  return [...omp, ...rl];
}

/** A comparable view: ids and the run-level temp root scrubbed to ordered labels, so ownership (which row is which) is projected, not dropped. */
async function projectOmp(d, item) {
  const f = bindFixture(d, item.key, item.opts);
  try {
    await item.run(f);
    const bindTotal = f.attempts.reduce((n, a) => n + a.newBind.length, 0);
    const all = dump(f);
    const view = scrubIds({ kind: "omp", attempts: f.attempts, dump: all });
    return { ...view, bindTotal, __strip: [...STRIP_HERE, "bindTotal"] };
  } finally { f.close(); }
}

async function projectRunLevel(d, item) {
  const f = await runLevelFixture(d, item.name);
  try {
    item.setup(f);
    const done = await f.resume();
    const all = dump(f);
    const view = scrubIds({ kind: "runlevel", done, approvalState: f.approvalState(), dump: all }, [f.root]);
    return { ...view, bindTotal: all.decisions.filter((r) => r.entry_id === "approval.bind").length, decisionRows: all.decisions.length, __strip: [...STRIP_HERE, ...RUN_LEVEL_HASHES, "bindTotal"] };
  } finally { f.close(); }
}

function required(d, item, proj) {
  const bad = [];
  if (item.kind === "runlevel") {
    if (proj.bindTotal !== 0) bad.push(`run-level path wrote ${proj.bindTotal} approval.bind rows`);
    const want = item.name === "happy" ? "completed" : "failed";
    if (proj.done.status !== want || (want === "failed" && !String(proj.done.error).startsWith(`${item.name.toUpperCase()}:`))) bad.push(`run-level outcome ${proj.done.status}/${proj.done.error} is not ${want}/${item.name.toUpperCase()}`);
    if (proj.decisionRows !== 0) bad.push(`run-level path wrote ${proj.decisionRows} decisions rows`);
  } else bad.push(...checkOmp(item, proj));
  if (bad.length) throw new Error(bad.join("; "));
}

function checkOmp(item, proj) {
  const bad = [];
  proj.attempts.forEach((a, i) => { const m = checkAttempt(a); if (m) bad.push(`attempt ${i + 1}: ${m}`); });
  const claimed = proj.attempts.flatMap((a) => a.newBind);
  const table = proj.dump.decisions.filter((r) => r.entry_id === "approval.bind");
  if (JSON.stringify(table.map((r) => [r.verdict, r.reason_code, r.tool_call_id])) !== JSON.stringify(claimed.map((r) => [r.verdict, r.reason_code, r.tool_call_id]))) bad.push("decisions table bind rows differ from the per-attempt rows");
  const other = proj.dump.decisions.filter((r) => !["approval.bind", "tool.policy"].includes(r.entry_id));
  if (other.length) bad.push(`unexpected decision entries: ${[...new Set(other.map((r) => r.entry_id))].join(",")}`);
  if (item.expectUses !== undefined && proj.dump.standing_uses.length !== item.expectUses) bad.push(`standing_uses ${proj.dump.standing_uses.length} != ${item.expectUses}`);
  return bad;
}

/** The per-attempt oracle: bound <=> this call moved the approval row approved -> consumed (read before and after), never the final result. */
function checkAttempt(a) {
  const rows = a.newBind;
  if (rows.some((r) => r.tool_call_id !== a.tool_call_id)) return `approval.bind row carries tool_call_id ${rows.find((r) => r.tool_call_id !== a.tool_call_id).tool_call_id}, the call's is ${a.tool_call_id}`;
  if (a.mode === "p3") return JSON.stringify(rows.map((r) => [r.verdict, r.reason_code])) === JSON.stringify([["unbound", "no_sink"]]) ? null : "P3 must be exactly one unbound/no_sink row";
  if (a.mode !== "omp") return rows.length === 0 ? null : `${a.mode} wrote ${rows.length} approval.bind rows`;
  if (rows.length !== 1) return `${rows.length} approval.bind rows for one consume (need exactly 1)`;
  const bound = a.before === "approved" && a.after === "consumed";
  const code = a.result?.status === "failed" ? /^([a-z_]+): /.exec(a.result.error_ref ?? "")?.[1] ?? null : null;
  if (bound) return rows[0].verdict === "bound" && rows[0].reason_code === null ? null : `consume moved approved -> consumed but row is ${rows[0].verdict}/${rows[0].reason_code}`;
  if (code === null) return "unbound attempt with no sink code in the result";
  return rows[0].verdict === "unbound" && rows[0].reason_code === code ? null : `row ${rows[0].verdict}/${rows[0].reason_code}, expected unbound/${code} (before ${a.before}, after ${a.after})`;
}

export default {
  name: "binding",
  pairs: [["s4a", "new"]],
  min: { items: 40, branches: BRANCHES },
  async load() { return items(); },
  async project(d, item) {
    const proj = item.kind === "runlevel" ? await projectRunLevel(d, item) : await projectOmp(d, item);
    if (d.dir !== DISTS.new && proj.bindTotal !== 0) throw new Error(`control failed: the old build wrote ${proj.bindTotal} approval.bind rows`);
    return proj;
  },
  required
};
