# ADR 0010: Interaction model — natural-language intent layer (Houge as Claude Code over Telegram)

- **Status:** accepted (direction; built in phases) · intent *enum-as-dispatch* refined by
  [ADR 0013](0013-llm-inner-composition.md) (loop composition; the enum survives as an advisory hint)
  · **amended 2026-07-27 by [ADR 0027](0027-idea-panel-claude-chair.md)** (contained panel chair seat — see end)
- **Date:** 2026-06-19
- **Deciders:** Paco

## Context

Houge grew command by command — `/ask`, `/research`, `/teach`, `/run` — each one a slash
command the user must pick to express intent. But Paco interacts with **Claude Code** almost
entirely in **plain language**, typing an explicit `/command` (like `/goal`) only rarely; the
agent infers what's wanted. Forcing a command to select intent is the same **trust tax** we
already rejected ([ADR 0001 amendment](0001-deterministic-harness-governs-everything.md):
the harness governs the irreversible; cognition is free). **Routing intent is itself a
cognitive act** — it belongs to Houge's intelligence, not a command parser. As the command
count grows (5 today, 30 later), the prefix grammar scales worse and feels less like talking
to a capable assistant.

Two constraints shaped the decision. First, **cost**: Paco is cost-sensitive on Claude tokens
and wants Houge to run on cheaper/other models (Kimi, pi). So the interaction model must not
imply a Claude dependency. Second, **autonomy**: unlike Claude Code, Houge runs **asynchronously
and unsupervised** (a daemon that can act while Paco is away), so some intents must stay
explicit and unforgeable for safety.

## Decision

**We will make natural language the primary interface. Houge infers intent and acts; explicit
commands survive only for the control/safety plane.**

