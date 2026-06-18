# Agent memory: state of the art (mid-2026) — literature review

A landscape review gathered to inform Houge's memory system *before* committing to a
design — deliberately **not** anchored on any single prior implementation. It pairs an
academic/architectural survey (arXiv) with a product/framework survey (vendor docs).
The design decisions this informs live in [ADR 0005](../decisions/0005-agent-memory-architecture.md).

> Sourcing note: arXiv IDs below were verified against primary sources where marked.
> Vendor benchmark numbers are **publicly contested between competitors** — treat all
> cross-system accuracy comparisons as directional, not settled. Some 2026-dated items
> are single-source / lightly verified and flagged inline.

---

## 1. The converged taxonomy (CoALA)

The field has largely standardized on a cognitive-science-derived split, formalized by
**CoALA** (Sumers, Yao, Narasimhan, Griffiths — arXiv:2309.02427, 2023, TMLR 2024):

- **Working memory** — active, in-context state for the current decision cycle; tightly
  coupled to (and bounded by) the context window.
- **Episodic memory** — past experiences/trajectories, with time ("what happened").
- **Semantic memory** — facts about the world and the user/self.
- **Procedural memory** — how-to; in practice realized as optimized instructions / prompt
  rules / skills-as-code, not a separate retrieval store.

It also splits **internal** actions — *retrieval* (read long-term), *reasoning* (update
working), *learning* (write long-term) — from external grounding actions. This vocabulary
is the lingua franca everything below builds on.

## 2. Foundational mechanisms

- **Generative Agents** (Park et al., arXiv:2304.03442, 2023) — the reference pattern an
  enormous amount of later work cites: an append-only **memory stream** of natural-language
  observations, retrieved by a weighted score of **recency** (exponential decay) ×
  **importance** (LLM-assigned 1–10) × **relevance** (embedding cosine), plus **reflection**
  (periodic LLM synthesis of higher-level insights, written back, citing source memory IDs).
- **MemGPT / Letta** (Packer et al., arXiv:2310.08560, 2023) — LLM-as-OS: **virtual-memory
  paging** between an in-context tier (system + working + small pinned **core memory**) and
  external tiers (**recall** = event history, **archival** = unbounded vector store). The LLM
  self-edits memory via tool calls; eviction pages to disk rather than deleting. Letta
  (the company/framework) generalizes core memory into labeled, size-capped, editable
  **memory blocks**, and adds **sleep-time** consolidation (see §4).
- **A-MEM** (Xu et al., arXiv:2502.12110, 2025) — Zettelkasten-style atomic notes that
  autonomously **link** to related notes and **evolve** neighbors when new notes arrive;
  flexible but LLM-heavy on the write path, and lacks principled forgetting.

## 3. Retrieval: vector vs. graph vs. temporal KG

- **Vector** (chunk→embed→ANN cosine) is the cheap, fast, mature default — but blind to
  relations (no multi-hop) and to fact-evolution (stale and fresh coexist, unversioned).
- **Graph** (entities/edges, multi-hop) — e.g. **GraphRAG** (Edge et al., Microsoft,
  arXiv:2404.16130, 2024): LLM-built entity graph + community summaries for global questions.
- **Temporal knowledge graph — Zep / Graphiti** (Rasmussen et al., arXiv:2501.13956, 2025):
  the clearest 2025–26 trend toward **temporal correctness**. **Bi-temporal** edges (event
  validity `t_valid/t_invalid` *and* ingestion time) and **invalidate-don't-delete** on
  contradiction (old facts are superseded, not removed) → can answer "what is true now" and
  "what was true at time X." Hybrid retrieval (cosine + BM25 + graph BFS, reranked), no LLM
  in the hot retrieval path. Apache-2.0 engine.
- **mem0 / mem0g** (Chhikara et al., arXiv:2504.19413, 2025) — production-oriented
  extract-then-consolidate with explicit **ADD/UPDATE/DELETE/NOOP** lifecycle ops; mem0g
  adds an entity graph. **HippoRAG 2** (2025) reframes RAG as continual memory via
  hippocampal-indexing + Personalized PageRank.

Pragmatic consensus: **start with vectors/keyword; add graph/temporal structure for the
specific high-value entities that need multi-hop or point-in-time reasoning.**

## 4. Consolidation & "sleep-time" (off the hot path)

- **Recursive / hierarchical summarization** — RAPTOR (Sarthi et al., arXiv:2401.18059,
  2024) builds an embed→cluster→summarize **tree**; recursive summarization (arXiv:2308.15022)
  folds prior memory + new context. Caveat: summarization is lossy and **recursive
  summarization compounds loss** ("recursive decay"), time-sensitive details first.
