# Spec — LLM inner composition: the inner loop refactor (ADR 0013)

Source of truth for building [ADR 0013](../../decisions/0013-llm-inner-composition.md).
Status: **DESIGN LOCKED 2026-07-02** (with Paco; grounded in a full runtime survey + Hermes/OpenClaw
research). **No `/goal` yet** — each step below is its own independently shippable, live-gated build,
taken one at a time on Paco's `/goal`. This spec is **step ⓪ of the spine roadmap** — the
[spine spec](2026-06-27-spine-self-evolution-loop.md) plugs in on top (its Slice A attribution is
this loop's observation hook).

## Goal

Contracts stop being scripts and become **envelopes**. A new **inner loop** lets the model choose
its next capability step by step; every step executes through `CapabilityRunner` and its
deterministic gates; the loop halts on final-answer, budget, or gate denial. All four
self-evolution layers (lessons, skills, wiki, code) become **tools inside one loop** instead of
four hardwired pipelines — so evolution happens whenever the conversation calls for it, in any
combination, in one turn.

**Code owns the gates; the LLM composes between them.**

## Current state (survey verdict, 2026-07-02)

- Every runtime model call is single-shot `{question, system} → {answer}` (`src/llm/types.ts`); no
  tools, no loop, no model-chosen next action anywhere.
- Dispatch is deterministic: gateway command switch → `executeClaim` if-chain on `allowed_actions`
  → `executeTurn` if-chain on the 6-way intent enum → fixed per-intent pipelines
  (`runAnswer`/`runResearch`/`runFeedback`/`runSkill`/`runSelfDiagnose`/`runSelfWrite`).
- The selfcode write/diagnose sub-route is a regex verb table (`WRITE_SIGNALS`, `intent.ts`).
- Seams to build on: `CapabilityRunner.execute` (single choke point: policy → budget → approval →
  adapter), `decideCapability` (pure policy fn), `ToolRegistry`, the `SelfWriteDeps` injection
  pattern, the composer's injected readers.

## Design invariants (non-negotiable)

1. **The floor does not move:** self-write guard · test gate · writer≠reviewer isolation ·
   branch-only publish + human-tapped `[Merge & reload]` with revert-on-red · unforgeable
   `/approve` `/deny` · global budget breaker · per-call capability policy + budgets ·
   untrusted-data DATA channel · env arming flags.
2. **Model-agnostic:** the loop protocol is JSON-in-text over the existing provider chain; no
   native function-calling dependency.
3. **Every step of every action passes `CapabilityRunner.execute`** — the loop adds no side-channel.
4. **Flag-gated parallel paths:** `HOUGE_INNER_LOOP_ENABLED` (default off) per surface; the enum
   path stays until live parity; no big-bang rewrite.
5. **Floor tests stay green untouched** (guard 42+72 adversarial, merge order, reviewer isolation,
   test-gate); composer goldens stay byte-stable (the loop gets its own prompt surface, a new
   `loop` discipline — never mutate existing disciplines).

## The loop protocol

Per step the model receives: objective · tool manifest (name, one-line description, input schema
sketch, remaining budget) · prior steps (action → result summaries) · the DATA-channel content.
It must emit exactly one JSON object:

```json
{"action": "web_search", "input": {"query": "..."}, "why": "one line"}
{"action": "final", "answer": "..."}
```

- **Tolerant parse** (fenced/bare/embedded JSON), same philosophy as `parseIntent`; N consecutive
  parse failures → treat last text as `final` (conservative default).
- Result payloads are truncated/summarized into the step transcript under a per-step char cap.
- All prior-step content and tool results ride the **DATA channel**, never the system prompt.

## Halt conditions (all code-owned)

final action · step cap = contract `max_tool_calls` · budget reserve denial · policy denial
(reported to the model once, then counted) · approval-pending (loop parks, resumes on `/approve`)
· consecutive-clarify cap (existing rule, re-expressed at loop level) · wall-clock timeout.

## Typed gate-points

- **Decision gates (may block):** `decideCapability` · budget reserve · approval gates · inside
  tools: guard/test-gate/reviewer. These are the only code-owned control points.
- **Observation hooks (read-only):** run-ledger step events (`loop_step`, action, capability,
  result digest) · telemetry (`recordLlmCall` role `compose`) · **attribution**: per step, record
  artifacts touched (lessons/skills scope blocks injected, wiki pages read, capabilities invoked)
  — this becomes spine Slice A's `recordAppliedArtifacts` (A1) for free.

---

## Roadmap — sequenced (each its own `/goal`, each ends with a LIVE Telegram run)

### Step ⓪·1 — the loop engine + first surface (`turn`)

**Build stages:**
- L1. `src/core/inner-loop.ts` — the step loop: prompt assembly (new `loop` discipline in the
  composer, additive), action protocol + tolerant parser, halt conditions, decision-gate and
  observation-hook seams. Injectable deps (`InnerLoopDeps`) mirroring the `SelfWriteDeps` pattern
  so tests mock every step.
- L2. Tool manifest derivation from the compiled contract (`allowed_actions` → manifest entries);
  a small per-tool descriptor registry (name, description, input schema sketch, adapter binding).
- L3. Wire the `turn` contract to the loop behind `HOUGE_INNER_LOOP_ENABLED` (default off);
  `executeTurn`'s enum path untouched as the fallback. Initial manifest: `llm_answer`,
  `web_search`, `lesson_write` (wraps distill + `shouldRejectLesson` backstop + append/reconcile),
  `clarify`.
- L4. Ledger events (`loop_started`, `loop_step`, `loop_halted{reason}`) + attribution recording.
- L5. Gates: typecheck · `npm test` · build · `dependencies: {}` · independent adversarial
  verification (subagent) · eval fixtures for the parser (garbage, fenced, multi-object, injection
  attempts in tool results).
- **L6. LIVE GATE (interactive, Telegram):** flag ON → a mixed-intent Chinese message (a correction
  + a question in one message) produces a superseding/appended lesson **and** a proper answer in
  one turn — impossible on the enum path. A thin research question triggers a second search
  (model-chosen depth). Flag OFF → behavior byte-identical to today.

### Step ⓪·2 — evolution layers as tools

**Build stages:**
- M1. Tool-wrap `skill_author` (Gate A → author → Gate B, unchanged inside), `self_diagnose`
  (read-only Codex worktree), `self_write_propose` (full writer → guard → test-gate → reviewer →
  branch → buttons pipeline, unchanged inside; still armed by `HOUGE_SELFWRITE_ENABLED`).
- M2. Delete the `WRITE_SIGNALS` regex sub-router — the model proposes `self_write_propose` vs
  `self_diagnose`; the gates decide what lands. (`intent.ts` classifier itself survives as an
  advisory hint in the loop prompt, not dispatch.)
- M3. Manifest policy: evolution tools appear in the manifest only when their arming flags are on.
- M4. Gates + independent verification (floor tests untouched).
- **M5. LIVE GATE:** a terse Chinese bug report ("修一下…" style, the proven 3516dee shape) routes
  to a self-write proposal end-to-end with no verb-table involvement; a diagnosis-only ask stays
  read-only; a message that merits *both* a lesson and a code proposal produces both.

### Step ⓪·3 — spine Slice A on the loop

The [spine spec](2026-06-27-spine-self-evolution-loop.md) stages A2–A9 (rating capability,
reconcile ADD/SUPERSEDE/UPDATE, reuse-value + decay, low-rating attribution pass, AVOID) — with
A1 (attribution) already emitted by the loop's observation hook. Live gate = spine A9 (visible
compounding).

