import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { CapabilityRunner } from "../../src/capabilities/capability-runner.js";
import { stableHash } from "../../src/domain/canonical.js";
import type { CompiledTaskContract, RiskLevel, SideEffectLevel } from "../../src/domain/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const contract: CompiledTaskContract = {
  objective: "execute gated local write",
  budget: { time_minutes: 5, max_tool_calls: 2, max_agent_delegations: 0 },
  allowed_actions: ["local_project_write"],
  forbidden_actions: ["coding_agent_cli"],
  output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" },
  approval_gates: ["local_write"],
  stop_condition: "gated action handled",
  contract_hash: "contract_hash",
  eval_hooks: ["milestone-2-approval"]
};

function registry() {
  const registry = new ToolRegistry();
  registry.register({
    name: "local_project_write",
    category: "tool",
    side_effect_level: "local_write",
    risk_level: "medium",
    timeout_ms: 1000,
    output_limit_bytes: 1000,
    execute: async () => ({ ok: true, output: { wrote: true } })
  });
  return registry;
}

describe("CapabilityRunner approval lifecycle", () => {
  it("requests approval before gated adapter execution", async () => {
    const requested: unknown[] = [];
    const runner = new CapabilityRunner(registry(), {
      requestApproval: (input) => {
        requested.push(input);
        return { approval_id: "appr_capability" };
      },
      consumeApprovedApproval: () => {
        throw new Error("must not consume before approval");
      }
    });

    await expect(runner.execute({
      run_id: "run_approval",
      requester: { kind: "user", id: "paco" },
      contract,
      capability: "local_project_write",
      input: { path: "runs/run_approval/artifact.txt", content: "hello" },
      budget: new BudgetLedger(contract.budget)
    })).resolves.toEqual({ status: "requires_approval", approval_id: "appr_capability" });
    expect(requested).toEqual([expect.objectContaining({
      capability: "local_project_write",
      adapter_input_hash: expect.any(String),
      adapter_input_json: JSON.stringify({ path: "runs/run_approval/artifact.txt", content: "hello" }),
      action_fingerprint: expect.any(String)
    })]);
  });

  it("re-runs policy, consumes approval, and executes the exact approved action", async () => {
    const consumed: unknown[] = [];
    const runner = new CapabilityRunner(registry(), {
      requestApproval: () => ({ approval_id: "appr_new" }),
      consumeApprovedApproval: (input) => {
        consumed.push(input);
        return { ok: true, approval_id: "appr_existing", state: "consumed" };
      }
    });

    const result = await runner.execute({
      run_id: "run_approval",
      requester: { kind: "user", id: "paco" },
      approved_approval_id: "appr_existing",
      contract,
      capability: "local_project_write",
      input: { path: "runs/run_approval/artifact.txt", content: "hello" },
      budget: new BudgetLedger(contract.budget)
    });

    expect(result.status).toBe("succeeded");
    expect(consumed).toEqual([expect.objectContaining({
      capability: "local_project_write",
      adapter_input_hash: expect.any(String),
      action_fingerprint: expect.any(String)
    })]);
  });

  it("returns denied_on_revalidation when policy changes after approval", async () => {
    const deniedContract = { ...contract, forbidden_actions: ["local_project_write"] };
    const runner = new CapabilityRunner(registry(), {
      requestApproval: () => ({ approval_id: "appr_new" }),
      consumeApprovedApproval: () => {
        throw new Error("must not consume when revalidation fails");
      }
    });

    await expect(runner.execute({
      run_id: "run_approval",
      requester: { kind: "user", id: "paco" },
      approved_approval_id: "appr_existing",
      contract: deniedContract,
      capability: "local_project_write",
      input: { path: "runs/run_approval/artifact.txt", content: "hello" },
      budget: new BudgetLedger(contract.budget)
    })).resolves.toMatchObject({
      status: "denied_on_revalidation",
      reason: "Capability forbidden by task contract"
    });
  });
});

describe("CapabilityRunner approval fingerprinting", () => {
  function gatedRegistry(overrides: { side_effect_level?: SideEffectLevel; risk_level?: RiskLevel } = {}) {
    const registry = new ToolRegistry();
    registry.register({
      name: "local_project_write",
      category: "tool",
      side_effect_level: overrides.side_effect_level ?? "local_write",
      risk_level: overrides.risk_level ?? "medium",
      timeout_ms: 1000,
      output_limit_bytes: 1000,
      execute: async () => ({ ok: true, output: { wrote: true } })
    });
    return registry;
  }

  async function captureApprovalRequest(
    reg: ToolRegistry,
    input: Record<string, unknown>,
    contractOverride: CompiledTaskContract = contract
  ): Promise<{ adapter_input_hash: string; adapter_input_json: string; action_fingerprint: string }> {
    let captured: { adapter_input_hash: string; adapter_input_json: string; action_fingerprint: string } | undefined;
    const runner = new CapabilityRunner(reg, {
      requestApproval: (req) => {
        captured = {
          adapter_input_hash: req.adapter_input_hash,
          adapter_input_json: req.adapter_input_json,
          action_fingerprint: req.action_fingerprint
        };
        return { approval_id: "appr_capture" };
      },
      consumeApprovedApproval: () => {
        throw new Error("not consumed");
      }
    });
    await runner.execute({
      run_id: "run_fp",
      requester: { kind: "user", id: "paco" },
      contract: contractOverride,
      capability: "local_project_write",
      input,
      budget: new BudgetLedger(contractOverride.budget)
    });
    if (!captured) throw new Error("expected approval request");
    return captured;
  }

  it("hashes adapter_input_json with the same serializer as adapter_input_hash", async () => {
    const captured = await captureApprovalRequest(gatedRegistry(), { path: "runs/run_fp/a.txt", content: "hello" });
    expect(captured.adapter_input_hash).toBe(stableHash(JSON.parse(captured.adapter_input_json)));
  });

  it("changes the fingerprint when capability, side_effect_level, risk_level, affected_resources, or adapter_input_hash change", async () => {
    const base = await captureApprovalRequest(gatedRegistry(), { path: "runs/run_fp/a.txt", content: "hello" });

    const differentInput = await captureApprovalRequest(gatedRegistry(), { path: "runs/run_fp/a.txt", content: "world" });
    expect(differentInput.action_fingerprint).not.toBe(base.action_fingerprint);

    const differentResource = await captureApprovalRequest(gatedRegistry(), { path: "runs/run_fp/b.txt", content: "hello" });
    expect(differentResource.action_fingerprint).not.toBe(base.action_fingerprint);
    expect(differentResource.adapter_input_hash).not.toBe(base.adapter_input_hash);

    const differentRisk = await captureApprovalRequest(
      gatedRegistry({ risk_level: "high" }),
      { path: "runs/run_fp/a.txt", content: "hello" }
    );
    expect(differentRisk.action_fingerprint).not.toBe(base.action_fingerprint);

    const externalContract: CompiledTaskContract = { ...contract, approval_gates: ["external_write"] };
    const differentSideEffect = await captureApprovalRequest(
      gatedRegistry({ side_effect_level: "external_write" }),
      { path: "runs/run_fp/a.txt", content: "hello" },
      externalContract
    );
    expect(differentSideEffect.action_fingerprint).not.toBe(base.action_fingerprint);
  });
});
