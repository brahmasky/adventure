# ADR 0013: LLM inner composition — code owns the gates, the model composes between them

- **Status:** accepted (direction; flag-gated migration per surface)
- **Date:** 2026-07-02
- **Deciders:** Paco
- **Relates to:** completes the [ADR 0001](0001-deterministic-harness-governs-everything.md)
  amendment; refines [ADR 0010](0010-natural-language-intent-layer.md) (intent dispatch) and
  re-sequences [ADR 0012](0012-self-evolution-spine-closed-loop.md)'s roadmap

## Context

This ADR completes a three-step progression. [ADR 0001](0001-deterministic-harness-governs-everything.md)
said *code owns everything*; its 2026-06-19 amendment narrowed that to *code owns only the
irreversible — the cognitive interior is free*. But the amendment gave no **mechanism**: a
principle that cognition is free, while every code path still hardwires the sequence of cognitive
steps. [ADR 0010](0010-natural-language-intent-layer.md) moved *routing* into the LLM (intent
classification) — yet each intent still lands on a fixed, code-sequenced handler. This ADR supplies
the missing mechanism: **the cognitive interior becomes an LLM-composed loop, and the deterministic
floor is expressed as typed gate-points on that loop.**

**What a full runtime survey found (2026-07-02).** Every model call in Houge today is single-shot
text-in/text-out (`LlmRequest = {question, system} → {answer}`, `src/llm/types.ts`). The model is
never handed tools and never chooses a next action; the only LLM "decisions" are enum/verdict
emissions that code branches on (intent classifier, Gate A/B, reviewer, distill). Concretely:

- **Either/or routing on a 6-way enum** (`answer|research|feedback|clarify|selfcode|skill`,
  `src/capabilities/intent.ts`): a real message is often a *mixture* — a correction **and** a
  question **and** perhaps a bug report — but it gets exactly one branch of `executeTurn`'s
  if-chain (`src/core/core-worker.ts`).
- **The selfcode write/diagnose split is a regex verb table** (`WRITE_SIGNALS`, English + Chinese)
  — the command-grammar trust tax ADR 0010 rejected, hiding one layer down.
- **Each self-evolution layer is its own hardwired pipeline** (`runFeedback`, `runSkill`,
  `runSelfWrite`, `runResearch`), so adding a layer (the LLM Wiki) the current way means a 7th
  intent, an 8th contract, another if-branch, another fixed sequence — **O(n) plumbing per layer
  and zero cross-layer composition**. The model can never decide "this correction deserves a
  lesson now *and* a self-write proposal."
- **Fixed depth:** research is always exactly search → synth → critique; the model cannot search
  again on a thin first pass nor skip the critique on a trivial lookup.

This stiffness is precisely why self-evolution does not feel *natural and smooth* across the four
levels ADR 0012 named (memory, skills, wiki, code): the layers exist, but only code — never
judgment — decides when and how they combine.

**Peer evidence (researched from primary sources, 2026-06-27/07-02).** Two 2026 MIT-licensed
personal-agent daemons bracket the design space:

- **Hermes-agent** (NousResearch) is **LLM-driven**: the model picks the next tool each turn; code
  owns only plumbing. Maximal flexibility, but its guarantees rest on a dangerous-command
  classifier + human approval — structurally weak under prompt injection, exactly where Houge is
  headed (autonomous internet ingestion). Its self-improvement is limited to the *text* layer
  (skill docs re-injected as context).
- **OpenClaw** (~100k stars) is **code-driven**, and states Houge's own principle verbatim: hard
  enforcement in tool policy/approvals/sandbox; *system-prompt guidance is advisory*. Its key
  mechanism is a **typed hook taxonomy** — *decision* hooks that can terminally `block`, vs
  *observation* hooks that only record. Its cautionary tale: it relaxed the floor for single-user
  convenience (default session runs tools on the host) and drew public sandbox-escape research.
  And it has **no native self-evolution** — the MOSS paper had to bolt source-rewriting on
  *externally*.

The lesson is double: the code envelope is validated (keep the floor hard, even single-user), and
the envelope need not hardwire flows — **express it as gate-points and let the model compose
between them.** Houge's distinctive position — OpenClaw's harness *plus* MOSS's source-evolution,
native and gated — is strengthened, not weakened, by freeing the interior.

