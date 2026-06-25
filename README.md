# Houge

Houge is a Telegram-first ChatOps harness and autonomous worker orchestrator: it turns natural-language chat and CLI commands into bounded, auditable, policy-governed task runs. You talk to Houge the way you talk to Claude Code — plain language in, intent inferred — and explicit slash commands survive only for the control/safety plane ([ADR 0010](docs/decisions/0010-natural-language-intent-layer.md)).

## Status

Milestones 0–2 are complete, plus the Milestone 3 always-on daemon and a global
autonomy budget breaker — 237 tests, zero runtime dependencies (Node 25, TypeScript,
Vitest, the built-in `node:sqlite`):

- **Milestone 0** — shared schemas, deterministic state machines (Run / Approval / ToolCall / Schedule), Run Ledger, idempotency.
- **Milestone 1** — local run engine: SQLite-backed runs, worker leases, Task Contracts, Capability Policy + budget ledger, a read-only file capability, sourced reports, fixture evals.
- **Milestone 2** — Telegram gateway (long-poll intake, allowlist auth), the natural-language front door + control commands (`/run` `/status` `/approve` `/deny` `/lessons` `/forget`), durable approvals, Notification Outbox.
- **Milestone 3 (in progress)** — always-on daemon: `houge telegram-poll` (no `--once`) runs a continuous long-poll loop answering commands in near-real-time, supervised by launchd (graceful shutdown, single-instance guard, heartbeat). The schedule trigger is the remaining M3 piece.
- **Natural-language front door** — every non-command message becomes one `turn` whose worker classifies intent (**answer** / **research** / **feedback** / **clarify**) on the model-agnostic LLM chain (`pi` → `kimi-api`, never Claude) and dispatches accordingly; see [Talking to Houge](#talking-to-houge).
- **Autonomy guardrails** — a global 24h budget circuit-breaker bounds runs / tool-calls / gated-attempts; see [Global autonomy circuit-breaker](#global-autonomy-circuit-breaker).
- **Web read** — a **research** intent searches the live web (pluggable Tavily/Firecrawl chain) and 猴哥 answers with cited sources, then a STORM-style self-critique pass sanity-checks the draft; free-read, gated-act ([ADR 0006](docs/decisions/0006-web-read-capability.md)).
- **Conversational learning** — a reaction to a prior answer ("too long", "prefer primary sources") gets a tighter re-answer, and when the feedback generalizes into a reusable preference it is silently distilled into a char-capped lesson block; see [Learning](#learning).

## Quick start

```bash
npm install
npm run build                          # tsc → dist/
npm test                               # vitest
npm run typecheck
npm run eval -- milestone-2

# CLI
npm run houge -- status
npm run houge -- run research-brief "compare gateway designs"
npm run houge -- telegram-poll --once  # process pending Telegram commands once

# Always-on daemon (continuous long-poll). Build first, then run the built JS so
# signals reach the daemon; deploy under launchd — see deploy/launchd/README.md.
node dist/cli.js telegram-poll
```

Configuration (Telegram token, LLM keys, model/timeout overrides) is read from a gitignored `.env` — copy `.env.example` and fill it in. Set `HOUGE_ENV_FILE` to point every git worktree at one shared `.env`. Full parameter list: [docs/reference/configuration.md](docs/reference/configuration.md).

## Talking to Houge

There are no `/ask`, `/research`, or `/teach` commands — you just type. Every
non-command Telegram message becomes one `turn` run whose worker first **classifies
intent** on the LLM chain into one of four intents, then dispatches:

- **answer** — answer directly from Houge's own knowledge.
- **research** — search the live web, synthesize a cited answer, and run a STORM-style self-critique pass ([ADR 0006](docs/decisions/0006-web-read-capability.md)).
- **feedback** — a reaction or correction to a prior answer; Houge re-answers honoring it and may distill a lesson ([Learning](#learning)).
- **clarify** — ask one clarifying question when genuinely unsure, rather than guess.

Misclassification is bounded by the `clarify` intent and a conservative default
(answer). Routing intent is itself a cognitive act, so it belongs to Houge's
intelligence, not a command parser ([ADR 0010](docs/decisions/0010-natural-language-intent-layer.md)).

## LLM providers

Cognition resolves an ordered provider chain with automatic fallback (first `ok`
wins; `unavailable`/error/timeout fall through). Default chain `pi,kimi-api`:
`pi` (hardened single-shot CLI, tools disabled) and `kimi-api` (OpenAI-compatible
HTTP) — model-agnostic, never Claude. Houge answers in its own voice — a projection
of its Core Identity ([memory/core/houge.md](memory/core/houge.md)): the cheerful,
capable 猴哥, but *inference only* (it answers; it doesn't act) on the **answer** path.
Override the persona with `HOUGE_ASK_SYSTEM_PROMPT`.

→ Every provider/model/timeout/key variable: [configuration reference](docs/reference/configuration.md#llm-provider-chain-powers-cognition).
The inference-vs-agentic safety boundary (why a tools-disabled `pi` is `external_read`):
[ADR 0002](docs/decisions/0002-pi-as-agent-runtime.md). Identity & memory direction:
[ADR 0005](docs/decisions/0005-agent-memory-architecture.md).

## Learning

Houge improves by accumulating **inspectable** lessons, not by retraining — and learning
is **conversational**, not a command. Two memory tiers back this:

- **Short-term — `chat_turns`.** A per-chat rolling thread of recent turns gives follow-ups
  context, so "too long" needs no reply-pointer and the chat feels like a conversation, not a
  vending machine. It is bounded by three env vars (window minutes / turns fed to a prompt /
  per-turn char cap when feeding) — see [configuration](docs/reference/configuration.md#short-term-conversation-memory-chat_turns).
- **Long-term — `lesson_blocks`.** Procedural preferences live in a SQLite table
  `lesson_blocks(scope, block, char_cap, updated_at)` — one char-capped, edit-in-place block
  per scope (default cap 1200). The **prompt composer** folds the relevant scope's block into
  future runs, so identity is consistent and a learned preference flows into the next run on
  that scope. Scope is inferred from the reacted-to turn's intent: answer → `ask`,
  research → `research`.

**How a lesson is learned.** When you react to a prior answer ("too long", "prefer primary
sources"), Houge does two things: (1) it **always re-answers** with a tighter answer honoring
the feedback; (2) **only when the feedback generalizes into a clear, reusable preference**, it
**silently distills** it into the scope's lesson block — no toast, no approval prompt. The
distiller treats *your* feedback as the instruction and the prior answer as reference only:
the untrusted-data wall holds, so Houge never adopts an instruction embedded in answer content
as a lesson. When a scope's block exceeds its `char_cap`, an LLM rewrite pass consolidates it
(deduping into the strongest rules).

This trades ADR 0007's upfront `/teach` + per-lesson approval gate for **precision +
reversibility** on *user-sourced* lessons — the human's own feedback is the trust anchor. Two
slash-only control commands keep it inspectable (idempotent, no run, no budget):

- `/lessons [scope]` — view the lesson block(s); shows the raw block plus char-count/cap so you can see consolidation pressure. With no scope, lists all scopes.
- `/forget <scope>` — clears that scope's lesson block and acks.

→ The composer, conversational learning, and the self-critique pass:
[configuration reference](docs/reference/configuration.md#learning--conversational-distillation-and-lesson_blocks).
Interaction model: [ADR 0010](docs/decisions/0010-natural-language-intent-layer.md);
learning-loop design: [ADR 0007](docs/decisions/0007-learning-loop.md);
prompt-composition seam: [ADR 0009](docs/decisions/0009-architecture-coherence.md).

## Self-evolution (Phase 1)

Houge can read his **own source** to diagnose a bug. A natural-language message like *"go
read your intent classifier and tell me why you asked which 猴哥"* classifies as the
`selfcode` intent and runs a **read-only Codex consult in a fresh git worktree** of his
committed `HEAD`, then relays the root cause in his voice. The worktree contains only
*tracked* files, so gitignored secrets (`.env`, `auth.json`, the live DB) are absent **by
construction**, and the running daemon's tree is untouched. The consult is `external_read`
(Houge's own source goes to OpenAI on Paco's subscription) — a read, not a write, so no
`/approve` gate; `codex exec --sandbox read-only` is the inner wall, and no
`--dangerously-bypass-*` flag is ever passed. `coding_agent_cli` is reachable **only** from
the `self-diagnose` contract — every normal turn forbids it.

This is **read-only diagnosis** (Phase 1) — Houge never edits a file. It is **off by
default**: set `HOUGE_CODEX_ENABLED=1` to turn it on (otherwise the `selfcode` branch
degrades to a normal answer noting the capability is off). Config:
`HOUGE_CODEX_ENABLED` / `HOUGE_CODEX_MODEL` / `HOUGE_CODEX_TIMEOUT_MS` / `HOUGE_CODEX_BIN`
— see [configuration](docs/reference/configuration.md#self-evolution-phase-1--code-self-diagnose).
Rationale: [ADR 0011](docs/decisions/0011-self-evolution-architecture.md).

## Self-evolution (Phase 2) — ambient skills

Beyond one-line *lessons*, Houge can apply reusable **procedures** — a *skill* is "how Houge
does a class of task well" (e.g. how he cross-checks figures in research). Skills are markdown
under `skills/<scope>/<name>.md` that the composer folds into a run between the surface
discipline and the lessons. They are **ambient — never invoked by name**: the ≤4 in-scope
skills ride in-prompt, each tagged with a `when:` hint, and Houge self-applies the relevant
ones during an ordinary message. A run with no skills composes byte-identically to before, and
a malformed skill file is skipped rather than crashing a turn. `skills/` is gitignored runtime
state; graduating a skill into the repo is a manual `git add`. View what's loaded with
**`/skills [scope]`** (a read-only viewer).

**Authoring (2b/2c).** Houge can **write** a skill — on command ("write a skill for X"), or
auto-promoted when a correction distills into a recurring *procedure*. A two-gate stack governs
it: **Gate A** routes (skill vs lesson vs code), then **Gate B** — a separate, walled-off **3-pass
anchor verifier** — scores whether *following the procedure* is sound (it never sees the author's
own anchors). Policy is **by origin**: a *commanded* skill is **advisory** (written regardless;
score stamped + reported); an *auto-authored* skill is **blocking** — kept only if Gate B passes,
else **guided-refine ≤3** against the failing criteria, then if still failing it is **parked** in
`skills/_pending/` (inert) with a saved lesson and a surfaced report (`/skills pending` to inspect).
On by default (`HOUGE_SKILLS_ENABLED` / `HOUGE_GATE_B_ENABLED` are the kill switches) — see
[configuration](docs/reference/configuration.md#self-evolution-phase-2a--ambient-skills).

## Self-evolution (Phase 3) — code self-write (gated)

The highest-risk surface: Houge can **write a diff to his own source**. A `selfcode` message with
**write intent** (*"猴哥, fix the intent router so it sees your identity"*) routes to a write path —
read intent still goes to Phase 1 diagnose, and an **ambiguous case defaults to diagnose** (read before
write).

**The autonomous check stack.** Houge frames the task, then **Codex writes the diff in a fresh git
worktree**. The diff runs through three checkers — writer ≠ checker by construction — with **no human in
the synchronous loop**:

1. **Protected-path check** (deterministic, ungameable) → **HARD DENY** if the diff touches the locked
   surface (gates, identity/ADRs, deps/build, or an *existing* test).
2. **Test gate** → `typecheck` + `npm test` + `build` in the worktree; red fails.
3. **Claude reviewer** (model diversity: Codex writes, Claude judges) → an adversarial
   *fixes-it / bugs / scope-creep* verdict — the staff-engineer check tests can't give.

A failed checker 2 or 3 feeds back to Codex for a **refine loop capped at ≤3** passes. Only if all three
pass does Houge **auto-publish the diff as a branch** (`houge/selfwrite/<run-id>`) and **notify Paco**.

**Safety properties.** The protected surface is a **HARD DENY that nothing — not even `/approve` —
can override** (per [ADR 0011](docs/decisions/0011-self-evolution-architecture.md) §5, the constants are
Paco's hand only). Net-new test files are **allowed** (good coverage), but editing or deleting an
*existing* test is denied (else Houge could delete the failing test to fake-pass the gate). The
protected list itself lives in the gate-machinery class, so Houge can't edit the list of what he can't
edit. **The daemon never hot-swaps** — Houge publishes a branch but **cannot make it run**; only Paco's
`git merge` can. **Off by default.** Every outcome (published / hard-deny / failed) is **signal, never a
silent drop**: a structured run-store event plus an async Telegram notification in Houge's voice.

**How Paco operates it.** Flip `HOUGE_SELFWRITE_ENABLED=true` (and point `HOUGE_CLAUDE_BIN` at the
absolute `claude` path). Then, when notified of a published branch, **review the `houge/selfwrite/<run-id>`
branch in git, `git merge` it, and reload the daemon** — at his leisure (pull-based, not a blocking
gate). Config: `HOUGE_SELFWRITE_ENABLED` / `HOUGE_SELFWRITE_REVIEWER` / `HOUGE_CLAUDE_BIN` /
`HOUGE_CLAUDE_TIMEOUT_MS` / `HOUGE_TESTGATE_TIMEOUT_MS` (the write adapter reuses `HOUGE_CODEX_*`) — see
[configuration](docs/reference/configuration.md#self-evolution-phase-3--code-self-write). Rationale:
[ADR 0011](docs/decisions/0011-self-evolution-architecture.md) §7 + its
[2026-06-25 amendment](docs/decisions/0011-self-evolution-architecture.md#amendment-2026-06-25-self-write-is-autonomous-to-branch-checkpoint--merge-not-approve);
spec: [Phase 3 spec](docs/superpowers/specs/2026-06-25-phase3-code-self-write.md).

**3.1: swappable writer/reviewer + token telemetry.** The **writer** is now swappable too (it was
hardcoded to Codex), so the heavy-token role can sit on whichever subscription is largest:
`HOUGE_SELFWRITE_WRITER` (`codex` | `claude`, default `codex`) pairs with `HOUGE_SELFWRITE_REVIEWER` —
e.g. `WRITER=claude` + `REVIEWER=codex` for Claude Max 5x writer + Codex Plus reviewer. The guard
checks the diff, not the author, so the swap can't widen what may land; same-provider writer+reviewer
logs a soft warning (model diversity), never blocks. **Token usage is now recorded per call**: each
LLM call emits an `llm_call` ledger event (provider, model, role, in/out/cached tokens, optional
cost + latency — **counts/metadata only, never prompt/diff/response bodies**), and a published branch
also stamps a compact writer+reviewer `usage_summary` on its `self_write_published` event. See
[configuration](docs/reference/configuration.md#phase-31--swappable-writer--per-role-models).

**3.3: merge from Telegram.** A published self-write fix now carries inline buttons — **[View diff] ·
[Merge & reload] · [Discard]** — so the §5 merge checkpoint moves from a terminal `git merge` to an
**authenticated tap**. **[Merge & reload]** merges → builds → **re-runs the test-gate** on merged `main`
→ (**red: auto-revert, no restart**, daemon keeps the old code; **green:** a durable "reloading" notice
that survives the bounce, then a detached `launchctl kickstart` self-restart onto the new `dist/`) →
optional `git push` (`HOUGE_SELFWRITE_PUSH`, default off). **[Discard]** deletes the branch; **[View
diff]** shows it. It stays **human-gated** — only your authenticated tap acts (callbacks are
allowlist-checked, same floor as messages), and the daemon **never merges on its own**. See
[configuration](docs/reference/configuration.md#phase-33--interactive-telegram-merge-controls).

## Safety model

Deterministic code owns control; the LLM is used only for judgment
([ADR 0001](docs/decisions/0001-deterministic-harness-governs-everything.md)).
Defense-in-depth: per-run budget bounds one task; Telegram rate limits bound intake
spikes; a **global circuit-breaker** bounds Houge as a whole over a rolling 24h window
(the autonomy floor for the always-on daemon); approval gates require your consent for
each risky action.

→ Breaker caps, defaults, and rationale:
[configuration reference](docs/reference/configuration.md#global-autonomy-circuit-breaker)
and [ADR 0003](docs/decisions/0003-global-budget-breaker.md).

## Documentation

- [Configuration reference](docs/reference/configuration.md) — every environment variable, default, and purpose.
- [Deploy the daemon (launchd)](deploy/launchd/README.md) — run the always-on daemon on macOS.
- [Architecture decisions](docs/decisions/README.md) — the *why* behind significant choices (ADRs).
- [Research notes](docs/research/) — landscape reviews that inform design (e.g. agent memory, mid-2026).
- [Design spec](docs/superpowers/specs/2026-05-25-houge-chatops-orchestrator-design.md) — architecture and milestone plan.
- [CONTRIBUTING.md](CONTRIBUTING.md) — documentation convention and definition of done (tests **and** a live run).
- [AGENTS.md](AGENTS.md) — coding, safety, and workflow rules. [CONTEXT.md](CONTEXT.md) — domain language.
