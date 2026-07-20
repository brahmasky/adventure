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
| [0001](0001-deterministic-harness-governs-everything.md) | Deterministic harness governs everything | accepted; scope narrowed by amendment; mechanism supplied by [0013](0013-llm-inner-composition.md) |
| [0002](0002-pi-as-agent-runtime.md) | Pi as agent runtime: inference vs agentic modes | accepted |
| [0003](0003-global-budget-breaker.md) | Global budget circuit-breaker (autonomy floor) | accepted |
| [0004](0004-long-poll-daemon.md) | Always-on long-poll daemon | accepted |
| [0005](0005-agent-memory-architecture.md) | Agent memory architecture direction | accepted; §1 retrieval amended by [0016](0016-episodic-local-embeddings.md) |
| [0006](0006-web-read-capability.md) | Web-read capability — free-read, gated-act | accepted |
| [0007](0007-learning-loop.md) | The learning loop — how Houge improves himself, safely | accepted; user-feedback capture superseded by [0010](0010-natural-language-intent-layer.md) |
| [0008](0008-houge-identity-authenticated-read.md) | Houge's identity & authenticated read | accepted |
| [0009](0009-architecture-coherence.md) | Architecture coherence — prompt composition, registries, whole-agent review | accepted |
| [0010](0010-natural-language-intent-layer.md) | Interaction model — natural-language intent layer (Houge as Claude Code over Telegram) | accepted; enum-as-dispatch refined by [0013](0013-llm-inner-composition.md) |
| [0011](0011-self-evolution-architecture.md) | Self-evolution architecture — code, skills, lessons (three layers, dual eval gates, Codex muscle) | accepted; refined by [0012](0012-self-evolution-spine-closed-loop.md) |
| [0012](0012-self-evolution-spine-closed-loop.md) | The self-evolution spine — a closed eval loop, not memory-as-king (feedback signal, four memory types, auto-rollback) | accepted; roadmap re-sequenced by [0013](0013-llm-inner-composition.md) |
| [0013](0013-llm-inner-composition.md) | LLM inner composition — code owns the gates, the model composes between them (contracts become envelopes; the inner loop; evolution layers as tools) | accepted |
| [0014](0014-dual-llm-privilege-separation.md) | Dual-LLM privilege separation — the reader that touches untrusted bytes cannot act (quarantined Q-LLM reader + privileged P-LLM planner; restores the [0006](0006-web-read-capability.md) wall inside the [0013](0013-llm-inner-composition.md) loop) | accepted (design; build after secrets firewall) |
| [0015](0015-secrets-firewall.md) | Secrets firewall — the main process holds no ambient credentials (boot-time SecretBroker + strip `process.env`; single source of truth; Codex env lockdown; output redaction; Phase 2 = broker process, deferred) | accepted (design; build as its own /goal) |
| [0016](0016-episodic-local-embeddings.md) | Episodic retrieval — local embeddings via Ollama (`embeddinggemma` over localhost HTTP, `dependencies:{}` intact; graceful BM25/recency degradation; vectors as SQLite BLOBs; amends [0005](0005-agent-memory-architecture.md) §1) | accepted |
| [0017](0017-scheduler.md) | Scheduler v1 — a new trigger source feeding the same gateway→worker spine (wall-clock+tz specs, DST-correct next-run math, fire-then-advance misfire policy; the [0003](0003-global-budget-breaker.md) breaker is the blast-radius net; vestigial schedule types go live) | accepted |
| [0018](0018-kill-switch.md) | Durable kill switch — park-alive tombstone + disarm posture | accepted |
| [0019](0019-metered-ceiling.md) | Metered-API $ ceiling — ledger-derived spend, latch-driven enforcement | accepted |
| [0020](0020-llm-wiki.md) | LLM wiki — verified, reusable knowledge pages (Phase W) | accepted |
| [0021](0021-db-backup.md) | DB backup — WAL-safe periodic snapshots via `VACUUM INTO` (tmp+rename, quick_check gate, latch-retry, local-only) | accepted |
| [0022](0022-money-fork-reopened.md) | Money fork re-opened — earning is IN (human-fronted), custody/trading/fund-holding stay OUT (re-decides charter fork 3; ADR 0001 floor unchanged) | accepted |
| [0023](0023-external-workspace.md) | External engineering workspace — container-sandboxed work on third-party repos | accepted |
| [0024](0024-introspection-invariant-sweep.md) | Introspection — the deterministic invariant sweep as Houge's first self-sensing organ (the **sense** stage ADR 0012 left open) | accepted |

## Writing a new ADR

1. Copy [`0000-template.md`](0000-template.md) to `NNNN-short-title.md` (next number).
2. Fill in Context → Decision → Consequences → Alternatives.
3. Add a row to the index above.
4. When a decision changes, supersede — don't edit — the old ADR.
