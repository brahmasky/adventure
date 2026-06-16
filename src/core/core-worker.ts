import { randomUUID } from "node:crypto";
import { BudgetLedger } from "../budget/budget-ledger.js";
import { CapabilityRunner } from "../capabilities/capability-runner.js";
import type { ApprovalRequestSink, CapabilityResult } from "../capabilities/capability-runner.js";
import { createLocalFileReadAdapter } from "../capabilities/local-file-read.js";
import { createLlmAnswerAdapter } from "../capabilities/llm-answer.js";
import { resolveChainBudgetMs, RUNNER_TIMEOUT_BUFFER_MS } from "../llm/registry.js";
import { createLocalProjectWriteAdapter } from "../capabilities/local-project-write-adapter.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { canonicalJson, stableHash } from "../domain/canonical.js";
import type { Identity } from "../domain/types.js";
import { createLedgerEvent } from "../run/run-ledger.js";
import { writeRunReport } from "../report/report-writer.js";
import { RunStore } from "../run/run-store.js";
import type { ClaimedRun } from "../run/run-store.js";
import { ToolRegistry } from "../tools/tool-registry.js";

export type CoreWorkerResult =
  | { status: "idle"; run_id?: never; report_path?: never; error?: never }
  | { status: "completed"; run_id: string; report_path: string; report_hash: string; error?: never }
  | { status: "waiting_for_approval"; run_id: string; approval_id: string; report_path?: never; error?: never }
  | { status: "failed"; run_id: string; error: string; report_path?: never };

const GATED_CAPABILITY = "local_project_write";
const GATED_SIDE_EFFECT = "local_write" as const;
const GATED_RISK = "medium" as const;

export class CoreWorker {
  constructor(
    private readonly runStore: RunStore,
    private readonly projectRoot: string,
    private readonly llmAdapter: (input: Record<string, unknown>) => Promise<ToolAdapterResult> = createLlmAnswerAdapter()
  ) {}

  async executeOnce(worker_id: string): Promise<CoreWorkerResult> {
    const claim = this.runStore.claimNext(worker_id, 30);
    if (!claim) {
      return { status: "idle" };
    }

    return this.executeClaim(claim);
  }

  async executeRun(run_id: string, worker_id: string): Promise<CoreWorkerResult> {
    const claim = this.runStore.claimRun(run_id, worker_id, 30);
    if (!claim) {
      return { status: "idle" };
    }

    return this.executeClaim(claim);
  }

  private async executeClaim(claim: ClaimedRun): Promise<CoreWorkerResult> {
    if (this.isGatedFixture(claim.run_id)) {
      return this.executeGatedFixture(claim);
    }

    if (claim.contract.allowed_actions.includes("llm_answer")) {
      return this.executeAsk(claim);
    }

    return this.executeResearchBrief(claim);
  }

  private isGatedFixture(run_id: string): boolean {
    const metadata = this.runStore.getRunMetadata(run_id);
    return metadata.force_gated_capability === true;
  }

  private approvalSink(): ApprovalRequestSink {
    return {
      requestApproval: (input) => {
        const record = this.runStore.createApprovalRequest(input);
        return { approval_id: record.approval_id };
      },
      consumeApprovedApproval: (input) => {
        const result = this.runStore.consumeApprovedApproval({
          approval_id: input.approval_id,
          run_id: input.run_id,
          requester: input.requester,
          capability: input.capability,
          adapter_input_hash: input.adapter_input_hash,
          action_fingerprint: input.action_fingerprint,
          tool_call_id: input.tool_call_id,
          operation_id: input.operation_id
        });
        return result;
      }
    };
  }

