import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { actionFingerprint, CapabilityRunner, type ApprovalRequestSink, type StandingUseInput } from "../../src/capabilities/capability-runner.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import { stableHash } from "../../src/domain/canonical.js";
import type { CompiledTaskContract } from "../../src/domain/types.js";
import { ToolRegistry, type SsrfContext } from "../../src/tools/tool-registry.js";

// Stage 4A §7: the standing row is a selector; only the sink's store CAS turns the gate into an allow. A forged selector, a
// sink without the CAS, a lost CAS, a trust ask or a context without the clean room all leave the call asking. The fingerprint the runner computes before policy
// is the one the store keyed three approvals on, so it must not move.
const contract = { allowed_actions: ["shell_external"], forbidden_actions: [], approval_gates: ["external_write"], budget: { time_minutes: 10, max_tool_calls: 10, max_agent_delegations: 0 } } as unknown as CompiledTaskContract;
const META = { side_effect_level: "external_write", risk_level: "medium" } as const;
const INPUT = { command: "curl -s -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post" };
/** The context the bridge passes on a standing use: the shell adapter selects the room from `executor` alone. */
const ROOM: SsrfContext = { run_id: "run_5", tool_call_id: "tc_5", executor: "cleanroom" };
function rig(use?: (i: StandingUseInput) => ReturnType<NonNullable<ApprovalRequestSink["standingUse"]>>) {
  const registry = new ToolRegistry(); let ran = 0;
  registry.register({ name: "shell_external", category: "tool", ...META, timeout_ms: 1_000, output_limit_bytes: 1_000, execute: async () => { ran++; return { ok: true, output: { exit_code: 0 } }; } });
  const requested: string[] = []; const used: StandingUseInput[] = []; const consumed: Array<Record<string, unknown>> = [];
  const decisions: Array<{ verdict: string; reason: string | null }> = [];
  const binds: string[] = [];
  const recorder: DecisionRecorder = { record: (entry, r) => { if (entry.id === "tool.policy") decisions.push({ verdict: r.verdict, reason: r.reason }); if (entry.id === "approval.bind") binds.push(r.verdict); return null; } };
  const sink: ApprovalRequestSink = {
    requestApproval: (i) => { requested.push(i.action_fingerprint); return { approval_id: "appr_1" }; },
    consumeApprovedApproval: (i) => { consumed.push(i as unknown as Record<string, unknown>); return { ok: true, approval_id: i.approval_id, state: "consumed", sealing: true }; },
    ...(use ? { standingUse: (i) => { used.push(i); return use(i); } } : {})
  };
  const exec = (extra: Record<string, unknown> = {}, ctx: SsrfContext | null = ROOM) => new CapabilityRunner(registry, sink).execute({ run_id: "run_5", tool_call_id: "tc_5", contract, capability: "shell_external", input: INPUT, budget: new BudgetLedger(contract.budget), recorder, ...extra }, ctx ?? undefined);
  return { exec, requested, used, consumed, decisions, binds, ran: () => ran };
}

describe("actionFingerprint", () => {
  it("equals the value the runner hands the approval sink and the pre-Stage-4A formula (a changed hash would orphan every stored streak)", async () => {
    const r = rig();
    await r.exec();
    const fp = actionFingerprint("shell_external", META, INPUT);
    expect(r.requested).toEqual([fp]);
    expect(fp).toBe(stableHash({ capability: "shell_external", side_effect_level: "external_write", risk_level: "medium", affected_resources: [], adapter_input_hash: stableHash(INPUT) }));
    expect(actionFingerprint("shell_external", META, { command: `${INPUT.command} ` })).not.toBe(fp); // one byte changed asks again
    expect(actionFingerprint("shell_external", META, { command: INPUT.command, extra: 1 })).not.toBe(fp);
  });
});

