import { stableHash } from "../domain/canonical.js";
import type { CompiledTaskContract } from "../domain/types.js";
import { decideCapability } from "../policy/capability-policy.js";
import type { ToolMetadata, ToolRegistry } from "../tools/tool-registry.js";
import type { BudgetLedger } from "../budget/budget-ledger.js";

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

export interface CapabilityExecutionInput {
  contract: CompiledTaskContract;
  capability: string;
  input: Record<string, unknown>;
  budget: BudgetLedger;
}

export class CapabilityRunner {
  constructor(private readonly registry: ToolRegistry) {}

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
      forbidden_actions: input.contract.forbidden_actions
    });

    if (decision.decision === "deny") {
      return {
        status: "denied",
        reason: decision.reason,
        recovery_hint: "Report the blocked action to the user"
      };
    }

    if (decision.decision === "requires_approval") {
      return {
        status: "denied",
        reason: "Live approval channel is not available in Milestone 1",
        recovery_hint: "Report the blocked action to the user"
      };
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
      const adapterResult = await metadata.execute(input.input);
      if (!adapterResult.ok) {
        return { status: "failed", error_ref: adapterResult.error };
      }

      return {
        status: "succeeded",
        output_ref: `inline:${input.capability}`,
        output_hash: stableHash(adapterResult.output),
        output: adapterResult.output
      };
    } catch (error) {
      return { status: "failed", error_ref: errorRef(error) };
    }
  }
}
