# ADR 0020: LLM wiki — verified, reusable knowledge pages (Phase W)

- **Status:** accepted
- **Date:** 2026-07-16
- **Deciders:** Paco
- **Relates to:** spine spec ④ (slices C1–C6); reuses the episodic store blueprint
  [ADR 0016](0016-episodic-local-embeddings.md), the dual-LLM wall
  [ADR 0014](0014-dual-llm-privilege-separation.md), the code-owned-surfacing rule
  (ADR 0001), and the loop-tool conventions of [ADR 0013](0013-llm-inner-composition.md) /
  [ADR 0017](0017-scheduler.md)

## Context

Houge re-searches the same topics from scratch (the Phase R residual): nothing durable
comes out of a research turn except the answer text. The wiki is the last major spine
capability — per-topic knowledge pages built from the internet, cross-source verified
(the first autonomous eval signal), reused and refined across turns and chats. Built in
two live-gateable slices: **W1** store + tools + verification + render (this ADR's
implementation), **W2** the reuse loop (retrieval into the prompt, rating/decay wiring).

## Decision — the 12 locked design points

1. **SQLite is truth; markdown is a render.** `wiki_pages` in houge.sqlite (episodic
   blueprint: FTS5 mirror + sync triggers, nullable embedding BLOB, supersede lineage);
   `memory/wiki/<slug>.md` regenerated on every save with YAML frontmatter (topic,
   sources, last_verified, confidence, supersedes, reuse_value) and a
   `## Contradictions (unresolved)` section when non-empty. The render write is
   best-effort — a failure never fails the save.
2. **Loop-native, no internal fetching (trust anchor).** Two manifest names
   `wiki_build`/`wiki_refine`, ONE shared adapter (`executeWikiUpsert`). Synthesis input
   = the turn's recorded external-read step digests (post-quarantine when Dual-LLM is
   armed) captured into `LoopTurnContext.externalReads`/`sourceUrls` — the model picks
   only WHEN and the TOPIC; code supplies the material. build⇄refine auto-route on
   existing-page identity — never a duplicate page.
3. **Deterministic C3 floor:** ≥ `HOUGE_WIKI_MIN_SOURCES` (default 2) distinct source
   URLs this turn (deduped host+path; unparseable URLs tolerated), else an exported
   refusal steering the model to fetch first.
4. **Topic identity (C6 recurrence):** `normalizeTopicSlug` (NFKC, lowercase,
   punct→`-`, cap 64, unicode letters kept so CJK slugs work) →
   `findWikiPageForTopic`: exact active slug → FTS top-1 → cosine ≥ 0.75; each leg
   degrades gracefully (Ollama down just skips the cosine leg).
5. **Cross-source verification = a separate walled verifier** (the Gate B pattern,
   author ≠ grader): role `"reader"` (cross-family chain), exported
   `WIKI_VERIFY_DISCIPLINE`, ensemble of `HOUGE_WIKI_VERIFY_PASSES` (default 2) with one
   retry per pass, output `{supported, unsupported[], contradictions[], confidence}`.
   Contradictions carry BOTH sides verbatim with source labels — NEVER averaged. All
   passes failing ⇒ the page saves UNVERIFIED (confidence NULL, verified_passes 0) —
   verification calibrates, never blocks (a wiki page is reversible prose; the human
   rating signal overrides in W2).
6. **Contradiction surfacing is code-owned:** `buildWikiContradictionNotice` rides the
   existing `turnCtx.evolutionNotices` append — the model cannot suppress it (ADR 0001).
7. **Trust boundary, 3 legs:** (a) ingestion rides the existing dual-LLM wall — no new
   raw-byte path exists; (b) write-time neutralization of title/summary/key_facts (and
   contradiction claim/a/b — they render into replies): flatten CR/LF + U+2028/U+2029 +
   NEL, `→`, `time_claims:`; caps title 120 / summary 500 / ≤10 key_facts ×240 /
   body_md 8000; (c) W2 retrieval will fold ONLY the sanitized projection (title +
   key_facts + confidence + ⚠ contradiction lines) under a data-not-instructions
   header — **body_md never enters a prompt** (it renders only into the .md file).
8. **Synthesis LLM:** role `"answer"` (general-model legs, inherits the metered fuse).
   Refine = the synthesis call carries the prior page as DATA + a reconcile
   instruction; `{"unchanged": true}` ⇒ touch last_verified only, no new row.
   Supersede = insert a new row + bidirectional pointers, never delete; the old row
   pays corrected_count/reuse (−0.5) ONLY when the refine surfaced contradictions
   (the candidate carries a `priorContradicted` flag).
9. **Scope: pages are GLOBAL** (no chat_id) — knowledge isn't per-conversation, and C6
   recurrence must work across chats.
10. **Breaker position: loop_step-only** (the schedule_task precedent) — no
    tool_finished event, so no 24h tool_calls count (the feeding fetches already
    counted); the internal synthesis/verify legs emit `llm_call` and inherit the
    metered-$ fuse (ADR 0019).
