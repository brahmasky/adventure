import { BudgetLedger } from "../budget/budget-ledger.js";
import { CapabilityRunner } from "../capabilities/capability-runner.js";
import { createLocalFileReadAdapter } from "../capabilities/local-file-read.js";
import { writeRunReport } from "../report/report-writer.js";
import { RunStore } from "../run/run-store.js";
import type { ClaimedRun } from "../run/run-store.js";
import { ToolRegistry } from "../tools/tool-registry.js";

export type CoreWorkerResult =
  | { status: "idle"; run_id?: never; report_path?: never; error?: never }
  | { status: "completed"; run_id: string; report_path: string; report_hash: string; error?: never }
  | { status: "failed"; run_id: string; error: string; report_path?: never };

export class CoreWorker {
  constructor(
    private readonly runStore: RunStore,
    private readonly projectRoot: string
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
      this.markFailed(claim.run_id, "running", result.status);
      return { status: "failed", run_id: claim.run_id, error: result.status };
    }

    const content = typeof result.output.content === "string" ? result.output.content : "";
    const source = typeof result.output.path === "string" ? result.output.path : "AGENTS.md";
    let report: { path: string; hash: string };
    try {
      report = writeRunReport(this.projectRoot, {
        run_id: claim.run_id,
        title: "Research brief",
        body: [
          `Objective: ${claim.contract.objective}`,
          "",
          "Local project rules:",
          "",
          content
        ].join("\n"),
        sources: [source],
        partial: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markFailed(claim.run_id, "running", message);
      return { status: "failed", run_id: claim.run_id, error: message };
    }

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

    return {
      status: "completed",
      run_id: claim.run_id,
      report_path: report.path,
      report_hash: report.hash
    };
  }

  private markFailed(run_id: string, expected: "running" | "reporting", reason: string): void {
    this.runStore.transition(run_id, expected, "failed", reason);
  }
}