1. **Behavioral role-model, not runtime.** *You talk to Houge the way you talk to Claude Code* —
   natural language in; infer intent (answer / look it up / that's feedback); **ask one
   clarifying question when genuinely unsure** rather than guess; cite; admit uncertainty.
   **Claude Code is the role-model for *behavior* (encoded in prompts), never the engine.**
   Every cognitive call runs on the model-agnostic `HOUGE_LLM_PROVIDERS` chain (pi → kimi → …);
   Houge has no hard Claude dependency. Token-frugality is *not* a design constraint.

2. **A single natural-language front door.** Every non-command Telegram message becomes one
   `turn` run whose worker first **classifies intent** (`answer` / `research` / `feedback` /
   `clarify`) on the LLM chain, then dispatches to the existing answer/research logic or the
   feedback path. `/ask`, `/research`, `/teach` are removed as commands; the underlying
   programs/capabilities remain (CLI and evals still use them directly).

3. **Commands only for the control/safety plane.** `/approve` and `/deny` stay slash-only and
   **unforgeable** — they can *never* be inferred from prose, so injected web/text content can
   never approve an action. `/status`, `/lessons`, `/forget` are explicit utilities; `/run`
   stays as an escape hatch for launching a named program. The split: **natural language for
   cognition; explicit, deterministic commands for control.**

4. **Two memory tiers.** *Short-term* conversation memory (a per-chat rolling thread) gives
   Houge context to interpret a message in-thread ("too long" needs no reply-pointer) — making
   it feel like a chat, not a vending machine. *Long-term* lessons (procedural preferences) live
   as char-capped, edit-in-place blocks retrieved into prompts by the composer (ADR 0009),
   consolidated by an LLM rewrite at the cap. This realizes the conversation-threading and
   episodic-context direction [ADR 0009](0009-architecture-coherence.md) anticipated.

5. **User feedback is high-trust → learned silently.** A correction in chat ("too long",
   "prefer primary sources") is distilled into a lesson and saved **silently** (no per-lesson
   approval prompt, no toast) **only when it generalizes into a clear, reusable preference**;
   it is inspectable and reversible via `/lessons` and `/forget`. This **supersedes ADR 0007's
   capture/activation mechanism for *user-sourced* lessons** (the `/teach` command and the
   proposed→`/approve` gate): because the human's own feedback is the trust anchor, the upfront
   approval gate is replaced by a high precision threshold + inspect-and-undo. **What stands
   from 0007:** the core-principles boundary, the trust-class **quarantine for
   web-derived lessons**, and the **eval gate + human approval for *self-proposed* (reflection)
   lessons**, which remain deferred and gated. The distiller reads the *user's* feedback as the
   instruction and the prior answer as reference only — the untrusted-data wall
   ([ADR 0006](0006-web-read-capability.md)) is preserved: Houge never adopts an instruction
   embedded in content as a lesson on its own.

6. **The safety floor is unchanged.** The `turn` contract keeps the same `forbidden_actions`,
   `approval_gates`, capability policy, and the global budget breaker
   ([ADR 0003](0003-global-budget-breaker.md)). Intent inference governs only the *cognitive*
   surface; every *act* still passes the deterministic gates. Misclassification is bounded by
   the `clarify` intent and a conservative default (answer).

## Consequences

- **Houge feels like the assistant Paco already uses** — talk normally, it figures out intent,
  asks when unsure — over Telegram (or any future IM), on cheap models.
- **The command surface shrinks to what must be explicit** (control/safety), which is also the
  only place a forged intent would be dangerous — so removing commands *increases* coherence.
- **Learning becomes frictionless** but trades the upfront approval gate for precision +
  reversibility; the risk (a wrong silent lesson) is mitigated by the "clear preference"
  threshold, `/lessons` visibility, and `/forget`. We accept this for *user-sourced* lessons
  only.
- **New cost surface:** one classifier call per message and short-thread context tokens — a
  deliberate, accepted cost (cheap on Kimi; token-frugality explicitly dropped as a constraint).
- **Accepted risk:** intent misclassification on weaker models; mitigated by ask-when-unsure
  and conservative defaults, tunable via the classifier prompt.
- **Built in phases:** Phase 1 = the natural-language front door (answer + research + chat
  memory); Phase 2 = the feedback/learning branch + lesson blocks. Each is independently
  shippable and live-gated.

## Alternatives considered

- **Keep the command grammar** — explicit and simple, but it's the trust tax we rejected and
  scales worse as commands multiply; rejected for the cognitive surface (kept for control).
- **Make Houge *be* Claude Code (Claude-powered agentic loop)** — closest to the role-model, but
  forces a Claude dependency and the token cost Paco can't carry; rejected in favor of the
  model-agnostic chain with Claude as behavioral role-model only.
- **Infer everything, including approvals, from natural language** — maximally natural but
  unsafe: a prompt-injected message could "approve" an action; rejected — approve/deny stay
  unforgeable commands.
- **Keep ADR 0007's per-lesson approval for user feedback** — safer per-lesson, but reintroduces
  ceremony on the human's own corrections; rejected in favor of silent save + inspect/undo for
  user-sourced lessons (self-proposed lessons keep the gate).

## Supersedes / relates to

- **Supersedes:** the command-as-front-door assumption; ADR 0007's `/teach` capture and
  per-lesson approval **for user-sourced lessons** (§5 above).
- **Realizes:** ADR 0009's flow direction (reply-as-feedback, conversation threading).
- **Preserves:** ADR 0001 (deterministic harness, as amended), 0003 (breaker), 0005 (memory),
  0006 (untrusted-data wall), 0007 (constitution boundary, quarantine, self-proposal eval gate),
  0009 (composer).

## Amendment (2026-07-27): a contained panel chair seat — the "never the engine" claim narrows

[ADR 0027](0027-idea-panel-claude-chair.md) narrows §1's "never the engine" (and the rejected
"Make Houge *be* Claude Code" alternative): Claude is never the **conversational/chain**
engine — it joins no provider chain, no registry, no tool manifest — but ONE contained,
tool-less, single-turn **chair seat** in the weekly idea panel is granted: subscription-auth,
broker-held token, spawn-bounded, panel-local, with a deterministic fallback so Houge still
has no hard Claude dependency. Everything else in this ADR stands as written; see ADR 0027
for the containment bar future seats must argue against.
