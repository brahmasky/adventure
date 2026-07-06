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

  if (event.type === "turn") {
    return compileTurnContract(event);
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

/**
 * The `self-diagnose` contract (ADR 0011, Phase 1). Derived in-route from a `turn` whose
 * intent classified as `selfcode`: it OPENS `coding_agent_cli` (read-only Codex consult in
 * a worktree) alongside `llm_answer`/`write_report`, while keeping writes/destructive/paid
 * forbidden. `coding_agent_cli` stays in every normal contract's forbidden_actions, so the
 * category is reachable ONLY here. Small tool budget (1–2 consults) but a long time ceiling
 * (Codex is slow). No new approval gate — the consult is `external_read`, not a write.
 */
export function compileSelfDiagnoseContract(objective: string): CompiledTaskContract {
  const base = {
    objective,
    budget: { time_minutes: 30, max_tool_calls: 3, max_agent_delegations: 0 },
    allowed_actions: ["coding_agent_cli", "llm_answer", "write_report"],
    forbidden_actions: ["generic_shell", "external_write", "destructive", "paid_action"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["local_write", "external_write", "destructive", "paid"] as SideEffectLevel[],
    stop_condition: "self-diagnosis produced or budget exhausted",
    eval_hooks: []
  };
  return { ...base, contract_hash: stableHash(base) };
}

/**
 * The `skill-author` contract (ADR 0011, Phase 2b). Derived in-route from a `turn` whose
 * intent classified as `skill`: it allows `llm_answer` (Gate A classify + the writer pass)
 * + `write_report`. The skill file write itself is a DIRECT `SkillStore.writeSkill` bounded
 * to the `skills/` root (low-risk prose, report-not-approve) — NOT a gated capability — so
 * no write capability is opened here. `coding_agent_cli` stays FORBIDDEN: skills are prose,
 * never code. Small budget (a few cheap-chain calls); short time ceiling.
 */
export function compileSkillAuthorContract(objective: string): CompiledTaskContract {
  const base = {
    objective,
    budget: { time_minutes: 10, max_tool_calls: 3, max_agent_delegations: 0 },
    allowed_actions: ["llm_answer", "write_report"],
    forbidden_actions: ["coding_agent_cli", "generic_shell", "external_write", "destructive", "paid_action"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["local_write", "external_write", "destructive", "paid"] as SideEffectLevel[],
    stop_condition: "skill authored + written (or down-routed), or budget exhausted",
    eval_hooks: []
  };
  return { ...base, contract_hash: stableHash(base) };
}

/**
 * The `code-self-write` contract (ADR 0011, Phase 3 — code self-write). Derived in-route from
 * a `turn` whose intent classified as `selfcode` in WRITE mode (and only when
 * `HOUGE_SELFWRITE_ENABLED=true`). It OPENS `coding_agent_cli` (write-mode Codex in a fresh
 * worktree) alongside `llm_answer`/`write_report`, while keeping `generic_shell`/`destructive`/
 * `paid_action` forbidden — the diff lands on a branch, never in the live tree. NO new approval
 * gate: the branch is fully reversible (nothing runs until Paco merges, §5), so it is not in the
 * irreversible class the approval gate guards. Long time ceiling (write-Codex + the full test
 * gate are slow); small tool budget — the refine loop is capped at ≤3 write attempts in-route.
 */
export function compileCodeSelfWriteContract(objective: string): CompiledTaskContract {
  const base = {
    objective,
    budget: { time_minutes: 60, max_tool_calls: 4, max_agent_delegations: 0 },
    allowed_actions: ["coding_agent_cli", "llm_answer", "write_report"],
    forbidden_actions: ["generic_shell", "external_write", "destructive", "paid_action"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["local_write", "external_write", "destructive", "paid"] as SideEffectLevel[],
    stop_condition: "self-write branch published, hard-denied, or failed after refine; or budget exhausted",
    eval_hooks: []
  };
  return { ...base, contract_hash: stableHash(base) };
}

function compileTurnContract(event: TypedTaskEvent): TaskContractResult {
  if (!event.goal?.trim()) {
    return invalid("Message is required");
  }

  // The natural-language front door (ADR 0010). The worker first classifies intent
  // on the LLM chain (the `intent_router` sentinel — never executed as a capability),
  // then dispatches to answer (llm_answer) or research (web_search + llm_answer).
  // Same safety floor as web-research; budget headroom for the extra classifier call.
  // `lesson_write` (ADR 0013, step ⓪·1) is the distill→backstop→append flow as a
  // capability: only the flag-gated inner loop invokes it (the legacy path never does;
  // the policy only ALLOWS, never forces), but it lives in the one turn envelope.
  // `self_diagnose`/`self_write_propose`/`skill_author` (step ⓪·2) are the evolution
  // layers as loop tools — same deal: allowed in the envelope, listed only when armed,
  // and each runs its unchanged legacy pipeline under its own sub-contract inside.
  // `http_fetch` (Phase 3.6 step ③) is a plain armed loop tool like web_search; the
  // 10-call budget lets a search → fetch×2-3 → answer chain fit in ONE turn (the old
  // 6 hit step_cap on real research turns — soak 07-05).
  const base = {
    objective: event.goal,
    budget: { time_minutes: 10, max_tool_calls: 10, max_agent_delegations: 0 },
    allowed_actions: [
      "intent_router",
      "web_search",
      "http_fetch",
      "to_local_time",
      "llm_answer",
      "lesson_write",
      "self_diagnose",
      "self_write_propose",
      "skill_author",
      "write_report"
    ],
    forbidden_actions: ["coding_agent_cli", "generic_shell", "external_write", "paid_action"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["local_write", "external_write", "destructive", "paid"] as SideEffectLevel[],
    stop_condition: "intent classified and answered, or budget exhausted",
    eval_hooks: []
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
