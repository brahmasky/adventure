# Houge

Houge (猴哥) is an **autonomous self-evolving agent**, not a chatbot. He lives as an always-on
Telegram-first daemon on Paco's Mac mini and turns plain language into bounded, auditable,
policy-governed task runs. He **improves himself**: he authors his own skills, learns lessons from
feedback, diagnoses his own source and writes his own code fixes. Mechanical safety nets, not human
approval, protect the two hard lines: *(a) no adverse impact to his own operation, (b) no leaking
secrets*. You talk to Houge the way you talk to Claude Code: plain language in, and the agent picks
its own steps. Slash commands survive only for the control and safety plane
([ADR 0010](docs/decisions/0010-natural-language-intent-layer.md)).

## Status

The foundation (state machines, run ledger, Telegram gateway, launchd daemon, global budget breaker)
and the **self-evolution spine** are complete. The core engine is now the **omp runtime**
([ADR 0028](docs/decisions/0028-omp-runtime.md), sub-project 1 of 4): about 2,870 hermetic tests,
zero runtime dependencies (Node 25, TypeScript, Vitest, the built-in `node:sqlite`).

- **An agent with real tools.** Every chat gets one supervised omp planner (Claude on subscription
  OAuth; the model per turn comes from code-owned role lists resolved against omp's catalog). It reads, edits and writes files on the mini, runs shell commands, and calls Houge's own
  tools through a daemon-side bridge. The old inner loop, the intent classifier and the JSON action
  protocol are gone.
- **Code-owned floors around it.** A macOS Seatbelt sandbox and a policy hook keep secrets and
  Houge's own files out of reach (floor A). Pushes, posts, sends and destructive deletes wait for
  Paco's `/approve` tap (floor B). Untrusted web and mail bytes still pass through a quarantined
  reader before the planner sees them.
- **Self-evolution, proven live.** 13+ merged self-writes: Codex writes a diff in a fresh worktree →
  protected-path guard → test gate → independent reviewer → auto-published branch → Paco's
  [Merge & reload] tap ([ADR 0011](docs/decisions/0011-self-evolution-architecture.md)).
- **The eval loop** ([ADR 0012](docs/decisions/0012-self-evolution-spine-closed-loop.md)): 0–3
  session ratings, per-turn attribution, reconcile-on-write, reuse value and decay.
- **Memory Houge owns:** lessons, skills, episodic facts and wiki pages, folded into each turn by
  the daemon. omp owns the conversation transcript, which survives restarts.

**What's next:** SP2 (Paco's personal tools), SP3 (auth broker, a separate macOS user for the
planner, a quota invariant) and SP4 (self-evolution v2). The sequence and current state live in
[docs/ROADMAP.md](docs/ROADMAP.md).

## Quick start

```bash
npm install
npm run build                          # tsc → dist/, then copies the omp assets (see Operations)
npm test                               # vitest, hermetic: no real omp, agy or Telegram
npm run typecheck

# CLI
npm run houge -- status
npm run houge -- run research-brief "compare gateway designs"
npm run houge -- telegram-poll --once  # process pending Telegram messages once

# Always-on daemon. Run the built JS so signals reach it; deploy under launchd
# (deploy/launchd/README.md).
node dist/cli.js telegram-poll
```

