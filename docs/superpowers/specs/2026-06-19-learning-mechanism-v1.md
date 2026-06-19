# Learning Mechanism v1 — how Houge learns (concrete spec)

The buildable spec for Houge's first real learning loop. Pins the still-open knobs from
[ADR 0007](../../decisions/0007-learning-loop.md) (lifecycle), [ADR 0005](../../decisions/0005-agent-memory-architecture.md)
(memory layers), and [ADR 0009](../../decisions/0009-architecture-coherence.md) (the prompt
composer) into a concrete v1, and folds in the scaling answer: **the store grows, the prompt
stays bounded.**

## Principles (the load-bearing four)

1. **The store grows; the prompt stays bounded.** Learned MDs accumulate on disk (cheap,
   unbounded). A *small relevant slice* enters any prompt. Memory is **not** a single growing
   prompt — you **retrieve**, you don't **accumulate**.
2. **Typed routing.** Learning sorts by *type* into different memory layers — there is no one
   dumping-ground file.
3. **Inspectable & reversible.** Lessons are human-readable markdown you can open, edit, and
   delete (the `CLAUDE.md` pattern). Mistakes are cheap to undo.
4. **Simple now, scalable later.** v1 loads the whole (small) lesson file; the
   retrieval/budget/consolidation machinery slots in *only when the lesson count makes it
   matter* — not on day one.

## Learning channels (and v1 scope)

| Channel | Trigger | Timescale | v1? |
|---|---|---|---|
| **`/teach`** | you type a lesson | durable | **✅ build** |
| **Reply-as-feedback** | you reply to an answer with a correction | durable | ⏳ optional/next |
| **Self-reflection** | daemon idle loop reviews runs, proposes lessons | durable | ⏳ deferred |
| **STORM self-critique** | within one run, grades + revises its own answer | ephemeral | ✅ (in-run; the inaugural discipline) |

## Where learning lands — typed routing (designed; v1 builds only the first row)

| Lesson type | Example | Lands in | v1? |
|---|---|---|---|
| **Procedural** | "sanity-check figures; prefer filings over forums" | `memory/skills/<scope>.md` | **✅** |
| **Preference** | "keep answers terse" | `memory/user/paco.md` | ⏳ |
| **Semantic / fact** | "SpaceX 2025 revenue = $18.7B" (+ `valid_from/until`) | `memory/wiki/<topic>.md` | ⏳ |
| **Episodic** | a run trace | `memory/journal/` (auto) | ⏳ |
| **Voice** | "a touch more playful" | the *voice* part of `houge.md` (gated) | ⏳ |

## The pipeline

```
CAPTURE   /teach text  (v1)   |  reply correction (next)  |  reflection (deferred)
   ↓
STRUCTURE → a LESSON line { content, scope, provenance, date }
   ↓        you-authored = high trust (active directly); agent-proposed = needs /approve (later)
GATE      v1: /teach is human-authored → active immediately; inspectable + revertible
   ↓
ROUTE     by type → the matching MD layer (v1: procedural → memory/skills/<scope>.md)
   ↓
STORE     append to the markdown file (the source of truth)
   ↓
INJECT    the prompt composer folds the file's lessons into the next matching run's prompt
```

## The prompt composer (ADR 0009 lever 1) — v1 behaviour

One function assembles every system prompt; **`houge.md` is loaded, never duplicated**:

```
composeSystemPrompt(surface) =
    Core Identity      (memory/core/houge.md — always loaded, small)
  + surface discipline (the fixed ask / research / STORM method)
  + learned lessons    (v1: read memory/skills/<surface>.md whole; "" if absent)
  + guardrails         (untrusted-data, answer-don't-act)
```

`/ask` and `/research` both call this instead of their hardcoded constants — so a lesson
taught for `research` shows up in `/research` automatically, and identity stays consistent.

## v1 concrete path (end to end)

1. `/teach research: a segment can't exceed the total — sanity-check figures; prefer filings
   over forums; flag when sources disagree`
2. Parser → a teach command (scope `research`, free-text lesson).
3. Append a bullet to **`memory/skills/research.md`** (created if absent), with `(date, via /teach)`.
4. Houge replies "Learned ✓ — I'll apply that to research."
5. Next `/research <topic>` → the composer reads `research.md` and folds its bullets into the
   synthesis system prompt's *learned-lessons* slot.
6. **Eval (the proof):** the SPCX `/research` before vs. after — the 10× error gone, sources
   better, disagreements flagged.

No SQLite, no retrieval ranking, no consolidation in v1 — `research.md` is small enough to
load whole. Inspectable and editable: open `research.md` to see exactly what 猴哥 has learned;
delete a line to make him forget it.

## Scaling staging (designed; built when needed)

| Stage | Mechanism | Trigger |
|---|---|---|
| **v1** | load the whole scope file | now |
| **growth** | SQLite + FTS5 catalog over lessons; scoped retrieval into a token budget | a scope exceeds ~the budget (≈20+ lessons) |
| **scale** | recency × importance × relevance ranking; consolidation + supersession + forgetting (daemon idle loop) | hundreds of lessons |

The markdown files stay the source of truth at every stage; SQLite is an *index layered on
for retrieval*, not a replacement.

## Open knobs to confirm during the build

- Lesson line format inside the MD (plain bullet vs. light front-matter for date/provenance/id).
- Whether `/teach` writes verbatim (v1) or Houge first normalizes it (adds an LLM step).
- Whether the STORM self-critique ships as a **built-in** discipline or as the **inaugural
  `/teach`-able lesson** (recommended: built-in default + overridable by a lesson).
- Scope inference: explicit prefix (`/teach research: …`) in v1; smarter inference later.

## Out of scope for v1 (deferred, designed)

Reflection (self-proposed lessons), the `/approve` + eval gate (only needed for agent-proposed
lessons), the other memory layers (preferences, wiki, journal), SQLite retrieval/ranking,
consolidation/forgetting, and reply-as-feedback. All specified in ADR 0005/0007; they slot onto
this same pipeline.