11. **Budget tail:** the wiki tools are EXCLUDED from `BUDGET_TAIL_TOOLS` and are not
    `terminalAfterSuccess`; the descriptor text steers sequencing ("call AFTER ≥2
    independent sources fetched this turn, BEFORE the final answer"). LOOP_DISCIPLINE
    is untouched — the composer goldens stay byte-stable.
12. **`memory/wiki/` is NOT a protected path** (it must stay runtime-writable);
    `.gitignore` already covers it. The PROTECTED files touched by this build
    (run-store.ts, task-contract.ts) were edited from the orchestrator seat, not by a
    self-write.

## Store path

Pages live under **`memory/wiki/`** (beside the other memory surfaces), superseding the
spine spec's `knowledge/` — recorded here as deliberate drift.

## Deferred (recorded, not lost)

- **Prediction-error feed** (using the wiki to score expectation vs outcome) — after W2.
- **Built-in scheduled refresh** — zero-code covered today: a `schedule_task` with goal
  "refresh your wiki page on X" fires a normal turn that fetches and calls wiki_refine.
- **Low-rating culprit attribution** stays lessons-only for now.

## Flags

`HOUGE_WIKI_ENABLED` (default OFF) · `HOUGE_WIKI_MIN_SOURCES` (2) ·
`HOUGE_WIKI_VERIFY_PASSES` (2) · `HOUGE_WIKI_MAX_PAGES` (200). W2 adds
`HOUGE_WIKI_RETRIEVE_CAP` / `HOUGE_WIKI_RECENCY_HALFLIFE_DAYS` / `HOUGE_WIKI_DECAY_DAYS`
(the `wiki_decay_state` latch table already exists — the schema landed complete in W1's
one migration, `2026-07-16-wiki-pages`).

## Slice W2 — the reuse loop (2026-07-17)

- **Retrieval scoring** (`src/run/wiki-retrieval.ts`, the episodic-retrieval clone):
  `score = relevance × recency × reuse` where relevance = max(normalized BM25, cosine,
  0.05 floor), recency = exponential half-life (`HOUGE_WIKI_RECENCY_HALFLIFE_DAYS`,
  default 30) on **max(created_at, last_verified, last_used)** — a re-verified or
  re-applied page is alive, never stale-by-birthday — and reuse =
  1 + 0.15·log1p(reuse_value), a log-compressed tie-breaker. Cap
  `HOUGE_WIKI_RETRIEVE_CAP` (default 1), 1200-char guard on the rendered projection
  (drops lowest-scored first). Never throws — any failure folds nothing.
- **Confidence is DISPLAYED, never ranked.** The verifier's confidence calibrates the
  reader's trust in a page (`(confidence 0.82, verified …)` / `(unverified)` on the
  title line); it must not hide an unverified-but-relevant page from retrieval — the
  human rating signal, not the verifier, governs a page's standing (reuse_value).
- **Prompt fold:** `WIKI_SECTION_HEADER` (web-derived reference DATA, not instructions;
  ⚠ disagreements surfaced, never settled) between the episodic and lessons sections;
  only the sanitized projection renders (title + key facts + ⚠ contradiction claims) —
  body_md never enters a prompt (decision 7c upheld). `wikiReader` absent ⇒
  byte-identical prompt. One query embedding per turn is SHARED by episodic + wiki
  retrieval (a single Ollama call).
- **Eval loop:** `loop_started.applied_artifacts.wiki_page_ids` seeds attribution;
  applied pages earn `applied_count`/`last_used` per turn; a session rating ≥2 pays
  +0.25 reuse_value to the window's applied pages (rating_history appended either way);
  the daily `runWikiDecayTick` (24h `wiki_decay_state` latch, riding the daemon's
  signal-path tick, flag-gated) decays actives unused for `HOUGE_WIKI_DECAY_DAYS`
  (default 45) by 20% and prunes — reversibly, never DELETE — below the lessons prune
  line; superseded rows are exempt (inactive lineage). One `wiki_decay_tick` ledger
  event per executed tick.
- **Known residual (W2 verifier F1, accepted for v1 — watch in soak):** the 0.05
  relevance floor means an armed daemon folds the top page into EVERY turn (a greeting
  still folds the best-scored page at cap 1), and each fold refreshes `last_used` +
  earns rating credit — the perpetually-folded top page never goes decay-stale and
  absorbs credit from unrelated turns. Same shape episodic shipped with; wiki's
  chunkier winner-take-all cap makes it more visible. Future fix if soak confirms:
  exclude pure-floor matches from fold/touch/credit.
- **F2 identity floor (W1 residual, live-observed):** `findWikiPageForTopic`'s FTS leg
  now requires EVERY topic token to match (FTS5 `AND`), not any. An any-token match
  merged token-overlapping DISTINCT topics ("Tesla Q2 earnings" hit the ASML page on
  q2+earnings); no fractional floor separates that shape (2/3 overlap on the false
  merge vs 1/2 on a legitimate rephrase), so identity demands full coverage —
  paraphrase recurrence stays the cosine leg's job. Exact-slug and cosine legs
  unchanged; W2 retrieval keeps OR semantics (breadth is fine there — it ranks, it
  never merges identity).
