# ADR 0001: Deterministic harness governs everything

- **Status:** accepted
- **Date:** 2026-05-25
- **Deciders:** Paco

## Context

Houge turns chat and CLI commands into bounded, auditable, policy-governed task
runs, and will eventually run unattended and delegate to LLMs/agents. The central
risk in any agentic system is letting the model make the decisions that determine
safety, cost, and side effects — routing, policy, budget, approvals, state. Models
are non-deterministic and promptable; an attacker who controls the input can steer
them. We need behavior that is reproducible, testable, and auditable regardless of
what any model does.

## Decision

**Deterministic code owns control; the LLM is used only for judgment.** Concretely:

- Routing, capability policy, budgets, approvals, idempotency, and state machines
  (Run / Approval / ToolCall / Schedule) are plain code with unit tests — never an
  LLM decision.
- Every tool call and side effect flows through the **Capability Runner** and is
  recorded in an append-only **Run Ledger**. The LLM may *draft* a task contract;
  deterministic code validates and applies it.
- Idempotency is enforced by `source + idempotency_key`; identity by canonical
  hashing (`stableHash`/`canonicalJson`). The same input yields the same decision.
- An LLM/agent is always invoked *through* a governed Capability, never as ambient
  authority.

## Consequences

- **Easier:** testing (the suite drives real logic against real SQLite), auditing
  (the ledger is the source of truth), and reasoning about blast radius.
- **Harder / accepted cost:** more upfront scaffolding before "it talks to an LLM";
  features must be expressed as capabilities and contracts, not ad-hoc model calls.
- **Commits us to:** every new external action being modelled as a capability with a
  side-effect level and policy, not a direct call. This is the invariant later ADRs
  (0002 pi-as-runtime, 0003 the breaker) build on.

## Alternatives considered

- **LLM-orchestrated control flow** (the model decides what to run): rejected —
  non-deterministic, unauditable, and unsafe under prompt injection.
- **Framework dependency for the agent loop:** rejected for V1 — zero runtime
  dependencies (Node + built-in `node:sqlite`) keeps the trust surface and behavior
  fully under our control.
