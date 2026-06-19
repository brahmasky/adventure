# ADR 0009: Architecture coherence — prompt composition, registries, and whole-agent review

- **Status:** accepted (direction; refactors applied at point of need)
- **Date:** 2026-06-19
- **Deciders:** Paco

## Context

Houge has grown **command by command** (`/ask` → `/research` → …), each adding a method and
a hardcoded prompt. That's healthy for shipping, but a step-back review surfaced three spots
where the *current code* has drifted from the *spec's* design and will fight us as the agent
grows:

- The **persona is duplicated as hardcoded constants** (`DEFAULT_ASK_SYSTEM_PROMPT`,
  `RESEARCH_SYNTHESIS_SYSTEM`) across capability files, and `memory/core/houge.md` (the Core
  Identity) **isn't loaded at runtime** — it's a doc, copied by hand.
- Program dispatch is an **`if/else` chain** on `allowed_actions` in the core worker.
- Each program method **news up its own `ToolRegistry`** and re-registers capabilities inline.

The deeper point Paco raised: we should periodically review what's best for the **agent as a
whole** — identity, prompt assembly, command surface, flow, safety — not just keep adding
commands. This ADR captures both the structural levers and that practice.

## Decision

### 1. Prompt-composition layer (the Context Pack) — foundational

Introduce **one place that assembles every system prompt**, instead of hardcoded per-surface
constants:

```
composeSystemPrompt(surface, ctx) =
    Core Identity   (loaded from memory/core/houge.md — single source)
  + surface discipline   (ask / research / STORM / …)
  + active lessons   (retrieved by scope — the learning-loop injection point, ADR 0007)
  + guardrails   (untrusted-data, answer-don't-act)
```

Every LLM-touching surface pulls its system prompt from this composer. This **de-duplicates
the persona, makes identity consistent, and is the single thing that makes self-evolution
possible** — lessons injected here improve `/ask` and `/research` at once. It also realizes
the spec's Context Pack. **This is the highest-leverage refactor; the learning loop cannot
work until prompt assembly is centralized.**

### 2. Program registry — declarative dispatch

Replace the `if/else` chain and hardcoded execute-methods with
`programs.register({ name, compileContract, execute })`; dispatch by lookup. Adding a program
(deep-research, a daily brief, future ones) becomes *registering*, not editing the core
worker — realizing the spec's "programs as artifacts" intent.

### 3. Capability registry — declared once

Capabilities are declared centrally (name, side-effect level, risk, timeout, output cap,
policy, adapter); programs **declare which they use**. Removes the inline re-registration,
keeps policy consistent.

### 4. Flow direction (built as the surface matures)

- **Reply-as-feedback** — replying to an answer with a correction routes into the learning
  loop (the natural "improve from interactions" path; Telegram supplies the reply context).
- **Conversation threading / episodic context** — `/ask` and `/research` are stateless
  one-shots; a session + episodic memory (ADR 0005) enables follow-ups and makes Houge a
  collaborator, not a vending machine.
- **Decouple run execution from the poll loop** — a long run currently blocks the daemon and
  delays `/guard`; a small work-queue keeps control responsive.
- **Richer observability** — `/history` activity feed + per-run detail + cost (the ledger has
  the data; OTel deferred).

### 5. Practice: periodic whole-agent coherence review

Adopt a recurring step-back review of the agent **as a whole** — identity, prompt assembly,
command surface, flow, safety — at milestone boundaries or every few features, rather than
only adding commands piecemeal. This ADR is the first such review; future ones amend or
supersede it.

## Consequences

- **Unblocks self-evolution:** lessons + identity flow through one composer; ADR 0007's slice
  becomes wiring, not a rebuild.
- **Extensible:** new commands/programs/capabilities are registrations, not core edits.
- **Done at point of need, not pre-emptively:** the composer first (it unblocks the learning
  loop); registries when adding the next program; flow upgrades as the loop matures — so this
  is targeted refactoring, not a rewrite.
- **Accepted cost:** a focused refactor of the prompt/dispatch paths before they ossify — the
  codebase is young, so it's the cheapest it will ever be.

## Alternatives considered

- **Keep adding commands as-is** — works short-term, but re-duplicates the persona each time
  and structurally blocks the learning loop; rejected.
- **Big upfront framework rewrite** — over-engineering; rejected in favour of refactoring at
  the point of extension.
- **Skip the composer; inject lessons per-surface** — re-creates the duplication the composer
  removes and makes identity drift across surfaces; rejected.

## Next (sequencing)

1. **Prompt composer** + load `houge.md` (foundational; unblocks the loop).
2. **Learning-loop slice** on it (`/teach` → lesson → injected via the composer) with the
   **STORM self-critique** (ADR 0006 amendment) as lesson #1.
3. **Program + capability registries** when adding the next program.
4. **Flow** (reply-as-feedback, threading) as the loop matures.