Configuration (Telegram token, seat models, feature flags) is read from a gitignored `.env`: copy
`.env.example` and fill it in. Every variable, its default and its purpose is in
[docs/reference/configuration.md](docs/reference/configuration.md); this README does not repeat them.
Chat turns also need omp installed and logged in (see [Operations](#operations)).

## Architecture

```
Telegram ──long-poll──▶ houge daemon (launchd; ledger, scheduler, sweeps, approvals, outbox)
                          │
                          ├─ turn ─▶ PlannerSupervisor (one per chat)
                          │            └─ omp planner, RPC mode, under sandbox-exec (planner.sb)
                          │                 built-ins read / edit / write ── policy hook ─┐
                          │                 Houge tool stubs (bash + 12) ────────────────┤ Unix socket
                          │                                                              ▼
                          │            bridge ─▶ CapabilityRunner (contract, budget, /approve, ledger) ─▶ adapters
                          │                        bash ─▶ shell wrapper under sandbox-exec (shell.sb)
                          │                        web_search · http_fetch · gmail_read · google_api ─▶ quarantined reader
                          │
                          ├─ one-shot omp seats: reader, photo, ticks, idea-panel judges + chair, self-write reviewer
                          ├─ agy-cli: voice transcription (omp cannot carry audio)
                          └─ codex exec: self-write writer and the read-only self-diagnose consult
```

- **The daemon** owns everything durable: the SQLite run ledger, contracts, budgets, approvals,
  the notification outbox, schedules, the invariant sweep and the kill switch. It holds no ambient
  credentials ([ADR 0015](docs/decisions/0015-secrets-firewall.md)).
- **The planner** is omp (`@oh-my-pi/pi-coding-agent`), with no version pin, run under its own
  profile `houge`. It loads exactly one extension, `dist/omp/extension/houge.js`, which installs the
  policy hook and registers one stub per Houge tool. The stubs hold no logic: each call crosses the
  bridge, and the daemon runs it.
- **The bridge** is a per-child Unix socket. Its authority (run, lease, contract, budget) is
  server-owned: the child sends a tool name and input, never a run id. Every Houge tool, `bash`
  included, executes daemon-side through `CapabilityRunner`, so contract, budget, approval and ledger
  apply to all of them ([ADR 0013](docs/decisions/0013-llm-inner-composition.md)).
- **One-shot seats** are tool-less, sessionless, extension-less omp spawns, one per call.

### How a turn runs

1. A message passes the Telegram allowlist and becomes one `turn` run (idempotent, with its own
   contract). A voice note is first transcribed on agy; a photo is read by the omp photo seat behind
   the reader wall, and its digest joins the caption.
2. The poll loop hands the run to the chat's `PlannerSupervisor` and goes back to polling. This
   **detached turn** is what lets `/approve`, `/kill` and a second message land while a turn runs.
3. The supervisor makes sure a planner child is up: omp answers with a version, Seatbelt profiles
   rendered, system prompt written (identity, discipline, the `ask` lessons, skills), bridge socket
   minted. A child counts as started only after the bridge has served it the tool manifest within
   15 s. `open_session` resumes the chat's transcript. A changed lesson, identity or skill restarts
   the child at the next idle boundary.
4. The daemon prepends a `[context]` block (episodic facts and wiki pages) to the prompt and
   records what it applied, so rating attribution still works.
5. omp runs its own agent loop. Built-in file calls are gated by the policy hook; Houge tool calls
   cross the bridge. A model error walks the routed role's candidate list, then steps up a role (Fast → Default →
   Thinking); an unknown model string fails at spawn and the next candidate is spawned instead.
6. A message that arrives mid-turn is steered into the live turn, and Paco gets one reply. Media and
   schedule fires never steer: each queues as its own turn.
7. At `agent_end` the reply goes out through the rich renderer. A reply ending in
   `[[attach: <path>]]` under the chat's workspace sends that file as a document. A turn deadline
   (paused while a card awaits `/approve`) and a frame-idle watchdog bound every turn.

### Tools

The planner has omp's `read`, `edit` and `write` built-ins and these Houge tools, each one JSON
declaration under `src/omp/tools/` plus a daemon-side adapter:

| Tool | What it does |
|------|--------------|
| `bash` | A shell command on the mini, run daemon-side under its own Seatbelt profile with resource limits; output capped at 32 KB. Matched external writes and destructive deletes wait for `/approve`. |
| `web_search` · `http_fetch` | Live web search (Tavily/Firecrawl chain) and an SSRF-hardened single-URL GET ([ADR 0006](docs/decisions/0006-web-read-capability.md)). Both return a reader digest. |
| `gmail_read` · `google_api` | Houge's own Gmail, read-only ([ADR 0025](docs/decisions/0025-google-api-surface.md)). Both return a reader digest. |
| `to_local_time` | Deterministic timezone conversion with code-computed today/tomorrow labels. |
| `lesson_write` | Distil Paco's correction into a durable lesson. |
| `schedule_task` | Create, list, update or cancel this chat's schedules ([ADR 0017](docs/decisions/0017-scheduler.md)). |
| `wiki_build` · `wiki_refine` | Save or improve a durable knowledge page ([ADR 0020](docs/decisions/0020-llm-wiki.md)). |
| `self_diagnose` · `self_write_propose` | Read Houge's own source, or propose a code change through the self-write pipeline. Both run in the background and end the turn. |
| `skill_author` | Author or refine a skill (Gate A routing, Gate B verification). Runs in the background. |

The tool-to-policy mapping is code-owned and protected (`src/omp/capability-map.ts`): a
declaration describes a tool but can never choose its policy class. Some tools are armed by flags
(see [configuration](docs/reference/configuration.md)). The money-track tools (`bounty_scan`,
`project_*`, `external_work`) and `llm_answer` were deleted with the cutover
([ADR 0022](docs/decisions/0022-money-fork-reopened.md), [0023](docs/decisions/0023-external-workspace.md)
amendments).

## Models and seats

Every LLM call runs on **subscription OAuth**; no metered API sits on any default chain
([ADR 0019](docs/decisions/0019-metered-ceiling.md) amendment: the $ ceiling is dormant). Each seat names a
**model role** (Fast, Default and Thinking for the planner's gears; Reader, Vision, Tiny, Judges, Chair, Reviewer for the
rest). A role is a code-owned list of `provider/model[:effort]` selectors resolved against omp's live catalog, and Paco
can override one from Telegram with `/models`. The lists, the resolution order, the daily change notice and the
`HOUGE_MODEL_ROLES` rollback switch live in the
[configuration reference § Model roles](docs/reference/configuration.md#model-roles), not here.

Two seats sit outside omp: **Voice** (agy-cli, Gemini Flash, voice-note transcription) and **Writer** (codex, self-write
diffs and the read-only self-diagnose consult).

Houge answers in its own voice, a projection of its Core Identity
([memory/core/houge.md](memory/core/houge.md)). The variables, defaults, fallback rules and what was
removed: [configuration reference](docs/reference/configuration.md#llm-runtime--omp-adr-0028).

## Learning

Houge improves by accumulating **inspectable** lessons, not by retraining, and learning is
**conversational**, not a command. Two memory tiers back this, plus omp's own transcript:

- **Short-term: the omp session.** Each chat's planner keeps its transcript on disk and resumes it
  after a restart, so follow-ups need no reply pointer. `chat_turns` still records every turn for the
  clarify cap, the eval loop and history.
- **Long-term: lessons.** Procedural preferences live in SQLite, one scope at a time (`ask` for
  conversation, `research` for the reader). The composer folds the active `ask` lessons into the
  planner's system prompt, so a learned preference shapes the next turn.

**How a lesson is learned.** When you react to an answer ("too long", "prefer primary sources"), the
planner re-answers honouring it and, when the feedback generalizes into a reusable preference, calls
`lesson_write`. The distiller treats *your* message as the instruction and prior answers as reference
only, so Houge never adopts an instruction embedded in fetched content as a lesson. Reconcile-on-write
(ADD / SUPERSEDE / UPDATE) keeps one current rule per preference.

**Consolidation (preserve-all merge).** A daily tick clusters near-duplicate active lessons in a scope
and merges each cluster into one lesson that keeps **every** directive and every AVOID. It adds the
merged lesson and supersedes the originals; it never deletes. Preview with
`houge lessons-consolidate --dry-run`. Design:
[lesson-consolidation spec](docs/superpowers/specs/2026-07-23-lesson-consolidation-design.md).

Slash commands keep it inspectable (idempotent, no run, no budget unless noted):

- `/lessons [scope]` view lessons · `/forget <scope|id>` retire them (a reversible status flip).
- `/skills [scope]` view skills; `/skills retire|restore <name>`, `/skills retired`, `/skills pending`.
- `/schedule` · `/schedule cancel <N>` list or cancel this chat's schedules. Schedules are created and
  updated conversationally through `schedule_task`.
- `/status` health digest · `/usage` token use per model (omp rows show "sub", never dollars).
- `/radar [n]` · `/idea pick <n>` the Idea Radar board and the weekly panel's shortlist
  ([ADR 0026](docs/decisions/0026-idea-radar-read-surface.md), [0027](docs/decisions/0027-idea-panel-claude-chair.md)).
- `/approve <id>` · `/deny <id>` · `/approvals` resolve or list pending approvals. Unforgeable:
  slash-only, never inferred from prose.
- `/kill [reason]` the durable kill switch ([ADR 0018](docs/decisions/0018-kill-switch.md)): aborts
  every planner, writes the `houge.kill` tombstone and stops the daemon; launchd relaunches into a
  parked process. `/disarm` · `/rearm` the evolution and scheduler stand-down that survives restarts.
- `/help` the command list. An unknown `/command` returns this list rather than starting a turn.

→ Composer, distillation and lesson tables:
[configuration reference](docs/reference/configuration.md#learning--conversational-distillation-and-the-lessons-table).
Learning-loop design: [ADR 0007](docs/decisions/0007-learning-loop.md); prompt-composition seam:
[ADR 0009](docs/decisions/0009-architecture-coherence.md).

## Self-evolution

**Diagnose (Phase 1).** Ask Houge why he did something and the planner can call `self_diagnose`: a
**read-only Codex consult in a fresh git worktree** of committed `HEAD`. The worktree holds only
tracked files, so gitignored secrets are absent by construction. Off by default
([configuration](docs/reference/configuration.md#self-evolution-phase-1--code-self-diagnose)).

**Skills (Phase 2).** A skill is a reusable procedure under `skills/<scope>/<name>.md` that the
composer folds into the planner's prompt; skills are ambient, never invoked by name. `skill_author`
writes one through a two-gate stack: **Gate A** routes (skill vs lesson vs code), then **Gate B**, a
separate 3-pass anchor verifier, scores whether following the procedure is sound. A commanded skill
is advisory; an auto-authored one is kept only if Gate B passes, else it is refined up to 3 times and
then parked in `skills/_pending/`. Skills retire, never delete (`skills/_retired/`), and a weekly
advisor suggests retirements ([configuration](docs/reference/configuration.md#self-evolution-phase-2a--ambient-skills)).

**Code self-write (Phase 3).** When the fix belongs in Houge's own code, the planner calls
`self_write_propose`. Codex writes the diff in a fresh worktree under `<data>/selfwrite`, and three
checkers run with no human in the synchronous loop:

1. **Protected-path guard** (deterministic) → **HARD DENY** if the diff touches the locked surface:
   gates, identity, ADRs, deps and build, the omp extension and floor code, or an *existing* test.
2. **Test gate** → `typecheck` + `npm test` + `build` in the worktree.
3. **Independent reviewer**: an omp seat on a different model family from the codex writer.

A failed check 2 or 3 feeds back to Codex, up to 3 refine passes. Only if all three pass does Houge
**publish a branch** (`houge/selfwrite/<run-id>`; the diff is re-hashed before publish) and notify
Paco with **[View diff] · [Merge & reload] · [Discard]**. [Merge & reload] merges, builds, re-runs the
test gate on merged `main` (red: auto-revert, no restart) and then kickstarts the daemon onto the new
`dist/`. The daemon never merges on its own. Protected-path denies are not overridable, not even by
`/approve`. Tool declarations under `src/omp/tools/` are deliberately self-writable data; the files
the planner process executes are protected.

Design: [ADR 0011](docs/decisions/0011-self-evolution-architecture.md) and its amendments;
[Phase 3 spec](docs/superpowers/specs/2026-06-25-phase3-code-self-write.md);
[configuration](docs/reference/configuration.md#self-evolution-phase-3--code-self-write).

## Safety model

Deterministic code owns the irreversible; the model owns judgment
([ADR 0001](docs/decisions/0001-deterministic-harness-governs-everything.md) as amended). Under omp
the planner runs **yolo under `$HOME`**: file reads, edits and ordinary shell commands need no
prompt, because approve-every-step would recreate the tool starvation ADR 0028 exists to end. The
floors sit underneath ([ADR 0028](docs/decisions/0028-omp-runtime.md), threat model and layers L0–L4):

- **No secrets in any child env (L0).** Every omp, agy and codex child starts from a five-name env
  allowlist; provider keys and the Telegram token never reach it.
- **Floor A: the OS sandbox and the policy hook (L1, L2).** The planner and every `bash` command run
  under `sandbox-exec`. Writes are denied by default outside `$HOME`, `/private/tmp` and the omp
  workspace, then denied again for the Houge repo, `dist/`, binary install trees and the dotfiles that
  make a shell, git or an editor run code. Credential stores (`.env`, the DB, `~/.ssh`, cloud and AI
  tool stores, Keychains) are read- and write-denied. The policy hook allowlists tool names, refuses
  URL-shaped reads and canonicalises every path the way omp resolves it before the floor check. The
  workspace and session roots are pinned against symlink swaps.
- **The bridge (L3).** No tool adapter lives in the planner process. Contract, budget (40 tool calls
  per run), approvals and the ledger apply to every call.
- **Floor B: `/approve` (L4).** A code-owned matcher sends `git push`, `gh … create`, HTTP writes,
  mail, remote copies, `npm publish`, `sudo`, `launchctl`, `crontab` and destructive deletes to an
  approval card; so does any bridge tool whose registry level is `external_write`. The card shows the
  matched classes and the command; one approval is in flight per turn, and an unanswered card expires
  after 30 minutes.
- **The dual-LLM wall** ([ADR 0014](docs/decisions/0014-dual-llm-privilege-separation.md)). Web,
  mail and Google API bytes are read by a separate, tool-less reader seat; the planner sees only its
  digest. The wall is unconditional. If planner and reader end up on one model family after
  fallback, the read proceeds but is audited (`wall_collapse`, incident `wall_collapsed`).
- **Global limits.** A rolling 24 h circuit breaker bounds runs, tool calls and gated attempts
  ([ADR 0003](docs/decisions/0003-global-budget-breaker.md)); the metered-$ ceiling stays dormant for
  any future metered leg; `/kill` parks the daemon so not even launchd can resurrect it.

**Accepted residuals** (Paco, 2026-09-30, recorded in ADR 0028): `bash` output is not quarantined and
network egress stays open, so a steered planner can fetch hostile bytes or send non-secret data out
through a command the matcher misses; the matcher is best effort; overwriting a file through
`edit`/`write` is not gated; and the planner process can read its own omp OAuth store, which only the
policy hook keeps from its tools. SP3 (a separate macOS user for the planner) is the structural fix.

→ Breaker caps and defaults:
[configuration reference](docs/reference/configuration.md#global-autonomy-circuit-breaker).

## Self-inspection — the invariant sweep

Houge's memory stores *content*. The **invariant sweep**
([ADR 0024](docs/decisions/0024-introspection-invariant-sweep.md)) checks his *behavior*: on a
twice-daily cadence it asserts invariants over his own flight recorder (`runs`, `scheduled_tasks`,
`notification_outbox`, `daemon_heartbeat`, `llm_attempt` rows): duplicate schedules, stuck runs,
undelivered notifications, overdue or failed schedules, an LLM leg that keeps failing, heartbeat gaps
and low disk. The omp runtime adds code-raised incidents of its own (version mismatch, planner start
failure or crash loop, sandbox unavailable, wall collapse).

A violation opens a durable **incident** (fingerprint `kind:subject`), emits a ledger event and sends
**one** Telegram line. Recurrences bump a counter silently; a clean sweep resolves the row; rows are
never deleted. The sweep is least-privileged by construction: SQL reads plus incident bookkeeping, no
LLM, no capability, no run creation.

```bash
sqlite3 houge.sqlite "SELECT kind, subject, state, seen_count, first_seen_at FROM incidents ORDER BY first_seen_at DESC"
```

## Jev intent shadow (dormant)

[Jev](https://docs.typesafe.ai/llms.txt) is a decision model that returns a typed choice with
calibrated confidence in a few hundred milliseconds. Before the omp cutover every turn started with a
~6 s intent-classifier call, and `houge jev-shadow replay` measured whether Jev could take that label
over. First run, 2026-09-26: **GO**, 91.7% agreement at confidence ≥ 0.7 on Paco's own 294 messages
(57% coverage), $0.035.

The classifier call is gone under omp, and the live shadow was removed on 2026-10-06; Jev now runs as System One
([ADR 0029](docs/decisions/0029-jev-system-one.md)). Design of the original trial:
`docs/superpowers/specs/2026-09-25-jev-intent-shadow-design.md`.

**Jev System One (ADR 0029, stage A decision tree; flags default off, `arm` on the mini).** Jev sits in front of the
planner as one decision point: six typed questions pick a category, a lane (memory and status skip the planner) or a
planner model role (Fast, Default or Thinking). Armed 2026-10-09 on Paco's calibration rows (zh and en); every unsure
turn still runs the planner on Default. Flow, bars and rollback:
[docs/reference/jev-decision-layer.md](docs/reference/jev-decision-layer.md); every flag and event:
[configuration.md](docs/reference/configuration.md#jev-system-one-adr-0029).

## Google identity — gmail_read / google_api

Houge has his own Google identity (`wukong.houge@gmail.com`,
[ADR 0008](docs/decisions/0008-houge-identity-authenticated-read.md)). **`gmail_read`** lists, searches
and opens messages in his own inbox and appends a code-built block of verification codes and links
(regexes over the raw body, not model transcription). **`google_api`** is the generic GET escape hatch
behind an exact allowlist registry (one row per granted OAuth scope; today `gmail/v1/users/me/*` ↔
`gmail.readonly`). The OAuth scope is the hard floor: the refresh token can read mail and nothing else.
Both tools always return through the quarantined reader
([ADR 0025](docs/decisions/0025-google-api-surface.md)).

**Runbook: Gmail ops fail with `auth_failed`.** The refresh token was revoked (or hit the 7-day
testing-mode expiry). Re-run `node scripts/gmail-auth.mjs <client_secret.json>` and copy the printed
lines into the mini's `.env`.

## Operations

**Prerequisites on the mini.** Node 25; omp (`@oh-my-pi/pi-coding-agent`, any version; the daemon probes a new version's
contract on its own and pages `omp_contract_drift` if it changed; `live-gate-omp.mjs --smoke` after an upgrade stays
the deeper manual check), with its
absolute path given to the daemon, because launchd runs on a restricted PATH; `agy` for voice notes;
`codex` for self-diagnose and self-write. Then log omp in four times under the `houge` profile, never
the default one:

```bash
omp --profile houge login anthropic            # Claude Max: planner and chair
omp --profile houge login google-antigravity   # Gemini reader and photos; Claude fallback
omp --profile houge login kimi-code            # Kimi: Tiny role, judge, reviewer, last planner fallback
omp --profile houge login openai-codex         # GPT judge and reader fallback
```

`/models` in Telegram shows which model each role resolves to today, and `/models set` overrides one.

The grants live in `~/.omp/profiles/houge`, a secret path the sandbox and the policy hook keep from
the planner's tools.

**Build.** `npm run build` runs `tsc` and then `scripts/copy-omp-assets.mjs`, which copies the files
`tsc` does not emit. The daemon needs all of these in `dist/`:

```
dist/cli.js                     the CLI and daemon entry
dist/omp/extension/houge.js     the one extension the planner loads (policy hook + tool stubs)
dist/omp/shell-wrapper.sh       the bash wrapper (copied; its hash is checked before use)
dist/omp/tools/*.json           the tool declarations (copied; validated at boot)
```

**Runtime state.** `<data>` is the directory holding `houge.sqlite`. Under it, `omp/` holds the
per-chat `sessions/` and `workspace/` (files the planner made for Paco), `bridge/` sockets, the
rendered `planner.sb` and `shell.sb` profiles, the profile config and the per-chat system prompts;
`selfwrite/` holds self-write worktrees. The daemon's own temp space is
`~/Library/Caches/houge-daemon`, outside any git repo.

**Deploy and restart.** Run the daemon under launchd ([deploy/launchd/README.md](deploy/launchd/README.md)).
After a build, `launchctl kickstart -k gui/$(id -u)/com.houge.daemon` restarts it onto the new `dist/`.
A restart ends any in-flight chat turn (it fails `planner_exit`, and Paco gets a reply saying so); the
transcript resumes on the next message.

**Live gates.** `npm test` stubs omp, so every change to the runtime also needs the real binary:

```bash
node scripts/live-gate-omp.mjs --dry      # print the case table
HOUGE_ENV_FILE=/abs/path/.env node scripts/live-gate-omp.mjs --smoke   # pre-restart smoke: real omp, temp DB copy
node scripts/live-gate-omp.mjs            # full gate against the live daemon, driven from Telegram
```

The smoke never touches the running daemon. A planner refusal of the sandbox self-test makes the
gate INCONCLUSIVE (exit 4), never PASS.

**Upgrading omp.** There is no version pin (2026-10-07): any version `omp --version` reports runs, and only an
omp that cannot run or prints no version refuses a spawn (incident `omp_unavailable`). After an upgrade, run the
smoke to confirm the frames and refusal texts Houge parses still hold
([configuration](docs/reference/configuration.md#llm-runtime--omp-adr-0028)).

**Rollback.** `git revert` the merge, `npm run build`, kickstart. Session and workspace dirs are
harmless to leave; there is no data migration to reverse.

## Backup & restore

The daemon can snapshot `houge.sqlite` into `backups/` on a schedule: a WAL-safe `VACUUM INTO`,
integrity-checked before it gets its final name, newest N kept. **Local-only**: it protects against
corruption and accidental deletes, not disk death ([ADR 0021](docs/decisions/0021-db-backup.md),
[configuration](docs/reference/configuration.md#db-backup-adr-0021)).

Restore:

```bash
launchctl bootout gui/$(id -u)/com.houge.daemon     # stop the daemon
cp backups/houge-<stamp>Z.sqlite houge.sqlite      # copy the snapshot over the live db
rm -f houge.sqlite-wal houge.sqlite-shm            # stale WAL siblings must not replay
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.houge.daemon.plist  # restart (kickstart fails after bootout), verify /status
```

## Documentation

- [Roadmap](docs/ROADMAP.md): charter, locked decisions, verified state, sequenced next builds.
- [Configuration reference](docs/reference/configuration.md): every environment variable, default and purpose.
- [Deploy the daemon (launchd)](deploy/launchd/README.md): run the always-on daemon on macOS.
- [Architecture decisions](docs/decisions/README.md): the *why* behind significant choices (ADRs). Start with [ADR 0028](docs/decisions/0028-omp-runtime.md) for the runtime.
- [omp runtime spec](docs/superpowers/specs/2026-09-30-omp-runtime-design.md): the design behind ADR 0028, with its threat model and residuals.
- [Research notes](docs/research/): landscape reviews that inform design (agent memory, web access).
- [CONTRIBUTING.md](CONTRIBUTING.md): documentation convention and definition of done (tests **and** a live run).
- [AGENTS.md](AGENTS.md): coding, safety and workflow rules. [CONTEXT.md](CONTEXT.md): domain language.
- Working logs: [sessions.md](sessions.md), what each build session did and why, newest last;
  [tasks/todo.md](tasks/todo.md), current state and shipped blocks; [tasks/lessons.md](tasks/lessons.md),
  orchestration mistakes and the rules that prevent them.