## Decision

**Contracts stop being scripts and become envelopes. A new inner loop lets the model choose its
next capability step by step; every step still executes through the deterministic gates; the loop
halts on final-answer, budget, or gate denial.** Concretely:

### 1. Contract = envelope, not script

A compiled contract's `allowed_actions` becomes a **tool manifest handed to the model**; its
budgets (`max_tool_calls`) become the loop's step cap; its `forbidden_actions` and
`approval_gates` remain code-enforced per step. Code no longer interprets the contract as a fixed
sequence of handler calls — the model composes the sequence, inside the envelope.

### 2. The inner loop (`src/core/inner-loop.ts`)

Each step, the model receives the objective, the manifest, and the transcript of prior steps, and
emits **one action**: `{action, input}` or `{action: "final", answer}`. Code executes the action
through `CapabilityRunner.execute` (policy → budget → approval → adapter — unchanged) and feeds the
result back. Halt conditions: final answer · step/budget cap · gate denial · repeated parse
failure.

- **Protocol-level tool calling, not API function-calling.** The pi/kimi chain is text-only, so
  the loop speaks JSON-in-text with a tolerant parser; unparseable output defaults to
  final-answer (the `parseIntent` philosophy). No provider API changes; **model-agnostic is
  preserved** (ADR 0010). Native function-calling is a later per-provider optimization, never a
  dependency.
- Loop-level code rules survive as code: the consecutive-clarify cap, conservative defaults,
  wall-clock timeouts.

### 3. Typed gate-points (the OpenClaw borrowing)

Two hook kinds on the loop, both plain code:

- **Decision gates** (may block): capability policy (`decideCapability`), budget reserve, approval
  gates (human `/approve`/`/deny`, unforgeable), and — inside tools that wrap them — the self-write
  guard/test-gate/reviewer chain. These are the **only** control points code owns; everything
  between them is the model's.
- **Observation hooks** (read-only): run ledger, telemetry, and — new — **attribution recording**:
  every loop step logs which capabilities/lessons/skills/wiki pages were touched. This *is* spine
  Slice A's `recordAppliedArtifacts` (ADR 0012 §1) falling out of the architecture for free.

### 4. Self-evolution layers become tools inside the loop

`lesson_write` (distill + backstop), `skill_author` (Gate A → author → Gate B), `self_diagnose`,
`self_write_propose` (writer → guard → test-gate → reviewer → branch → human tap), and later
`wiki_build/refine` join `llm_answer`/`web_search`/`clarify` in the manifest. **Each pipeline's
hard gates stay intact *inside* the tool boundary** — the loop decides only *when* to invoke a
tool, never what a tool may skip. The `WRITE_SIGNALS` regex dies: the model proposes, the gates
decide, `HOUGE_SELFWRITE_ENABLED` still arms. This is what makes evolution natural: the model
reaches for a memory write, a skill, or a code-fix proposal the same way it reaches for a search —
whenever the conversation calls for it, in any combination, in one turn.

### 5. The floor is unchanged

Explicitly untouched: the self-write guard (fail-closed, non-overridable) · test gate ·
writer≠reviewer isolation · branch-only publish + human-tapped merge with revert-on-red ·
unforgeable `/approve` `/deny` · global budget breaker · per-call capability policy + budgets ·
untrusted-data DATA channel · env arming flags · the secrets-firewall direction. A prompt-injected
message can now steer *composition*, but composition only selects among contract-allowed
capabilities: it can waste bounded budget, never cross a gate, forge an approval, or widen the
envelope. Same floor, larger free interior. (OpenClaw's relaxed-floor episode is the standing
warning against single-user exceptions.)

### 6. Migration is flag-gated per surface, live-gated per step

`HOUGE_INNER_LOOP_ENABLED` (default off) flips one surface at a time, starting with the `turn`
front door; the intent-enum path remains the fallback until parity is proven **live over
Telegram**. The enum may survive as an advisory hint in the loop prompt; it stops being dispatch.
Detail in [the inner-loop spec](../superpowers/specs/2026-07-02-inner-loop-refactor.md).

