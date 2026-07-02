# ADR 0012: The self-evolution spine — a closed eval loop, not memory-as-king

- **Status:** accepted (direction; built in a sequenced roadmap) · roadmap **re-sequenced by
  [ADR 0013](0013-llm-inner-composition.md)** — the inner loop is step ⓪; attribution rides its
  observation hooks; the wiki lands loop-native
- **Date:** 2026-06-27
- **Deciders:** Paco
- **Relates to:** refines [ADR 0011](0011-self-evolution-architecture.md) (does not supersede it)

## Context

[ADR 0011](0011-self-evolution-architecture.md) gave Houge the *machinery* to change himself:
he self-writes his own code (gated: writer → test-gate → reviewer → branch → human merge),
authors his own skills, and learns lessons. As of 2026-06-27 that machinery is **shipped and
proven** — Houge has landed two fully-autonomous self-writes over Telegram (the 猴哥 intent fix
`3c85328`, the research-critique prompt fix `3516dee`).

And yet Houge **does not compound.** He re-fixed the same 猴哥 bug across stale branches; he
re-explains himself because he has no long-term memory of what he has already said; the same
correction (process-leak, language drift) surfaced at three layers — lesson, skill attempt, then
code fix — because nothing tied the second occurrence back to the first. This is not a
database-size problem. It is a **loop-not-closing** problem: Houge can *change*, but the loop
that turns a change into durable, measured, compounding improvement is open.

Two things forced this ADR now. **(1)** The locked strategic direction (2026-06-26) committed
Houge to *full autonomy + mechanical safety nets*, with the **self-evolution spine as the first
build before any task capability** — so the spine's shape must be decided. **(2)** Five 2026
papers on agent memory and self-evolution were read in full to inform it
(briefs retained in session 2026-06-27):

- **MOSS** (arXiv 2605.22794) — self-evolution by rewriting source code; built on OpenClaw, a
  personal-assistant daemon structurally identical to Houge. *Has* a closed loop.
- **Strategy Genes** (arXiv 2604.15097) — experience encoded as compact ~230-token control
  objects with an explicit AVOID field. *Has* a closed loop.
- **AtomMem** (arXiv 2606.19847) — long-term memory via atomic-fact extraction. *No* eval loop.
- **DCPM** (arXiv 2606.09483, Tencent) — dual-process memory + supersedes chains. *No* eval loop.
- **AI Meets Brain** (arXiv 2512.23343) — 57-page survey of ~50 memory systems. Catalogs the
  loop; does not solve the signal problem.

**The convergent finding is the heart of this ADR.** Three of the five are 2026 state-of-the-art
memory systems with **no runtime feedback loop at all** — they write memories on one-shot LLM
judgment and trust it (DCPM admits its revisions "over-fire" with no way to catch it). The survey
treats "how does the system know a change was good?" as the field's blind spot. The two papers
that *do* close the loop (MOSS, Strategy Genes) both depend on the **same** thing: an
**executable verifier** — they replay the failing case / run candidate code against checkpoints,
and *only verified changes persist*. **The eval loop is the open problem, and a real verifier is
what makes it work.** Houge's existing gated self-write is already further along this axis than
any of the three memory papers.

A second forcing distinction emerged in discussion (Paco, 2026-06-27): **learning knowledge ≠
getting feedback.** The internet is a *library* (knowledge in); the eval loop is a *report card*
(self-knowledge: which of my own changes were net-positive). A kid with unlimited internet and no
feedback becomes a confident conspiracy theorist, not a scholar. The internet can teach Houge
facts and skills but can **never** teach him which of *his own* changes improved him — that is the
spine's un-outsourceable job. This is why the spine's first cut is the eval loop, not the
knowledge-acquisition arm.

Constraints carried in (unchanged): cheap, model-agnostic runtime (pi → kimi; Claude/Codex/Gemini
are build-time muscle, [ADR 0010](0010-natural-language-intent-layer.md)); **local-first, zero-cost**
defaults (local embeddings — confirmed by every memory paper: all-MiniLM-L6-v2, bge-m3);
**freedom-over-control** ([ADR 0001](0001-deterministic-harness-governs-everything.md)) — it is OK
for Houge to fail; gates are nets, not a cage; and the core principles stay constant
([ADR 0005](0005-agent-memory-architecture.md)).

## Decision

