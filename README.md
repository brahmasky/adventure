# Houge

Houge is a Telegram-first ChatOps harness and autonomous worker orchestrator: it turns chat and CLI commands into bounded, auditable, policy-governed task runs.

## Status

Milestones 0–2 are implemented and tested (209 tests, zero runtime dependencies — Node 25, TypeScript, Vitest, the built-in `node:sqlite`):

- **Milestone 0** — shared schemas, deterministic state machines (Run / Approval / ToolCall / Schedule), Run Ledger, idempotency.
- **Milestone 1** — local run engine: SQLite-backed runs, worker leases, Task Contracts, Capability Policy + budget ledger, a read-only file capability, sourced reports, fixture evals.
- **Milestone 2** — Telegram gateway (long-poll command intake, allowlist auth), `/ask` `/run` `/status` `/approve` `/deny`, durable approvals, Notification Outbox.
- **`/ask` LLM** — a pluggable provider registry with an ordered fallback chain (`pi` CLI → `kimi-api`); see [LLM providers](#llm-providers).

Telegram currently runs as a **one-shot poll** (`telegram-poll --once`); the continuous always-on daemon is Milestone 3.

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
npm run houge -- telegram-poll --once  # process pending Telegram commands
```

Configuration (Telegram token, LLM keys, model/timeout overrides) is read from a gitignored `.env` — copy `.env.example` and fill it in. Set `HOUGE_ENV_FILE` to point every git worktree at one shared `.env`.

## LLM providers

`/ask` resolves an ordered provider chain with automatic fallback (first `ok`
wins; `unavailable`/error/timeout fall through). Known providers: `pi` (hardened
single-shot CLI), `kimi-api` (OpenAI-compatible HTTP).

- **Default chain:** `pi,kimi-api` (`HOUGE_LLM_PROVIDERS` unset).
- **Config:** see `.env.example` for `HOUGE_LLM_PROVIDERS`, `HOUGE_LLM_MODEL[_PI/_KIMI]`,
  `HOUGE_LLM_TIMEOUT_MS[_PI/_KIMI]`, `KIMI_API_KEY`, `HOUGE_KIMI_BASE_URL`,
  `HOUGE_PI_ENV_PASSTHROUGH`, `HOUGE_ASK_SYSTEM_PROMPT`. `HOUGE_LLM_PROVIDER` (singular)
  is ignored when the plural `HOUGE_LLM_PROVIDERS` is set.
- **Neutral `/ask` persona:** `/ask` is plain question answering, so Houge sends a
  neutral system prompt that *replaces* pi's default coding-assistant persona (and
  seeds the API providers' system message) — answers stay direct and aren't skewed
  toward a coding framing. Override the whole prompt with `HOUGE_ASK_SYSTEM_PROMPT`.
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
