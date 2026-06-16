# Houge

Houge is a Telegram-first ChatOps harness and autonomous worker orchestrator. The current project state is design and discovery only: there is no runtime scaffold, package manifest, test framework, or Git repository metadata yet.

## Current Phase

Milestone -1 is in progress. This phase validates implementation assumptions before Milestone 0 creates schemas, state machines, migrations, and tests.

Validated so far:

- Global `pi` CLI is available at `/opt/homebrew/bin/pi`.
- `pi --version` returned `0.75.5`.
- `pi-chat` source is `https://github.com/earendil-works/pi-chat`.
- A project-local `pi-chat` install was tested and removed because it added about 218 MB under `.pi/`.

## Dependency Guidance

Use the global `pi` executable for discovery and smoke tests. Do not rely on global Pi settings or sessions for Houge runs.

For project-scoped Pi commands, prefer:

```bash
PI_CODING_AGENT_DIR=/Users/pluo/Projects/adventure/.pi/agent pi --no-session ...
```

`pi-chat` is optional and should not be installed by default. Do not install it globally for Houge unless a later milestone explicitly accepts that dependency. If a future spike needs it, install it project-locally, evaluate it, and remove it afterward unless the project decides to keep it:

```bash
pi install -l https://github.com/earendil-works/pi-chat
```

Project-local Pi state such as `.pi/` should be treated as generated dependency/cache data, not source.

## LLM providers

`/ask` resolves an ordered provider chain with automatic fallback (first `ok`
wins; `unavailable`/error/timeout fall through). Known providers: `pi` (hardened
single-shot CLI), `kimi-api` (OpenAI-compatible HTTP), `anthropic` (HTTP).

- **Default chain:** `pi,kimi-api` (`HOUGE_LLM_PROVIDERS` unset). `anthropic`
  stays available but is no longer default.
- **Config:** see `.env.example` for `HOUGE_LLM_PROVIDERS`, `HOUGE_LLM_MODEL[_PI/_KIMI]`,
  `HOUGE_LLM_TIMEOUT_MS[_PI/_KIMI]`, `KIMI_API_KEY`, `HOUGE_KIMI_BASE_URL`,
  `HOUGE_PI_ENV_PASSTHROUGH`, `ANTHROPIC_API_KEY`. `HOUGE_LLM_PROVIDER` (singular)
  is ignored when the plural `HOUGE_LLM_PROVIDERS` is set.
- **Runner timeout coupling:** the CapabilityRunner's `Promise.race` `timeout_ms`
  is the only enforced wall-clock bound (the contract's `time_minutes` is not
  enforced). It is *derived* from the chain — `sum(per-provider timeouts) +
  buffer` (`resolveChainBudgetMs` + `RUNNER_TIMEOUT_BUFFER_MS`; default
  60s + 30s + 15s = 105s) — so a healthy chain that legitimately falls through
  every provider is never killed mid-flight.

### Policy amendment (ratified)

Single-shot, tools-disabled, env-allowlisted, killable CLI inference (`pi`) is
classified `external_read` and is allowed ungated. Full agentic
`coding_agent_cli` delegation (tools enabled) remains denied until V2
containment.

## Key Documents

- [AGENTS.md](AGENTS.md): project workflow, safety, and coding guidelines.
- [CONTEXT.md](CONTEXT.md): Houge domain language.
- [Houge design spec](docs/superpowers/specs/2026-05-25-houge-chatops-orchestrator-design.md): current architecture and milestone plan.
