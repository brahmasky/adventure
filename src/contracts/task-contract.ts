import { stableHash } from "../domain/canonical.js";
import type { CompiledTaskContract, SideEffectLevel, TypedTaskEvent } from "../domain/types.js";

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

  if (event.program === "research-brief") {
    return compileResearchBriefContract(event);
  }
  if (event.program === "web-research") {
    return compileWebResearchContract(event);
  }
  return invalid(`Unknown program: ${event.program ?? "(missing)"}`);
}

function compileResearchBriefContract(event: TypedTaskEvent): TaskContractResult {
  if (!event.goal?.trim()) {
    return invalid("Goal is required");
  }

  const base = {
    objective: event.goal,
    budget: { time_minutes: 15, max_tool_calls: 5, max_agent_delegations: 0 },
    allowed_actions: ["local_file_read", "write_report"],
    forbidden_actions: ["coding_agent_cli", "generic_shell", "external_write", "paid_action"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["local_write", "external_write", "destructive", "paid"] as SideEffectLevel[],
    stop_condition: "sourced local research brief produced or budget exhausted",
    eval_hooks: ["milestone-1-local-run"]
  };

  return { ok: true, contract: { ...base, contract_hash: stableHash(base) } };
}

function compileWebResearchContract(event: TypedTaskEvent): TaskContractResult {
  if (!event.goal?.trim()) {
    return invalid("Topic is required");
  }

  // Tier-1 web read (ADR 0006): web_search (read the live web) + llm_answer
  // (synthesize with sources). external_read only — no write/act capability.
  const base = {
    objective: event.goal,
    budget: { time_minutes: 10, max_tool_calls: 4, max_agent_delegations: 0 },
    allowed_actions: ["web_search", "llm_answer", "write_report"],
    forbidden_actions: ["coding_agent_cli", "generic_shell", "external_write", "paid_action"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["local_write", "external_write", "destructive", "paid"] as SideEffectLevel[],
    stop_condition: "sourced web research answer produced or budget exhausted",
    eval_hooks: ["web-research"]
  };

  return { ok: true, contract: { ...base, contract_hash: stableHash(base) } };
}

function compileAskContract(event: TypedTaskEvent): TaskContractResult {
  if (event.program !== undefined && event.program !== "ask") {
    return invalid(`Unknown program: ${event.program}`);
  }
  if (!event.goal?.trim()) return invalid("Question is required");
  const base = {
    objective: event.goal,
    budget: { time_minutes: 5, max_tool_calls: 2, max_agent_delegations: 0 },
    allowed_actions: ["llm_answer", "write_report"],
    forbidden_actions: ["coding_agent_cli", "generic_shell", "external_write", "paid"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["local_write", "external_write", "destructive", "paid"] as SideEffectLevel[],
    stop_condition: "concise answer report produced or budget exhausted",
    eval_hooks: ["milestone-2-ask-path"]
  };
  return { ok: true, contract: { ...base, contract_hash: stableHash(base) } };
}