- **Episodic→semantic distillation** — "Episodic Memory is the Missing Piece" (Pink et al.,
  arXiv:2502.06975, 2025) argues for an *explicit* episodic store; NEMORI (arXiv:2508.03341,
  2025) distills via a **prediction-error** signal (keep what's hard to predict).
- **Offline consolidation** — **Sleep-time Compute** (Lin et al., arXiv:2504.13171, 2025):
  pre-compute over a context during idle time → ~5× less test-time compute at equal accuracy.
  LightMem (arXiv:2510.18866, 2025) decouples organization into non-inference periods. This
  is the active frontier (Letta sleep-time agents, LangMem background manager, OpenAI
  "Dreaming"): **do the LLM-heavy memory work between turns, not on the user's turn.**
- **Forgetting** — most self-organizing systems lack a principled policy (a noted gap).
  Options seen: decay (MemoryBank's Ebbinghaus curve, arXiv:2305.10250), eviction-to-cold
  (MemGPT), explicit DELETE (mem0), invalidation (Zep).

## 5. What the products ship (mid-2026)

- **Anthropic / Claude** — five mechanisms: a client-side **Memory Tool** (`/memories`
  files, app executes the ops, "**assume interruption** — checkpoint progress because
  context can reset"); server-side **context editing + compaction**; **Claude Code**
  `CLAUDE.md` (human-written, directory-walked, loaded in full) **+ auto-memory**
  (`~/.claude/projects/<p>/memory/` with a `MEMORY.md` index, first ~200 lines/25KB loaded,
  topic files on demand); the **Agent SDK** (auto-compaction, isolated-context subagents
  returning condensed summaries, persistent `memory` dir); and **Claude.ai** per-project
  memory with an **editable human-readable summary**. (Memory files are *context, not
  enforced config* — hard guarantees need hooks.)
- **OpenAI** — ChatGPT **saved memories** (always-on list) + **reference chat history** (a
  "continually updated synthesis," editable Memory Summary, response-level provenance UI);
  **Codex memories** (~April 2026 preview: background summaries of idle threads in
  `~/.codex/memories/`, off by default) vs **AGENTS.md** (static human convention, not
  learned). Server state moved Threads → **Responses/Conversations API** (durable, no TTL).
- **Hermes Agent** (Nous Research, MIT, 2026) — Houge's closest sibling: a Telegram/Slack/
  Discord CLI agent, model-agnostic, with a local **SQLite + FTS5** cross-session memory +
  LLM summarization in `~/.hermes/`. Validates SQLite+FTS5 as a sound, dependency-light store.
- **OpenClaw** (Steinberger, MIT gateway, 2026) — **routes, doesn't remember**: per-sender
  sessions + credential state, no documented long-term memory. A transport peer, not a
  memory one.
- **Frameworks** — Letta/MemGPT (blocks + sleep-time), LangGraph **+ LangMem** (semantic/
  episodic/procedural, hot-path tools + background manager), **mem0** (hybrid vector+graph,
  LLM CRUD), **Zep/Graphiti** (temporal KG). Common thread: consumer-facing memory is always
  **inspectable and user-editable**.

## 6. Evaluation (and a warning)

Named benchmarks: **LongMemEval** (arXiv:2410.10813 — 5 abilities: extraction, multi-session
reasoning, temporal reasoning, knowledge-updates, abstention; ~30% accuracy drop on long
histories → long context alone is insufficient), **LoCoMo** (arXiv:2402.17753 — ~300-turn
dialogues), DMR, MSC. **Temporal reasoning and knowledge-updates are the hardest axes;
abstention is underdeveloped (models over-answer).** Headline vendor numbers (mem0 vs Zep)
are **publicly disputed** — build a **small domain-specific eval** (multi-session recall,
contradiction, forgetting) rather than choosing a backend on marketing numbers.

## 7. Design principles (the actionable distillation)

1. **Adopt the four-type taxonomy; treat the context window as a managed, scarce resource.**
   Make context assembly an explicit, budgeted step.
2. **Keep raw episodic memory non-lossy; layer abstraction on top.** Avoid destructive
   recursive summarization as the only store; summaries should point back to raw + provenance.
3. **Score retrieval on more than cosine** — recency × importance × relevance; hybrid
   (semantic + keyword + structural) with reranking.
4. **Handle fact evolution as a core requirement** — invalidate-don't-delete with validity
   intervals; don't let stale and current facts silently coexist.
5. **Move expensive consolidation off the hot path** — online fast path + offline
   consolidation worker.
6. **Split episodic vs semantic; treat procedural as prompt-shaping.**
7. **Make writes inspectable, attributed, reversible** — and ideally user-editable; gate the
   *durable* writes, auto-capture the raw ones.
8. **Match structure to need, start simple; evaluate with your own domain set.**

## 8. Where the field is unsettled

- Vector vs. graph vs. hybrid (graphs win on multi-hop/temporal but cost more; gains are
  non-uniform across question types).
- Summarize vs. keep raw, and how aggressively (recursive-decay critiques are live).
- Automatic LLM-self-editing vs. gated/deterministic writes (flexibility vs. reliability).
- Explicit external store vs. parametric consolidation into weights.
- Whether principled forgetting actually helps (asserted more than demonstrated).
- Evaluation is immature; cross-paper numbers often aren't comparable.

## Key sources

CoALA 2309.02427 · Generative Agents 2304.03442 · MemGPT 2310.08560 · A-MEM 2502.12110 ·
GraphRAG 2404.16130 · Zep 2501.13956 · mem0 2504.19413 · RAPTOR 2401.18059 · Sleep-time
Compute 2504.13171 · Episodic-Memory Position 2502.06975 · NEMORI 2508.03341 · MemoryBank
2305.10250 · LongMemEval 2410.10813 · LoCoMo 2402.17753 · surveys 2404.13501 / 2505.00675 /
2512.13564. Products: platform.claude.com/docs (memory tool), claude.com/blog/context-management,
code.claude.com/docs/en/memory, openai.com/index/memory-and-new-controls-for-chatgpt,
developers.openai.com/codex/memories, github.com/nousresearch/hermes-agent, docs.openclaw.ai.
