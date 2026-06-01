import { stableHash } from "../domain/canonical.js";
import type { CompiledTaskContract, TypedTaskEvent } from "../domain/types.js";

export type TaskContractResult =
  | { ok: true; contract: CompiledTaskContract }
  | {
      ok: false;
      error: { code: "TASK_CONTRACT_INVALID"; message: string };
    };

function invalid(message: string): TaskContractResult {
  return {
    ok: false,
    error: { code: "TASK_CONTRACT_INVALID", message }
  };
}

export function compileTaskContract(event: TypedTaskEvent): TaskContractResult {
  if (event.type === "ask") {
    return compileAskContract(event);
  }

  if (event.type !== "run") {
    return invalid(`Unsupported event type: ${event.type}`);
  }

  if (event.program !== "research-brief") {
    return invalid(`Unknown program: ${event.program ?? "(missing)"}`);
  }

  if (!event.goal?.trim()) {
    return invalid("Goal is required");
  }

  const base = {
    objective: event.goal,
    budget: { time_minutes: 15, max_tool_calls: 5, max_agent_delegations: 0 },
    allowed_actions: ["local_file_read", "write_report"],
    forbidden_actions: ["coding_agent_cli", "generic_shell", "external_write", "paid_action"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["external_write", "destructive_file_action", "paid_action"],
    stop_condition: "sourced local research brief produced or budget exhausted",
    eval_hooks: ["milestone-1-local-run"]
  };

  return {
    ok: true,
    contract: {
      ...base,
      contract_hash: stableHash(base)
    }
  };
}

function compileAskContract(event: TypedTaskEvent): TaskContractResult {
  if (event.program !== "ask") return invalid(`Unknown program: ${event.program ?? "(missing)"}`);
  if (!event.goal?.trim()) return invalid("Question is required");
  const base = {
    objective: event.goal,
    budget: { time_minutes: 5, max_tool_calls: 2, max_agent_delegations: 0 },
    allowed_actions: ["local_file_read", "write_report"],
    forbidden_actions: ["coding_agent_cli", "generic_shell", "external_write", "paid"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["external_write", "destructive", "paid"],
    stop_condition: "concise answer report produced or budget exhausted",
    eval_hooks: ["milestone-2-ask-path"]
  };
  return { ok: true, contract: { ...base, contract_hash: stableHash(base) } };
}
