// The run-level sink fixture (spec 2026-10-29 §6 item 4, "through the eval fixture seam"): a port of runLevelFixture in
// tests/capabilities/approval-bind-matrix.test.ts. force_gated_capability -> CoreWorker.executeRun parks on an approval -> the approval is
// granted -> a second executeRun consumes it through the store's run-level consume (no recorder on this path). Not a corpus.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACO } from "./stage4-bind-fixture.mjs";
import { mkStore, mkTemp } from "./stage4-diff-lib.mjs";

const NO_OMP_BIN = "/nonexistent/houge-tests/omp"; // the same pin as tests/helpers/omp-env.ts: nothing here can reach a real omp

/** Builds the parked-and-approved fixture on a fresh temp store. `resume()` runs the second executeRun. */
export async function runLevelFixture(d, name) {
  const root = mkTemp(`runlevel-${name}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "Rules");
  const store = mkStore(d, "bare", join(root, "runlevel.sqlite"));
  const intake = new d.Gateway(store).intake(d.buildTypedTaskEvent({
    source: "cli", type: "run", program: "research-brief", goal: "force approval fixture", requested_by: PACO, notify: { kind: "local" },
    idempotency_key: "cli:bind-runlevel:1", source_reference: "argv", metadata: { force_gated_capability: true }
  }));
  if (!intake.ok) throw new Error("run-level intake failed");
  const savedBin = process.env.HOUGE_OMP_BIN;
  process.env.HOUGE_OMP_BIN = NO_OMP_BIN;
  try {
    const parked = await new d.CoreWorker(store, root).executeRun(intake.run_id, "eval-worker");
    if (parked.status !== "waiting_for_approval") throw new Error(`run-level fixture: expected an approval wait, got ${parked.status}`);
    const pending = store.getApprovalForRun(intake.run_id, "pending");
    if (!pending) throw new Error("run-level fixture: no pending approval");
    store.processApprovalTrigger({ event: d.buildTypedTaskEvent({ source: "telegram", type: "approve", approval_id: pending.approval_id, requested_by: PACO,
      notify: { kind: "telegram", chat_id: "222" }, idempotency_key: "telegram:bind-runlevel-approve:1", source_reference: "telegram:update:20:message:1" }),
      decision: "approved", resolved_at: "2026-05-28T00:10:00.000Z" });
    const real = store.getApprovedActionForRun(intake.run_id);
    if (!real) throw new Error("run-level fixture: no approved action");
    return { d, store, root, run_id: intake.run_id, approval_id: pending.approval_id, real, savedBin,
      resume: () => new d.CoreWorker(store, root).executeRun(intake.run_id, "eval-worker"),
      feed: (action) => { store.getApprovedActionForRun = () => action; }, // the stored row is tampered, the worker is handed the untampered action
      poke: (sql, ...a) => store.db.prepare(sql).run(...a),
      approvalState: () => store.db.prepare(`SELECT state FROM approvals WHERE approval_id = ?`).get(pending.approval_id)?.state ?? null,
      close: () => { if (savedBin === undefined) delete process.env.HOUGE_OMP_BIN; else process.env.HOUGE_OMP_BIN = savedBin; try { store.close(); } catch { /* closed */ } } };
  } catch (e) {
    if (savedBin === undefined) delete process.env.HOUGE_OMP_BIN; else process.env.HOUGE_OMP_BIN = savedBin;
    throw e;
  }
}

/** The eight run-level refusals, each by its real precondition (the test file's CODES table, plus RUN_NOT_RUNNING). */
export const RUN_LEVEL_CASES = [
  ["approval_not_found", (f) => f.feed({ ...f.real, approval_id: "appr_missing" })],
  ["approval_not_approved", (f) => { f.poke(`UPDATE approvals SET state = 'pending' WHERE approval_id = ?`, f.approval_id); f.feed(f.real); }],
  ["approval_requester_mismatch", (f) => { f.poke(`UPDATE approvals SET requester_json = ? WHERE approval_id = ?`, JSON.stringify({ kind: "user", id: "mallory" }), f.approval_id); f.feed(f.real); }],
  ["approval_run_mismatch", (f) => { f.poke(`UPDATE approvals SET run_id = 'run_other' WHERE approval_id = ?`, f.approval_id); f.feed(f.real); }],
  ["approval_capability_mismatch", (f) => { f.poke(`UPDATE approvals SET capability = 'other_cap' WHERE approval_id = ?`, f.approval_id); f.feed(f.real); }],
  ["approval_input_mismatch", (f) => { f.poke(`UPDATE approvals SET adapter_input_hash = 'deadbeef' WHERE approval_id = ?`, f.approval_id); f.feed(f.real); }],
  ["approval_action_mismatch", (f) => { f.poke(`UPDATE approvals SET action_fingerprint = 'deadbeef' WHERE approval_id = ?`, f.approval_id); f.feed(f.real); }],
  ["run_not_running", (f) => { f.store.getApprovedActionForRun = () => { f.poke(`UPDATE runs SET state = 'cancelled' WHERE run_id = ?`, f.run_id); return f.real; }; }]
];
