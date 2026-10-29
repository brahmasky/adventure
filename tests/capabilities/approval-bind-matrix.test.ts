import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { actionFingerprint, CapabilityRunner, type CapabilityResult } from "../../src/capabilities/capability-runner.js";
import { CoreWorker } from "../../src/core/core-worker.js";
import { storeRecorder } from "../../src/decisions/record.js";
import { stableHash } from "../../src/domain/canonical.js";
import { buildTypedTaskEvent, type CompiledTaskContract, type Identity } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { createToolApprovalSink } from "../../src/omp/tool-approval-sink.js";
import { RunStore } from "../../src/run/run-store.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { pinOmpEnv } from "../helpers/omp-env.js";

// Stage 4B Task 1: today's consume binding, pinned BEFORE it moves behind a decision-ladder entry (spec §2.1 P1–P7, §6 item 4).
// Every case reads the outcome back from the stores, never from the runner's say-so: the result bytes, the approval row,
// the standing rows, the run's new ledger events and the decisions rows. Later tasks add row assertions to these cases.
pinOmpEnv();

const W = "w1";
const PACO: Identity = { kind: "user", id: "paco" };
const OTHER: Identity = { kind: "user", id: "mallory" };
const CHAT = "555";
const LEASE_S = 86_400 * 400;
const INPUT = { command: "curl -X POST https://example.test/post" };
const INPUT_ONE_BYTE = { command: "curl -X POST https://example.test/posu" }; // one byte changed
const META = { side_effect_level: "external_write", risk_level: "medium" } as const;
const FP = actionFingerprint("shell_external", META, INPUT);
const contract = (forbidden: string[] = []): CompiledTaskContract => ({
  objective: "bind matrix", budget: { time_minutes: 5, max_tool_calls: 5, max_agent_delegations: 0 }, allowed_actions: ["shell_external"],
  forbidden_actions: forbidden, output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" }, approval_gates: ["external_write"],
  stop_condition: "done", contract_hash: "h", eval_hooks: []
});

type AdapterMode = "ok" | "fail" | "timeout";
type RowState = "pending" | "approved" | "denied" | "consumed";
interface RawDb { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown }; exec(sql: string): void }
const rawDb = (s: RunStore): RawDb => s["db"] as unknown as RawDb;
let seq = 0;

function makeRun(store: RunStore, source: "user" | "schedule", claim = true): string {
  const n = ++seq;
  const ev = source === "schedule"
    ? buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "post it", requested_by: { kind: "schedule", id: "sch_1" }, notify: { kind: "telegram", chat_id: CHAT },
        idempotency_key: `schedule:sch_1:${n}`, source_reference: "scheduled_tasks.sch_1" })
    : buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: "post it", requested_by: PACO, notify: { kind: "telegram", chat_id: CHAT },
        idempotency_key: `telegram:${n}`, source_reference: `telegram:update:${n}:message:1` });
  const r = new Gateway(store).intake(ev);
  if (!r.ok) throw new Error(JSON.stringify(r));
  if (claim) store.claimRun(r.run_id, W, LEASE_S);
  return r.run_id;
}

interface ApprovedRowOpts {
  run_id?: string; worker_id?: string; requester?: Identity; capability?: string; input?: Record<string, unknown>; fingerprint?: string;
  state?: RowState; expires_in_ms?: number;
}

