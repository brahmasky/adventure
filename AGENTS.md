# Houge — agent rules

Houge (猴哥) is an autonomous self-evolving, Telegram-first daemon on Paco's Mac mini. Node + TypeScript, SQLite, zero runtime dependencies. Claude is the build-orchestrator seat only. Global rules: `~/.claude/CLAUDE.md`; this file overrides it.

## Read first
1. `tasks/todo.md` — the top "CURRENT SYSTEM STATE" block only (the rest is shipped history).
2. `tasks/lessons.md` — orchestration mistakes and the rules that prevent them. Review at session start.
3. `docs/ROADMAP.md` — charter, locked decisions, sequenced next builds.
4. `docs/decisions/README.md` — ADR index. Read the ADR before touching the area it governs.
5. `CONTEXT.md` — domain terms (run, ledger, contract, invariant, …). Use these words.
6. `sessions.md` — one arc entry per build session, newest last. Append one when shipping.
7. `docs/reference/configuration.md` — every env var. Documented there, linked from README, never duplicated.

## Invariants (locked; change only by a new ADR and Paco's hand)
- `dependencies: {}` stays empty (ADR 0001, 0016). Node stdlib plus devDeps only.
- Claude may run in the runtime only as a subscription model through omp (ADR 0032, D7), never through a metered API or the Claude Code CLI. Default LLM chains are flat-rate subscription legs only: omp under profile `houge`, agy-cli for voice, codex for the self-write writer. Metered APIs are the capped escape hatch (ADR 0019). Jev (TypeSafe System One), a non-generative typed decider, is one rung of the decision ladder (ADR 0033, ADR 0034): what it may cause depends on what it read — over tool output it only tightens or proposes, over Paco's own message it may cause a reversible, announced effect (a lane reply, the memory shortcut's lesson save) — it never gates an action (with one named exception, ADR 0034 2.4), and every outage reaches Paco.
- Two hard lines: no adverse impact to Houge's own operation; no secret leak. The main process holds no ambient credentials (ADR 0015).
- Code owns the gates, the model composes between them (ADR 0013). Routing, retries, status codes, deterministic transforms: plain code. Judgment calls only: LLM.
- Protected surface (`src/capabilities/self-write-guard.ts`, `PROTECTED_DIRS` / `PROTECTED_FILES`): `AGENTS.md`, `docs/decisions/`, `src/policy/`, `src/grow`, gate machinery, kill switch. Paco's hand only, never a self-write.
- Kernel and grow zone (ADR 0035). New capability starts in the grow zone (Houge's own git repo at `HOUGE_GROW_DIR`), written by Houge through `grow_submit`. It moves into `src/` only when it fails the kernel test: can this file weaken a floor, leak a secret, or stop Houge running? The orchestrator writes no grow-zone item except the exemplars in `grow-seed/`.
- Repo is PUBLIC (`brahmasky/adventure`). A push is publishing.

## Commands
```bash
npm run typecheck && npm test && npm run build   # hermetic: real SQLite; clock, Telegram, subprocesses stubbed
npm run houge -- <cmd>                            # live CLI against the real DB and .env
node scripts/live-gate-<name>.mjs                 # live gate; every shipped slice gets one
```
- Definition of done = tests green **and** a live run shown (`CONTRIBUTING.md`). A wiring bug once survived 225 green tests.
- Worktrees under `.worktrees/` have no `.env`: run `HOUGE_ENV_FILE=/abs/path/to/main/checkout/.env node scripts/live-gate-<name>.mjs`. Gate scripts import `../dist/`, so build the branch first.
- Daemon temp files (media downloads, agy workdirs, codex out-files) live under `~/Library/Caches/houge-daemon` (`HOUGE_DAEMON_TMP_DIR`), never `os.tmpdir()`; `children/` under it is every CLI child's TMPDIR and `cleanroom/` holds sealed-run rooms — nothing else writes there. `scripts/live-gate-media.mjs` points that at its own temp dir, so it can run alongside vitest.
- Daemon runs the built JS: `launchctl kickstart -k gui/$(id -u)/com.houge.daemon` (`deploy/launchd/README.md`). Rebuilding `dist/` on main changes what the running daemon loads next (a changed `omp/shell-wrapper.sh` fails every turn closed with `wrapper_mismatch` until a restart), so a merge's rebuild is followed by a kickstart, not left "owed". Revive and `/rearm` are Paco's actions. A silent daemon may be parked on purpose: check `houge.parked` / `houge.kill` first.
- Codex: `codex exec … < /dev/null -o <file>` (a non-TTY hangs on stdin otherwise). `-s read-only` cannot run vitest; use `-s workspace-write` when the pass must run tests. `codex review` rejects a prompt together with `--base`: use `codex exec` and "run git diff <base>".

## Build flow
The global flow applies in full. Houge specifics:
- Spec review probes the live binary / DB / env before trusting the spec text.
- Docs sync on ship is a re-read, not an append: grep README, CONTEXT, `docs/reference/*` (`configuration.md`, `decision-map.md`, `jev-decision-layer.md`), `deploy/launchd/README.md` and ROADMAP for every command, env var, kind, entry, ADR and file the slice touched, and fix each claim it made false. Then: ADR amendment + index row, `tasks/todo.md` state block, `tasks/lessons.md`, `sessions.md` entry. Placement rules: `CONTRIBUTING.md`. `tests/docs/` checks the mechanical parity (commands, env vars, ladder entries, ADR index); the final review checks the rest ("which doc claim did this branch make false?").
- A decision lands in code and ADR together. A decision made in chat goes into `tasks/todo.md` at once as "decided, not shipped", and the ADR says "to be changed, spec X" until the code ships; the ADR amendment merges in the same branch as the code. Every spec names the ADR rules it changes and greps the code for what the new rule forbids. A checkable ADR rule has a test in `tests/adr/` named after the rule id; changing the rule changes the test in the same commit. The final review asks: "does any ADR rule now contradict the code, or another ADR?"
- Flow by zone. Kernel (the protected surface, `src/omp`, `src/policy`, `src/decisions`, `src/grow`, and anything an ADR rule names): the global flow in full. Other `src/` code: tests, one different-model review, live gate; a spec and ADR only when a rule changes. Grow zone: no build flow; the door's checks are the gate.
- Commits land on `main` (direct, or a PR for a multi-task slice). One concern per commit, stage by name.
- Rebuild `dist/` after merge.

## Autonomy (overrides to `~/.claude/standards/automation-contract.md`)
Default is run-to-completion. Paco's touchpoints per slice: approve scope, approve the reviewed spec, sign ADR. Houge-specific tier moves:
- **Tier A (run):** push to `main` once every gate is green; protected-surface edits that implement an approved spec (the spec approval is Paco's hand); live gates that message Paco's own Telegram chat (inside the test surface); drafting ADR amendments, `tasks/todo.md`, `sessions.md`, `tasks/lessons.md`; `launchctl kickstart` after a merge whose reviews and gates are green and whose `dist/` is rebuilt (Paco 2026-10-29) — first check `houge.parked` / `houge.kill` and that no run is in flight (wait for it otherwise), then verify the new pid and the boot migrations, and report it.
- **Tier B (checkpoint):** a live gate that writes to a third-party service Houge does not own; a spec whose reviews disagree on a locked rule (present both readings with a recommendation, then wait).
- **Tier C (Paco decides):** changing what an invariant or ADR *means*; accepting a residual a probe could not close (e.g. a sealed-room boundary left open); any other `launchctl kickstart` (no green merge behind it, a parked or killed daemon), revive, `/rearm`; anything on a metered API; `dependencies` leaving `{}`.
- **Model diversity here:** orchestrator fixed per session; `spec-review-senior` runs as a subagent on a model other than the orchestrator **and** codex; task reviewers ≠ implementer; final whole-branch review on the most capable non-orchestrator model + codex whole-diff. Every dispatch names its `model`. A same-model review is written as such in the report.

## Code
- Functions under 50 lines (reviewers enforce it).
- Match surrounding style. Every changed line traces to the request. Remove only orphans your own change created; mention unrelated dead code and leave it.
- Two contradicting patterns in the codebase: pick the more recent or better tested, say why, flag the other. A blend of both is worse than either.
- Handle errors explicitly. No silent failure.
- Telegram output goes through the rich renderer, never plain text.
- Tests live in `tests/<area>/` mirroring `src/`; `tests/adr/` (ADR conformance) and `tests/docs/` (docs parity) are the two areas that do not mirror it. Each test encodes why the behaviour matters: a test that still passes when the business logic changes is wrong.

## Reporting
State assumptions before building; when readings differ materially, ask. Fail loud: "tests pass" only with none skipped, "done" only after the live run, uncertainty surfaced not hidden. Checkpoint after each step: done, verified, left.
