# Houge

Houge is a Telegram-first ChatOps harness and autonomous worker orchestrator: it turns chat and CLI commands into bounded, auditable, policy-governed task runs.

## Status

Milestones 0–2 are complete, plus the Milestone 3 always-on daemon and a global
autonomy budget breaker — 237 tests, zero runtime dependencies (Node 25, TypeScript,
Vitest, the built-in `node:sqlite`):

- **Milestone 0** — shared schemas, deterministic state machines (Run / Approval / ToolCall / Schedule), Run Ledger, idempotency.
- **Milestone 1** — local run engine: SQLite-backed runs, worker leases, Task Contracts, Capability Policy + budget ledger, a read-only file capability, sourced reports, fixture evals.
- **Milestone 2** — Telegram gateway (long-poll command intake, allowlist auth), `/ask` `/run` `/status` `/approve` `/deny`, durable approvals, Notification Outbox.
- **Milestone 3 (in progress)** — always-on daemon: `houge telegram-poll` (no `--once`) runs a continuous long-poll loop answering commands in near-real-time, supervised by launchd (graceful shutdown, single-instance guard, heartbeat). The schedule trigger is the remaining M3 piece.
- **`/ask` LLM** — a pluggable provider registry with an ordered fallback chain (`pi` CLI → `kimi-api`); see [LLM providers](#llm-providers).
- **Autonomy guardrails** — a global 24h budget circuit-breaker bounds runs / tool-calls / gated-attempts; see [Global autonomy circuit-breaker](#global-autonomy-circuit-breaker).

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

## LLM providers

`/ask` resolves an ordered provider chain with automatic fallback (first `ok`
wins; `unavailable`/error/timeout fall through). Default chain `pi,kimi-api`:
`pi` (hardened single-shot CLI, tools disabled) and `kimi-api` (OpenAI-compatible
HTTP). `/ask` answers in Houge's voice — a projection of its Core Identity
([memory/core/houge.md](memory/core/houge.md)): the cheerful, capable 猴哥, but
*inference only* (it answers; it doesn't act). Override the persona with
`HOUGE_ASK_SYSTEM_PROMPT`.

→ Every provider/model/timeout/key variable: [configuration reference](docs/reference/configuration.md#llm-provider-chain-powers-ask).
The inference-vs-agentic safety boundary (why a tools-disabled `pi` is `external_read`):
[ADR 0002](docs/decisions/0002-pi-as-agent-runtime.md). Identity & memory direction:
[ADR 0005](docs/decisions/0005-agent-memory-architecture.md).

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
