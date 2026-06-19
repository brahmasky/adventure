# ADR 0001: Deterministic harness governs everything

- **Status:** accepted · **scope narrowed 2026-06-19** (see Amendment) — *governs the
  irreversible, not the cognitive*
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

---

## Amendment (2026-06-19): control is the floor, not the point

*"Governs everything" was over-stated. This narrows the scope without reversing the
principle — informed by the "intent-driven / let-go" critique (over-orchestration is a
**trust tax** on a capable model) and a deliberate project choice: Houge is an experiment
we're willing to see fail, so energy belongs on **intelligence**, not on the cage.*

The harness governs the **irreversible and the catastrophic** — not the cognitive:

- **Floor (deterministic, gated):** anything that could irreversibly harm *others* or the
  operator — destructive/filesystem-escaping actions, external writes, paid actions, secret/
  token exposure, acting-under-identity. These keep the gate. Kept **minimal** and framed as
  Houge's own character, not an imposed band (see `memory/core/houge.md`).
- **Free (the model's to run):** everything cognitive — reading, researching, thinking,
  synthesizing, competing drafts, exploring, proposing. Here we **give the wheel to the
  model**: direction over scripts, emergence over SOP. Over-constraining this space makes
  Houge *dumber*, not safer.
- **Mistakes are cheap and reversible, not impossible.** Exploration is made safe by
  reversibility (isolated identity, eval-rollback, reversible memory, objective audit) — the
  way you childproof a cliff, not cage a child — rather than by forbidding the attempt.

So the invariant stands — *deterministic code owns the few things that must not go wrong, the
LLM owns judgment* — but the boundary sits at **irreversible action**, and the cognitive
interior is free. The project's centre of gravity is **intelligence**; the floor stays small,
quiet, and objective (constitution + budget breaker + OTel/ledger audit).
