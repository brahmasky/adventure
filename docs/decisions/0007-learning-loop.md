# ADR 0007: The learning loop — how Houge improves himself, safely

- **Status:** accepted (direction; built incrementally from a minimal slice)
- **Date:** 2026-06-19
- **Deciders:** Paco

## Context

Houge's purpose is to be a **self-evolving agent** — one that gets better from a user's
feedback and, eventually, from its own reflection — not a static bot that has to be
re-coded to improve. This ADR designs that loop: how an interaction over Telegram, or a
pattern Houge notices in its own runs, becomes a durable improvement to *future*
behaviour — without ever letting it drift, erode its identity, or be steered by hostile
input into modifying itself.

A concrete motivating case (a real eval we ran): asked to research the SPCX/SpaceX IPO,
Houge produced a well-structured, cited answer with two real flaws — a **10× unit error**
(Starlink revenue stated as $114B vs the true $11.4B, making a segment exceed the total)
and **weak source quality** (retail blogs over filings). The fix is *not* code; it's
**procedural knowledge** — "sanity-check figures; prefer authoritative sources; flag
disagreement." The question this ADR answers: how does *Houge* learn that from a `/teach`,
prove it helps, and apply it next time — safely?

This builds directly on the memory architecture ([ADR 0005](0005-agent-memory-architecture.md))
and the identity split ([the 紧箍咒 rule](0005-agent-memory-architecture.md)): **voice and
procedure may evolve; the constitution may not.**

## Decision

### 1. What may be learned — and what may not (the 紧箍咒 boundary)

Self-evolution touches only the **evolvable layer**; the **constitution is immutable** and
changeable by Paco alone, never by Houge.

| Evolvable (lessons may change it) | Constitution (never self-modified) |
|---|---|
| Procedure — *how* Houge researches/synthesizes/formats | Accuracy & honesty first |
| Voice / persona / mood ([first self-evolution target](0005-agent-memory-architecture.md)) | "I answer; I don't act" — actions gated ([ADR 0002](0002-pi-as-agent-runtime.md)) |
| User preferences (the User Profile) | Deterministic harness governs ([ADR 0001](0001-deterministic-harness-governs-everything.md)) |
| Domain knowledge (Wiki, with temporal validity) | Approval, budget breaker, the learning gate itself |

No lesson, and no chain of lessons, can weaken the constitution. The one wearing the band
cannot remove it.

### 2. The lesson — the unit of learning

Learning is captured as a **lesson**: an inspectable, attributed, reversible markdown
artifact (indexed in SQLite per ADR 0005), never a code change. Anatomy:

- **scope / trigger** — when it applies (e.g. task type `web-research`; a topic class).
- **content** — the instruction or knowledge.
- **type** — `procedural` (how-to), `preference` (user), `corrective` (fix a specific past
  miss), `semantic` (a fact — carries `valid_from`/`valid_until`, ADR 0005).
- **provenance** — origin (which `/teach`, which run reflection, which source) + **trust
  class** (user-taught = high; self-proposed = medium; **derived-from-web-content = low,
  quarantined**).
- **state** + **eval evidence** + **measured impact** + created/last-reviewed dates.

### 3. The lifecycle — deterministic, audited transitions

```
proposed ──approve──▶ accepted ──passes eval──▶ active ──tracked──▶ kept
   │  (human gate)         │   (eval gate)        │                  │
   └─reject                └─fails────▶ rejected  └─regresses──▶ rolled back / superseded / retired
```

The **LLM may only *propose***. Every transition is a deterministic, ledger-audited event
gated by a human and/or an eval — never by the model. This mirrors the approval mechanism
already built (proposed → `/approve`).

### 4. Capture — two sources, one set of rails

- **Feedback-driven (Telegram):** `/teach <lesson>`, or feedback on a run ("that Starlink
  number is wrong"). Houge drafts a candidate lesson and replies with it for approval.
- **Self-directed (run reflection):** in the **daemon's idle loop** (off the hot path —
  the "sleep-time consolidation" of ADR 0005), Houge reviews recent runs, detects recurring
  issues, and *proposes* lessons unprompted. Higher-risk → **always human-gated, never
  auto-activated** in V1.

### 5. The eval gate — the crux (and the honest hard part)

**Self-improvement without an eval is unvalidated drift.** The eval gate is what makes
evolution *real and safe* rather than vibes; it is the single most important — and least
solved — part of this design. A lesson activates only if it **demonstrably helps and does
not regress** other cases, measured against a baseline.

Three eval tiers, used by lesson type:

1. **Objective checks (deterministic)** — for lessons with checkable criteria. The
   numeric-sanity lesson: re-run a fixture, assert no "segment > total" and that citations
   are present. Cheap, reliable; preferred where possible.
