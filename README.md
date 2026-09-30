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

Voice notes and photos work when `HOUGE_MEDIA_INGEST_ENABLED` is on: a voice note is transcribed
and answered like typed text (the reply starts with what Houge heard); a photo is read behind the
dual-LLM wall and its description joins your caption. Videos and files are not read yet.

## LLM providers

Houge runs on **omp** (`@oh-my-pi/pi-coding-agent`, an oh-my-pi fork), pinned at `18.4.4`, under
its own profile `houge`, on **subscription OAuth only**: no metered API
([ADR 0028](docs/decisions/0028-omp-runtime.md)). Each Telegram chat gets one supervised omp
planner (Opus 5.5 by default, falling back to Opus 4.6 and then Kimi k3). The planner works with
real tools: `read`/`edit`/`write` on the mini, a sandboxed `bash`, and Houge's own tools through a
daemon-side bridge. Every other seat (the quarantined reader, photos, background ticks, the idea
panel, the self-write reviewer) is a tool-less one-shot omp call on its own model chain. Voice notes
stay on the flat-rate `agy-cli` leg, because omp cannot hear audio yet.

**One-time setup: the four subscription logins.** Run these on the mini, under the `houge` profile,
never the default one:

```bash
omp --profile houge login anthropic            # Claude Max: Opus 5.5 planner and chair
omp --profile houge login google-antigravity   # Gemini reader and photos; Opus 4.6 fallback
omp --profile houge login kimi-code            # k3: ticks, judge, reviewer, last planner fallback
omp --profile houge login openai-codex         # GPT-5.5 judge and reader fallback
```

The grants live in `~/.omp/profiles/houge`, a secret path: the sandbox and the policy hook keep it
from the planner's tools. Kimi Code refreshes its token against kimi.ai, so the daemon passes the
`KIMI_CODE_OAUTH_HOST` and `KIMI_CODE_BASE_URL` pair into omp children. That pair is the default
value of `HOUGE_OMP_ENV_PASSTHROUGH`, so leave the variable unset unless omp needs another name.

**The version pin.** Every spawn checks `omp --version` against `HOUGE_OMP_VERSION` (default
`18.4.4`) and refuses on a mismatch, opening incident `omp_version_mismatch`. To move the pin,
install the new omp and smoke it with the pin overridden for that one run:

```bash
HOUGE_OMP_VERSION=<new> HOUGE_ENV_FILE=/abs/path/.env node scripts/live-gate-omp.mjs --smoke
```

Only when that passes, set `HOUGE_OMP_VERSION=<new>` in `.env` (or add it to
`HOUGE_OMP_VERSION_ALLOW`) and restart the daemon. omp's own update checks are switched off in the
profile config.

Each seat's model is one `provider/model[:effort]` chain in a `HOUGE_OMP_*` variable. The old
`HOUGE_LLM_*`, pi, kimi-api and gemini-api settings are gone. Houge answers in its own voice, a
projection of its Core Identity ([memory/core/houge.md](memory/core/houge.md)).

