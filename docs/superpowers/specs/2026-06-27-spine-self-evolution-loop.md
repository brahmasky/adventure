# Spec — the self-evolution spine (closed eval loop) — sequenced roadmap

Source of truth for building [ADR 0012](../../decisions/0012-self-evolution-spine-closed-loop.md).
Status: **DESIGN LOCKED 2026-06-27** (Decisions 1–4 settled with Paco; 5 papers read). **No `/goal`
yet** — each roadmap step below is its own independently shippable, live-gated build, taken one at a
time on Paco's `/goal`.

> **RE-SEQUENCED 2026-07-02 by [ADR 0013](../../decisions/0013-llm-inner-composition.md)** (LLM inner
> composition): a **step ⓪ — the inner loop** — now precedes this roadmap; see the
> [inner-loop spec](2026-07-02-inner-loop-refactor.md). Consequences for this spec: **A1 (attribution
> logging) is emitted by the loop's observation hook** rather than built standalone; Slice A (① below,
> stages A2–A9) lands *on* the loop as its step ⓪·3; **Slice B (④, the wiki) is built loop-native**
> (tools `wiki_build`/`wiki_refine` in the loop manifest, never a hardcoded pipeline). All Decisions
> 1–4 stand unchanged.

## Goal

Close the loop so Houge **compounds**. He already changes himself (self-write, skills, lessons) but
doesn't accumulate — re-fixes the same bug, re-explains himself, the same correction recurs across
layers. The spine makes every improvement run one loop —

```
sense signal → remember → change → EVALUATE → keep/rollback → consolidate
```

— with a real feedback signal as the engine and reconcile-on-write as the compounding mechanism.
Build a **thin vertical slice of the whole loop first** and let it reveal the memory shape; do **not**
pre-build a maximal memory architecture (every paper's ablation says ~80% of value is the simplest
layers).

## The shared loop machinery (built once, in Slice A; reused everywhere)

The whole point: the loop is **one set of machinery** that every memory type plugs into.

1. **Attribution logging** — per turn, record *what was retrieved/applied* (which lessons/skills/
   wiki pages/facts). The load-bearing enabler: a rating is only as useful as what it can attach to.
2. **The rating prompt** — Houge asks `0–3` + optional one line, at a session boundary (lull +
   substance) and after high-stakes events, **rate-limited**. Stored against the turn's applied set.
3. **Reconcile-on-write** — `ADD | SUPERSEDE | UPDATE` against existing memories of the same kind
   (top-k neighbors by local embedding). SUPERSEDE writes bidirectional pointers, never deletes.
4. **Reuse-value + decay** — a counter per artifact; applied-and-not-corrected → value++; unused →
   decay; prune below threshold. (The forgetting the papers omit.)
5. **Low-rating attribution pass** — a bounded LLM read over the transcript → the likely culprit
   artifact → flag/supersede. Single rating = weak; a **pattern** across sessions acts.

## The feedback signal (Decision 1)

- Primary = explicit human rating (above). Silence = weak/neutral, never positive.
- Secondary = reuse-as-value (free).
- Autonomous (cross-source verify, prediction-error) = later, only on the wiki domain (§Slice B).
- **No standalone LLM-as-judge.** Conversation has no executable verifier; we don't fake one.

## Memory model (Decision 2) — four types, two new

| Type | Home | Unit | New? |
|---|---|---|---|
| Lessons | `lesson_blocks` (SQLite) | preference/constraint + `AVOID` | +metadata |
| Skills | `skills/<scope>/<name>.md` | procedure + `AVOID` | +metadata |
| **LLM Wiki** | `knowledge/<topic>.md` | synthesized topic page | **new** |
| **Conversational-episodic** | new store (SQLite `episodic_facts`) | atomic fact (pronoun-resolved, time-grounded) | **new** |

- **Eval metadata** on every artifact: `applied_count`, `rating_history`, `reuse_value`,
  `supersedes`/`superseded_by`, `last_used`.