  private async executeGatedFixture(claim: ClaimedRun): Promise<CoreWorkerResult> {
    // The forced fixture routes through the gated local_project_write capability,
    // which the default research-brief contract does not list. Widen allowed_actions
    // for this fixture while keeping local_write in the approval gates.
    const gatedClaim: ClaimedRun = {
      run_id: claim.run_id,
      contract: {
        ...claim.contract,
        allowed_actions: [...claim.contract.allowed_actions, GATED_CAPABILITY],
        approval_gates: claim.contract.approval_gates.includes(GATED_SIDE_EFFECT)
          ? claim.contract.approval_gates
          : [...claim.contract.approval_gates, GATED_SIDE_EFFECT]
      }
    };
    claim = gatedClaim;
    const requester = this.runStore.getRunRequester(claim.run_id);
    const approved = this.runStore.getApprovedActionForRun(claim.run_id);

    // Resume path: an approval was granted for a previous attempt.
    if (approved) {
      const reconciled = this.reconcileApprovedAction(claim, approved);
      if (!reconciled.ok) {
        return reconciled.result;
      }

      return this.runGatedCapability(claim, requester, reconciled.input, approved.approval_id);
    }

    // First attempt: generated action that needs approval.
    const generatedInput = {
      path: `runs/${claim.run_id}/artifact.txt`,
      content: "approved gated artifact"
    };

    return this.runGatedCapability(claim, requester, generatedInput, undefined);
  }

