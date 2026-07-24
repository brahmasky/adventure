# Houge

Houge (猴哥) is an **autonomous self-evolving agent** — not a chatbot. He lives as an
always-on Telegram-first daemon that turns natural language into bounded, auditable,
policy-governed task runs, and he **improves himself**: he authors his own skills, learns
lessons from feedback, diagnoses his own source, and writes his own code fixes — with
mechanical safety nets (not human approval) protecting the two hard lines: *(a) no adverse
impact to his own operation, (b) no leaking secrets*. You talk to Houge the way you talk to
Claude Code — plain language in, intent inferred — and explicit slash commands survive only
for the control/safety plane ([ADR 0010](docs/decisions/0010-natural-language-intent-layer.md)).

## Status

The foundation (Milestones 0–3: state machines, run ledger, Telegram gateway, always-on
launchd daemon, global budget breaker) is complete, and the **self-evolution spine** is live
on top of it — ~1,150 tests, zero runtime dependencies (Node 25, TypeScript, Vitest, the
built-in `node:sqlite`):

- **Agentic inner loop** ([ADR 0013](docs/decisions/0013-llm-inner-composition.md)) — every
  turn hands the model a tool manifest (web_search, http_fetch, to_local_time, llm_answer,
  lesson_write, self_diagnose, self_write_propose, skill_author); it composes its own steps;
  every step still executes through the deterministic gates.
- **Self-evolution, proven live** — Houge has 13+ merged self-writes: a write-intent runs
  Codex in a fresh worktree → protected-path guard → test gate → independent reviewer →
  auto-published branch → Paco's [Merge & reload] tap ([ADR 0011](docs/decisions/0011-self-evolution-architecture.md)).
- **The eval loop (spine Slice A)** ([ADR 0012](docs/decisions/0012-self-evolution-spine-closed-loop.md)) —
  0–3 session ratings, per-turn attribution, reconcile-on-write (ADD/SUPERSEDE/UPDATE),
  reuse-value + decay; compounding is observable in `/lessons`.
- **Security walls, armed in production** — a secrets firewall (broker + env strip + egress
  redaction, [ADR 0015](docs/decisions/0015-secrets-firewall.md)) and a dual-LLM wall (a
  quarantined reader ingests untrusted web bytes; the planner that chooses actions never
  sees them, [ADR 0014](docs/decisions/0014-dual-llm-privilege-separation.md)).
- **Web read** — loop-native `web_search` (Tavily/Firecrawl chain) + SSRF-hardened
  `http_fetch`; free-read, gated-act ([ADR 0006](docs/decisions/0006-web-read-capability.md)).