**The unit of self-evolution is the closed loop, not the layer.** ADR 0011 decomposed
self-evolution by *artifact* (lessons / skills / code, each with its own gate). This ADR reframes
it by *process*: every improvement, on every artifact, runs the same loop —

```
sense signal → remember → change → EVALUATE → keep / rollback → consolidate
```

Memory is the **keystone** (everything depends on it) but the **eval loop is the engine** — it
gives direction; without it, autonomy is a confident random walk. We build a **thin vertical slice
of the whole loop** first and let the loop reveal the memory shape, rather than over-specifying a
maximal memory architecture up front (every paper's ablation says ~80% of the value is in the
simplest layers).

### 1. The feedback signal — explicit human rating, primary; reuse-value, secondary

The signal that drives keep/rollback. On Houge's main surface (conversation) there is **no
executable verifier**, so we do not pretend one exists. Instead:

- **Primary = an explicit, Houge-initiated rating** (the Anthropic "how is this session going?
  0–3" model) + an optional one-line comment. Asked at a **session boundary** (lull + substance)
  **and** after **high-stakes events** (a self-write merged, a new skill first applied, a research
  answer delivered), **rate-limited** so it never fatigues. *Sparse-but-explicit beats
  dense-but-ambiguous:* silence counts as weak/neutral, never as positive.
- **Attribution.** Each rating attaches to the **artifacts that were live that session** — which
  requires logging, per turn, *what was retrieved/applied*. This is the cheap, load-bearing
  enabler. A low rating triggers a **bounded LLM attribution pass** over the transcript to identify
  the likely culprit artifact; a low rating + comment becomes a **superseding** lesson.
- **Weak evidence, accumulated.** A single rating never acts; a **pattern across sessions**
  promotes or demotes an artifact (MOSS's batch discipline — gate a change on a batch of signal,
  not one reaction).
- **Secondary = reuse-as-value** (free): an artifact applied-and-not-corrected gains weight.
- **Rejected: standalone LLM-as-judge self-evaluation** — it rationalizes its own mistakes (the
  same conclusion as ADR 0011 §"Alternatives"; reaffirmed by the three loop-less memory papers).
- **Autonomous signals** (cross-source verification, prediction-error) arrive later, via the
  knowledge/wiki domain (§4), which — unlike conversation — can partly grade itself.

### 2. Compounding = reconcile-on-write, never append

The direct cure for "re-fixes the same bug / re-explains himself," and the most convergent finding
across the papers (DCPM, AtomMem, the survey, Strategy Genes all land here independently): when a
new memory arrives, **reconcile it against what exists — ADD (novel) / SUPERSEDE (it changed) /
UPDATE (it supplements) — rather than appending a duplicate.** SUPERSEDE writes a bidirectional
pointer and **never deletes** the predecessor (DCPM: chain-traversal predicted correct answers 78%
vs 31%). This is also the **memory half of keep/rollback** (§5): reverting a bad memory = traverse
back to the superseded version.

### 3. Four memory types for v1 — reuse what exists, add two

| Type | What it holds | Home | Status |
|---|---|---|---|
| **Lessons** | preferences / behavior | `lesson_blocks` (SQLite) | exists; +eval-metadata, +AVOID |
| **Skills** | reusable procedures | `skills/` | exists; +eval-metadata, +AVOID |
| **LLM Wiki** | durable, synthesized, per-topic *world* knowledge | `knowledge/<topic>.md` | **new** |
| **Conversational-episodic** | what Paco & Houge actually discussed | new store | **new** |

- **Lessons + skills** gain **eval metadata** (`applied_count`, `rating_history`, `reuse_value`, a
  `supersedes` pointer) and an explicit **`AVOID` field** — Strategy Genes' single highest-ROI
  element (+4.6pp), and the natural output of the eval loop ("you leaked the process again → AVOID:
  emitting revision notes").
- **The LLM Wiki** (Karpathy's framing) is the *consolidate-external-knowledge* type: Houge reads
  sources and writes durable, synthesized, refinable topic pages — not raw dumps, not ephemeral
  lookups. It is built *from the internet*, so it depends on the `http_fetch` capability
  ([Phase 3.6](../superpowers/specs/2026-06-26-phase3.6-http-fetch.md), if specced separately;
  otherwise the spine spec).
- **Conversational-episodic memory** is built with the AtomMem + DCPM **dual-process** mechanism:
  a **fast path** (per session: distill turns into atomic, pronoun-resolved, time-grounded facts;
  reconcile via §2; store only the novel residual — *not* raw transcripts) and a **slow path**
  (daily/idle: consolidate the day's facts, promote recurring → durable patterns, merge dups).
  Extraction is **prompt-only** (no fine-tuning; AtomMem-Flat captured most of the gain).
- **Forgetting is mandatory** (the papers' weakest point — AtomMem and DCPM are append-only and
  grow unbounded). Raw transcripts are dropped after distillation; distilled memories **decay if
  unused** and are pruned below a threshold (survey's Ebbinghaus pattern). Houge's edge over the
  papers: the **distillation itself runs inside the eval loop**, so a memory that proves wrong or
  useless decays or is superseded instead of being trusted forever.
- **Deferred** (add only when the loop shows recall is the bottleneck): DCPM's nightly
  pattern-induction graph + cross-domain collision, AtomMem's PageRank graph — single-digit
  ablation gains for substantial complexity.

### 4. The internet is the library; the eval loop is the report card

Knowledge acquisition (facts, skills, wiki pages) flows *in* from the internet via capabilities
(`http_fetch`, `web_search`). This **expands what Houge knows** but does **not** supply the
self-improvement signal. The wiki domain is special only in that it offers a **partial autonomous
verifier** — Houge can cross-check a claim across sources and notice when a prediction it wrote
later proves false — which is the autonomous signal conversation lacks. The eval loop is therefore
*more* necessary once Houge ingests the open internet, not less: without it, autonomous ingestion
of contradictory/adversarial content ([ADR 0006](0006-web-read-capability.md)) is a confident
random walk at higher speed.

### 5. Keep / rollback — two flavors, hard-failures-auto only

- **Memory rollback** = the supersede chain (§2). Cheap, basically free.
- **Code/behavior rollback** = the load-bearing new piece (MOSS). Today's gates (test-gate +
  Phase-3.3 post-merge-red → auto-revert-no-restart) prove a change *compiles and passes tests*;
  they do **not** prove the daemon *comes up healthy live* on the new code. We add a **post-restart
  live health-probe**: after self-restart, sample heartbeat / process-alive / responds-to-a-probe
  over a short window; N consecutive passes commit, else **auto-rollback to last-known-good** (the
  pre-merge git commit, read from an *independent* record so a corrupt change can't trap the loop),
  rebuild, restart, and notify Paco.
- **Scope:** **hard failures only** (crash / won't-boot / crash-loop). **Soft regressions** ("boots
  but answers worse") are not auto-detectable without a fast reliable signal we don't have — they
  ride the **slow eval loop** (§1: ratings over sessions → supersede/revert). Do not expect the fast
  net to catch quality regressions.
- **Auto-rollback is the net that unlocks full autonomy.** It is what makes the locked
  *notify-after, not approve-before* fork safe — if Houge bricks himself, he recovers himself. Until
  it ships, the merge stays **human-tapped** (ADR 0011 Amendment 2's `[Merge & reload]`). It slots
  in **right before** the human-tapped → autonomous merge flip, alongside the internet steps where
  stakes rise. Caveat: code rollback is clean only without irreversible state change — DB
  migrations stay **out of autonomous scope** for now.

### 6. Built as a sequenced roadmap (each step shippable + live-gated)

Decided (Paco): build **both** the behavior slice and the knowledge slice, **sequenced** — the
behavior slice de-risks the shared loop machinery with no new capability, then the *same* engine is
carried to the knowledge slice. The thin slice builds the loop **once** (rating + attribution
logging + reconcile-on-write/supersede + reuse-value + decay) and proves it on one memory type; the
other types then plug in. Detail in
[the spine spec](../superpowers/specs/2026-06-27-spine-self-evolution-loop.md):

1. **Slice A** — loop machinery, proven on lessons (no new capability).
2. **Conversational-episodic memory** (no new capability; reuses the machinery).
3. **`http_fetch`** — the internet capability (hard prereq for the wiki).
4. **Slice B** — the LLM Wiki (reuses the machinery + adds the autonomous cross-source signal).
5. **Skills** gain the eval metadata.

The remaining mechanical safety-net floor from the locked charter (kill-switch, secrets firewall,
self-regression eval, metered-API $ ceiling) interleaves: the eval loop in step 1 **is** the
self-regression-eval seed; the secrets firewall and auto-rollback become load-bearing at steps 3–4.

## Consequences

- **Compounding becomes the measured default**, not an accident: every correction attaches to an
  artifact, supersedes rather than duplicates, and earns or loses its place by signal. The
  loop-not-closing problem this ADR exists to fix is directly targeted.
- **The eval loop is treated as the differentiated, open problem** — the thing no memory paper
  solves and the thing Houge is already ahead on. Building it is the project's actual edge.
- **Honest signal boundaries are accepted:** conversation gets a sparse-but-true human signal
  (slow), knowledge gets a dense-but-fuzzy autonomous signal (faster, lower-quality), code gets a
  hard-failure auto-net + a slow soft-regression net. We do not manufacture a fake metric to paper
  over the gap.
- **Memory stays thin and local** (four types, two new, prompt-only extraction, local embeddings,
  mandatory forgetting); the heavy graph/induction machinery is deferred behind evidence.
- **Auto-rollback is the precondition for full autonomy** — until it ships, the human merge tap
  stays, which keeps Paco the backstop and bounds risk during the build.
- **Accepted risks:** the autonomous cross-source signal can confidently consolidate
  consensus-but-wrong knowledge (mitigated: it only *calibrates*, the human rating overrides; the
  wiki is reversible prose); attribution from a coarse session rating is imperfect (mitigated: the
  bounded transcript pass + accumulate-before-acting); forgetting can prune something later useful
  (mitigated: decay is slow and reuse refreshes value).

## Alternatives considered

- **Memory-as-king** (build a maximal memory architecture first — the DCPM/AtomMem shape):
  rejected — three SOTA memory papers prove a rich store still can't self-assess; the loop, not the
  store, is the engine, and the ablations show the fancy layers add single digits.
- **Internet learning as the primary self-improvement signal** ("Houge learns from the web like a
  kid"): rejected as a *category error* — the internet is knowledge-in, not the report card; it
  raises drift stakes and cannot grade Houge's own changes. Adopted instead as the knowledge arm
  (§4) layered *on top of* the eval loop.
- **LLM-as-judge as the signal:** rejected (see §1) — rationalizes its own mistakes.
- **Auto-rollback on soft quality regression:** rejected for v1 — not reliably auto-detectable
  without a fast signal we don't have; routed to the slow eval loop instead.
- **Flip to autonomous merge immediately** (per the locked autonomy fork): deferred — gated on
  auto-rollback shipping first; until then the human tap is the net (ADR 0011 Amendment 2 stands).

## Supersedes / relates to

- **Refines** [ADR 0011](0011-self-evolution-architecture.md): keeps its machinery (Codex muscle,
  worktree isolation, refine ≤3, the guard/test-gate/reviewer stack, the merge checkpoint) and
  reframes its *three-layers-by-artifact* model into *one-closed-loop-by-process* with the eval
  loop as the engine and four memory types. ADR 0011 and its amendments stand; this ADR adds the
  loop, the signal, the memory shape, and auto-rollback around them.
- **Builds on** [ADR 0007](0007-learning-loop.md) (the eval gate as "the least-solved part" — now
  the spine's engine), [ADR 0005](0005-agent-memory-architecture.md) (memory direction;
  core-principles constant), [ADR 0006](0006-web-read-capability.md) (untrusted-data wall — gates
  the wiki/internet arm), [ADR 0010](0010-natural-language-intent-layer.md) (model-agnostic chain;
  build-time/runtime split), [ADR 0001](0001-deterministic-harness-governs-everything.md)
  (freedom-over-control; deterministic floor).
- **External evidence / prior art:** MOSS (2605.22794) — directed batch-anchored evolution,
  replay verification, post-swap health-probe + auto-rollback; Strategy Genes (2604.15097) —
  compact control objects, AVOID field, compress-don't-hoard, executable-verifier gating; AtomMem
  (2606.19847) — atomic-fact extraction, residual-write; DCPM (2606.09483) — dual-process
  write/consolidate, supersedes chains; AI Meets Brain survey (2512.23343) — the extract→update→
  retrieve→apply loop, multi-factor retrieval, semantic-merge, Ebbinghaus forgetting, the
  Fidelity/Dynamics/Generalization eval triad.