/** The binding fixture: a real in-memory store, a running run leased to w1, the real omp sink, a runner over a stub registry. */
function bindFixture(o: { source?: "user" | "schedule"; approver?: Identity; sink?: boolean; forbid?: boolean } = {}) {
  const store = RunStore.openInMemory();
  const source = o.source ?? "user";
  const run_id = makeRun(store, source);
  const adapter: { mode: AdapterMode } = { mode: "ok" };
  const registry = new ToolRegistry();
  registry.register({
    name: "shell_external", category: "tool", ...META, timeout_ms: 40, output_limit_bytes: 10_000,
    execute: () => adapter.mode === "ok" ? Promise.resolve({ ok: true, output: { ran: true } })
      : adapter.mode === "fail" ? Promise.resolve({ ok: false, error: "adapter boom" })
      : new Promise((resolve) => setTimeout(() => resolve({ ok: true, output: { ran: true } }), 300))
  });
  const sink = createToolApprovalSink({ store, worker_id: W, tool_call_id: "tc_sink", approvalTimeoutMs: 60_000, ...(o.approver ? { approver: o.approver } : {}) });
  const runner = new CapabilityRunner(registry, o.sink === false ? undefined : sink);
  const recorder = storeRecorder(store);
  const requester: Identity = source === "schedule" ? { kind: "schedule", id: "sch_1" } : PACO;

  function approvedRow(x: ApprovedRowOpts = {}): string {
    const input = x.input ?? INPUT;
    const row = store.createToolApproval({
      run_id: x.run_id ?? run_id, worker_id: x.worker_id ?? W, tool_call_id: `tc_row_${++seq}`, capability: x.capability ?? "shell_external",
      input_hash: stableHash(input), action_fingerprint: x.fingerprint ?? actionFingerprint("shell_external", META, input), requester: x.requester ?? (o.approver ?? requester),
      summary: "HTTP write", side_effect_level: "external_write", expires_at: new Date(Date.now() + 86_400_000).toISOString()
    });
    const state = x.state ?? "approved";
    if (state === "approved" || state === "consumed") store.resolveToolApprovalForTest(row.approval_id, "approved");
    if (state === "denied") store.resolveToolApprovalForTest(row.approval_id, "denied");
    if (state === "consumed") rawDb(store).prepare(`UPDATE tool_approvals SET state = 'consumed' WHERE approval_id = ?`).run(row.approval_id);
    if (x.expires_in_ms !== undefined) rawDb(store).prepare(`UPDATE tool_approvals SET expires_at = ? WHERE approval_id = ?`).run(new Date(Date.now() + x.expires_in_ms).toISOString(), row.approval_id);
    return row.approval_id;
  }
  const eventTypes = (): string[] => store.getLedgerEvents(run_id).map((e) => e.event_type);
  /** Runs one resume and returns the result with the ledger events it added to this run. */
  async function execute(approved_approval_id: string, x: { standing_trial?: { standing_id: string }; requester?: Identity } = {}): Promise<{ result: CapabilityResult; added: string[] }> {
    const before = eventTypes().length;
    const result = await runner.execute({
      run_id, requester: x.requester ?? requester, approved_approval_id, contract: contract(o.forbid ? ["shell_external"] : []), capability: "shell_external", input: INPUT,
      budget: new BudgetLedger(contract().budget), budget_reserved: true, recorder, tool_call_id: "tc_run", action_summary: "HTTP write",
      ...(x.standing_trial ? { standing_trial: x.standing_trial } : {})
    });
    return { result, added: eventTypes().slice(before) };
  }
  return {
    store, run_id, adapter, approvedRow, execute, requester,
    /** the decisions rows the runner's recorder wrote for this run — what the matrix must keep identical when the consume moves */
    get recorded(): Array<{ entry_id: string; verdict: string; reason_code: string | null }> {
      return store.listDecisionsForRun(run_id).map((d) => ({ entry_id: d.entry_id, verdict: d.verdict, reason_code: d.reason_code }));
    },
    state: (id: string): string | undefined => store.getToolApproval(id)?.state,
    standingUses: (): number => (rawDb(store).prepare(`SELECT COUNT(*) AS n FROM standing_uses`).get() as { n: number }).n,
    otherRun: () => makeRun(store, "user", false)
  };
}

