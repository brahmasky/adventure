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

## LLM provider chain (powers `/ask`)

See [ADR 0002](../decisions/0002-pi-as-agent-runtime.md) for the inference-vs-agentic
policy behind the `pi` provider.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_LLM_PROVIDERS` | `pi,kimi-api` | Ordered, comma-separated chain with automatic fallback (first success wins; unavailable/error/timeout falls through). Known providers: `pi` (hardened single-shot CLI), `kimi-api` (OpenAI-compatible HTTP). The singular `HOUGE_LLM_PROVIDER` is ignored when this plural is set. |
| `HOUGE_LLM_MODEL_PI` | unset → pi's own configured model | Model is configured **per provider** (namespaces differ). Set this only to make Houge override pi's own choice. |
| `HOUGE_LLM_MODEL_KIMI` | `moonshot-v1-auto` (stable alias) | A model your `KIMI_API_KEY` can access (`GET /v1/models`). |
| `HOUGE_ASK_SYSTEM_PROMPT` | built-in neutral prompt | `/ask` is plain question answering, so Houge replaces pi's default *coding-assistant* persona (and seeds the API system message) with a neutral one. Override the whole prompt here. |
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
