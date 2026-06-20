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
| `HOUGE_LLM_PROVIDERS` | `pi,kimi-api` | Ordered, comma-separated chain with automatic fallback (first success wins; unavailable/error/timeout falls through). Known providers: `pi` (hardened single-shot CLI), `kimi-api` (OpenAI-compatible HTTP). The singular `HOUGE_LLM_PROVIDER` is ignored when this plural is set. |
| `HOUGE_LLM_MODEL_PI` | unset → pi's own configured model | Model is configured **per provider** (namespaces differ). Set this only to make Houge override pi's own choice. |
| `HOUGE_LLM_MODEL_KIMI` | `moonshot-v1-auto` (stable alias) | A model your `KIMI_API_KEY` can access (`GET /v1/models`). |
| `HOUGE_ASK_SYSTEM_PROMPT` | composed from `memory/` + `lesson_blocks` | The **answer**-path system prompt. When unset it is **composed** (identity + answer discipline + the `ask` scope's lesson block + guardrails — see [Learning](#learning--conversational-distillation-and-lesson_blocks) below), replacing pi's default *coding-assistant* persona. Set this to override the whole prompt. |
| `HOUGE_LLM_TIMEOUT_MS` | — | Fallback per-provider wall-clock timeout (ms) for any provider without a specific one. |
| `HOUGE_LLM_TIMEOUT_MS_PI` | `60000` | pi timeout (ms). |
| `HOUGE_LLM_TIMEOUT_MS_KIMI` | `30000` | kimi timeout (ms). |

> The CapabilityRunner's enforced wall-clock cap is **derived** from these:
> `sum(per-provider timeouts) + 15000` buffer. With defaults (pi 60s + kimi 30s)
> the runner cap is 105s — so a healthy chain that legitimately falls through every
> provider is never killed mid-flight.

### pi CLI provider

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_PI_ENV_PASSTHROUGH` | — | Extra env var **names** (comma-separated) to pass through to the pi child. The child runs with a minimal allowlist (`PATH, HOME, TERM, LANG, USER`) so the attacker-controlled question never sees the Telegram token or unrelated keys; add the var pi needs for auth here. |

### Kimi API provider

| Variable | Default | Purpose |
|----------|---------|---------|
| `KIMI_API_KEY` | — | Secret. Enables the `kimi-api` provider; if unset the provider reports `unavailable` and the chain falls through. |
| `HOUGE_KIMI_BASE_URL` | `https://api.moonshot.ai` | Base URL for the OpenAI-compatible endpoint. |

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
scope's lesson block steers both. Telegram link previews are disabled to cut the outbound
exfil leg; the URLs read are recorded in the ledger (`web_search_performed`).

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

## Learning — conversational distillation and `lesson_blocks`

Every LLM-touching surface (the **answer** path, the research synthesis + critique, the
feedback distiller) builds its system prompt from one place — the **composer**
(`src/prompt/composer.ts`): Core Identity (`memory/core/houge.md`, loaded not duplicated) +
a per-surface discipline + the relevant **scope's lesson block** + guardrails.
Design: [ADR 0009](../decisions/0009-architecture-coherence.md); interaction model:
[ADR 0010](../decisions/0010-natural-language-intent-layer.md); learning loop:
[ADR 0007](../decisions/0007-learning-loop.md).

**Learning is conversational, not a command.** When the user reacts to a prior answer,
Houge **always re-answers** honoring the feedback, and **only when the feedback generalizes
into a clear, reusable preference** it **silently distills** it into a lesson — no toast, no
approval prompt. The distiller treats the *user's* feedback as the instruction and the prior
answer as reference only, so the untrusted-data wall holds: Houge never adopts an instruction
embedded in answer content as a lesson. This supersedes ADR 0007's `/teach` + per-lesson
approval gate **for user-sourced lessons** — trading the upfront gate for a high-precision
threshold plus inspect-and-undo.

Long-term lessons live in the SQLite table
`lesson_blocks(scope, block, char_cap, updated_at)` — **one char-capped, edit-in-place
block per scope** (not the old file-based `memory/skills/*.md` store, which is removed).
Scope is inferred from the reacted-to turn's intent: answer → `ask`, research → `research`.

| Column | Default | Purpose |
|--------|---------|---------|
| `scope` | — | The lesson namespace (`ask`, `research`, …). The composer folds this scope's block into future runs on that surface. |
| `block` | (empty) | The current consolidated lesson text for the scope, edited in place as new preferences arrive. |
| `char_cap` | `1200` | Soft ceiling on `block`. When the block exceeds its cap, an **LLM rewrite pass consolidates** it — deduping into the strongest rules — instead of growing unbounded. |
| `updated_at` | — | Last write timestamp. |

Inspect and undo with the slash-only control commands `/lessons` and `/forget` (see the
[command reference](#telegram-command-reference)). `memory/core/houge.md` is committed (his
spine); the `lesson_blocks` table is local runtime state. The only prompt knob is
`HOUGE_ASK_SYSTEM_PROMPT` (in the [LLM provider chain](#llm-provider-chain-powers-cognition)
table) — an escape hatch to override the composed **answer**-path prompt wholesale.

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
| `/lessons [scope]` | control | View the lesson block(s): the raw `block` plus its char-count/cap so consolidation pressure is visible. No scope → lists all scopes. |
| `/forget <scope>` | control | Clear that scope's lesson block and ack. |

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