### 7. The spine roadmap is re-sequenced, not detoured

The loop is **step ⓪ of the spine** (ADR 0012 §6): attribution (Slice A's enabler) is emitted by
the loop's observation hook; the rating/reconcile/reuse machinery then lands on it; the LLM Wiki
is built **loop-native** from day one and never acquires a legacy pipeline.

## Consequences

- **Cross-layer composition becomes possible** — the concrete win: a single mixed Chinese message
  (correction + question) can produce a superseding lesson *and* an answer *and*, when warranted, a
  self-write proposal, in one turn. Today it gets one branch.
- **Adding an evolution layer costs O(1)** — a tool in the manifest — instead of intent + contract
  + if-branch + pipeline. The wiki is the first beneficiary.
- **Attribution logging stops being a bolt-on** and becomes a property of the loop, tightening the
  spine's eval story (every rating attaches to exactly what the loop actually touched).
- **Accepted costs:** more model calls per turn (bounded by step caps; token-frugality was already
  dropped as a constraint, ADR 0010) · higher latency on composed turns · weak models may compose
  poorly (mitigated: caps, final-answer default, per-surface fallback flag, and
  best-model-per-capability — composition may ride a stronger chain leg than answering).
- **Blast-radius risk concentrates in the first migration step** — mitigated by parallel-path
  flag gating rather than rewrite; the ~300 floor tests (guard, merge order, reviewer isolation,
  test-gate) are untouched by design, and the composer's byte-stable goldens survive because the
  loop gets its own prompt surface.

## Alternatives considered

- **Keep the enum and add more intents** (wiki = 7th intent, etc.): rejected — O(n) plumbing,
  either/or routing forever, and the regex sub-router problem multiplies. This is the path the
  runtime survey showed is already creaking.
- **Full LLM-driven orchestration** (the Hermes shape — model owns the loop *and* the policy):
  rejected — same verdict as ADR 0001, now with peer evidence: guarantees collapse into classifier
  coverage + human vigilance, exactly wrong for autonomous internet ingestion.
- **Native function-calling APIs as the loop protocol:** rejected as a *foundation* — it would
  couple the loop to specific providers and break the model-agnostic chain; acceptable later as a
  per-provider optimization behind the same protocol.
- **An agent-framework dependency for the loop:** rejected — the zero-runtime-dependency rule
  (ADR 0001) stands; the loop is a few hundred lines against seams that already exist
  (`CapabilityRunner.execute`, `decideCapability`, `ToolRegistry`).
- **Big-bang rewrite of `executeTurn`:** rejected — flag-gated parallel paths per surface, live
  parity before retirement.

## Supersedes / relates to

- **Completes** [ADR 0001](0001-deterministic-harness-governs-everything.md)'s amendment: the
  invariant stands (*deterministic code owns the few things that must not go wrong*), and the
  cognitive interior now has its mechanism — an LLM-composed loop over typed gate-points.
- **Refines** [ADR 0010](0010-natural-language-intent-layer.md): natural language stays the front
  door and the control/safety command plane stays unforgeable; the intent *enum-as-dispatch* is
  retired in favor of loop composition (the enum may persist as an advisory hint).
- **Re-sequences** [ADR 0012](0012-self-evolution-spine-closed-loop.md): the loop becomes step ⓪
  of the spine roadmap; Slice A's attribution rides the loop's observation hooks; the wiki lands
  loop-native. All of 0012's decisions (signal, memory types, keep/rollback) stand.
- **Preserves** [ADR 0003](0003-global-budget-breaker.md) (breaker), [ADR 0006](0006-web-read-capability.md)
  (untrusted-data wall), [ADR 0011](0011-self-evolution-architecture.md) (self-write machinery and
  gates, now behind a tool boundary).
- **External evidence:** Hermes-agent (NousResearch) — the LLM-driven pole and its injection
  weakness; OpenClaw — the code-driven pole, the decision/observation hook taxonomy adopted here,
  and the relaxed-floor cautionary tale; MOSS (arXiv 2605.22794) — proof that source-evolution
  had to be bolted onto OpenClaw externally, whereas Houge carries it natively.
