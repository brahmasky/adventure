# Contributing to Houge

Detailed coding, safety, and workflow rules live in [AGENTS.md](AGENTS.md); domain
language in [CONTEXT.md](CONTEXT.md). This file covers two conventions that keep the
project legible as it grows and goes public: **where documentation goes**, and **what
"done" means**.

## Documentation convention — detail lives in the layer that matches its audience

The README is a **front door**, not a manual. Put each kind of information in its
layer, and have the README *link* to the rest:

| Layer | Holds | Audience |
|-------|-------|----------|
| `README.md` | What Houge is, status, quickstart, a Documentation index. **No low-level tables.** | First-time visitor |
| [`docs/reference/`](docs/reference/) | Exhaustive parameter catalogs — every env var, default, purpose ([configuration.md](docs/reference/configuration.md)). | Operator looking something up |
| [`docs/decisions/`](docs/decisions/) | Architecture Decision Records — the **why** behind significant choices. | Collaborator / future-you |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | The living architecture & milestone spec. | Contributor |
| `.env.example` | Terse copy-paste config template. | Anyone setting up |

**Rule:** a configuration parameter is documented in `docs/reference/configuration.md`
(README links to it, never duplicates the table). A significant or non-obvious
decision — architecture, a security trade-off, a default that needs justifying — gets
an **ADR**. Don't bury these in the README, and don't leave them only in commit
messages or chat.

### Architecture Decision Records (ADRs)

One decision per file, append-only: `Context → Decision → Consequences → Alternatives`.
To change a decision, write a new ADR that **supersedes** the old one (flip its
status) — never rewrite history. Copy [`docs/decisions/0000-template.md`](docs/decisions/0000-template.md)
and add a row to the [ADR index](docs/decisions/README.md). Write one when a reviewer
would reasonably ask "why is it built this way?".

## Definition of done — tests **and** a live run

`npm test` is hermetic: it proves the *logic* against real SQLite but stubs the clock,
Telegram, and subprocesses — so it does **not** prove the pieces are wired together.
A goal is done only when **both** hold:

1. `npm run typecheck` clean, `npm test` green, `npm run build` succeeds.
2. A **live end-to-end run** demonstrates the user-facing behavior — via Telegram when
   the feature is bot-facing, otherwise a live CLI run (`npm run houge -- …`) against a
   real on-disk DB with real env. Show the result.

This rule exists because it has already paid off: a real Gateway↔poll-runner wiring bug
survived 225 green unit tests and was caught only by the live run (see
[ADR 0003](docs/decisions/0003-global-budget-breaker.md)). Prefer a live run over
adding yet another hermetic test for integration seams.

## Working rhythm

Plan → spec → TDD → **live** verification. Keep changes minimal and idiomatic to the
surrounding code; zero runtime dependencies is a deliberate constraint (see
[ADR 0001](docs/decisions/0001-deterministic-harness-governs-everything.md)).
