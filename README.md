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

## Key Documents

- [AGENTS.md](AGENTS.md): project workflow, safety, and coding guidelines.
- [CONTEXT.md](CONTEXT.md): Houge domain language.
- [Houge design spec](docs/superpowers/specs/2026-05-25-houge-chatops-orchestrator-design.md): current architecture and milestone plan.