→ Every `HOUGE_OMP_*` variable, its default, and what was removed:
[configuration reference](docs/reference/configuration.md#llm-runtime--omp-adr-0028).
The threat model and floors: [ADR 0028](docs/decisions/0028-omp-runtime.md). Identity & memory
direction: [ADR 0005](docs/decisions/0005-agent-memory-architecture.md).

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
- `/radar [n]` — numbered top active idea cards from the daily Idea Radar tick (ADR 0026): code-owned sources (HN/HF/Devpost/GitHub/lobste.rs) → one DATA-framed extract call → bounded `ideas` store with momentum = distinct items × sources; `/radar <n>` drills into one card (summary, panel scores, source titles + URLs). Pre-arm gate: `houge radar --dry-run` (real fetches, zero writes).
- `/idea` · `/idea pick <n>` — the weekly judge panel's frozen shortlist (ADR 0027: kimi/gemini/codex judges + contained claude chair, mean-score fallback) and the pick that feeds R3 (global singleton — at most one `picked` card, ever). Pre-arm gate: `houge radar-panel --dry-run` (real seats, zero writes, no push, no brief).
- `/help` — the command list. Any typo'd/unknown `/slash-command` returns this list rather than falling through to an (expensive) LLM turn.
- `/kill [reason]` — the durable kill switch (ADR 0018): writes the `houge.kill` tombstone and stops the daemon; launchd relaunches into a PARKED process, so nothing automatic can resurrect it. Revival is manual (delete the file, restart) and does not raise a false `heartbeat_gap` incident — the parked process leaves a `houge.parked` marker the sweep reads once. `/disarm` · `/rearm` — one-command evolution/scheduler stand-down that survives restarts (posture file outranks `.env`).

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

**Retirement (spec 2026-07-29).** The lifecycle's death verb is **retire, never delete**: a
retired skill moves to `skills/_retired/<scope>/` (inert, stamped with `retired`/`retired_by`/
`superseded_by` lineage), reversible via restore. Surfaces: `/skills retire|restore <name>`
(`<scope>/<name>` disambiguates) · `/skills retired` (the graveyard view) · natural language
("退役周报技能") routed through Gate A with **code-side** name resolution — ambiguity asks,
never guesses. A **fed-refine** (a request naming exactly one active skill feeds its file to
the writer) that renames auto-retires the predecessor with `superseded_by` lineage. A weekly
**re-verify advisor** (`HOUGE_SKILL_REVERIFY_ENABLED`, suggest-only, quiet-when-healthy)
re-scores stale skills with Gate B and flags failures with the exact retire command — it
never moves a file itself.

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
3. **Independent reviewer** (model diversity: Codex writes, an omp seat on `HOUGE_OMP_REVIEWER` judges) →
   an adversarial *fixes-it / bugs / scope-creep* verdict — the staff-engineer check tests can't give.

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

**How Paco operates it.** Flip `HOUGE_SELFWRITE_ENABLED=true`. Then, when notified of a published branch, **review the `houge/selfwrite/<run-id>`
branch in git, `git merge` it, and reload the daemon** — at his leisure (pull-based, not a blocking
gate). Config: `HOUGE_SELFWRITE_ENABLED` / `HOUGE_SELFWRITE_REVIEWER` / `HOUGE_OMP_REVIEWER` /
`HOUGE_TESTGATE_TIMEOUT_MS` (the write adapter reuses `HOUGE_CODEX_*`) — see
[configuration](docs/reference/configuration.md#self-evolution-phase-3--code-self-write). Rationale:
[ADR 0011](docs/decisions/0011-self-evolution-architecture.md) §7 + its
[2026-06-25 amendment](docs/decisions/0011-self-evolution-architecture.md#amendment-2026-06-25-self-write-is-autonomous-to-branch-checkpoint--merge-not-approve);
spec: [Phase 3 spec](docs/superpowers/specs/2026-06-25-phase3-code-self-write.md).

**3.1: swappable writer/reviewer + token telemetry.** The **writer** is now swappable too (it was
hardcoded to Codex), so the heavy-token role can sit on whichever subscription is largest:
`HOUGE_SELFWRITE_WRITER` (now `codex` only; the Claude writer was later removed) pairs with
`HOUGE_SELFWRITE_REVIEWER` (`omp` by default, or `codex`). The guard
checks the diff, not the author, so the swap can't widen what may land; same-provider writer+reviewer
logs a soft warning (model diversity), never blocks. **Every LLM leg attempt is recorded**: each leg
tried — success, failure, or fallthrough, run-scoped or daemon tick — emits an `llm_attempt`
ledger event (provider, role, outcome, model, latency, tokens, priced cost on metered legs, a
bounded error kind — **counts/metadata only, never prompt/diff/response bodies**) through a
required audit sink the compiler will not let a call site omit, and a published branch
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
daemon checks seven assertions over its own flight recorder (`runs`, `scheduled_tasks`,
`notification_outbox`, `daemon_heartbeat`) every `HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES`
(default 720 — twice a day): duplicate enabled schedules, stuck runs, undelivered
notifications, overdue schedules, failed schedules, a provider leg that keeps failing with no
success (the shape in which a dead flat-rate leg hid for three months), heartbeat gaps (a gap that spans a
deliberate `/kill` park is logged, not opened — the parked process leaves `houge.parked`).

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

## Jev intent shadow — replay

Every chat turn starts with an intent label (answer / research / feedback / clarify /
selfcode / skill) that today costs one CLI LLM call, about 6 s. [Jev](https://docs.typesafe.ai/llms.txt)
is a decision model that returns a typed choice with calibrated confidence in a few hundred
milliseconds. `houge jev-shadow replay` measures whether it can take that label over, without
touching the daemon: for each historical turn it rebuilds the thread as of classification time,
asks Jev and the current classifier the same question, and prints GO / STOP (`--dry-run` first;
resumable; labels only, never message text, in `.houge/jev-shadow/replay.jsonl`).

First run, 2026-09-26: **GO** — on Paco's own Telegram messages (294 turns) Jev agrees with the
classifier 91.7% of the time at confidence ≥ 0.7, covering 57% of turns (Chinese 92.4%; English
84.2% on 19 confident turns). The all-sources headline, 94.2% over 374 turns, is inflated by 70
repeats of 3 scheduled prompts. $0.035 total. Jev's label stays advisory — it never gates
an action. The live shadow is **dormant since the omp cutover** (ADR 0028): the classifier call it
shadowed is gone, so `HOUGE_JEV_SHADOW_ENABLED` has no effect. `houge jev-shadow report` still reads
the historical shadow rows.
Configuration: [docs/reference/configuration.md](docs/reference/configuration.md)
("Jev intent shadow"); design: `docs/superpowers/specs/2026-09-25-jev-intent-shadow-design.md`.

## Google identity — gmail_read / google_api

Houge has his own Google identity (`wukong.houge@gmail.com`,
[ADR 0008](docs/decisions/0008-houge-identity-authenticated-read.md)), and with
`HOUGE_GOOGLE_ENABLED=true` he can read it. **`gmail_read`** lists, searches, and opens messages
in his own inbox, appending a deterministic code-built block of verification codes/links (the
registration trust anchor — regexes over the raw body, not model transcription). **`google_api`**
is the generic GET escape hatch behind an exact allowlist registry (one row per granted OAuth
scope; today `gmail/v1/users/me/*` ↔ `gmail.readonly`). The OAuth scope is the hard floor: the
refresh token can read mail and do nothing else, no matter what a hostile email asks for. Both
tools are always read through the quarantined reader (the wall is unconditional under omp,
ADR 0028), so `HOUGE_GOOGLE_ENABLED` alone arms them
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
- Working logs: [sessions.md](sessions.md) — what each build session did and why, newest last; [tasks/todo.md](tasks/todo.md) — live config truth, shipped blocks, parked/watch list; [tasks/lessons.md](tasks/lessons.md) — orchestration mistakes and the rules that prevent them.
