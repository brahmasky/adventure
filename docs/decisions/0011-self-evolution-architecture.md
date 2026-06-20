# ADR 0011: Self-evolution architecture — how Houge improves his code, skills, and lessons

- **Status:** accepted (direction; built in phases)
- **Date:** 2026-06-20
- **Deciders:** Paco

## Context

Houge's purpose is to be a **self-evolving agent** ([ADR 0007](0007-learning-loop.md)) — one
that gets better from feedback and from reviewing himself, not a static bot that must be
re-coded to improve. ADR 0007 built the *lesson* loop (procedural preferences) but explicitly
**deferred** "learning beyond procedure/voice — e.g. self-editing programs or **code** — the
latter is V2 self-evolution and needs its own review." This ADR specifies that V2: how Houge
**reviews and improves his own code and skills**, not just his preferences.

Two things unblock it now. **(1) A coding muscle:** Codex CLI is installed and authenticated on
Paco's ChatGPT subscription — a strong, non-Claude coding agent we can delegate to (validated
live: it read Houge's source cold and correctly diagnosed the 猴哥 classifier bug). **(2) An
eval gate for the subjective surface:** ADR 0007 called the eval gate "the single most
important — and least solved — part," specifically for quality you can't check with a test.
The OPENSKILL paper (arXiv 2606.06741) demonstrates a mechanism — *self-built deterministic
assertions anchored to independently-retrieved world facts* — that approximates a ground-truth
verifier (80.5% recall, 88.9% intent coverage) **without ever seeing the answer key**. That is
the missing gate for the skills/prose surface.

Constraints carried in: the runtime is **cheap and model-agnostic** (pi → kimi, never a hard
Claude dependency — [ADR 0010](0010-natural-language-intent-layer.md)); Claude/Codex are
**build-time muscle, never the runtime engine**; and the **freedom-over-control** framing
([ADR 0001](0001-deterministic-harness-governs-everything.md), as amended) holds — **it is OK
for Houge to fail; that is the experiment.** Gates are safety nets that make failure cheap, not
a cage. Prior art: **yoyo-evolve** — a self-evolving agent whose ~200-line harness owns identity,
memory, and gates while a frontier model does the actual coding; it proves the loop works, but
in a safe-to-fail regime (disposable CI, no secrets) we must harden for real stakes.

## Decision

### 1. The evolvable self has three layers

Houge improves himself across three surfaces, each with its own unit, eval gate, and risk.
**Default to the lightest form that holds the knowledge** — escalate only when the lighter one
can't carry it.

| Layer | Unit | Eval gate | Risk | Status |
|---|---|---|---|---|
| **Lessons** | a preference / constraint (a tweak) | the user (silent save) | trivial, reversible | shipped ([ADR 0010](0010-natural-language-intent-layer.md)) |
| **Skills** | a reusable *procedure* for a class of tasks (markdown artifact) | self-built assertions on world-fact anchors + the user for taste | low — no compile/merge | this ADR (Phase 2) |
| **Code** | a *capability* that must execute logic | tests + typecheck + build, then `/approve` | highest — only writable-irreversible-ish surface | this ADR (Phases 1, 3) |

These extend, never replace, the lesson loop. None of them touch the **core principles**
(honesty, no irreversible harm, secrets stay secret) — those are Houge's character, changeable
only by Paco's hand ([the core-principles rule](0005-agent-memory-architecture.md)).

### 2. The routing rubric — what becomes what

Both the cheap runtime chain (as a conservative *flag*) and the build-time muscle (as it
*authors*) share one rubric:

```
answer (keep nothing) → lesson → skill → code
  one-off / no reuse ........................ answer
  a do/don't preference or taste ............ lesson
  a reusable PROCEDURE, when ALL hold ....... skill
       (1) recurring class, not one-off
       (2) a method, not a tweak
       (3) promptable — needs no new code
       (4) world-fact grounded → transfers across models AND is verifiable
  must execute logic / live data / I/O ...... code
```

**Fuzzy lesson↔skill boundary → Houge saves the lesson now and ASKS whether to promote it**
(the `clarify`-when-unsure instinct, applied to learning). He asks only on genuine ambiguity
(clear cases route silently), never blocks (the lesson is saved regardless; the skill is an
opt-in upgrade), and each answer **calibrates** his sense of Paco's lesson↔skill line so he
asks less over time — the rubric itself self-evolves.

### 3. Two eval gates, one router

Self-improvement without an eval is unvalidated drift (ADR 0007). We now have a gate for **both**
surfaces:

- **Code → objective gate.** A candidate change is applied in an isolated git worktree and run
  through `npm test` + typecheck + build. Green → keep; red → auto-revert. The deterministic
  harness mechanically verifies the change before it is accepted.
- **Skills/prose → anchor gate (OPENSKILL).** A *separate, walled-off* model session retrieves
  **verification knowledge** (documented formats, reference values, domain standards) distinct
  from the skill content, emits deterministic `{0,1}` assertions anchored to those facts, and
  scores the skill by whether running it satisfies them. The user remains the judge for the
  **deep-semantic / taste slice** the anchors provably cannot cover (~11% in the paper).