### Step ⓪·4 — retire the legacy paths

- Flip `HOUGE_INNER_LOOP_ENABLED` default on for migrated surfaces; remove `executeTurn`'s
  if-chain and the per-intent handlers whose logic now lives in tools; `runResearch`'s fixed
  search → synth → critique dissolves into loop composition under budget.
- Contracts become envelope-only; `executeClaim`'s tier if-chain collapses to loop-vs-legacy.
- **LIVE GATE:** a normal day's traffic (answer, research, feedback, selfcode) over Telegram on
  the loop path only; `/status`, `/lessons`, `/approve`, `/deny` unchanged.

### Later (per spine spec, loop-native)

Episodic memory (②), `http_fetch` (③), the LLM Wiki (④ — built as loop tools `wiki_build`/
`wiki_refine` from day one, never a pipeline), skills eval-metadata (⑤), auto-rollback + the
autonomy flip (interleaved, unchanged from ADR 0012 D4).

## File pointers (new / changed)

- New: `src/core/inner-loop.ts`, `src/core/tool-manifest.ts` (descriptor registry),
  loop discipline block in `src/prompt/composer.ts` (additive).
- Changed: `src/core/core-worker.ts` (flag fork in `executeTurn`; later retirement),
  `src/run/run-ledger.ts` + `run-store.ts` (loop events, attribution), `src/capabilities/intent.ts`
  (enum → advisory hint; delete `WRITE_SIGNALS` in ⓪·2), `src/contracts/task-contract.ts`
  (envelope semantics; budgets as step caps).
- Untouched by design: `self-write-guard.ts`, `test-gate.ts`, `diff-reviewer.ts`,
  `self-write-merge.ts`, `branch-publish.ts`, `capability-policy.ts`, gateway command plane.

## Risks / mitigations

- **Weak models compose poorly** (pi/kimi picking bad actions) → step caps, final-answer default,
  per-surface fallback flag, best-model-per-capability (composition may ride a stronger chain leg).
- **Prompt injection steers composition** → composition selects only among contract-allowed tools;
  budget bounded; approvals human; DATA-channel discipline enforced by the loop's prompt assembly.
- **Latency/cost per turn rises** → accepted (ADR 0010 dropped token-frugality); caps bound it.
- **Loop stalls/ping-pongs** (model re-issuing the same action) → repeated-action detector counts
  toward the parse-failure cap.
- **Blast radius of ⓪·1** → parallel-path flag; goldens untouched; floor tests untouched.

## Verification (every step)

typecheck clean · `npm test` green · `npm run build` OK · `dependencies: {}` · independent
adversarial verification · **a LIVE run over real Telegram** (the cardinal rule — never `npm test`
alone) · flag OFF ⇒ byte-identical legacy behavior until ⓪·4.
