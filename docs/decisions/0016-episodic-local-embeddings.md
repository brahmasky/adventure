# ADR 0016: Episodic retrieval — local embeddings via Ollama (amends 0005 §1)

- **Status:** accepted
- **Date:** 2026-07-15
- **Deciders:** Paco
- **Relates to:** amends [ADR 0005](0005-agent-memory-architecture.md) §1 ("SQLite + FTS5,
  no vector DB... add a vector layer only if a real workload proves FTS5 insufficient");
  implements the retrieval leg of Phase M (roadmap ② conversational-episodic memory) under
  [ADR 0013](0013-llm-inner-composition.md)'s composed loop

## Context

ADR 0005 committed to FTS5-only keyword retrieval and explicitly deferred vector embeddings
"until a workload demonstrably needs them." Phase M (episodic memory: distill chat turns into
durable facts, retrieve them into future prompts) is that workload, demonstrated before a line
of retrieval code was written:

- **Paco chats with Houge in Chinese.** FTS5's `unicode61` tokenizer does **not** word-segment
  CJK — an unbroken Chinese run indexes as ONE token, so a query like 「明天周末我该干嘛」
  shares no token with a stored fact like 「Paco 喜欢周末骑车」. For the primary user's primary
  language, keyword relevance is near-useless: BM25 returns zero hits on exactly the recalls
  that matter. (Verified against `node:sqlite`'s compiled FTS5 during Phase M recon; encoded
  as a test: *CJK query with embeddings retrieves the right fact with ZERO FTS hits*.)
- The 0005 escape hatch was designed for this moment: "revisitable behind the Context
  Selector seam" — retrieval scoring is one function, so the vector leg slots in without
  reshaping the store.

The tension: ADR 0001's zero-runtime-dependency principle (`dependencies: {}`) rules out a
vector DB client, an embeddings SDK, or any npm package.

## Decision

**Paco chose embeddings-now (2026-07-15) over an FTS5-only v1.** The implementation keeps
`dependencies: {}`:

1. **Local Ollama over plain HTTP** (`http://localhost:11434/api/embed`, built-in `fetch`) —
   a *system-service* dependency in the same class as the pi/agy CLIs Houge already shells to,
   not an npm dependency. Model: **`embeddinggemma`** (768-dim, multilingual — CJK support is
   the entire reason FTS5-only was insufficient). Configurable via `HOUGE_EMBED_URL` /
   `HOUGE_EMBED_MODEL` / `HOUGE_EMBED_TIMEOUT_MS`.
2. **Graceful degradation is the contract, not a fallback.** ANY embed failure — Ollama down,
   model missing, timeout, malformed body — returns `null`: facts are stored **without** an
   embedding (a nullable BLOB column, backfillable later), and retrieval degrades to
   BM25 + recency + reuse. No retries, never blocks a turn or a distill pass.
3. **Retrieval scores `relevance × recency × reuse × salience`** (the 0005 §2 commitment),
   where relevance = max(normalized BM25, cosine, small floor): the cosine leg carries CJK,
   the BM25 leg carries English when vectors are absent, and zero-FTS-hit ≠ zero relevance.
4. **Facts store their vectors in SQLite** (`episodic_facts.embedding` BLOB + `embedding_model`),
   not a vector DB: at the per-chat cap of 200 active facts, brute-force cosine over a
   candidate pool is microseconds — an index would be infrastructure without a workload.

## Consequences

- **0005 §1 is amended, not discarded:** SQLite stays the one store; FTS5 stays the keyword
  floor and the zero-setup path; "no vector DB" still holds — what changed is that vectors now
  exist, computed by a local sidecar and stored as BLOBs.
- **A new operational dependency class member:** the daemon's host should run Ollama with
  `embeddinggemma` pulled. When it doesn't, nothing breaks — memory quietly loses semantic
  recall for CJK until the service returns (rows written meanwhile are backfillable; a
  backfill pass is deliberately deferred until the soak shows it matters).
- **Latency:** local embed is ~50ms typical; `HOUGE_EMBED_TIMEOUT_MS` (default 5s) caps the
  worst case on the turn's hot path — acceptable for v1, revisit if the soak disagrees.
- **Privacy holds:** fact text never leaves the machine for embedding (localhost HTTP), which
  is also why a hosted embeddings API was not the chosen shape.
- **Revisit conditions:** an ANN index (or sqlite-vec) only if active-fact caps grow ~100×;
  a different model only via the env knobs + `embedding_model` column (rows self-describe
  which model produced them, so mixed-model stores are detectable).

## Alternatives considered

- **FTS5-only v1, embeddings later** (the literal 0005 plan): rejected by Paco 2026-07-15 —
  the primary workload is Chinese, so "later" would ship a memory that cannot recall for its
  main user; the CJK gap is structural (tokenizer), not tunable.
- **A CJK-segmenting FTS tokenizer** (ICU/trigram): `node:sqlite` ships without ICU and a
  custom tokenizer means native code — a heavier dependency than an HTTP sidecar, and it
  still yields keyword (not semantic) recall.
- **npm embeddings client / vector DB** (openai sdk, sqlite-vec, LanceDB): rejected —
  breaks `dependencies: {}` (ADR 0001) for capability the ~200-row scale doesn't need.
- **Hosted embeddings API** (OpenAI/Gemini): rejected — sends every remembered life detail
  off-machine, adds a metered cost and a network dependency to the memory path; a local
  model is strictly better here and free.