- **Extraction is prompt-only** (no fine-tuning; AtomMem-Flat captured most of the gain). **Local
  embeddings** (MiniLM/bge-m3 class) for reconcile/retrieve — zero cost, no network.
- **Deferred:** DCPM nightly induction graph + cross-domain collision; AtomMem PageRank graph.

## Keep / rollback (Decision 4)

- Memory rollback = the supersede chain (free).
- Code rollback = **post-restart live health-probe + auto-rollback to last-known-good** (pre-merge
  commit, independent record), **hard-failures only** (crash/won't-boot/crash-loop). Soft regressions
  ride the slow eval loop. Auto-rollback **unlocks** the human-tapped → autonomous merge flip; until
  it ships, `[Merge & reload]` stays human-tapped (ADR 0011 Amendment 2).

---

## Roadmap — sequenced (each its own `/goal`, each ends with a LIVE run)

### ① Slice A — loop machinery, proven on lessons  *(no new capability)*

The de-risking step: build the whole engine where it's cheapest, on artifacts Houge already has.

**Build stages (each green; via build + independent-verification subagents):**
- A1. `run-store.ts` — `recordAppliedArtifacts(run_id, [{kind,id,version}])`; persist per turn.
- A2. `lesson_blocks` schema migration — add `applied_count`, `rating_history` (json), `reuse_value`,
  `supersedes`/`superseded_by`, `avoid` (text), `last_used`. Accessors on `RunStore`.
- A3. Rating capability — `src/capabilities/session-rating.ts`: trigger policy (session-lull +
  substance threshold + high-stakes events; rate-limited via a stored cooldown), the `0–3` prompt
  over the notification path, parse + store against the applied set. Env: `HOUGE_RATING_ENABLED`,
  `HOUGE_RATING_COOLDOWN_*`, `HOUGE_SESSION_LULL_MINUTES`.
- A4. `src/capabilities/reconcile.ts` — `reconcile(newLesson, neighbors) → ADD|SUPERSEDE|UPDATE`
  (top-k by local embedding; tolerant parse; default ADD on miss). Wire into the feedback/distill
  path so corrections supersede instead of append.
- A5. Reuse-value + decay — increment on apply-without-correction; a daily decay+prune pass.
- A6. Low-rating attribution pass — bounded LLM read of the transcript → culprit artifact → flag;
  accumulate (a pattern, not one rating, supersedes/demotes).
- A7. `AVOID` field threaded into the composer (lessons render their AVOID line).
- A8. Gates: typecheck · `npm test` · build · deps {} · independent adversarial verification.
- **A9. LIVE GATE (interactive, Telegram):** Paco corrects a behavior → lesson written with AVOID
  (not appended; supersedes the prior if present) → Houge asks `0–3` at session end → next session
  the behavior is correct AND a *repeat* correction **supersedes** rather than re-learns (= visible
  compounding). `/lessons` shows reuse_value + supersede lineage.

### ② Conversational-episodic memory  *(no new capability; reuses ①)*

**Build stages:**
- B1. `episodic_facts` store + migration (fact text, embedding, participants, ts, salience,
  `supersedes`, reuse_value, last_used).
- B2. Fast path — `src/capabilities/episodic-extract.ts`: per session, distill turns → atomic
  facts (prompt-only, pronoun-resolved, time-grounded) → reconcile via A4 → store residual only.
- B3. Retrieval — fold relevant episodic facts into the composer (multi-factor: relevance + recency
  + reuse, not pure cosine — survey's procedural-recall fix). Cap per turn.
- B4. Slow path — daily consolidation: cluster the day's facts, promote recurring → durable, merge
  dups; decay/prune raw + stale (reuse A5).
- B5. Gates + independent verification.
- **B6. LIVE GATE:** Paco states a durable fact ("I'm in Sydney, cycle weekends") → days later asks
  a related question → Houge uses it WITHOUT re-asking, and does not re-explain something already
  told. Wrong/transient facts decay or get superseded (not trusted forever).

### ③ Phase 3.6 — `http_fetch`  *(the internet capability — hard prereq for ④)*

Build per the existing [Phase 3.6 spec](#) (todo.md "Phase 3.6", gates H1–H7): narrow server-side
GET, SSRF resolve-and-PIN floor, GET/HEAD only, byte+time caps, no-redirect, optional denylist.
**Secrets firewall** (charter floor) becomes load-bearing here — Houge's main process must not read
`.env`; creds brokered only into the capabilities that need them.

### ④ Slice B — the LLM Wiki  *(reuses ① + adds the autonomous signal)*

**Build stages:**
- C1. `knowledge/<topic>.md` store — synthesized page + frontmatter (sources, last_verified,
  confidence, `supersedes`, reuse_value). `.gitignore /knowledge/` (runtime state).
- C2. Build/refine path — `src/capabilities/wiki.ts`: topic intent → `http_fetch` sources →
  synthesize page (compress, don't dump) → reconcile/supersede an existing page (stay current
  without losing history).
- C3. **Cross-source verification = the autonomous signal** — multiple sources, flag contradictions,
  attach a confidence; a written prediction later checkable feeds prediction-error.
- C4. Reuse/rating/supersede-on-update — free from ①. Wiki pages fold into research/answer turns.
- C5. Gates + independent verification.
- **C6. LIVE GATE:** Paco asks Houge to look into a topic → a `knowledge/<topic>.md` page is built
  + cross-source-verified → the topic recurs → Houge reuses + refines the page (supersede), and the
  page measurably improves over interactions. Contradictions surfaced, not silently averaged.

### ⑤ Skills — eval metadata  *(tiny, once ① exists)*

Add the same eval metadata + AVOID + reconcile to `skills/`; skills now compound on the proven loop.

### Interleaved — auto-rollback + autonomy flip (Decision 4)

Before flipping `[Merge & reload]` from human-tapped to autonomous: build the **post-restart live
health-probe + auto-rollback to last-known-good** (hard-failures only). Then the locked
*notify-after* autonomy fork can land. The rest of the charter safety floor (kill-switch,
metered-$ ceiling) tracked separately; the eval loop (①) is the self-regression-eval seed.

## File pointers (new / changed)

- New: `src/capabilities/session-rating.ts`, `reconcile.ts`, `episodic-extract.ts`, `wiki.ts`;
  stores `episodic_facts`, `knowledge/`.
- Changed: `src/run/run-store.ts` (applied-artifacts, eval metadata, migrations), `src/prompt/
  composer.ts` (AVOID + episodic/wiki folding), `src/capabilities/intent.ts` (topic/wiki intent),
  `src/core/core-worker.ts` (rating triggers, reconcile wiring), `src/contracts/task-contract.ts`
  (wiki/episodic contracts), `src/capabilities/self-write-merge.ts` (health-probe + auto-rollback).

## Risks / unknowns

- **Sparse human signal** (Slice A) → compounding slow to *show*; mitigated by reuse-value + the
  episodic/wiki paths densifying signal.
- **Cross-source signal is fuzzy** (Slice B) → consensus ≠ truth; mitigated — it only *calibrates*,
  human rating overrides, wiki is reversible prose.
- **Attribution from a coarse session rating** is imperfect → mitigated by the transcript pass +
  accumulate-before-acting.
- **Forgetting** could prune something later useful → decay slow, reuse refreshes value.
- **Local embedding quality** for reconcile → start simple, measure; bge-m3-class if needed.

## Out of scope (→ later)

DCPM nightly induction graph + cross-domain collision; AtomMem PageRank; proactive/scheduled wiki
refresh (scheduler ADR); browser tier (JS/SPA) of internet access; multimodal; kill-switch +
metered-$ ceiling design.

## Verification (every step)

typecheck clean · `npm test` green · `npm run build` OK · `dependencies: {}` · independent
adversarial verification · **a LIVE run over real Telegram** (the cardinal rule — never `npm test`
alone).
