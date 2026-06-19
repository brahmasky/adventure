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
| [0004](0004-long-poll-daemon.md) | Always-on long-poll daemon | accepted |
| [0005](0005-agent-memory-architecture.md) | Agent memory architecture direction | accepted |
| [0006](0006-web-read-capability.md) | Web-read capability — free-read, gated-act | accepted |
| [0007](0007-learning-loop.md) | The learning loop — how Houge improves himself, safely | accepted |
| [0008](0008-houge-identity-authenticated-read.md) | Houge's identity & authenticated read | accepted |
| [0009](0009-architecture-coherence.md) | Architecture coherence — prompt composition, registries, whole-agent review | accepted |

## Writing a new ADR

1. Copy [`0000-template.md`](0000-template.md) to `NNNN-short-title.md` (next number).
2. Fill in Context → Decision → Consequences → Alternatives.
3. Add a row to the index above.
4. When a decision changes, supersede — don't edit — the old ADR.