// output_hash is sha256 of the canonical adapter output {"ran":true}, a literal (checked with `printf '{"ran":true}' | shasum -a 256`), not computed here
const OK: CapabilityResult = { status: "succeeded", output_ref: "inline:shell_external", output_hash: "f9065a2a435e2e3efc39980ff31f9ea29ba970e700e9ecf6a0645f82a18f7bda", output: { ran: true } };
const refused = (code: string): CapabilityResult => ({ status: "failed", error_ref: `${code}: ${code}` });
/** Every refusal: the result bytes are the code twice, the policy row is the only decision recorded, and the caller reads the row back itself. */
async function expectRefused(f: ReturnType<typeof bindFixture>, id: string, code: string, rowState = "approved"): Promise<void> {
  const { result, added } = await f.execute(id);
  expect(result).toEqual(refused(code));
  expect(f.state(id)).toBe(rowState); // a refusal never moves the approval row
  expect(added).toEqual([]); // nothing reached the run's ledger
  expect(f.store.listStandingApprovals()).toEqual([]); // no standing row created or touched
  expect(f.standingUses()).toBe(0);
  expect(f.recorded).toEqual(POLICY_ROWS);
}
const POLICY_ROWS = [{ entry_id: "tool.policy", verdict: "requires_approval", reason_code: "gated_side_effect" }];

