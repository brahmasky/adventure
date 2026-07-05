# Configuration reference

Every Houge configuration parameter, its default, and what it does. This is the
canonical catalog — `.env.example` is the terse copy-paste template, this is the
explained version, and the README only links here.

**How configuration is loaded** (`src/config/load-env.ts`): the CLI reads
`<cwd>/.env` at startup (or the file named by `HOUGE_ENV_FILE`). **Real environment
variables take precedence over the file.** `.env` is gitignored.

**Resolution order for a given setting:** explicit request value → per-provider env
var → general env var → code default. Secrets are env-only and never written to
reports, memory, logs, or chat.

To share one `.env` across git worktrees, point each at an absolute path:
`set -x HOUGE_ENV_FILE /Users/pluo/Projects/adventure/.env`.

---

## Telegram

Required for `houge telegram-poll --once` (and the Milestone 3 daemon).

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `HOUGE_TELEGRAM_BOT_TOKEN` | — | yes | Bot token from @BotFather. |
| `HOUGE_TELEGRAM_USER_ID` | — | yes | Your numeric Telegram user id (e.g. from @userinfobot). The intake allowlist binds to it. |
| `HOUGE_TELEGRAM_CHAT_ID` | — | yes | Numeric chat id. For a 1:1 chat with your bot this equals your user id. |

## Always-on daemon

