import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { actionFingerprint } from "../../src/capabilities/capability-runner.js";
import { TurnTrust } from "../../src/decisions/trust.js";
import { buildTypedTaskEvent, type CompiledTaskContract, type Identity, type SideEffectLevel } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { createBridgeHandler, STANDING_TRIAL_LINE, type ActiveTurn, type BridgeHandlerDeps } from "../../src/omp/bridge-handler.js";
import type { BridgeRequest } from "../../src/omp/bridge-protocol.js";
import { classifyCommand, UNSEEN_SCRIPT_LABEL } from "../../src/omp/command-matcher.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { toolApprovalWaiters } from "../../src/omp/tool-approval-sink.js";
import { loadToolDeclarations, TOOL_DECLS_DIR, type ToolDeclaration } from "../../src/omp/tool-decls.js";
import { RunStore, type StandingApprovalRow } from "../../src/run/run-store.js";
import { ToolRegistry, type SsrfContext, type ToolMetadata } from "../../src/tools/tool-registry.js";
import { passThroughJudge } from "../helpers/omp-worker.js";

// Hermetic: availability is the sandbox flag alone here (the real predicate also probes /usr/bin/sandbox-exec; tested in cleanroom-run.test.ts).
vi.mock("../../src/omp/cleanroom-run.js", async (orig) => ({ ...(await orig<typeof import("../../src/omp/cleanroom-run.js")>()), cleanroomAvailable: (cfg: { sandbox: boolean }) => cfg.sandbox }));

