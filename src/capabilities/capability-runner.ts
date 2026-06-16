import { randomUUID } from "node:crypto";
import { canonicalJson, stableHash } from "../domain/canonical.js";
import type { CompiledTaskContract, Identity } from "../domain/types.js";
import { decideCapability } from "../policy/capability-policy.js";
import type { ToolAdapterResult, ToolMetadata, ToolRegistry } from "../tools/tool-registry.js";
import type { BudgetLedger } from "../budget/budget-ledger.js";
import type { ApprovalRequestInput } from "../run/run-store.js";

type ToolExecute = NonNullable<ToolMetadata["execute"]>;

function errorRef(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error) ?? "Unknown capability execution failure";
  } catch {
    return "Unknown capability execution failure";
  }
}

export type CapabilityResult =
  | { status: "succeeded"; output_ref: string; output_hash: string; output: Record<string, unknown> }
  | { status: "denied"; reason: string; recovery_hint?: string }
  | { status: "requires_approval"; approval_id: string }
  | { status: "denied_on_revalidation"; reason: string; recovery_hint?: string }
  | { status: "failed"; error_ref: string }
  | { status: "timed_out"; error_ref: string }
  | { status: "cancelled"; error_ref: string }
  | { status: "uncertain_outcome"; reconciliation_ref: string };

export interface ApprovalRequestSink {
  requestApproval(input: ApprovalRequestInput): { approval_id: string };
  consumeApprovedApproval(input: {
    run_id: string;
    approval_id: string;
    requester: Identity;
    capability: string;
    adapter_input_hash: string;
    action_fingerprint: string;
    tool_call_id: string;
    operation_id: string;
    consumed_at: string;
  }): { ok: true; approval_id: string; state: "consumed" } | { ok: false; error: { code: string; message: string } };
}

export interface CapabilityExecutionInput {
  run_id?: string;
  requester?: Identity;
  approved_approval_id?: string;
  contract: CompiledTaskContract;
  capability: string;
  input: Record<string, unknown>;
  budget: BudgetLedger;
}

export class CapabilityRunner {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly approvals?: ApprovalRequestSink
  ) {}

  async execute(input: CapabilityExecutionInput): Promise<CapabilityResult> {
    const metadata = this.registry.get(input.capability);
    if (!metadata) {
      return {
        status: "denied",
        reason: "Unknown capability",
        recovery_hint: "Use a registered capability"
      };
    }

    const reservation = input.budget.reserveToolCall();
    if (!reservation.ok) {
      return {
        status: "denied",
        reason: reservation.reason,
        recovery_hint: "Write a partial report"
      };
    }

    const decision = decideCapability({
      capability: input.capability,
      category: metadata.category,
      side_effect_level: metadata.side_effect_level,
      risk_level: metadata.risk_level,
      allowed_actions: input.contract.allowed_actions,
      forbidden_actions: input.contract.forbidden_actions,
      approval_gates: input.contract.approval_gates
    });

    if (decision.decision === "deny") {
      if (input.approved_approval_id) {
        return {
          status: "denied_on_revalidation",
          reason: decision.reason,
          recovery_hint: "Report the blocked action to the user"
        };
      }
      return {
        status: "denied",
        reason: decision.reason,
        recovery_hint: "Report the blocked action to the user"
      };
    }

    // The verbatim Task 6 test asserts adapter_input_json === JSON.stringify(input.input)
    // (insertion order preserved). stableHash re-canonicalizes regardless of key order,
    // so adapter_input_hash === stableHash(JSON.parse(adapter_input_json)) still holds.
    const adapter_input_json = JSON.stringify(input.input);
    const adapter_input_hash = stableHash(input.input);
    const action_fingerprint = stableHash({
      capability: input.capability,
      side_effect_level: metadata.side_effect_level,
      risk_level: metadata.risk_level,
      affected_resources: [...affectedResources(input.input)].sort(),
      adapter_input_hash
    });

    if (decision.decision === "requires_approval") {
      if (!input.approved_approval_id) {
        if (!this.approvals) {
          return {
            status: "denied",
            reason: "Live approval channel is not available",
            recovery_hint: "Report the blocked action to the user"
          };
        }

        const requested = this.approvals.requestApproval({
          run_id: input.run_id ?? "",
          approval_type: "capability",
          capability: input.capability,
          action_fingerprint,
          adapter_input_hash,
          adapter_input_json,
          action_summary: `Execute ${input.capability}`,
          side_effect_level: metadata.side_effect_level,
          risk_level: metadata.risk_level,
          affected_resources: affectedResources(input.input),
          requester: input.requester ?? { kind: "system", id: "core" },
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        });

        return { status: "requires_approval", approval_id: requested.approval_id };
      }
    }

    // Decision is allow, or requires_approval with an approved_approval_id present.
    if (input.approved_approval_id) {
      if (!this.approvals) {
        return {
          status: "failed",
          error_ref: "Approval sink is not available for resume"
        };
      }

      const consumption = this.approvals.consumeApprovedApproval({
        run_id: input.run_id ?? "",
        approval_id: input.approved_approval_id,
        requester: input.requester ?? { kind: "system", id: "core" },
        capability: input.capability,
        adapter_input_hash,
        action_fingerprint,
        tool_call_id: `tool_${randomUUID()}`,
        operation_id: `op_${randomUUID()}`,
        consumed_at: new Date().toISOString()
      });

      if (!consumption.ok) {
        return {
          status: "failed",
          error_ref: `${consumption.error.code}: ${consumption.error.message}`
        };
      }
    }

    return this.executeAdapter(metadata, input);
  }

  private async executeAdapter(
    metadata: ToolMetadata,
    input: CapabilityExecutionInput
  ): Promise<CapabilityResult> {
    if (!metadata.execute) {
      return { status: "failed", error_ref: `adapter_not_connected:${input.capability}` };
    }
    try {
      const adapterResult = await executeWithTimeout(
        () => (metadata.execute as ToolExecute)(input.input),
        metadata.timeout_ms
      );
      if (!adapterResult.ok) {
        return { status: "failed", error_ref: adapterResult.error };
      }

      if (Buffer.byteLength(canonicalJson(adapterResult.output), "utf8") > metadata.output_limit_bytes) {
        return { status: "failed", error_ref: "Tool output exceeded limit" };
      }

      return {
        status: "succeeded",
        output_ref: `inline:${input.capability}`,
        output_hash: stableHash(adapterResult.output),
        output: adapterResult.output
      };
    } catch (error) {
      if (error instanceof ToolTimeoutError) {
        return { status: "timed_out", error_ref: "Tool execution timed out" };
      }
      return { status: "failed", error_ref: errorRef(error) };
    }
  }
}

function affectedResources(input: Record<string, unknown>): string[] {
  return typeof input.path === "string" ? [`path:${input.path}`] : [];
}

class ToolTimeoutError extends Error {
  constructor() {
    super("Tool execution timed out");
  }
}

async function executeWithTimeout(
  execute: () => ReturnType<ToolExecute>,
  timeout_ms: number
): Promise<ToolAdapterResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(execute),
      new Promise<ToolAdapterResult>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ToolTimeoutError()),
          timeout_ms
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
