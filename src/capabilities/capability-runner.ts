import { randomUUID } from "node:crypto";
import { decideSync } from "../decisions/decide.js";
import { TOOL_BUDGET } from "../decisions/entries/tool-budget.js";
import { TOOL_POLICY } from "../decisions/entries/tool-policy.js";
import type { DecisionRecorder } from "../decisions/types.js";
import { canonicalJson, stableHash } from "../domain/canonical.js";
import type { CompiledTaskContract, Identity } from "../domain/types.js";
import { decideCapability, type CapabilityDecision, STANDING_MISMATCH_REASON, STANDING_REASON } from "../policy/capability-policy.js";
import type { SsrfContext, ToolAdapterResult, ToolMetadata, ToolRegistry } from "../tools/tool-registry.js";
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
  | { status: "failed"; error_ref: string; output?: Record<string, unknown> }
  | { status: "timed_out"; error_ref: string; output?: Record<string, unknown> }
  | { status: "cancelled"; error_ref: string; output?: Record<string, unknown> }
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
    standing_trial?: { standing_id: string };
  }):
    | {
        ok: true;
        approval_id: string;
        state: "consumed";
        /** Audit/test-only: the store owns candidate → sealing; no production caller reads this. */
        sealing?: boolean;
      }
    | { ok: false; error: { code: string; message: string } };
  /** The store CAS behind a standing use (Stage 4A §7). A sink that cannot authorise one omits it; the runner then asks. */
  standingUse?(input: StandingUseInput): StandingUseResult;
}

export interface StandingUseInput {
  standing_id: string;
  action_fingerprint: string;
  run_id: string;
  tool_call_id: string;
}

export type StandingUseResult = { ok: true; move_id: string } | { ok: false; code: string };

export interface CapabilityExecutionInput {
  run_id?: string;
  requester?: Identity;
  approved_approval_id?: string;
  contract: CompiledTaskContract;
  capability: string;
  input: Record<string, unknown>;
  budget: BudgetLedger;
  signal?: AbortSignal;
  budget_reserved?: boolean;
  recorder?: DecisionRecorder;
  action_summary?: string;
  tool_call_id?: string;
  /** turn.trust's added tap (spec §7.2), outside `input` so the action fingerprint is unchanged. */
  trust_ask?: boolean;
  /** Stage 4A: the bridge's selector for a `standing` row of this run's schedule — authorised only by the sink's CAS. Outside `input`, so the fingerprint is unchanged. */
  standing?: { standing_id: string };
  /** Stage 4A: the fourth-run trial selector; rides the consume so the store can move candidate → sealing behind the same CAS. */
  standing_trial?: { standing_id: string };
}

