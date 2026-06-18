# Architecture Decision Records

Short, immutable, numbered records of significant decisions — the **why** behind how
Houge is built. Each ADR captures one decision: its context, the choice, and the
consequences. They are append-only: to change a decision, write a new ADR that
supersedes the old one (and flip the old one's status), so the reasoning trail
survives even as the code changes.

Read these first when onboarding — they explain choices the code alone can't.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-deterministic-harness-governs-everything.md) | Deterministic harness governs everything | accepted |
| [0002](0002-pi-as-agent-runtime.md) | Pi as agent runtime: inference vs agentic modes | accepted |
| [0003](0003-global-budget-breaker.md) | Global budget circuit-breaker (autonomy floor) | accepted |

## Writing a new ADR

1. Copy [`0000-template.md`](0000-template.md) to `NNNN-short-title.md` (next number).
2. Fill in Context → Decision → Consequences → Alternatives.
3. Add a row to the index above.
4. When a decision changes, supersede — don't edit — the old ADR.