describe("approval consume binding through CapabilityRunner + the omp sink (today's behaviour, P1–P6)", () => {
  it("happy path: an approved row bound to these exact bytes is consumed and the adapter runs once", async () => {
    const f = bindFixture();
    const id = f.approvedRow();
    const { result, added } = await f.execute(id);
    expect(result).toEqual(OK);
    expect(f.state(id)).toBe("consumed");
    expect(added).toEqual([]);
    expect(f.recorded).toEqual(POLICY_ROWS);
  });

  it("unknown_approval: a row that belongs to another run is refused as if absent (a stolen approval id buys nothing)", async () => {
    const f = bindFixture();
    const id = f.approvedRow({ run_id: f.otherRun() });
    await expectRefused(f, id, "unknown_approval");
    expect(f.state(id)).toBe("approved");
  });

  it("unknown_approval: no row at all", async () => {
    const f = bindFixture();
    const { result, added } = await f.execute("appr_does_not_exist");
    expect(result).toEqual(refused("unknown_approval"));
    expect(added).toEqual([]);
    expect(f.store.listStandingApprovals()).toEqual([]);
    expect(f.standingUses()).toBe(0);
    expect(f.recorded).toEqual(POLICY_ROWS);
  });

  it.each<RowState>(["pending", "denied", "consumed"])("not_approved: a %s row never authorises, and its state is left as found", async (state) => {
    const f = bindFixture();
    const id = f.approvedRow({ state });
    await expectRefused(f, id, "not_approved", state);
  });

  it("expired: expires_at 1 ms in the past refuses, and the row stays approved (nothing consumed)", async () => {
    const f = bindFixture();
    const id = f.approvedRow({ expires_in_ms: -1 });
    await expectRefused(f, id, "expired");
    expect(f.state(id)).toBe("approved");
  });

  it("action_mismatch: the row was approved for a different capability", async () => {
    const f = bindFixture();
    const id = f.approvedRow({ capability: "local_project_write" });
    await expectRefused(f, id, "action_mismatch");
    expect(f.state(id)).toBe("approved");
  });

  it("action_mismatch: one byte of the input differs from what the human approved", async () => {
    const f = bindFixture();
    const id = f.approvedRow({ input: INPUT_ONE_BYTE });
    await expectRefused(f, id, "action_mismatch");
    expect(f.state(id)).toBe("approved");
  });

  it("owner_mismatch: a row opened by another worker cannot be spent by w1", async () => {
    const f = bindFixture();
    const id = f.approvedRow({ worker_id: "w2" });
    await expectRefused(f, id, "owner_mismatch");
    expect(f.state(id)).toBe("approved");
  });

  it("requester_mismatch: a row approved for another identity is refused", async () => {
    const f = bindFixture();
    const id = f.approvedRow({ requester: OTHER });
    await expectRefused(f, id, "requester_mismatch");
    expect(f.state(id)).toBe("approved");
  });

  it("P5 operator-approver swap: on a schedule-born run the sink presents the operator, so an operator-approved row consumes (expected ok)", async () => {
    const f = bindFixture({ source: "schedule", approver: PACO });
    const id = f.approvedRow({ requester: PACO });
    expect(f.requester).toEqual({ kind: "schedule", id: "sch_1" }); // the runner's own requester is the schedule, not Paco
    const { result, added } = await f.execute(id);
    expect(result).toEqual(OK);
    expect(f.state(id)).toBe("consumed");
    // a schedule-born run with a key-eligible action credits its first streak: the credit rides the same consume
    expect(added).toEqual(["standing_streak"]);
    expect(f.store.listStandingApprovals().map((r) => [r.state, r.credited_runs_json])).toEqual([["streak", JSON.stringify([f.run_id])]]);
  });

  it("P5 control: the same schedule-born run WITHOUT the swap is a requester_mismatch (the swap is what makes the operator's tap count)", async () => {
    const f = bindFixture({ source: "schedule" });
    const id = f.approvedRow({ requester: PACO });
    await expectRefused(f, id, "requester_mismatch");
    expect(f.state(id)).toBe("approved");
  });

  it("lease_lost: the lease expired between approval and consume", async () => {
    const f = bindFixture();
    const id = f.approvedRow();
    rawDb(f.store).prepare(`UPDATE runs SET lease_expires_at = ? WHERE run_id = ?`).run(new Date(Date.now() - 1000).toISOString(), f.run_id);
    await expectRefused(f, id, "lease_lost");
    expect(f.state(id)).toBe("approved");
  });

  it("lease_lost: the run is no longer running", async () => {
    const f = bindFixture();
    const id = f.approvedRow();
    rawDb(f.store).prepare(`UPDATE runs SET state = 'waiting_for_approval' WHERE run_id = ?`).run(f.run_id);
    await expectRefused(f, id, "lease_lost");
    expect(f.state(id)).toBe("approved");
  });

  it("standing_trial on a candidate row: the fourth consume moves candidate -> sealing behind the CAS (scheduled shell_external)", async () => {
    const f = bindFixture({ source: "schedule", approver: PACO });
    const sa = f.store.insertStandingApprovalForTest({ schedule_id: "sch_1", chat_id: CHAT, action_fingerprint: FP, state: "candidate" });
    const id = f.approvedRow({ requester: PACO });
    const { result, added } = await f.execute(id, { standing_trial: { standing_id: sa.standing_id } });
    expect(result).toEqual(OK);
    expect(f.state(id)).toBe("consumed");
    expect(f.store.getStandingApproval(sa.standing_id)).toMatchObject({ state: "sealing", sealing_approval_id: id, sealed_run_id: f.run_id });
    expect(added).toEqual(["standing_sealing"]);
    expect(f.standingUses()).toBe(0);
  });

  it("standing_trial on a non-candidate (streak) row: the consume still credits the streak as an ordinary approval, and nothing seals", async () => {
    const f = bindFixture({ source: "schedule", approver: PACO });
    const sa = f.store.insertStandingApprovalForTest({ schedule_id: "sch_1", chat_id: CHAT, action_fingerprint: FP, state: "streak" });
    const id = f.approvedRow({ requester: PACO });
    const { result, added } = await f.execute(id, { standing_trial: { standing_id: sa.standing_id } });
    expect(result).toEqual(OK);
    expect(f.state(id)).toBe("consumed");
    expect(f.store.getStandingApproval(sa.standing_id)).toMatchObject({ state: "streak", sealing_approval_id: null, credited_runs_json: JSON.stringify([f.run_id]) });
    expect(added).toEqual(["standing_streak"]);
  });

  it.each(["sealing", "standing"] as const)("standing_trial on a %s row (non-candidate, never credited again): the consume succeeds, the standing row is byte-for-byte unchanged, no event", async (state) => {
    const f = bindFixture({ source: "schedule", approver: PACO });
    const move_id = f.store.insertLadderMove({ entry_id: "tool.policy", scope: "sa_x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
    const sa = f.store.insertStandingApprovalForTest({ schedule_id: "sch_1", chat_id: CHAT, action_fingerprint: FP, state, move_id, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    const before = f.store.getStandingApproval(sa.standing_id);
    const id = f.approvedRow({ requester: PACO });
    const { result, added } = await f.execute(id, { standing_trial: { standing_id: sa.standing_id } });
    expect(result).toEqual(OK);
    expect(f.state(id)).toBe("consumed");
    expect(f.store.getStandingApproval(sa.standing_id)).toEqual(before); // no credit, no state change, no updated_at bump
    expect(f.store.listStandingApprovals()).toHaveLength(1);
    expect(added).toEqual([]);
    expect(f.standingUses()).toBe(0);
  });

  it("standing_trial on an ineligible (user-born) run: the consume succeeds and earns NO credit, no sealing, no standing event", async () => {
    const f = bindFixture();
    const sa = f.store.insertStandingApprovalForTest({ schedule_id: "sch_1", chat_id: CHAT, action_fingerprint: FP, state: "candidate" });
    const id = f.approvedRow();
    const { result, added } = await f.execute(id, { standing_trial: { standing_id: sa.standing_id } });
    expect(result).toEqual(OK);
    expect(f.state(id)).toBe("consumed");
    expect(f.store.getStandingApproval(sa.standing_id)).toMatchObject({ state: "candidate", sealing_approval_id: null, credited_runs_json: "[]" });
    expect(added).toEqual([]);
  });

  it("a second consume of the same row is refused: one approval spends once", async () => {
    const f = bindFixture();
    const id = f.approvedRow();
    expect((await f.execute(id)).result).toEqual(OK);
    await expectRefused(f, id, "not_approved", "consumed");
  });

  it("consume ok then the adapter fails: the row IS consumed (the approval is spent) and the result is the adapter's failure", async () => {
    const f = bindFixture();
    f.adapter.mode = "fail";
    const id = f.approvedRow();
    const { result, added } = await f.execute(id);
    expect(result).toEqual({ status: "failed", error_ref: "adapter boom" });
    expect(f.state(id)).toBe("consumed");
    expect(added).toEqual([]);
    expect(f.store.listStandingApprovals()).toEqual([]);
  });

  it("consume ok then the adapter times out: the row IS consumed and the result is the timeout", async () => {
    const f = bindFixture();
    f.adapter.mode = "timeout";
    const id = f.approvedRow();
    const { result, added } = await f.execute(id);
    expect(result).toEqual({ status: "timed_out", error_ref: "Tool execution timed out" });
    expect(f.state(id)).toBe("consumed");
    expect(added).toEqual([]);
    expect(f.store.listStandingApprovals()).toEqual([]);
  });

  describe("multi-fault: which code wins is the check order unknown -> not_approved -> expired -> action -> owner -> requester -> lease", () => {
    it("expired + one-byte mismatch -> expired", async () => {
      const f = bindFixture();
      const id = f.approvedRow({ expires_in_ms: -1, input: INPUT_ONE_BYTE });
      await expectRefused(f, id, "expired");
    });
    it("wrong owner + wrong requester -> owner_mismatch", async () => {
      const f = bindFixture();
      const id = f.approvedRow({ worker_id: "w2", requester: OTHER });
      await expectRefused(f, id, "owner_mismatch");
    });
    it("not approved + expired -> not_approved", async () => {
      const f = bindFixture();
      const id = f.approvedRow({ state: "pending", expires_in_ms: -1 });
      await expectRefused(f, id, "not_approved", "pending");
    });
  });

  it("P2: a contract that now denies -> denied_on_revalidation BEFORE any consume; the row stays approved and unspent", async () => {
    const f = bindFixture({ forbid: true });
    const id = f.approvedRow();
    const { result, added } = await f.execute(id);
    expect(result).toEqual({ status: "denied_on_revalidation", reason: "Capability forbidden by task contract", recovery_hint: "Report the blocked action to the user" });
    expect(f.state(id)).toBe("approved");
    expect(added).toEqual([]);
    expect(f.store.listStandingApprovals()).toEqual([]);
    expect(f.recorded).toEqual([{ entry_id: "tool.policy", verdict: "denied", reason_code: "forbidden" }]);
  });

  it("P3: a runner with no sink fails a resume with the fixed text and spends nothing", async () => {
    const f = bindFixture({ sink: false });
    const id = f.approvedRow();
    const { result, added } = await f.execute(id);
    expect(result).toEqual({ status: "failed", error_ref: "Approval sink is not available for resume" });
    expect(f.state(id)).toBe("approved");
    expect(added).toEqual([]);
    expect(f.store.listStandingApprovals()).toEqual([]);
    expect(f.recorded).toEqual(POLICY_ROWS);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// P7: the run-level sink. Reached only through the eval fixture (force_gated_capability) -> CoreWorker.executeRun ->
// runGatedCapability -> store.consumeApprovedApproval. It passes NO recorder, so the decisions table must stay empty.
// ---------------------------------------------------------------------------------------------------------------------
type ApprovalsDb = { state: string };

async function runLevelFixture() {
  const root = mkdtempSync(join(tmpdir(), "houge-bind-runlevel-"));
  writeFileSync(join(root, "AGENTS.md"), "Rules");
  const store = RunStore.openInMemory();
  const n = ++seq;
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "cli", type: "run", program: "research-brief", goal: "force approval fixture", requested_by: PACO, notify: { kind: "local" },
    idempotency_key: `cli:bind-runlevel:${n}`, source_reference: "argv", metadata: { force_gated_capability: true }
  }));
  if (!intake.ok) throw new Error("expected intake");
  const parked = await new CoreWorker(store, root).executeRun(intake.run_id, "eval-worker");
  if (parked.status !== "waiting_for_approval") throw new Error(`expected approval wait, got ${JSON.stringify(parked)}`);
  const pending = store.getApprovalForRun(intake.run_id, "pending");
  if (!pending) throw new Error("expected pending approval");
  store.processApprovalTrigger({
    event: buildTypedTaskEvent({ source: "telegram", type: "approve", approval_id: pending.approval_id, requested_by: PACO, notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: `telegram:bind-runlevel-approve:${n}`, source_reference: "telegram:update:20:message:1" }),
    decision: "approved", resolved_at: "2026-05-28T00:10:00.000Z"
  });
  const run_id = intake.run_id;
  const approval_id = pending.approval_id;
  const real = store.getApprovedActionForRun(run_id);
  if (!real) throw new Error("expected approved action");
  return {
    store, root, run_id, approval_id, real,
    resume: () => new CoreWorker(store, root).executeRun(run_id, "eval-worker"),
    /** the stored row is tampered but the worker is handed the untampered action, so reconciliation passes and the CONSUME is what decides */
    feed: (action: typeof real) => vi.spyOn(store, "getApprovedActionForRun").mockImplementation(() => action),
    poke: (sql: string, ...a: unknown[]) => rawDb(store).prepare(sql).run(...a),
    approvalState: (): string => (rawDb(store).prepare(`SELECT state FROM approvals WHERE approval_id = ?`).get(approval_id) as ApprovalsDb).state,
    decisions: (): number => (rawDb(store).prepare(`SELECT COUNT(*) AS n FROM decisions`).get() as { n: number }).n
  };
}

describe("run-level sink through CoreWorker.executeRun (force_gated_capability) — P7", () => {
  it("happy path: park, approve, resume completes; the approval is consumed; the decisions table holds ZERO rows (no recorder on this path)", async () => {
    const f = await runLevelFixture();
    expect(f.decisions()).toBe(0); // control: even the first (parking) call recorded nothing
    const done = await f.resume();
    expect(done).toEqual({ status: "completed", run_id: f.run_id, report_path: join(f.root, "runs", f.run_id, "report.md"), report_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }); // the report body embeds the random run id, so its hash is not a fixed literal
    expect(f.approvalState()).toBe("consumed");
    expect(f.store.getLedgerEvents(f.run_id).map((e) => e.event_type)).toEqual([
      "run_created", "contract_attached", "worker_lease_acquired", "approval_requested", "notification_queued", "worker_lease_released", "approval_resolved", "notification_queued",
      "worker_lease_acquired", "tool_started", "tool_finished", "report_written", "worker_lease_released", "run_completed", "notification_queued"]);
    expect(f.store.listStandingApprovals()).toEqual([]);
    expect(f.decisions()).toBe(0);
  });

  const PARKED = ["run_created", "contract_attached", "worker_lease_acquired", "approval_requested", "notification_queued", "worker_lease_released", "approval_resolved", "notification_queued", "worker_lease_acquired", "tool_started"];
  const REFUSED_LEDGER = [...PARKED, "report_written", "worker_lease_released", "run_failed", "notification_queued"]; // consume refused: no tool_finished
  const CODES: Array<{ code: string; error: string; state: string; setup: (f: Awaited<ReturnType<typeof runLevelFixture>>) => void }> = [
    { code: "APPROVAL_NOT_FOUND", error: "APPROVAL_NOT_FOUND: Approval not found", state: "approved", setup: (f) => { f.feed({ ...f.real, approval_id: "appr_missing" }); } },
    { code: "APPROVAL_NOT_APPROVED", error: "APPROVAL_NOT_APPROVED: Approval is not approved", state: "pending", setup: (f) => { f.poke(`UPDATE approvals SET state = 'pending' WHERE approval_id = ?`, f.approval_id); f.feed(f.real); } },
    { code: "APPROVAL_REQUESTER_MISMATCH", error: "APPROVAL_REQUESTER_MISMATCH: Approval requester does not match", state: "approved", setup: (f) => { f.poke(`UPDATE approvals SET requester_json = ? WHERE approval_id = ?`, JSON.stringify(OTHER), f.approval_id); f.feed(f.real); } },
    { code: "APPROVAL_RUN_MISMATCH", error: "APPROVAL_RUN_MISMATCH: Approval run does not match", state: "approved", setup: (f) => { f.poke(`UPDATE approvals SET run_id = 'run_other' WHERE approval_id = ?`, f.approval_id); f.feed(f.real); } },
    { code: "APPROVAL_CAPABILITY_MISMATCH", error: "APPROVAL_CAPABILITY_MISMATCH: Approval capability does not match", state: "approved", setup: (f) => { f.poke(`UPDATE approvals SET capability = 'other_cap' WHERE approval_id = ?`, f.approval_id); f.feed(f.real); } },
    { code: "APPROVAL_INPUT_MISMATCH", error: "APPROVAL_INPUT_MISMATCH: Approval adapter input hash does not match", state: "approved", setup: (f) => { f.poke(`UPDATE approvals SET adapter_input_hash = 'deadbeef' WHERE approval_id = ?`, f.approval_id); f.feed(f.real); } },
    { code: "APPROVAL_ACTION_MISMATCH", error: "APPROVAL_ACTION_MISMATCH: Approval action fingerprint does not match", state: "approved", setup: (f) => { f.poke(`UPDATE approvals SET action_fingerprint = 'deadbeef' WHERE approval_id = ?`, f.approval_id); f.feed(f.real); } }
  ];
  it.each(CODES)("$code: the run fails with the store's exact error, the approvals row is left as found, the ledger shows no tool_finished, and still no decisions row", async ({ error, state, setup }) => {
    const f = await runLevelFixture();
    setup(f);
    const done = await f.resume();
    expect(done).toEqual({ status: "failed", run_id: f.run_id, error });
    expect(f.approvalState()).toBe(state);
    expect(f.store.getLedgerEvents(f.run_id).map((e) => e.event_type)).toEqual(REFUSED_LEDGER);
    expect(f.store.listStandingApprovals()).toEqual([]);
    expect(f.decisions()).toBe(0);
  });

  it("RUN_NOT_RUNNING: the run left `running` between the claim and the consume", async () => {
    const f = await runLevelFixture();
    vi.spyOn(f.store, "getApprovedActionForRun").mockImplementation(() => {
      f.poke(`UPDATE runs SET state = 'cancelled' WHERE run_id = ?`, f.run_id);
      return f.real;
    });
    const done = await f.resume();
    expect(done).toEqual({ status: "failed", run_id: f.run_id, error: "RUN_NOT_RUNNING: Run is not running" });
    expect(f.approvalState()).toBe("approved");
    // the run was flipped out from under the worker, so its own terminal events never land: the ledger stops after the report
    expect(f.store.getLedgerEvents(f.run_id).map((e) => e.event_type)).toEqual([...PARKED, "report_written", "notification_queued"]);
    expect(f.store.listStandingApprovals()).toEqual([]);
    expect(f.decisions()).toBe(0);
  });
});
