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
8. **Identity evolution — the core-principles rule.** Core Identity splits into a **voice**
   layer (tone, character, mood — learned via the User Profile + Lessons, free to evolve) and a
   small set of **core principles** (accuracy/honesty, the operating rules, the
   no-irreversible-harm boundary) that are simply who Houge is — changed only by Paco's hand,
   never self-edited, because they protect Paco and are the experiment's one constant, not
   because they restrain Houge. Persona-voice is the designated **first self-evolution target**:
   lowest-risk (a worse joke is reversible; a deleted file is not), highest-feedback, and it
   exercises the full self-evolution loop before it ever reaches code or capabilities.
   **Everything evolvable is free; the core principles hold** — and because Houge holds them as
   character, there is nothing to escape. (Childproof a cliff, not cage a child —
   [ADR 0001](0001-deterministic-harness-governs-everything.md).)

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

## Amendment — memory A1 (2026-10-02)

Spec `docs/superpowers/specs/2026-10-02-memory-a1-fixes-design.md` (Rev 3). The stores now behave as this ADR describes:
- **Lessons** carry one closed-list theme (`format`, `time`, `honesty`, `hygiene`, `sources`, `tasks`, `self`;
  `unthemed` by default); merging is same-theme only (a themed UPDATE onto an `unthemed` target adopts the theme).
  Every write is capped (text 240, AVOID 120) and stored as one line: an over-cap write is refused, never stored.
  An UPDATE keeps the target's standing. A SUPERSEDE or UPDATE may cross the `ask` / `research` scopes (both render
  in one omp prompt); the new row takes the target's scope. The omp planner renders every active `ask` and
  `research` lesson, theme then id, under `HOUGE_LESSON_CHAR_CAP`; a lesson that does not fit is a `lesson_dropped`
  ledger row and incident, and its `last_used` is refreshed (seen, not credited) so decay cannot delete it. A render
  failure opens `lesson_render_failed`. Consolidation's growth floor is gone (Paco keeps it off).
- **Credit** follows the prompt: only the lessons and core facts the spawned session's prompt holds are touched and
  rated.
- **Retrieval** admits a fact or page only above a cosine gate over the whole chat pool (`HOUGE_EPISODIC_MIN_COSINE`
  0.42, `HOUGE_WIKI_MIN_COSINE` 0.42; embeddinggemma kept after a benchmark); without a query embedding only FTS
  hits enter, and the FTS legs drop English function words and short non-CJK tokens. Each turn's attribution row
  carries the gate telemetry. Decay no longer prunes facts or pages (B redesigns the lifecycle). Rows with no
  embedding are embedded on correction and by a bounded daily backfill; an embedding outage opens
  `embeddings_unavailable`.
- **Biography**: a merged fact is core only when every source is; core never decays and is never cap-pruned;
  `core_overflow` opens above `HOUGE_EPISODIC_CORE_CAP`.
- **Provenance**: each extracted fact cites a numbered user line and a quote that code checks
  (`HOUGE_EPISODIC_EVIDENCE`, `shadow` by default); a passing fact points at that one turn, and `core` needs it. An
  evidence-failing fact never touches a core row. Fact reconcile has its own prompt and embedding neighbours.

## Amendment — an over-cap merge never loses the instruction (2026-10-06, Paco)

A1 refused a reconcile UPDATE whose merged text or inherited AVOID exceeded the cap, so the planner could tell Paco
or save a narrower rule. In practice the planner hit the same cap and the instruction was lost (live gate against
lesson #45, both the Jev memory lane and the planner's `lesson_write`). Now: the reconcile prompt states the 240-char
limit; an over-cap UPDATE gets one retry asking the model to fit both rules into the cap; if it still does not fit
and the new rule fits on its own, the new rule is saved as its own lesson (ADD, the target's theme when themed) and the
target stays untouched, ledgered `lesson_update_overflow {candidate, target, merged_chars}`. A near-duplicate is the
accepted cost. A candidate that is itself over a cap is still refused (`lesson_write_capped`).