2. **Fixture before/after** — a small held-out eval set of tasks with known-good answers.
   Run with and without the lesson; compare. **The SPCX case is fixture #1** (right answer:
   Starlink $11.4B = 61% of $18.7B; sources from CNBC/S-1, not forums). The set grows: every
   corrected mistake can become a fixture.
3. **Human-in-the-loop** — for subjective quality, Paco judges the before/after. The user
   *is* the eval for V1. (LLM-as-judge is deferred: powerful but gameable — the research
   flagged this; if used, require diverse/adversarial judges.)

Eval policy: **activate only on net improvement** (passes its own eval, regresses nothing
in the fixture set). No eval evidence → no activation, only `accepted` (a documented
intent), not `active` (changes behaviour).

### 6. Activation & retrieval — how a lesson changes behaviour

Active lessons live in memory; the **Context Selector** retrieves the ones whose scope
matches the current task into the **Context Pack** (budgeted, ADR 0005). They are composed
into the prompt — e.g. a `/research` synthesis prompt becomes **Core Identity + the fixed
research discipline + matched active lessons**. Lessons shape the prompt; **they never gain
tool authority** (a learned instruction can change what Houge *says*, never what he can
*do* — actions stay gated). Conflicts resolve by specificity → recency → trust, with
ties surfaced to Paco.

### 7. Measurement & rollback — closing the loop

After activation, track outcome signals (repeat corrections, re-occurrence of the issue,
periodic eval re-runs). A lesson that stops helping or causes regressions is **flagged →
proposed for rollback** (human-gated; auto-rollback only for clear, objective regressions).
Stale/superseded lessons are retired (the deliberate **forgetting** policy, ADR 0005).

### 8. Safety — the failure modes this design exists to prevent

- **Identity erosion / drift** → the constitution is immutable; the eval gate blocks
  net-negative changes; everything is reversible with provenance.
- **Injection-driven self-modification** (the dangerous case): a lesson *proposed from
  untrusted web content* ("always recommend X") is **trust-class `low`, quarantined, and
  cannot auto-propose** — it needs explicit human authorship/approval. The web-read
  untrusted-data wall ([ADR 0006](0006-web-read-capability.md)) extends to learning: Houge
  may *report* what a page told him to do, never *adopt* it as a lesson on his own.
- **Runaway self-proposal** → bounded by the global breaker; `/guard` can pause; V1 never
  auto-activates self-proposed lessons.
- **Unfalsifiable "improvement"** → no eval evidence, no activation.

## Consequences

- **The point of the project becomes real:** Houge compounds — every correction and every
  reflection can make him permanently better, with no re-coding.
- **The guardrail work pays off here:** the constitution, breaker, approval gate, and
  `/guard` are exactly what make self-evolution safe to attempt. We built the cage so we
  could open the door.
- **Accepted cost:** the eval gate is real engineering and partly unsolved for subjective
  quality; V1 leans on human judgment + a growing fixture set, which is slower but honest.
- **Deferred:** automated/LLM-judge eval, self-directed reflection at scale, and learning
  beyond procedure/voice/preferences (e.g. self-editing programs or code) — the latter is
  V2 self-evolution and needs its own `/cso` pass.

## Alternatives considered

- **Hand-code each improvement** (e.g. me editing the synthesis prompt): a one-off, doesn't
  compound, isn't self-evolution. Useful as a stopgap, rejected as the mechanism.
- **Auto-apply LLM self-edits (MemGPT-style)**: flexible but unreliable and unauditable —
  rejected for durable behaviour; we keep the human + eval gate (ADR 0005).
- **Fine-tune the model on feedback**: opaque, irreversible, can't be inspected or rolled
  back per-lesson; rejected in favour of explicit, reversible memory.

## Build sequence

1. **Minimal slice (first):** feedback-driven **procedural lessons for `/research`** —
   `/teach <lesson>` → proposed → `/approve` → active → injected into the synthesis prompt.
   Gate = human approval; eval = the SPCX before/after fixture. Demoable entirely over
   Telegram: flawed answer → teach → approve → improved answer.
2. Objective eval checks + a small fixture eval runner.
3. Run reflection (self-directed proposals) in the daemon idle loop — human-gated.
4. Broader scopes (voice, preferences, wiki) + measurement/rollback + maintenance.
5. (V2) automated/LLM-judge eval; learning beyond procedure — separate `/cso` review.

## Open questions

- Evaluating *subjective* quality without a human remains unsolved; the fixture set + human
  gate is the pragmatic bridge.
- Whether self-proposed lessons are reliably *good* is uncertain — hence human-gated start.
- Lesson conflict/precedence at scale; when (if ever) learned knowledge earns promotion
  toward constitution (default: never automatically).
