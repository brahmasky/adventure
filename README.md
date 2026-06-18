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
wins; `unavailable`/error/timeout fall through). Default chain `pi,kimi-api`:
`pi` (hardened single-shot CLI, tools disabled) and `kimi-api` (OpenAI-compatible
HTTP). `/ask` uses a neutral system prompt so answers aren't skewed toward a coding
framing.

→ Every provider/model/timeout/key variable: [configuration reference](docs/reference/configuration.md#llm-provider-chain-powers-ask).
The inference-vs-agentic safety boundary (why a tools-disabled `pi` is `external_read`):
[ADR 0002](docs/decisions/0002-pi-as-agent-runtime.md).

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
- [Architecture decisions](docs/decisions/README.md) — the *why* behind significant choices (ADRs).
- [Design spec](docs/superpowers/specs/2026-05-25-houge-chatops-orchestrator-design.md) — architecture and milestone plan.
- [CONTRIBUTING.md](CONTRIBUTING.md) — documentation convention and definition of done (tests **and** a live run).
- [AGENTS.md](AGENTS.md) — coding, safety, and workflow rules. [CONTEXT.md](CONTEXT.md) — domain language.