- **Conversational learning** — feedback gets a tighter re-answer and, when it generalizes,
  is silently distilled into a lesson; see [Learning](#learning).
- **Natural-language front door** — every non-command message becomes one `turn` classified
  on the model-agnostic LLM chain; see [Talking to Houge](#talking-to-houge).

**What's next** — the sequenced build plan (research-convergence fix → episodic memory →
kill-switch + $-ceiling → LLM wiki → the autonomy flip's preconditions) lives in
[docs/ROADMAP.md](docs/ROADMAP.md).

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
wins; `unavailable`/error/timeout fall through). Default chain `pi,kimi-api`; the
recommended live chain is `pi,agy-cli,kimi-api,gemini-api`. Two kinds of leg:
**coding-tuned** — `pi` (hardened single-shot CLI, tools disabled) and `kimi-api`
(OpenAI-compatible HTTP) — and **general** — `agy-cli` (the Antigravity CLI in
`--print` mode, Gemini Flash) and `gemini-api` (Google's OpenAI-compat endpoint).
The general legs exist because a coding model over-produces on research/answer prose
and blew `pi`'s 256KB output cap (the 2026-06-26 silent-failure incident); a general
leg synthesizes cleanly and catches the fall-through. All model-agnostic — best model per
capability, flat-rate legs first, metered APIs as capped fallback.
Houge answers in its own voice — a projection of its Core Identity
([memory/core/houge.md](memory/core/houge.md)): the cheerful, capable 猴哥, but
*inference only* (it answers; it doesn't act) on the **answer** path. Override the
persona with `HOUGE_ASK_SYSTEM_PROMPT`.

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

**Consolidation (preserve-all merge).** As lessons accumulate, near-duplicates within a scope are
merged by a **daily preserve-all merge tick** (mirroring episodic consolidation): it clusters
near-duplicate ACTIVE lessons and merges each cluster into ONE lesson that keeps **every** directive
and every AVOID. It is **ADD-then-supersede-all** — it never deletes; the originals are superseded,
not dropped, and reuse value is carried (capped/clamped). A cluster-size cap plus gross-collapse and
avoid-drop floors keep a merge from over-collapsing. Preview a run with `houge lessons-consolidate
--dry-run`; the tick is gated by `HOUGE_LESSON_CONSOLIDATE_ENABLED` (in `DISARM_FLAGS`). Design:
[lesson-consolidation spec](docs/superpowers/specs/2026-07-23-lesson-consolidation-design.md).

This trades ADR 0007's upfront `/teach` + per-lesson approval gate for **precision +
reversibility** on *user-sourced* lessons — the human's own feedback is the trust anchor. Two
slash-only control commands keep it inspectable (idempotent, no run, no budget):

- `/lessons [scope]` — view the lesson block(s); shows the raw block plus char-count/cap so you can see consolidation pressure. With no scope, lists all scopes.
- `/forget <scope>` — clears that scope's lesson block and acks.
- `/schedule` · `/schedule cancel <N>` — list/cancel this chat's scheduled tasks; the list numbers them `#1..#N` (cancel by number or full id), and schedules are created, listed, **updated**, and cancelled conversationally via the `schedule_task` loop tool ("每周一早上8点给我AI周报", "周报以后加上悉尼工作机会") — ADR 0017 + its 2026-07-20 v2 amendment.
- `/status` — a three-section health digest (🟢 HEALTH / 📈 ACTIVITY / 💰 COST & USAGE), including the invariant-sweep self-check line ("swept Xh ago · N open incidents") so a silent-healthy sweep is still visible; Sydney-local times.
- `/usage` (Telegram) / `houge usage` (CLI) — token/cost observability from the SQLite ledger, split **API (metered, real $) vs CLI (subscription, tokens-only)** with the model per leg.
- `/help` — the command list. Any typo'd/unknown `/slash-command` returns this list rather than falling through to an (expensive) LLM turn.
- `/kill [reason]` — the durable kill switch (ADR 0018): writes the `houge.kill` tombstone and stops the daemon; launchd relaunches into a PARKED process, so nothing automatic can resurrect it. Revival is manual (delete the file, restart). `/disarm` · `/rearm` — one-command evolution/scheduler stand-down that survives restarts (posture file outranks `.env`).

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

Deterministic code owns the irreversible; the LLM owns judgment
([ADR 0001](docs/decisions/0001-deterministic-harness-governs-everything.md), as amended:
the cognitive interior is the model's to run — the gates sit at irreversible action).
Defense-in-depth: per-run budget bounds one task; Telegram rate limits bound intake
spikes; a **global circuit-breaker** bounds Houge as a whole over a rolling 24h window
(the autonomy floor for the always-on daemon); a **metered-$ ceiling** bounds the
pay-per-token legs in dollars ($5/24h · $50/month defaults — breach drops the metered
legs, flat-rate keeps working, [ADR 0019](docs/decisions/0019-metered-ceiling.md)); a
durable **kill switch** (`/kill`, [ADR 0018](docs/decisions/0018-kill-switch.md)) parks
the daemon so not even launchd can resurrect it; approval gates require your consent for
each risky action. On top of that floor: the self-write **protected-path guard** (fail-closed,
not overridable by `/approve`), the worktree **test gate**, an **independent diff reviewer**,
branch-only publish with a **human-tapped merge**, the **secrets firewall**
([ADR 0015](docs/decisions/0015-secrets-firewall.md)), and the **dual-LLM wall**
([ADR 0014](docs/decisions/0014-dual-llm-privilege-separation.md)).

→ Breaker caps, defaults, and rationale:
[configuration reference](docs/reference/configuration.md#global-autonomy-circuit-breaker)
and [ADR 0003](docs/decisions/0003-global-budget-breaker.md).

## Self-inspection — the invariant sweep

Houge's memory (lessons, skills, wiki, episodic facts) stores *content*: what was said,
learned, known. The **invariant sweep** ([ADR 0024](docs/decisions/0024-introspection-invariant-sweep.md))
covers the other half — his own *behavior*. With `HOUGE_INVARIANT_SWEEP_ENABLED=true` the
daemon checks six assertions over its own flight recorder (`runs`, `scheduled_tasks`,
`notification_outbox`, `daemon_heartbeat`) every `HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES`
(default 720 — twice a day): duplicate enabled schedules, stuck runs, undelivered
notifications, overdue schedules, failed schedules, heartbeat gaps.

A violation opens a durable **incident** (fingerprint `kind:subject`), emits a ledger event,
and sends **one** Telegram line. Recurrences bump a counter silently; a clean sweep resolves
the row; rows are never deleted, and a recurrence after resolution opens a new row so
recurrence stays countable. At most 3 alerts per sweep plus a summary line, and reopens inside
30 minutes are silent — a monitor that spams during an outage gets muted, and a muted monitor
is worse than none.

It is the least-privileged component in the system by construction: pure SQL reads plus
incident bookkeeping — no LLM, no capability, no run creation. It cannot act on what it finds.

```bash
sqlite3 houge.sqlite "SELECT kind, subject, state, seen_count, first_seen_at FROM incidents ORDER BY first_seen_at DESC"
```

Deferred to slice B: the judgment half — promise-vs-action diffing, plan-vs-execution
divergence, a daily LLM retro digest, an `/incidents` view, and the
incident → `self_diagnose` → regression-tested self-write bridge.

## Google identity — gmail_read / google_api

Houge has his own Google identity (`wukong.houge@gmail.com`,
[ADR 0008](docs/decisions/0008-houge-identity-authenticated-read.md)), and with
`HOUGE_GOOGLE_ENABLED=true` he can read it. **`gmail_read`** lists, searches, and opens messages
in his own inbox, appending a deterministic code-built block of verification codes/links (the
registration trust anchor — regexes over the raw body, not model transcription). **`google_api`**
is the generic GET escape hatch behind an exact allowlist registry (one row per granted OAuth
scope; today `gmail/v1/users/me/*` ↔ `gmail.readonly`). The OAuth scope is the hard floor: the
refresh token can read mail and do nothing else, no matter what a hostile email asks for. Both
tools are quarantined behind the dual-LLM wall and armed **only as a couple** —
`HOUGE_GOOGLE_ENABLED` AND `HOUGE_DUAL_LLM_ENABLED`, or they silently leave the tool manifest
([ADR 0025](docs/decisions/0025-google-api-surface.md)). This closes the Earn-P3 registration
loop: sign up on a venue → the verification mail lands in Houge's inbox → he reads the code
himself.

**Runbook — Gmail ops fail with `auth_failed`.** This is the *expected* failure mode.
Cause: the refresh token was revoked (or hit the 7-day testing-mode expiry, if the OAuth consent
screen was ever un-published). Fix: re-run `node scripts/gmail-auth.mjs <client_secret.json>`
and copy the three `HOUGE_GMAIL_*` lines into the mini's `.env`.

## Backup & restore

With `HOUGE_BACKUP_ENABLED=true` the daemon snapshots `houge.sqlite` into `backups/`
every `HOUGE_BACKUP_INTERVAL_HOURS` (default 24h): a WAL-safe `VACUUM INTO`,
integrity-checked before it gets its final name, newest `HOUGE_BACKUP_KEEP` (default 7)
kept. **Local-only** — protects against corruption and accidental deletes, not disk death
([ADR 0021](docs/decisions/0021-db-backup.md)).

Restore:

```bash
launchctl bootout gui/$UID/com.houge.daemon        # stop the daemon
cp backups/houge-<stamp>Z.sqlite houge.sqlite      # copy the snapshot over the live db
rm -f houge.sqlite-wal houge.sqlite-shm            # stale WAL siblings must not replay
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.houge.daemon.plist  # restart (kickstart fails after bootout), verify /status
```

## Documentation

- [Roadmap](docs/ROADMAP.md) — the model-agnostic handoff plan: verified state, non-negotiables, sequenced next builds.
- [Configuration reference](docs/reference/configuration.md) — every environment variable, default, and purpose.
- [Deploy the daemon (launchd)](deploy/launchd/README.md) — run the always-on daemon on macOS.
- [Architecture decisions](docs/decisions/README.md) — the *why* behind significant choices (ADRs).
- [Research notes](docs/research/) — landscape reviews that inform design (e.g. agent memory, mid-2026).
- [Design spec](docs/superpowers/specs/2026-05-25-houge-chatops-orchestrator-design.md) — architecture and milestone plan.
- [CONTRIBUTING.md](CONTRIBUTING.md) — documentation convention and definition of done (tests **and** a live run).
- [AGENTS.md](AGENTS.md) — coding, safety, and workflow rules. [CONTEXT.md](CONTEXT.md) — domain language.