A **gap-vs-bug classifier** routes a failure (or a correction) to the right gate: an
implementation bug → the code path (Codex + tests); a missing-world-knowledge gap → acquire
knowledge and refine the skill/lesson.

### 4. The coding muscle — Codex, rented, swappable

Houge delegates code reasoning to **Codex CLI as a `coding_agent_cli` capability** (a seat the
harness already reserves in `ToolMetadata.category`). This is a *tool delegation*, like
`web_search` delegates to Tavily — **not** the runtime engine, so ADR 0010 holds: Houge's own
cognition (intent, memory, judgment) stays on the cheap chain. **Houge owns the agency** —
deciding what to fix, holding the context, running it through his gates, owning the outcome in
his journal; the model is rented muscle (the yoyo lesson). For **diagnosis**, delegation is
**thin**: Houge frames the question with his context, Codex consults read-only, Houge judges and
relays. The muscle is **swappable** — the chain stays model-agnostic, so a strong open coder can
replace Codex later (Codex authors skills/diffs at build-time; they run on the cheap chain — the
OPENSKILL transfer result, +5.5–14.8% onto weaker models, confirms world-fact-grounded artifacts
port cleanly).

### 5. Isolation, and the one constant

Self-edits land in a **fresh git worktree**, which by construction excludes gitignored secrets
(`.env`, `auth.json`, the live DB) and isolates from the running process. **The daemon never
hot-swaps unverified self-authored code** — a diff lands on a branch; *Paco* merges and reloads.
The only off-limits surface is the **no-irreversible-harm core principle** (the approval gate on
real-account/destructive/paid actions; secrets stay secret) — held as character, changeable only
by Paco's hand. This is not a cage on Houge; it is the experiment's one constant, there to
protect Paco.

### 6. Safe-to-fail discipline (anti-overfit)

Failure is cheap and expected, so we tune for boldness, not caution: **cap any refinement loop
at ~3 passes** (OPENSKILL peaks at 3, degrades at 5/10 — refining to "all checks pass" *overfits*
the verifier); prefer stopping early over chasing a perfect score; keep artifacts bounded
(char-capped lessons, ≤4 skills per concern); and treat a bad change as a revert + a journal
entry, not a catastrophe.

### 7. Built in phases (each independently shippable + live-gated)

- **Phase 1 — code self-diagnose** (read-only): Houge reads his own source via a read-only Codex
  consult in a worktree and explains a bug. No writes, no gate needed. *Validated; next build.*
- **Phase 2 — skills**: make disciplines first-class loadable artifacts; add the OPENSKILL
  anchor verifier; the routing rubric; a build-time consolidation pass. *Design open.*
- **Phase 3 — code self-write**: Codex generates a diff → preview in the `/approve` prompt
  (hash-bound to what executes) → apply in a worktree → the test gate is the eval → green keeps,
  red reverts. Highest risk; requires a security review of the protected surface first.

## Consequences

- **The point of the project becomes real:** Houge compounds across code, skills, *and*
  preferences — every correction and reflection can make him permanently better, no re-coding.
- **The eval gate is answered for both regimes:** objective (tests, for code) and subjective
  (world-fact anchors, for skills) — the part ADR 0007 left open.
- **Cost is bounded:** Codex runs on Paco's subscription (no per-token bill); open-world
  knowledge acquisition is done **lazily** (only on a classified knowledge-gap), not per turn.
- **Accepted risk:** cheap-model routing/classification can misfire; mitigated by ask-when-unsure,
  conservative defaults, and the human gate. The gap-vs-bug classifier is new and unproven.
- **A tool dependency** on Codex/OpenAI for the code surface — accepted because it is a swappable
  *tool*, not the engine, and the chain stays model-agnostic.

## Alternatives considered

- **Frontier-model-as-engine** (make Houge Claude/GPT-powered): rejected by ADR 0010 on
  cost/dependency — Codex enters as a *delegated tool* instead.
- **Self-feedback verifier** ("ask the model if it did well"): rejected — OPENSKILL shows
  anchor-grounded verification beats self-feedback, which rationalizes its own mistakes.
- **Auto-merge self-edits to main** (yoyo's model): rejected — yoyo gets away with it because it
  is a disposable public toy with no secrets; Houge has Paco's accounts. Paco merges.
- **Trajectory-distilled skills** (AutoSkill/Memento): rejected — they encode model-specific
  behavior and *collapse below the no-skill floor* on transfer; skills must encode world-facts.
- **Only-code or only-skills evolution:** rejected — the three-layer model with lightest-form
  routing is the point; each surface catches what the others can't.

## Supersedes / relates to

- **Realizes** ADR 0007's deferred V2 (self-editing code + the eval gate for subjective quality).
- **Preserves** ADR 0001 (deterministic harness, freedom-over-control), 0003 (breaker),
  0005 (memory; the core-principles rule), 0006 (untrusted-data wall), 0009 (composer),
  0010 (model-agnostic chain; build-time/runtime split; ask-when-unsure).
- **External evidence / prior art:** OPENSKILL (arXiv 2606.06741) for the anchor-grounded verifier
  and model-agnostic skill transfer; yoyo-evolve for the harness-owns-the-self, frontier-model-as-
  muscle loop (and as the cautionary example of un-gated auto-merge).