// Stage 4A §7 bridge: a selector, never an authority. The fifth run of a standing key runs sealed with no card; the fourth (candidate)
// asks with the trial line and runs its approved resume sealed; an unscheduled turn, a hostile turn or a missing sandbox get today's path.
const PINNED_ENV = ["HOUGE_DUAL_LLM_ENABLED", "HOUGE_SCHEDULER_ENABLED", "HOUGE_HTTPFETCH_ENABLED"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of PINNED_ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of PINNED_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const ENVELOPE = ["web_search", "http_fetch", "shell", "shell_external", "shell_destructive", "fs_read", "fs_write", "write_report"];
const DECLS: ToolDeclaration[] = (() => { const r = loadToolDeclarations(TOOL_DECLS_DIR); if (!r.ok) throw new Error(r.error); return r.decls; })();
const PACO: Identity = { kind: "user", id: "paco" };
const CMD = "curl -s -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post";
const EXT_META = { side_effect_level: "external_write", risk_level: "medium" } as const;
const FUTURE = new Date(Date.now() + 90 * 86_400_000).toISOString(); // the sink's standingUse compares against the real clock
type Exec = NonNullable<ToolMetadata["execute"]>;
const meta = (name: string, side_effect_level: SideEffectLevel, execute: Exec): ToolMetadata => ({ name, category: "tool", side_effect_level, risk_level: side_effect_level === "external_write" ? "medium" : "low", timeout_ms: 5_000, output_limit_bytes: 64_000, execute });
let seq = 0;
interface Opts { scheduled?: boolean; sandbox?: boolean; hostile?: boolean }

function setup(o: Opts = {}) {
  const store = RunStore.openInMemory();
  // the schedule exists first: the use CAS checks the run's requester against an ENABLED schedule row
  const schedule_id = store.addScheduledTask({ chat_id: "555", goal: "post", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z" }).schedule_id;
  const scheduled = o.scheduled !== false;
  const r = new Gateway(store).intake(buildTypedTaskEvent(scheduled
    ? { source: "schedule", type: "turn", program: "turn", goal: "post", requested_by: { kind: "schedule", id: schedule_id }, notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `schedule:${schedule_id}:${++seq}`, source_reference: `scheduled_tasks.${schedule_id}` }
    : { source: "telegram", type: "turn", program: "turn", goal: "post", requested_by: PACO, notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `telegram:${++seq}`, source_reference: `telegram:update:${seq}:message:1` }));
  if (!r.ok) throw new Error(JSON.stringify(r));
  const run_id = r.run_id; const claim = store.claimRun(run_id, "planner:555:a", 120); if (!claim) throw new Error("claim failed");
  const contract: CompiledTaskContract = { ...claim.contract, allowed_actions: ENVELOPE, forbidden_actions: ["coding_agent_cli", "paid_action"], approval_gates: ["external_write", "destructive", "paid"], budget: { ...claim.contract.budget, max_tool_calls: 40 } };
  const seen: Array<SsrfContext | undefined> = [];
  const sealedOut = (ctx?: SsrfContext) => ctx?.executor === "cleanroom" ? { executor: "cleanroom", cleanroom: { room: "room-t", ran: true, torn_down: true, tampered: false, escaped: false } } : {};
  const shell: Exec = async (_i, _s, ctx) => { seen.push(ctx); return { ok: true, output: { exit_code: 0, output: "200", truncated: false, ...sealedOut(ctx) } }; };
  const registry = new ToolRegistry();
  registry.register(meta("shell", "local_write", shell)); registry.register(meta("shell_external", "external_write", shell)); registry.register(meta("shell_destructive", "destructive", shell));
  const awaiting: boolean[] = []; const dir = mkdtempSync(join(tmpdir(), "hbs-"));
  const trust = new TurnTrust({ store, run_id, chat_id: "555", born: scheduled ? "schedule" : "telegram", env: {} });
  if (o.hostile) trust.raise("injection_withheld", null);
  const turn: ActiveTurn = { run_id, worker_id: "planner:555:a", chat_id: "555", requester: scheduled ? { kind: "schedule", id: schedule_id } : PACO, contract, approver: PACO,
    budget: new BudgetLedger(contract.budget), registry, signal: new AbortController().signal, cwd: dir, step: { n: 0 }, cache: new Map(), unreported: new Map(),
    quarantine: async (tool) => ({ digest: "d", contains_instructions: false, source_meta: { tool, bytes: 1 } }), setAwaitingApproval: (on) => { awaiting.push(on); }, postureOk: () => null, judge: passThroughJudge, trust };
  const deps: BridgeHandlerDeps = { store, cfg: { ...resolveOmpConfig({}), sandbox: o.sandbox !== false }, ctx: { home: join(dir, "home"), repo: join(dir, "repo"), data: join(dir, "data") }, decls: DECLS, env: {}, turnEnvelopeActions: ENVELOPE, activeTurn: () => turn };
  const handle = createBridgeHandler(deps);
  const events = (type: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === type).map((e) => e.payload);
  const decisions = () => store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "tool.policy").map((d) => [d.tool_call_id, d.verdict, d.reason_code]);
  const fp = actionFingerprint("shell_external", EXT_META, { command: CMD });
  const key = { schedule_id, chat_id: "555", action_fingerprint: fp };
  return { store, run_id, turn, handle, seen, awaiting, events, decisions, fp, key, schedule_id };
}
const call = (command: string, toolCallId = `tc${++seq}`): BridgeRequest => ({ id: `r${++seq}`, kind: "call", tool: "bash", input: { command }, toolCallId });
type CallResult = { content: string; isError: boolean };
async function pendingApproval(store: RunStore, awaiting: boolean[]): Promise<string> {
  await vi.waitFor(() => { expect(awaiting).toContain(true); });
  const id = store.listPendingApprovalIds()[0]; if (!id) throw new Error("no pending approval"); return id;
}
function decide(store: RunStore, id: string, decision: "approved" | "denied"): void { store.resolveToolApprovalForTest(id, decision); toolApprovalWaiters.resolve(id, decision); }
function standingRow(s: ReturnType<typeof setup>, o: Partial<StandingApprovalRow> = {}) {
  const move_id = s.store.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
  return s.store.insertStandingApprovalForTest({ ...s.key, state: "standing", move_id, expires_at: FUTURE, ...o });
}

describe("bridge standing selection", () => {
  it("the fifth run: no approval_requested, decision reason standing, executor cleanroom on the first context, one standing_used; a sixth call in the same run asks (standing_mismatch)", async () => {
    const s = setup();
    const row = standingRow(s);
    const r = (await s.handle(call(CMD, "c5"))) as CallResult;
    expect(r.isError).toBe(false);
    expect(s.events("approval_requested")).toEqual([]);
    expect(s.seen[0]).toMatchObject({ run_id: s.run_id, tool_call_id: "c5", executor: "cleanroom" });
    expect(s.decisions()).toEqual([["c5", "allowed", "standing"]]);
    expect(s.events("standing_used")).toEqual([expect.objectContaining({ standing_id: row.standing_id, run_id: s.run_id, tool_call_id: "c5", action_fingerprint: s.fp })]);
    expect(s.events("tool_finished")[0]).toMatchObject({ executor: "cleanroom" });
    const sixth = s.handle(call(CMD, "c6")) as Promise<CallResult>;
    decide(s.store, await pendingApproval(s.store, s.awaiting), "approved");
    expect((await sixth).isError).toBe(false);
    expect(s.decisions().find((d) => d[0] === "c6")).toEqual(["c6", "requires_approval", "standing_mismatch"]);
    expect(s.events("standing_used")).toHaveLength(1);
  });
  it("the fourth run (candidate): the first call asks with the trial line and no executor; the approved resume runs sealed and the row is sealing on this call", async () => {
    const s = setup();
    const c = s.store.insertStandingApprovalForTest({ ...s.key, state: "candidate", credited_runs_json: JSON.stringify(["r1", "r2", "r3"]) });
    const p = s.handle(call(CMD, "c4")) as Promise<CallResult>;
    const id = await pendingApproval(s.store, s.awaiting);
    const card = s.store.claimNextNotification("t", 30);
    expect(String(card?.payload.text)).toContain(`Why: ${STANDING_TRIAL_LINE}`);
    decide(s.store, id, "approved");
    expect((await p).isError).toBe(false);
    expect(s.seen).toHaveLength(1); expect(s.seen[0]).toMatchObject({ executor: "cleanroom" });
    expect(s.store.getStandingApproval(c.standing_id)).toMatchObject({ state: "sealing", sealed_run_id: s.run_id, sealed_tool_call_id: "c4", sealing_approval_id: id });
    expect(s.events("approval_requested")[0]).toMatchObject({ action_fingerprint: s.fp }); // the sealed fourth call's fingerprint is the streak's
  });
  it("a candidate row ended during the wait: the call still runs sealed (the card promised a sealed folder) but earns no sealing row", async () => {
    const s = setup();
    const c = s.store.insertStandingApprovalForTest({ ...s.key, state: "candidate" });
    const p = s.handle(call(CMD, "c4b")) as Promise<CallResult>;
    const id = await pendingApproval(s.store, s.awaiting);
    s.store.endStandingApproval({ standing_id: c.standing_id, reason: "denied", now: new Date().toISOString() });
    decide(s.store, id, "approved");
    expect((await p).isError).toBe(false);
    expect(s.events("tool_finished")[0]).toMatchObject({ executor: "cleanroom" });
    expect(s.events("standing_sealing")).toEqual([]);
    expect(s.store.getStandingApproval(c.standing_id)?.state).toBe("ended");
  });
  it("no selector: an unscheduled turn on the same bytes, a hostile scheduled turn, the sandbox off — each asks as today with no executor", async () => {
    for (const o of [{ scheduled: false }, { hostile: true }, { sandbox: false }] as Opts[]) {
      const s = setup(o);
      // the unscheduled turn's requester is { kind: "user", id: "paco" }: a row keyed on schedule "paco" is what a lookup without the
      // requester-kind guard would find, so the guard (not the key) is what this case pins
      standingRow(s, o.scheduled === false ? { schedule_id: "paco" } : {});
      const p = s.handle(call(CMD)) as Promise<CallResult>;
      decide(s.store, await pendingApproval(s.store, s.awaiting), "approved");
      await p;
      expect(s.events("approval_requested")).toHaveLength(1);
      expect(s.seen[0]).not.toHaveProperty("executor");
      expect(s.events("standing_used")).toEqual([]);
      expect(s.store.claimNextNotification("t", 30)?.payload.text).not.toContain(STANDING_TRIAL_LINE);
    }
  });
  it("a command the matcher cannot read (an unseen shell script) never selects, even with a standing row on its exact bytes", async () => {
    const UNSEEN = "curl -s -X POST -d a=1 https://httpbin.org/post | sh";
    expect(classifyCommand(UNSEEN)).toEqual({ kind: "external_write", label: `HTTP write, ${UNSEEN_SCRIPT_LABEL}` }); // it reaches shell_external
    const s = setup();
    standingRow(s, { action_fingerprint: actionFingerprint("shell_external", EXT_META, { command: UNSEEN }) });
    const p = s.handle(call(UNSEEN)) as Promise<CallResult>;
    decide(s.store, await pendingApproval(s.store, s.awaiting), "approved");
    await p;
    expect(s.events("approval_requested")).toHaveLength(1);
    expect(s.seen[0]).not.toHaveProperty("executor");
    expect(s.events("standing_used")).toEqual([]);
  });
  it("a plain or destructive command never selects, whatever rows exist", async () => {
    const s = setup();
    s.store.insertStandingApprovalForTest({ ...s.key, action_fingerprint: actionFingerprint("shell", { side_effect_level: "local_write", risk_level: "low" }, { command: "ls" }), state: "standing" });
    expect(((await s.handle(call("ls"))) as CallResult).isError).toBe(false);
    expect(s.seen[0]).not.toHaveProperty("executor"); expect(s.decisions()[0]?.[2]).toBe("allowed");
  });
});