`houge telegram-poll` (no `--once`) runs the continuous long-poll daemon. Design
and rationale: [ADR 0004](../decisions/0004-long-poll-daemon.md). Deployment under
launchd: [deploy/launchd/README.md](../../deploy/launchd/README.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_TELEGRAM_LONGPOLL_TIMEOUT_S` | `30` | Telegram `getUpdates` long-poll timeout (seconds). The daemon blocks on a held connection for up to this long; a message arriving sooner is delivered immediately. Not your message latency — just how long an *idle* connection is held. |
| `HOUGE_DAEMON_BACKOFF_BASE_MS` | `1000` | Base delay for exponential backoff after a Telegram error (`base · 2^(failures-1)`). |
| `HOUGE_DAEMON_BACKOFF_MAX_MS` | `60000` | Cap on the backoff delay. |
| `HOUGE_DAEMON_LOCK_PATH` | `houge.daemon.lock` (cwd) | PID lockfile for the single-instance guard; a second daemon with the same lock exits instead of fighting over the Telegram long-poll (which would cause HTTP 409). |

## LLM provider chain (powers cognition)

Every cognitive call — intent classification, the **answer** path, research synthesis
and critique, and the feedback distiller — runs on this model-agnostic chain (`pi` → kimi,
never Claude). See [ADR 0002](../decisions/0002-pi-as-agent-runtime.md) for the
inference-vs-agentic policy behind the `pi` provider and
[ADR 0010](../decisions/0010-natural-language-intent-layer.md) for the natural-language
front door.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_LLM_PROVIDERS` | `pi,kimi-api` | Ordered, comma-separated chain with automatic fallback (first success wins; unavailable/error/timeout falls through). Known providers: `pi` + `agy-cli` (hardened single-shot CLIs), `kimi-api` + `gemini-api` (OpenAI-compatible HTTP). `agy-cli`/`gemini-api` are **general-model** legs (Gemini Flash) so research synthesis doesn't over-produce like the coding-tuned `pi`/`kimi` legs (Phase 3.4). Recommended live chain: `pi,agy-cli,kimi-api,gemini-api`. The singular `HOUGE_LLM_PROVIDER` is ignored when this plural is set. |
| `HOUGE_LLM_MODEL_PI` | unset → pi's own configured model | Model is configured **per provider** (namespaces differ). Set this only to make Houge override pi's own choice. |
| `HOUGE_LLM_MODEL_KIMI` | `moonshot-v1-auto` (stable alias) | A model your `KIMI_API_KEY` can access (`GET /v1/models`). |
| `HOUGE_LLM_MODEL_GEMINI` | `gemini-3.5-flash` | Model for the `gemini-api` leg (a general model; the latest Flash on the public API). |
| `HOUGE_AGY_MODEL` | `Gemini 3.5 Flash (Low)` | Model for the `agy-cli` leg (`agy models` lists choices). |
| `HOUGE_ASK_SYSTEM_PROMPT` | composed from `memory/` + `lessons` | The **answer**-path system prompt. When unset it is **composed** (identity + answer discipline + the `ask` scope's lessons + guardrails — see [Learning](#learning--conversational-distillation-and-the-lessons-table) below), replacing pi's default *coding-assistant* persona. Set this to override the whole prompt. |
| `HOUGE_LLM_TIMEOUT_MS` | — | Fallback per-provider wall-clock timeout (ms) for any provider without a specific one. |
| `HOUGE_LLM_TIMEOUT_MS_PI` | `60000` | pi timeout (ms). |
| `HOUGE_LLM_TIMEOUT_MS_KIMI` | `30000` | kimi timeout (ms). |
| `HOUGE_LLM_TIMEOUT_MS_AGY` | `60000` | agy-cli timeout (ms). |
| `HOUGE_LLM_TIMEOUT_MS_GEMINI` | `30000` | gemini-api timeout (ms). |

> The CapabilityRunner's enforced wall-clock cap is **derived** from these:
> `sum(per-provider timeouts) + 15000` buffer. With the 4-leg chain (pi 60s + agy 60s +
> kimi 30s + gemini 30s) the runner cap is 195s — so a healthy chain that legitimately
> falls through every provider is never killed mid-flight.

### pi CLI provider

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_PI_ENV_PASSTHROUGH` | — | Extra env var **names** (comma-separated) to pass through to the pi child. The child runs with a minimal allowlist (`PATH, HOME, TERM, LANG, USER`) so the attacker-controlled question never sees the Telegram token or unrelated keys; add the var pi needs for auth here. |

### agy CLI provider (Antigravity / Gemini)

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_AGY_BIN` | `agy` (on PATH) | Absolute path to the `agy` binary. Set this for the daemon, which runs under a restricted PATH (like `HOUGE_CLAUDE_BIN`/`HOUGE_CODEX_BIN`). |
| `HOUGE_AGY_ENV_PASSTHROUGH` | — | Extra env var **names** (comma-separated) for the agy child. Same minimal allowlist as pi (`PATH, HOME, TERM, LANG, USER`); agy normally reads its auth from `$HOME`, so this is rarely needed. The prompt rides argv (`--print <prompt>`) as a single discrete element — injection-safe — and `--dangerously-skip-permissions` is never passed. |

### Kimi API provider

| Variable | Default | Purpose |
|----------|---------|---------|
| `KIMI_API_KEY` | — | Secret. Enables the `kimi-api` provider; if unset the provider reports `unavailable` and the chain falls through. |
| `HOUGE_KIMI_BASE_URL` | `https://api.moonshot.ai` | Base URL for the OpenAI-compatible endpoint. |

### Gemini API provider

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | — | Secret. Enables the `gemini-api` provider; if unset the provider reports `unavailable` and the chain falls through. |
| `HOUGE_GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` | Base URL for Google's OpenAI-compatibility endpoint (the factory appends `/chat/completions`). |
| `HOUGE_GEMINI_MAX_TOKENS` | `8192` | Output token budget. Generous because 3.5-flash spends "thinking" tokens against the same budget — a tight cap can starve the visible answer. |

## Web read (powers the **research** intent)

Tier-1 web access — a pluggable, keyed provider chain (like the LLM chain). Design and
guardrails: [ADR 0006](../decisions/0006-web-read-capability.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_WEB_PROVIDERS` | `tavily,firecrawl` | Ordered chain with fallback (first `ok` wins; unavailable/error falls through). Known: `tavily`, `firecrawl`. |
| `TAVILY_API_KEY` | — | Tavily key ([tavily.com](https://www.tavily.com) — 1,000 credits/mo, no card). Unset → provider unavailable, chain falls through. |
| `FIRECRAWL_API_KEY` | — | Firecrawl key ([firecrawl.dev](https://www.firecrawl.dev) — 1,000 credits/mo, no card). |
| `HOUGE_WEB_MAX_RESULTS` | `5` | Results per search — bounds synthesis tokens and the global breaker's exposure. |
| `HOUGE_WEB_TIMEOUT_MS` | tavily 20000 / firecrawl 30000 | Per-provider request timeout (ms). |
| `HOUGE_TAVILY_BASE_URL` | `https://api.tavily.com` | Tavily API base. |
| `HOUGE_FIRECRAWL_BASE_URL` | `https://api.firecrawl.dev` | Firecrawl API base. |

A **research** intent runs the `web-research` program: search the live web (`web_search`,
`external_read`) → 猴哥 synthesizes an answer treating results as **untrusted data** and
**citing source URLs** → a **STORM-style self-critique pass** re-reads the draft (figures
internally consistent? weakest claims? any single source over-weighted?) and returns a
corrected final answer ([ADR 0006](../decisions/0006-web-read-capability.md) amendment).
Both the synthesis and critique prompts come from the composer (below), so the `research`
scope's lessons steer both. Telegram link previews are disabled to cut the outbound
exfil leg; the URLs read are recorded in the ledger (`web_search_performed`).

## Direct URL read (`http_fetch`, loop tool — Phase 3.6 step ③)

`http_fetch` fetches ONE public http(s) URL as a plain inner-loop tool (like
`web_search`, but armed): GET/HEAD only, redirects never followed — a 3xx reports its
target so the next fetch revalidates from scratch. The SSRF floor is **code-owned and
not configurable**: private/reserved/special-range IPs are always refused
(resolve-and-pin, one DNS resolution per fetch), credentials-in-URL refused, and the
byte cap binds the *decompressed* body. Accepted Posture-A residuals are documented in
the module docblock (`src/web/http-fetch.ts`); the URLs read are recorded in the ledger
(`http_fetch_performed`).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_HTTPFETCH_ENABLED` | off | Arms the tool (armed-listing, like `HOUGE_SELFWRITE_ENABLED`): disarmed ⇒ unlisted ⇒ unreachable. Accepts 1/true/yes/on. |
| `HOUGE_HTTPFETCH_TIMEOUT_MS` | `15000` | Wall-clock cap per fetch (ms) — bounds the whole body read, not just the connect, so slow-trickle bodies can't stall a turn. |
| `HOUGE_HTTPFETCH_MAX_BYTES` | `1000000` | Byte cap on the **decompressed** body (zip-bomb guard). Cap hit ⇒ the kept prefix ships with `truncated: true`. |
| `HOUGE_HTTPFETCH_DENY` | — | Optional comma-separated host denylist, **punycode form** (WHATWG URL parsing punycodes IDN hosts before matching). Each entry matches the exact host and every subdomain (dot-suffix), e.g. `evil.test` also blocks `a.evil.test`. |

## Secrets firewall (ADR 0015, Phase 1)

When armed, the five real secrets (`KIMI_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`,
`FIRECRAWL_API_KEY`, `HOUGE_TELEGRAM_BOT_TOKEN`) are lifted into an in-process
`SecretBroker` at boot and then **deleted from `process.env`** — the daemon holds no
ambient credential, so a self-written `process.env.KIMI_API_KEY` reads `undefined`. The
broker feeds the provider chain builders (single source of truth: `config.apiKey`, the
`?? process.env` fallback is gone) and the Telegram client, and masks any secret **value**
in outbound chat replies, ledger payloads, and error text. Codex children always get an
explicit allowlisted env regardless of this flag. See
[ADR 0015](../decisions/0015-secrets-firewall.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_SECRETS_FIREWALL_ENABLED` | off | Arms the firewall (lift-into-broker + strip `process.env` + redact egress). Accepts 1/true/yes/on. OFF ⇒ byte-identical to before the firewall existed. |
| `HOUGE_CODEX_ENV_PASSTHROUGH` | — | Optional comma-separated extra env var names the Codex child may inherit, on top of the `PATH/HOME/TERM/LANG/USER` allowlist. |

## Dual-LLM privilege separation (ADR 0014, Phase 1)

The **act** half of the lethal trifecta (the secrets firewall above is the **exfil** half). When
armed, every successful external-read result (`web_search`/`http_fetch`) is summarized by a
**quarantined reader (Q-LLM)** into a schema-constrained extraction
(`{summary, facts[], answer_to_objective, contains_instructions}` — no action field), and the
**planner (P-LLM)** — the only call that emits actions — reads that extraction, never the raw
fetched bytes. An injection in a page can at worst corrupt a data field a human sees; it cannot
steer the planner. On a reader parse miss the fallback is a metadata-only
`[unreadable external source: N bytes]` digest — never the raw bytes. See
[ADR 0014](../decisions/0014-dual-llm-privilege-separation.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_DUAL_LLM_ENABLED` | off | Arms the quarantined reader for external-read tools. Accepts 1/true/yes/on. OFF ⇒ byte-identical to before Dual-LLM existed (raw output digested inline). |
| `HOUGE_LLM_READER_PROVIDERS` | `HOUGE_LLM_PROVIDERS` | The reader's own provider chain (same names/format as `HOUGE_LLM_PROVIDERS`). Unset ⇒ the planner chain. Point it at a cheap, **cross-family** leg (e.g. `agy-cli,gemini-api`) for free injection resistance. |

## Short-term conversation memory (`chat_turns`)

A per-chat rolling thread of recent turns gives follow-ups context, so a reaction like
"too long" needs no reply-pointer and the chat feels like a conversation, not a vending
machine ([ADR 0010](../decisions/0010-natural-language-intent-layer.md) §4). Turns are
stored in the `chat_turns` table; three env vars bound how much of that thread is shared
and fed into a prompt. **Full turn text is always stored** — the char cap below applies
only when feeding a prompt.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_CHAT_CONTEXT_WINDOW_MINUTES` | `60` | How far back a follow-up still shares a thread. A message arriving after this gap starts a fresh thread (no prior context). |
| `HOUGE_CHAT_CONTEXT_TURNS` | `8` | Max recent turns fed into a prompt. Bounds the short-thread context tokens added per message. |
| `HOUGE_CHAT_CONTEXT_TURN_CHARS` | `500` | Per-turn char cap applied **only when feeding a prompt** (the stored turn keeps its full text). Truncates a long prior turn so the thread stays cheap. |

## Learning — conversational distillation and the `lessons` table

Every LLM-touching surface (the **answer** path, the research synthesis + critique, the
feedback distiller) builds its system prompt from one place — the **composer**
(`src/prompt/composer.ts`): Core Identity (`memory/core/houge.md`, loaded not duplicated) +
a per-surface discipline + the relevant **scope's lessons** (active rows composed at read
time) + guardrails.
Design: [ADR 0009](../decisions/0009-architecture-coherence.md); interaction model:
[ADR 0010](../decisions/0010-natural-language-intent-layer.md); learning loop:
[ADR 0007](../decisions/0007-learning-loop.md); reconcile/supersede + eval metadata:
[ADR 0012](../decisions/0012-self-evolution-spine-closed-loop.md) (spine Slice A, ⓪·3).

**Learning is conversational, not a command.** When the user reacts to a prior answer,
Houge **always re-answers** honoring the feedback, and **only when the feedback generalizes
into a clear, reusable preference** it **silently distills** it into a lesson — no toast, no
approval prompt. The distiller treats the *user's* feedback as the instruction and the prior
answer as reference only, so the untrusted-data wall holds: Houge never adopts an instruction
embedded in answer content as a lesson. This supersedes ADR 0007's `/teach` + per-lesson
approval gate **for user-sourced lessons** — trading the upfront gate for a high-precision
threshold plus inspect-and-undo. A correction that implies a "don't" also carries an
**`AVOID` line**, rendered under the lesson in the prompt.

**Reconcile-on-write, never append (⓪·3 S1).** Each durable lesson is **one row** in the
SQLite `lessons` table (the old one-block-per-scope `lesson_blocks` store was migrated —
its bullets split into rows — and is kept only as a frozen archive). Before a new lesson is
written, one cheap-chain compare against the scope's active lessons decides
**ADD / SUPERSEDE / UPDATE / DROP**: a changed preference *supersedes* its predecessor via
bidirectional pointers (never deleted — the chain is the memory rollback), a supplement is
merged, a duplicate is dropped. Rows carry eval metadata (`applied_count`,
`corrected_count`, `reuse_value`, `rating_history`, `last_used`) that the spine's S2 signal
path feeds; the composer renders active rows most-valuable-first, char-capped (~1200) like
the old block. The old over-cap LLM consolidation rewrite is gone — dedupe happens at write
time, and overflow past the row cap prunes the lowest `reuse_value` rows (reversibly).

| Env var | Default | Purpose |
|---------|---------|---------|
| `HOUGE_LESSON_CAP_PER_SCOPE` | `20` | Max **active** lesson rows per scope. Writing past the cap prunes the lowest-`reuse_value` rows (a reversible status flip, never a delete; the just-written row is always spared). Also caps how many rows the composer even considers when rendering. |

Inspect and undo with the slash-only control commands `/lessons` (shows each row's id,
reuse/applied counters, AVOID, and `supersedes #n` lineage) and `/forget <scope|id>` (see the
[command reference](#telegram-command-reference)). `memory/core/houge.md` is committed (his
spine); the `lessons` table is local runtime state. The only prompt knob is
`HOUGE_ASK_SYSTEM_PROMPT` (in the [LLM provider chain](#llm-provider-chain-powers-cognition)
table) — an escape hatch to override the composed **answer**-path prompt wholesale.

## Self-evolution (Phase 1) — code self-diagnose

Houge can read his **own source** to diagnose a bug. A `selfcode`-classified message runs a
**read-only Codex consult in a fresh git worktree** of committed `HEAD`, then relays the root
cause in his voice. The worktree holds only *tracked* files, so gitignored secrets are absent
by construction and the daemon's tree is untouched; the consult is `external_read` (no
`/approve` gate), `codex exec --sandbox read-only` is the inner wall, and no
`--dangerously-bypass-*` flag is ever passed. `coding_agent_cli` is reachable only from the
`self-diagnose` contract — every normal turn keeps it forbidden. Read-only diagnosis only —
Houge never edits a file in this phase. Design: [ADR 0011](../decisions/0011-self-evolution-architecture.md);
spec: [Phase 1 spec](../superpowers/specs/2026-06-20-phase1-code-self-diagnose.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_CODEX_ENABLED` | `off` | Master switch for the read-only Codex consult. When not truthy (`1`/`true`/`yes`/`on`), the `selfcode` branch **degrades gracefully** to a normal answer that notes the capability is off — so the feature ships dark and is opt-in. |
| `HOUGE_CODEX_MODEL` | unset → codex's own configured model | Model override passed to `codex exec -m <model>`. Unset → Codex uses its own default. |
| `HOUGE_CODEX_TIMEOUT_MS` | `240000` | Wall-clock timeout (ms) for one Codex consult — Codex is slow (minutes). The CapabilityRunner's enforced cap is **derived** as this value + 15000 buffer, so a legitimately-long consult is not killed early. |
| `HOUGE_CODEX_BIN` | `codex` | The Codex CLI binary name/path. A missing binary maps to a clean error (the consult fails, the run reports it) rather than crashing. |

## Self-evolution (Phase 2a) — ambient skills

A **skill** is a reusable *procedure* for a class of task ("how Houge does X well") — distinct
from a *lesson* (a one-line preference) and from *code*. Skills are hand-authored markdown under
`skills/<scope>/<name>.md` (`scope` ∈ the composer surfaces: `ask` | `research` | `selfcode` | …),
loaded by the composer into a run **between discipline and lessons**. They are **ambient — never
invoked by name**: the ≤cap in-scope skills ride in-prompt, each prefixed by its `when:` hint, and
Houge self-applies the relevant ones during an ordinary natural-language turn. Skills are prose
that executes no logic (low-risk, instantly revertible), so they live outside SQLite and outside
git (`skills/` is gitignored runtime state). A run with **no skills composes byte-identically** to
the pre-skills prompt. Design: [ADR 0011](../decisions/0011-self-evolution-architecture.md); spec:
[Phase 2 spec](../superpowers/specs/2026-06-21-phase2-skills.md).

Skill file format (frontmatter is the source of truth; `skills/REGISTRY.md` is a generated view):

```markdown
---
name: cross-check-figures
scope: research
when: comparing numbers across multiple sources   # trigger hint; Houge self-applies
anchors:                                           # world-fact assertions (Gate B, 2c)
  - a part never exceeds its whole
  - units are converted before comparison
version: 2
last_verified: 2026-06-21
origin: refined                                    # commanded | learned | refined
---

<the numbered procedure Houge follows for this class of task>
```

A malformed or missing skill file is **skipped, never throws** — a bad skill weakens an answer at
most, it can never break a turn. Use `/skills [scope]` to view the loaded skills (read-only).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_SKILLS_ENABLED` | `on` | Kill switch for the ambient skills layer. Skills are read-only/low-risk, so this defaults **on** — only an explicit `0`/`false`/`no`/`off` disables it, in which case the composer omits the skills section (composing byte-identically to a no-skills run). |
| `HOUGE_SKILL_MAX_PER_SCOPE` | `4` | Max skills folded into a prompt per scope (alphabetical by filename; the rest are dropped). Bounds the prompt and keeps self-selection precise. |
| `HOUGE_SKILL_REFINE_PASSES` | `3` | Max **guided-refine** passes for a blocked auto-authored skill (the paper peaks at 3). Each pass re-authors the draft against Gate B's specific failing criteria, then re-verifies. |

### Gate B — the anchor verifier (Phase 2c)

Gate B is a **separate, walled-off** verifier that scores an authored skill's *procedure* for
correctness. It runs a **3-pass ensemble**: each pass independently derives 4–6 procedure-level
quality criteria from world-knowledge (it is fed **only** the skill's `when:` + procedure body —
**never** the author's own `anchors:`, so an author can't grade its own homework) and judges
whether following the procedure satisfies each; the final score is the mean of the passes. A skill
**passes** when `score ≥ threshold`. The threshold is a *separation* bar, not a high-quality bar —
good skills score modestly; the gate works on the good/bad gap (the validating spike cleanly split
good skills 0.28–0.89 from broken ones ≤0.06).

**Advisory vs blocking by origin (D5):**
- **Commanded** skills (you asked Houge to write one) → **advisory**: written regardless; the score
  is stamped into the frontmatter (`score`, `last_verified`) and shown in the report, with a `⚠ low
  score` note when below threshold.
- **Auto-authored** skills (promoted from a recurring-procedure correction) → **blocking**: kept
  only if Gate B passes; otherwise **guided-refine ≤ `HOUGE_SKILL_REFINE_PASSES`**, then if still
  failing the draft is **parked** in `skills/_pending/` (inert — never applied) and a lightest-form
  lesson is saved. Every auto-author is surfaced in a report (pass **or** blocked) — nothing silent.

A Gate B parse failure / LLM error **never** blocks a turn: it is treated as *unscored* and falls
back to an advisory write with a noted error (only a real **low score** blocks, never an error).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_GATE_B_ENABLED` | `on` | Kill switch for Gate B. Off → every skill is treated as unscored/advisory (commanded and auto both write). Only `0`/`false`/`no`/`off` disables it. |
| `HOUGE_GATE_B_PASSES` | `3` | Number of independent Gate B passes averaged into the score (the ensemble that tamed single-pass noise in the spike). |
| `HOUGE_GATE_B_THRESHOLD` | `0.15` | Pass threshold on the mean score — the good/bad **separation** gap from the spike, not an absolute quality bar. |

## Self-evolution (Phase 3) — code self-write

Houge can write a **diff to his own source** to fix a bug. A `selfcode` message with **write
intent** (*"fix it so you stop asking which 猴哥"*) routes to `runSelfWrite`: Houge frames the task,
has **Codex write a diff in a fresh git worktree** (`codex exec --sandbox workspace-write`), then runs
it **autonomously** through three checkers — (1) a deterministic **protected-path check** (HARD DENY on
any gate/identity/dep/existing-test path; **not** overridable by `/approve`), (2) the **test gate**
(typecheck + test + build in the worktree), (3) an **independent Claude reviewer** (model diversity:
the writer is Codex, the checker is Claude) — with a **refine loop ≤3**. Only if all pass does Houge
**publish the diff as a branch** (`houge/selfwrite/<run-id>`) and **notify Paco**. The daemon **never
hot-swaps**: Paco merges + reloads at his leisure (the [ADR 0011](../decisions/0011-self-evolution-architecture.md)
§5 one constant). **Off by default.** Design: [ADR 0011](../decisions/0011-self-evolution-architecture.md)
§7 + [its 2026-06-25 amendment](../decisions/0011-self-evolution-architecture.md#amendment-2026-06-25-self-write-is-autonomous-to-branch-checkpoint--merge-not-approve);
spec: [Phase 3 spec](../superpowers/specs/2026-06-25-phase3-code-self-write.md). The write adapter
**reuses the `HOUGE_CODEX_*` variables** (above, in [Phase 1](#self-evolution-phase-1--code-self-diagnose)):
`HOUGE_CODEX_MODEL`, `HOUGE_CODEX_TIMEOUT_MS`, `HOUGE_CODEX_BIN`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_SELFWRITE_ENABLED` | `false` | Master switch for the **entire** code-self-write surface. Off until Paco flips it. When not truthy, a write-intent `selfcode` message **falls back to read-only diagnose** (Phase 1) — the safe direction (read before write) — so the feature ships dark and is opt-in. |
| `HOUGE_SELFWRITE_REVIEWER` | `kimi` | Which agent runs **checker 3** (the independent reviewer). `kimi` — the local `kimi-cli` agent (**default**: cheap + model-diverse from the Codex writer; the free test-gate + the human merge are the real safety net). `claude` — the Claude CLI reviewer (spike-validated GO). `codex` — an independent Codex session (fresh session + adversarial prompt). writer≠checker is preserved either way. |
| `HOUGE_CLAUDE_BIN` | — (no default) | **Absolute** path to the `claude` CLI, used by **both** the Claude reviewer and the Claude writer. **No default by design:** the launchd daemon's PATH does not include `~/.local/bin`, so `claude` is not resolvable by name — an absolute path is required (e.g. `/Users/pluo/.local/bin/claude`). If unset, whichever Claude role is selected is **disabled** (for the reviewer, set `HOUGE_SELFWRITE_REVIEWER=codex` to use the fallback). Spike-validated invocation: `claude -p` (print mode), with the prompt/task fed on **stdin**, under the daemon's restricted PATH. |
| `HOUGE_CLAUDE_TIMEOUT_MS` | `180000` | Wall-clock timeout (ms) for one Claude pass — **shared** by the reviewer and the writer. The spike measured ~7–29s for a real reviewer verdict and ~15s for a headless writer edit; the cap leaves headroom for the async ack-then-deliver UX. |
| `HOUGE_TESTGATE_TIMEOUT_MS` | `300000` | Wall-clock timeout (ms) for the whole **test gate** (typecheck + test + build) run in the worktree. A gate that exceeds it is treated as red (no publish), not a crash. |

#### Phase 3.5 — kimi reviewer backend (`HOUGE_SELFWRITE_REVIEWER=kimi`)

The **default** checker-3 backend (cheap + model-diverse from the Codex writer). The local `kimi-cli` agent, invoked headless with the adversarial prompt on **stdin** — `kimi-cli --print --quiet --final-message-only --input-format text --agent-file <no-tools agent>` — which prints the clean final assistant message (the verdict JSON) to stdout (the "To resume this session" notice goes to stderr). `--final-message-only` emits no token telemetry, so a kimi review carries **no `usage`**. The `kimi-cli` wrapper has an absolute-path interpreter shebang, so it runs under the daemon's restricted PATH with no extra PATH setup.

**Isolation (writer≠checker):** kimi-cli's *default* agent ships Shell/file tools and auto-approves them in `--print` mode, so an unconfined reviewer could read/write **any absolute path** on the host (a prompt-injection exfil/tamper surface). The reviewer is therefore pinned to a generated **no-tools agent** (`tools: []`, verified to refuse a file read) and run in a neutral temp cwd — the analogue of the Claude reviewer's tools-denied and the Codex reviewer's `--sandbox read-only`. The diff is judged purely as inline text.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_KIMI_CLI_BIN` | — (no default) | **Absolute** path to the `kimi-cli` binary (e.g. `/Users/pluo/.local/bin/kimi-cli`). **No default by design:** the daemon's PATH does not include `~/.local/bin`, so `kimi-cli` is not resolvable by name. If unset while `HOUGE_SELFWRITE_REVIEWER=kimi`, the kimi reviewer is **disabled** (clean error, no publish). |
| `HOUGE_KIMI_CLI_MODEL` | — (omitted) | Optional model override passed as `--model <m>`. When unset, `--model` is omitted and kimi-cli uses its own configured default (`kimi-for-coding`). |
| `HOUGE_KIMI_CLI_TIMEOUT_MS` | `180000` | Wall-clock timeout (ms) for one kimi pass (per attempt; retried once on a transient timeout/unparseable). A normal kimi review returns in ~7s. |

### Phase 3.1 — swappable writer + per-role models

Phase 3.1 makes the **writer** swappable too (it was hardcoded to Codex), so the heavy-token role
can sit on whichever subscription is largest. The writer is the token-heavy role (measured: Codex
writer ~200K–1.2M tokens/run, mostly cached input from agentic file-reading; Claude reviewer ~25K
in + ~1.2K out). Paco's case → `WRITER=claude` + `REVIEWER=codex` (Claude Max 5x writer + Codex Plus
reviewer); the proven default is the reverse. The deterministic protected-path guard checks the
**diff**, not who wrote it, so swapping the writer cannot widen what may land.

**Model diversity** (writer ≠ reviewer provider) is recommended and is the default. Setting both
roles to the **same provider** logs a soft warning — it is **not blocked**.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_SELFWRITE_WRITER` | `codex` | Which agent **writes the diff** (the heavy-token role). `codex` — the existing `codex exec --sandbox workspace-write` adapter (now run with `--json` so token usage is captured). `claude` — a headless agentic Claude edit: `claude -p --model <m> --permission-mode bypassPermissions --output-format json`, with the framed task on stdin and `cwd` set to the throwaway worktree (so the permission bypass is scoped to that disposable tree). The Claude writer requires `HOUGE_CLAUDE_BIN` (absolute) just like the reviewer; if unset, the Claude writer is **disabled** (clean error, no publish). |
| `HOUGE_CLAUDE_WRITER_MODEL` | `sonnet` | Claude **writer** model. Resolution: `HOUGE_CLAUDE_WRITER_MODEL` → `HOUGE_CLAUDE_MODEL` → `sonnet`. (Per-role override so the writer model can differ from the reviewer model while sharing one fallback.) |
| `HOUGE_CLAUDE_MODEL` | `sonnet` | The Claude **reviewer** model, **and** the shared fallback for the writer model above. There is **no separate `HOUGE_CLAUDE_REVIEWER_MODEL`** — the reviewer reads `HOUGE_CLAUDE_MODEL` directly (default `sonnet`; the default Opus over-thinks a large diff and times out). |

> The Claude writer and reviewer **share** `HOUGE_CLAUDE_BIN` and `HOUGE_CLAUDE_TIMEOUT_MS`. They
> differ only in model: the writer resolves `HOUGE_CLAUDE_WRITER_MODEL` (→ `HOUGE_CLAUDE_MODEL` →
> `sonnet`), the reviewer resolves `HOUGE_CLAUDE_MODEL` (→ `sonnet`).

### Phase 3.1 — LLM telemetry (the `llm_call` ledger event)

Phase 3.1 captures **real token usage at the source** for every LLM call — replacing the prior
hand-grepping of Codex rollout logs — and records it as a structured ledger event. This realizes the
backlog "LLM telemetry" item.

Each LLM call emits one **`llm_call`** ledger event (`RunStore.recordLlmCall`,
`src/run/run-store.ts`; actor `capability_runner`). Usage is normalized to one canonical shape
(`src/run/llm-usage.ts`) regardless of engine — Codex `--json` `token_count` events, Claude
`--output-format json` `usage` + `total_cost_usd`, and the kimi cheap-chain client all feed the same
`recordLlmCall`. Payload fields:

| Field | Required | Notes |
|-------|----------|-------|
| `provider` | yes | The engine (e.g. `codex`, `claude`, `kimi`, `pi`). |
| `model` | yes | The resolved model name. |
| `role` | yes | One of `writer` \| `reviewer` \| `classify` \| `frame` \| `answer`. |
| `input_tokens` | yes | Prompt/input token count. |
| `output_tokens` | yes | Output tokens (Codex includes reasoning output here). |
| `cached_input_tokens` | yes | Cached input (Claude: cache_read + cache_creation). |
| `cost_usd` | optional | Present when the provider reports it (Claude `total_cost_usd`); Codex reports no per-call cost. |
| `latency_ms` | optional | Per-call wall-clock when measured by the caller. |

**Counts/metadata ONLY — by construction.** The prompt, diff, and response bodies are **never**
passed to `recordLlmCall` and are **never** stored. The usage normalizers are tolerant: malformed or
absent usage returns `null` (no event), never throws — telemetry can never break a run.

In addition, the **`self_write_published`** event carries an optional compact **`usage_summary`**
(writer + reviewer token totals for the published run — counts/metadata only, same no-bodies rule),
so a published branch's per-role cost is visible without scanning the individual `llm_call` events.

### Phase 3.3 — interactive Telegram merge controls

The published-fix notification carries an inline keyboard — **[View diff] · [Merge & reload] ·
[Discard]** (`callback_data` = `selfwrite:<action>:<run-id>`) — so the §5 merge checkpoint moves from a
terminal `git merge` to an **authenticated Telegram tap**. The human gate is **preserved**: the daemon
merges + reloads self-authored code **only on Paco's tap**, never on its own. **Callbacks are
allowlist-authed** — the callback's `from` user is checked against the same allowlist as messages, so
**only Paco's taps act** (a non-allowed tap is rejected); the buttons are cleared after a tap and the
actions are idempotent, so a branch can't be double-merged. Design: [ADR 0011](../decisions/0011-self-evolution-architecture.md)
§5 + [its Amendment 2](../decisions/0011-self-evolution-architecture.md#amendment-2-2026-06-25-the-mergereload-checkpoint-moves-to-telegram-still-human-gated);
spec: [Phase 3 spec](../superpowers/specs/2026-06-25-phase3-code-self-write.md#phase-33--interactive-telegram-merge-controls--5-amendment).

The buttons (handled by `src/telegram/self-write-action-handler.ts` over the merge actions in
`src/capabilities/self-write-merge.ts`):

- **[View diff]** — read-only `git diff main...<branch>` (bounded; buttons left in place, repeatable).
- **[Merge & reload]** — capture the pre-merge ref → `git merge` → `npm run build` → **re-run the
  test-gate on merged `main`** → green: durable "merged, reloading…" notice, optional push, then a
  detached `launchctl kickstart` self-restart onto the new `dist/`. **POST-MERGE-VERIFY safeguard:** a
  red build or test-gate triggers an auto-revert (`git reset --hard` to the pre-merge ref) with **no
  restart and no push** — the daemon keeps running the old code, nothing landed.
- **[Discard]** — `git branch -D <branch>` (idempotent: an already-gone branch is a no-op).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_SELFWRITE_PUSH` | `false` | When truthy (`1`/`true`/`yes`/`on`), a **green** [Merge & reload] also runs `git push origin <branch>` (the merged `main`) after the merge+build+test-gate pass, before the self-restart. Default off — the merge lands locally only; a red post-merge gate never pushes. |
| `HOUGE_DAEMON_LABEL` | `com.houge.daemon` | The launchd label the self-restart kickstarts (`launchctl kickstart -k gui/$uid/<label>`). Set this only if the daemon is installed under a non-default label. |

## Telegram command reference

Natural language first: just type, and Houge classifies intent (**answer** / **research** /
**feedback** / **clarify**) — there are no `/ask`, `/research`, or `/teach` commands. Slash
commands survive only for the control/safety plane (idempotent, no run, no budget unless
noted), and `/approve` · `/deny` are **unforgeable** — never inferred from prose.

| Command | Plane | Purpose |
|---------|-------|---------|
| `/status` | control | Per-cap breaker headroom, run counts by state, last error. |
| `/run <program> [args]` | control | Escape hatch to launch a named program directly (consumes budget). |
| `/approve <id>` · `/deny <id>` | safety | Resolve a pending approval gate. Unforgeable — slash-only, never inferred. |
| `/lessons [scope]` | control | View the active lesson rows: each with its id, reuse/applied counters, `AVOID` line, and `supersedes #n` lineage. No scope → lists all scopes. |
| `/forget <scope\|id>` | control | Prune that scope's lessons, or one lesson by numeric id (a reversible status flip — rows are never deleted) and ack. |
| `/skills [scope]` | control | Read-only **viewer** of the ambient skills (name · scope · `when:` · version); regenerates `skills/REGISTRY.md`. Never invokes a skill. No scope → lists all scopes. |
| `/skills pending` | control | Read-only **viewer** of the parked (blocked auto-author) drafts under `skills/_pending/` — inert, never applied. Inspect to hand-fix + promote, or discard. |

## Global autonomy circuit-breaker

A durable cross-run **breaker** (not a throttle) over a rolling 24h window — the
safety floor for the always-on daemon. Once any cap is reached, new run admissions
are **refused** at the Gateway with a `global_budget_fuse` ledger event and exactly
one deduped Telegram alert per fuse episode; admissions re-arm automatically as the
window clears. Status/approve/deny are never blocked. Rationale and design:
[ADR 0003](../decisions/0003-global-budget-breaker.md).

| Variable | Default | Axis | Protects against |
|----------|---------|------|------------------|
| `HOUGE_GLOBAL_MAX_RUNS_24H` | `200` | Volume (how many jobs) | Looping schedules, re-enqueue bugs, command floods. |
| `HOUGE_GLOBAL_MAX_TOOL_CALLS_24H` | `1000` | Cost (compute/$) | Aggregate LLM/tool spend across all runs — e.g. a single run that burns thousands of calls. |
| `HOUGE_GLOBAL_MAX_GATED_ATTEMPTS_24H` | `100` | Risk (dangerous intent) | Repeated attempts at approval-requiring actions (bad lesson, injection, loop) and the approval-prompt spam they cause. |

Defaults live in `DEFAULT_GLOBAL_BUDGET_CAPS` (`src/budget/global-budget-ledger.ts`);
a missing or non-numeric override falls back to the default. `/status` surfaces
per-cap headroom (used/limit/remaining), run counts by state, and the last error.
