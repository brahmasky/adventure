# ADR 0005: Agent memory architecture direction

- **Status:** accepted (direction; implemented incrementally from Milestone 4)
- **Date:** 2026-06-18
- **Deciders:** Paco

## Context

Houge's spec already describes a layered memory system (Core Identity, User Profile,
Programs, Skills, Wiki, Environment Guidebooks, Lessons, Run Journal, Raw Artifacts) with
a Memory Catalog, Context Pack (budgeted), Context Selector, and a human-approved Learning
Lifecycle. Before building it (Milestone 4), we surveyed the mid-2026 state of the art —
academic (arXiv) and product/framework — deliberately independent of any prior
implementation. Full review: [docs/research/agent-memory-2026.md](../research/agent-memory-2026.md).

The survey showed Houge's instincts are mostly **validated** (layered memory; budgeted
retrieval; human-gated, inspectable markdown writes — the safe side of the field's most
contested axis), with a few clear **gaps** (temporal correctness; off-hot-path
consolidation; explicit retrieval scoring; user-editable memory). It also surfaced a
strong fit: the always-on daemon (ADR 0004) is the natural home for background consolidation.

## Decision

Build Houge's memory on the converged four-type taxonomy (working / episodic / semantic /
procedural), keeping the existing layered-markdown + human-gated design, with these
commitments:

1. **Zero-dependency store: SQLite + FTS5, no vector DB.** Use the built-in `node:sqlite`
   for durable memory and FTS5 for keyword retrieval. This preserves the zero-runtime-deps
   principle (ADR 0001) and matches the Hermes-Agent pattern. Add a vector/graph layer only
   if a real workload proves FTS5 insufficient — not pre-emptively.
2. **Hybrid, budgeted retrieval scored recency × importance × relevance** (the Generative
   Agents pattern) into the Context Pack's fixed token budget — not load-everything.
3. **Auto-capture raw episodic; human-gate the durable distillation.** The Run Journal
   captures raw turns/runs automatically (low-risk logging). Distilling episodic → durable
   semantic/procedural memory (User Profile, Wiki, Lessons) goes through the human-approved,
   eval-gated Learning Lifecycle. Always keep raw + provenance; summaries point back to source.
4. **Temporal correctness: invalidate-don't-delete.** Semantic facts carry `valid_from` /
   `valid_until`; a contradicting fact supersedes (does not overwrite) its predecessor, so
   "true until X" is answerable. (Closes the spec's clearest gap.)
5. **Consolidation runs off the hot path, in the daemon's idle loop** — reflection and
   episodic→semantic distillation happen between polls, never on the user's turn.
6. **Memory is user-inspectable and editable over Telegram** — extend `/teach` with
   view / correct / forget, mirroring every consumer system's editable-summary pattern.
7. **Evaluate with a small domain set** (multi-session recall, contradiction, forgetting) —
   vendor benchmark numbers are publicly disputed and not a basis for choices.

Core Identity (`memory/core/houge.md`) is the small, always-loaded identity block — the
first concrete memory artifact, written now alongside naming Houge (猴哥).

## Consequences

- **Easier / aligned:** stays zero-dep and on the auditable end of the write-policy debate;
  the daemon doubles as the consolidation worker (a direct payoff from Milestone 3).
- **Adds to the spec:** temporal validity fields, explicit retrieval scoring, and the
  daemon-as-consolidator role are new commitments folded into the Memory System section.
- **Accepted cost / risk:** FTS5 keyword retrieval lacks semantic fuzziness a vector store
  gives; acceptable for a single-operator agent and revisitable behind the Context Selector
  seam. Human-gated distillation trades some autonomy for auditability (deliberate).
- **Deferred:** graph/temporal-KG engines, vector embeddings, and parametric consolidation
  are out of scope until a workload demonstrably needs them.

## Alternatives considered

- **Vector DB / embeddings now** (mem0, Letta archival): rejected for V1 — adds a dependency
  and infra before a workload justifies it; FTS5 + scoring covers the single-operator case.
- **Temporal knowledge graph (Zep/Graphiti)**: the right model for fact-evolution, but the
  full graph engine is heavyweight; we adopt its *idea* (bi-temporal invalidation) in SQLite
  rather than its infrastructure.
- **Automatic LLM-self-editing memory (MemGPT/Letta)**: flexible but flagged unreliable
  ("forgets to save, overwrites wrong"); rejected for durable writes in favor of the gated
  lifecycle. (We still use LLM judgment to *propose* writes.)
- **Copy WuKong's LCM**: explicitly declined as a template — referenced only as one data
  point after this independent survey.