describe("CapabilityRunner standing", () => {
  it("a won CAS: allowed with reason standing, no card, the adapter runs once, the CAS saw the same fingerprint the card would have", async () => {
    const r = rig(() => ({ ok: true, move_id: "lm_1" }));
    expect((await r.exec({ standing: { standing_id: "sa_1" } })).status).toBe("succeeded");
    expect(r.requested).toEqual([]); expect(r.ran()).toBe(1);
    expect(r.used).toEqual([{ standing_id: "sa_1", action_fingerprint: actionFingerprint("shell_external", META, INPUT), run_id: "run_5", tool_call_id: "tc_5" }]);
    expect(r.decisions).toEqual([{ verdict: "allowed", reason: "standing" }]);
    expect(r.binds).toEqual([]); // a standing use never consumes an approval row, so approval.bind stays silent
  });
  it("a lost CAS asks with reason standing_mismatch; a sink without standingUse asks the same way (fail closed)", async () => {
    const lost = rig(() => ({ ok: false, code: "already_used" }));
    expect(await lost.exec({ standing: { standing_id: "sa_1" } })).toEqual({ status: "requires_approval", approval_id: "appr_1" });
    expect(lost.decisions).toEqual([{ verdict: "requires_approval", reason: "standing_mismatch" }]); expect(lost.ran()).toBe(0);
    const bare = rig();
    expect(await bare.exec({ standing: { standing_id: "sa_forged" } })).toEqual({ status: "requires_approval", approval_id: "appr_1" });
    expect(bare.decisions).toEqual([{ verdict: "requires_approval", reason: "standing_mismatch" }]);
  });
  it("a context without the clean room never spends the grant: the CAS is not consulted, the call asks with standing_mismatch, the adapter does not run", async () => {
    // the shell adapter selects the room from ctx.executor alone, so a direct caller with a valid sink and an ordinary ctx must not get an allow
    const r = rig(() => ({ ok: true, move_id: "lm_1" }));
    expect(await r.exec({ standing: { standing_id: "sa_1" } }, null)).toEqual({ status: "requires_approval", approval_id: "appr_1" });
    expect(r.used).toEqual([]); expect(r.ran()).toBe(0);
    expect(r.decisions).toEqual([{ verdict: "requires_approval", reason: "standing_mismatch" }]);
    const plain = rig(() => ({ ok: true, move_id: "lm_1" }));
    expect((await plain.exec({ standing: { standing_id: "sa_1" } }, { run_id: "run_5", tool_call_id: "tc_5" })).status).toBe("requires_approval");
    expect(plain.used).toEqual([]);
  });
  it("a trust ask beats standing: the CAS is never consulted and the card goes out", async () => {
    const r = rig(() => ({ ok: true, move_id: "lm_1" }));
    expect((await r.exec({ standing: { standing_id: "sa_1" }, trust_ask: true })).status).toBe("requires_approval");
    expect(r.used).toEqual([]); expect(r.decisions).toEqual([{ verdict: "requires_approval", reason: "gated_side_effect" }]);
  });
  it("standing never lifts a deny", async () => {
    const r = rig(() => ({ ok: true, move_id: "lm_1" }));
    const denied = await r.exec({ standing: { standing_id: "sa_1" }, contract: { ...contract, forbidden_actions: ["shell_external"] } });
    expect(denied.status).toBe("denied"); expect(r.used).toEqual([]);
  });
  it("standing_trial rides the consume (the store moves candidate → sealing behind that CAS), and is absent when not set", async () => {
    const r = rig();
    await r.exec({ approved_approval_id: "appr_1", budget_reserved: true, standing_trial: { standing_id: "sa_c" } });
    expect(r.consumed[0]).toMatchObject({ approval_id: "appr_1", standing_trial: { standing_id: "sa_c" } });
    await r.exec({ approved_approval_id: "appr_1", budget_reserved: true });
    expect(r.consumed[1]).not.toHaveProperty("standing_trial");
  });
  it("on the approved resume the standing selector is ignored (the approval is the authority) and the adapter runs", async () => {
    const r = rig(() => ({ ok: false, code: "not_standing" }));
    expect((await r.exec({ standing: { standing_id: "sa_1" }, approved_approval_id: "appr_1", budget_reserved: true })).status).toBe("succeeded");
    expect(r.used).toEqual([]);
  });
});