export class CapabilityRunner {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly approvals?: ApprovalRequestSink
  ) {}

  async execute(
    input: CapabilityExecutionInput,
    signalOrSsrfCtx?: AbortSignal | SsrfContext,
    ssrfCtx?: SsrfContext
  ): Promise<CapabilityResult> {
    let signal: AbortSignal | undefined = input.signal;
    let ctx: SsrfContext | undefined = ssrfCtx;
    if (signalOrSsrfCtx instanceof AbortSignal) {
      signal = signalOrSsrfCtx;
    } else if (signalOrSsrfCtx !== undefined && signalOrSsrfCtx !== null) {
      ctx = signalOrSsrfCtx as SsrfContext;
    }
    const metadata = this.registry.get(input.capability);
    if (!metadata) {
      return {
        status: "denied",
        reason: "Unknown capability",
        recovery_hint: "Use a registered capability"
      };
    }

    const reservation = input.budget_reserved && input.approved_approval_id ? { ok: true as const } : input.budget.reserveToolCall();
    const recorder = input.recorder ?? { record: () => null };
    decideSync(TOOL_BUDGET, { ok: reservation.ok }, { run_id: input.run_id ?? null, tool_call_id: input.tool_call_id ?? null, recorder });
    if (!reservation.ok) {
      return {
        status: "denied",
        reason: reservation.reason,
        recovery_hint: "Write a partial report"
      };
    }

    // adapter_input_json is JSON.stringify(input.input) with its insertion order kept (the approval
    // replays exactly these bytes); stableHash re-canonicalizes regardless of key order, so
    // adapter_input_hash === stableHash(JSON.parse(adapter_input_json)) still holds.
    // Computed before policy: a standing use's CAS is keyed on the same fingerprint the card would carry.
    const adapter_input_json = JSON.stringify(input.input);
    const adapter_input_hash = stableHash(input.input);
    const action_fingerprint = actionFingerprint(input.capability, metadata, input.input);

    const policy = decideCapability({
      capability: input.capability, category: metadata.category, side_effect_level: metadata.side_effect_level, risk_level: metadata.risk_level,
      allowed_actions: input.contract.allowed_actions, forbidden_actions: input.contract.forbidden_actions, approval_gates: input.contract.approval_gates,
      ...(input.trust_ask === true ? { trust_ask: true } : {}), ...(input.standing ? { standing: input.standing } : {})
    });
    // the approved resume's authority is the approval row, never the selector
    const decision = policy.standing && !input.approved_approval_id ? this.authoriseStanding(policy.standing.standing_id, input, action_fingerprint, ctx) : { decision: policy.decision, reason: policy.reason };
    decideSync(TOOL_POLICY, { decision: decision.decision, reason: decision.reason }, { run_id: input.run_id ?? null, tool_call_id: input.tool_call_id ?? null, recorder });

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
          action_summary: input.action_summary ?? `Execute ${input.capability}`,
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
        consumed_at: new Date().toISOString(),
        ...(input.standing_trial ? { standing_trial: input.standing_trial } : {})
      });

      if (!consumption.ok) {
        return {
          status: "failed",
          error_ref: `${consumption.error.code}: ${consumption.error.message}`
        };
      }
    }

    return this.executeAdapter(metadata, input, signal ?? input.signal, ctx);
  }

  /**
   * The atomic authorisation at the execution boundary (§7): only a won store CAS turns the gate into an allow; a missing sink, a
   * missing CAS or a lost one asks. The CAS is consulted only when this call will run in the clean room — the adapter
   * selects the room from ctx.executor alone, so a grant is never spent on an ordinary shell.
   */
  private authoriseStanding(standing_id: string, input: CapabilityExecutionInput, action_fingerprint: string, ctx: SsrfContext | undefined): CapabilityDecision {
    if (ctx?.executor !== "cleanroom") return { decision: "requires_approval", reason: STANDING_MISMATCH_REASON };
    const use = this.approvals?.standingUse?.({ standing_id, action_fingerprint, run_id: input.run_id ?? "", tool_call_id: input.tool_call_id ?? `tool_${randomUUID()}` });
    return use?.ok ? { decision: "allow", reason: STANDING_REASON } : { decision: "requires_approval", reason: STANDING_MISMATCH_REASON };
  }

  private async executeAdapter(
    metadata: ToolMetadata,
    input: CapabilityExecutionInput,
    signal?: AbortSignal,
    ssrfCtx?: SsrfContext
  ): Promise<CapabilityResult> {
    if (!metadata.execute) {
      return { status: "failed", error_ref: `adapter_not_connected:${input.capability}` };
    }
    try {
      const settled = await executeCancellable(metadata.execute, input.input, metadata.timeout_ms, signal ?? input.signal, ssrfCtx);
      if (settled.kind === "timeout") return { status: "timed_out", error_ref: "Tool execution timed out", ...lateFacts(settled.late) };
      if (settled.kind === "cancelled") return { status: "cancelled", error_ref: "Tool execution cancelled", ...lateFacts(settled.late) };
      const adapterResult = settled.value;
      if (!adapterResult.ok) {
        // a structured failure (a clean-room run's `ran` and seal facts) must survive: Stage 4A and the ledger read it
        return { status: "failed", error_ref: adapterResult.error, ...(adapterResult.output ? { output: adapterResult.output } : {}) };
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
      return { status: "failed", error_ref: errorRef(error) };
    }
  }
}

/** The action identity three approvals and a standing row are keyed on: canonical JSON of the adapter input, so key order never matters and one byte does. */
export function actionFingerprint(capability: string, metadata: Pick<ToolMetadata, "side_effect_level" | "risk_level">, input: Record<string, unknown>): string {
  return stableHash({ capability, side_effect_level: metadata.side_effect_level, risk_level: metadata.risk_level, affected_resources: [...affectedResources(input)].sort(), adapter_input_hash: stableHash(input) });
}

function affectedResources(input: Record<string, unknown>): string[] {
  return typeof input.path === "string" ? [`path:${input.path}`] : [];
}

export const CLEANUP_BOUND_MS = 5_000;

type Settled =
  | { kind: "result"; value: ToolAdapterResult }
  | { kind: "timeout"; late?: ToolAdapterResult }
  | { kind: "cancelled"; late?: ToolAdapterResult };

/** An aborted clean-room run still settles with its seal facts (ran, torn_down, tampered); the ledger needs them even on cancel/timeout. */
function lateFacts(late: ToolAdapterResult | undefined): { output?: Record<string, unknown> } {
  return late && !late.ok && late.output ? { output: late.output } : {};
}

async function executeCancellable(
  execute: ToolExecute, input: Record<string, unknown>, timeout_ms: number, external?: AbortSignal, ssrfCtx?: SsrfContext
): Promise<Settled> {
  if (external?.aborted) return { kind: "cancelled" };
  const ac = new AbortController();
  const adapter = Promise.resolve().then(() => execute(input, ac.signal, ssrfCtx));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;
  const stop = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeout_ms);
    onExternalAbort = () => resolve({ kind: "cancelled" });
    external?.addEventListener("abort", onExternalAbort, { once: true });
  });
  try {
    const first = await Promise.race([adapter.then((value): Settled => ({ kind: "result", value })), stop]);
    if (first.kind === "result") return first;
    ac.abort();
    const late = await Promise.race([
      adapter.catch(() => undefined),
      new Promise<undefined>((r) => { cleanup = setTimeout(() => r(undefined), CLEANUP_BOUND_MS); })
    ]);
    return late ? { kind: first.kind, late } : first;
  } finally {
    clearTimeout(timer);
    clearTimeout(cleanup);
    if (onExternalAbort) external?.removeEventListener("abort", onExternalAbort);
  }
}