  private reconcileApprovedAction(
    claim: ClaimedRun,
    approved: {
      approval_id: string;
      capability: string;
      adapter_input_json: string;
      adapter_input_hash: string;
      action_fingerprint: string;
    }
  ): { ok: true; input: Record<string, unknown> } | { ok: false; result: CoreWorkerResult } {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(approved.adapter_input_json) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, result: this.failReconciliation(claim, approved.approval_id, `Stored adapter input is not valid JSON: ${message}`) };
    }

    const recomputedHash = stableHash(parsed);
    if (recomputedHash !== approved.adapter_input_hash) {
      return {
        ok: false,
        result: this.failReconciliation(claim, approved.approval_id, "Stored adapter input hash does not match recomputed hash")
      };
    }

    const recomputedFingerprint = stableHash({
      capability: approved.capability,
      side_effect_level: GATED_SIDE_EFFECT,
      risk_level: GATED_RISK,
      affected_resources: typeof parsed.path === "string" ? [`path:${parsed.path}`] : [],
      adapter_input_hash: recomputedHash
    });
    if (recomputedFingerprint !== approved.action_fingerprint) {
      return {
        ok: false,
        result: this.failReconciliation(claim, approved.approval_id, "Stored action fingerprint does not match recomputed fingerprint")
      };
    }

    return { ok: true, input: parsed };
  }

  private failReconciliation(claim: ClaimedRun, approval_id: string, reason: string): CoreWorkerResult {
    const tool_call_id = `tool_${randomUUID()}`;
    const operation_id = `op_${randomUUID()}`;
    this.runStore.appendLedgerEvent(
      createLedgerEvent({
        run_id: claim.run_id,
        correlation_id: claim.run_id,
        event_type: "reconciliation_required",
        actor: "capability_runner",
        sequence: this.nextSequence(claim.run_id),
        payload: {
          tool_call_id,
          operation_id,
          reason,
          reconciliation_ref: `approval:${approval_id}`
        }
      })
    );
    this.markFailed(claim.run_id, "running", reason);
    return { status: "failed", run_id: claim.run_id, error: reason };
  }

  private async runGatedCapability(
    claim: ClaimedRun,
    requester: Identity,
    input: Record<string, unknown>,
    approved_approval_id: string | undefined
  ): Promise<CoreWorkerResult> {
    const registry = new ToolRegistry();
    registry.register({
      name: GATED_CAPABILITY,
      category: "tool",
      side_effect_level: GATED_SIDE_EFFECT,
      risk_level: GATED_RISK,
      timeout_ms: 1000,
      output_limit_bytes: 100_000,
      execute: createLocalProjectWriteAdapter(this.projectRoot, claim.run_id)
    });

    const tool_call_id = `tool_${randomUUID()}`;
    const operation_id = `op_${randomUUID()}`;
    const input_hash = stableHash(input);

    if (approved_approval_id) {
      this.runStore.appendLedgerEvent(
        createLedgerEvent({
          run_id: claim.run_id,
          correlation_id: claim.run_id,
          event_type: "tool_started",
          actor: "capability_runner",
          sequence: this.nextSequence(claim.run_id),
          payload: {
            tool_call_id,
            operation_id,
            adapter_name: GATED_CAPABILITY,
            input_hash,
            timeout_ms: 1000
          }
        })
      );
    }

    const startedAt = Date.now();
    const result = await new CapabilityRunner(registry, this.approvalSink()).execute({
      run_id: claim.run_id,
      requester,
      ...(approved_approval_id ? { approved_approval_id } : {}),
      contract: claim.contract,
      capability: GATED_CAPABILITY,
      input,
      budget: new BudgetLedger(claim.contract.budget)
    });

    if (result.status === "requires_approval") {
      // createApprovalRequest already parked the run as waiting_for_approval.
      return { status: "waiting_for_approval", run_id: claim.run_id, approval_id: result.approval_id };
    }

    if (result.status !== "succeeded") {
      return this.failWithPartialReport(claim, result);
    }

    this.runStore.appendLedgerEvent(
      createLedgerEvent({
        run_id: claim.run_id,
        correlation_id: claim.run_id,
        event_type: "tool_finished",
        actor: "capability_runner",
        sequence: this.nextSequence(claim.run_id),
        payload: {
          tool_call_id,
          status: "succeeded",
          output_hash: result.output_hash,
          duration_ms: Date.now() - startedAt,
          bytes_out: Buffer.byteLength(canonicalJson(result.output), "utf8")
        }
      })
    );

    return this.writeCompletionReport(claim, {
      title: "Gated capability run",
      body: [
        `Objective: ${claim.contract.objective}`,
        "",
        `Executed ${GATED_CAPABILITY}: ${JSON.stringify(result.output)}`
      ].join("\n"),
      sources: typeof input.path === "string" ? [input.path] : []
    });
  }

  private async executeAsk(claim: ClaimedRun): Promise<CoreWorkerResult> {
    const registry = new ToolRegistry();
    // The runner's Promise.race is the ONLY enforced wall-clock bound (the
    // contract's time_minutes is not enforced). Derive it from the chain so a
    // healthy chain that legitimately falls through every provider is never
    // killed mid-flight: sum(per-provider timeouts) + buffer. Default chain
    // (pi 60s + kimi 30s) + 15s buffer = 105s.
    const llmTimeoutMs = resolveChainBudgetMs(process.env) + RUNNER_TIMEOUT_BUFFER_MS;
    registry.register({
      name: "llm_answer",
      category: "tool",
      side_effect_level: "external_read",
      risk_level: "low",
      timeout_ms: llmTimeoutMs,
      output_limit_bytes: 100_000,
      execute: this.llmAdapter
    });

    const result = await new CapabilityRunner(registry).execute({
      contract: claim.contract,
      capability: "llm_answer",
      input: { question: claim.contract.objective },
      budget: new BudgetLedger(claim.contract.budget)
    });

    if (result.status !== "succeeded") {
      return this.failWithPartialReport(claim, result);
    }

    const answer = typeof result.output.answer === "string" ? result.output.answer : "";
    const model = typeof result.output.model === "string" ? result.output.model : "unknown";
    const provider = typeof result.output.provider === "string" ? result.output.provider : "unknown";
    return this.writeCompletionReport(claim, {
      title: "Answer",
      body: [`Question: ${claim.contract.objective}`, "", answer].join("\n"),
      sources: [`llm:${provider}:${model}`]
    });
  }

  private async executeResearchBrief(claim: ClaimedRun): Promise<CoreWorkerResult> {
    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 100_000,
      execute: createLocalFileReadAdapter(this.projectRoot)
    });

    const result = await new CapabilityRunner(registry).execute({
      contract: claim.contract,
      capability: "local_file_read",
      input: { path: "AGENTS.md" },
      budget: new BudgetLedger(claim.contract.budget)
    });

    if (result.status !== "succeeded") {
      return this.failWithPartialReport(claim, result);
    }

    const content = typeof result.output.content === "string" ? result.output.content : "";
    const source = typeof result.output.path === "string" ? result.output.path : "AGENTS.md";
    return this.writeCompletionReport(claim, {
      title: "Research brief",
      body: [
        `Objective: ${claim.contract.objective}`,
        "",
        "Local project rules:",
        "",
        content
      ].join("\n"),
      sources: [source]
    });
  }

  private writeCompletionReport(
    claim: ClaimedRun,
    input: { title: string; body: string; sources: string[] }
  ): CoreWorkerResult {
    const startedAt = Date.now();
    let report: { path: string; hash: string };
    try {
      report = writeRunReport(this.projectRoot, {
        run_id: claim.run_id,
        title: input.title,
        body: input.body,
        sources: input.sources,
        partial: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markFailed(claim.run_id, "running", message);
      return { status: "failed", run_id: claim.run_id, error: message };
    }

    this.runStore.recordReportWritten(claim.run_id, report.path, report.hash, false);

    if (!this.runStore.transition(claim.run_id, "running", "reporting", "report written")) {
      this.markFailed(claim.run_id, "running", "failed to enter reporting");
      return {
        status: "failed",
        run_id: claim.run_id,
        error: "failed to enter reporting"
      };
    }

    if (!this.runStore.transition(claim.run_id, "reporting", "completed", "completed")) {
      this.markFailed(claim.run_id, "reporting", "failed to complete");
      return {
        status: "failed",
        run_id: claim.run_id,
        error: "failed to complete"
      };
    }

    this.runStore.recordRunCompleted(claim.run_id, report.path, Date.now() - startedAt);

    // The poll/dispatch loop delivers this terminal notification to the run's
    // original notify target (Telegram chat or local sink).
    this.runStore.enqueueFinalReportNotification(claim.run_id, { report_path: report.path });

    return {
      status: "completed",
      run_id: claim.run_id,
      report_path: report.path,
      report_hash: report.hash
    };
  }

  private nextSequence(run_id: string): number {
    const events = this.runStore.getLedgerEvents(run_id);
    return events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
  }

  private markFailed(run_id: string, expected: "running" | "reporting", reason: string): void {
    if (this.runStore.transition(run_id, expected, "failed", reason)) {
      this.runStore.recordRunFailed(run_id, reason, false);
    }
  }

  private failWithPartialReport(claim: ClaimedRun, result: Exclude<CapabilityResult, { status: "succeeded" }>): CoreWorkerResult {
    const detail = capabilityFailureDetail(result);
    try {
      const report = writeRunReport(this.projectRoot, {
        run_id: claim.run_id,
        title: "Partial report",
        body: [
          `Objective: ${claim.contract.objective}`,
          "",
          `Capability status: ${result.status}`,
          `Error: ${detail}`
        ].join("\n"),
        sources: [],
        partial: true
      });
      this.runStore.recordReportWritten(claim.run_id, report.path, report.hash, true);
    } catch {
      this.markFailed(claim.run_id, "running", detail);
      return { status: "failed", run_id: claim.run_id, error: detail };
    }

    this.markFailed(claim.run_id, "running", detail);
    return { status: "failed", run_id: claim.run_id, error: detail };
  }
}

function capabilityFailureDetail(result: Exclude<CapabilityResult, { status: "succeeded" }>): string {
  switch (result.status) {
    case "denied":
    case "denied_on_revalidation":
      return result.recovery_hint ? `${result.reason}; ${result.recovery_hint}` : result.reason;
    case "failed":
    case "timed_out":
    case "cancelled":
      return result.error_ref;
    case "requires_approval":
      return `Approval required: ${result.approval_id}`;
    case "uncertain_outcome":
      return `Reconciliation required: ${result.reconciliation_ref}`;
  }
}
