# Houge vs the Claude Code lifecycle — internal inventory (2026-10-04)

Evidence: repo at `main@ec01f16`, live `houge.sqlite` (read-only), omp 18.4.4 source under `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent`. "90d" = ledger rows with `occurred_at >= now-90d` (2026-07-06 → 2026-10-03). Ledger total 10,906 rows; 310 turn runs in 90d (305 completed, 5 failed).

## Headline numbers (90d)

| Signal | Count | Source |
|---|---|---|
| `loop_step` total | 1,292 | `ledger_events` |
| … `web_search` | 956 (74%) | same |
| … `shell` / `shell_external` / `fs_read` / `fs_write` | 39 / 6 / 6 / 1 — all since the 2026-10-01 omp cutover | same |
| … `self_write_propose` | 18 (7 since cutover) | same |
| … `self_diagnose` | 5 | same |
| … `skill_author` | 4 (1 since cutover) | same |
| … `lesson_write` | 31 | same |
| `self_write_published` / `_failed` / `_blocked` | 8 / 9 / 0 (all-time 19 / 17 / 1) | same |
| Failure reasons (9) | tests red ×4, reviewer rejected ×4, both reviewers unparseable ×1 | payloads |
| Codex writer legs (`llm_attempt role=writer`) | 19 ok | same |
| Reviewer legs | kimi-code 8 ok / 3 err, codex 5 ok / 1 err, kimi-cli 1 | same |
| Self-write commits reaching `main` | 8 (7 on 2026-07-07…07-20, 1 on 2026-10-02 `4431d13`); all-time 22 | `git log` |
| `reload_marker` rows (written only by the `[Merge & reload]` tap, `self-write-merge.ts:226`) | **0** | DB |
| `daemon_boots` reasons | 7 boots: kickstart ×5, crash_recovery ×1, unknown ×1 — none a self-write reload | DB |
| Approvals (`tool_approvals`) | 12: memory_correct_write 6 consumed; shell_external 2 consumed / 2 denied / 2 expired | DB |
| Session ratings | 11 total, mean 2.7, **last one 2026-09-25** | `session_ratings` |
| Idea radar | 305 cards; 10 weekly shortlists, `picked_idea_id` NULL in **all 10** | `ideas`, `radar_shortlists` |
| Skills / lessons / schedules | 3 active skill files; 52 lessons (13 active); 2 enabled schedules, 80 fires | fs, DB |

## Stage-by-stage table

Verdicts: **present** / **partial** / **missing** / **forbidden** (by ADR).

| # | Stage | What Houge has today | Trust gate | 90d evidence | Verdict |
|---|---|---|---|---|---|
| 1 | Sense a need / pick work | Idea radar tick (`src/capabilities/idea-radar.ts:9-20`, external sources → cards) and weekly panel (`idea-panel.ts:11-20`, 3 omp judges + Opus chair → shortlist of 3). Invariant sweep (ADR 0024) senses *health*, not *weakness*. No weakness-mining over the ledger (SP4, `tasks/todo.md` "SP4 self-evolution v2"). Paco picks via `/idea pick <n>` (`telegram-command-parser.ts:162-177`). | Radar/panel write only to `ideas`; a pick is Paco's command | 67 radar ticks, 11 panel ticks, 10 shortlists, **0 picks**. Radar is outward-facing (what to build in the world), never inward (what in me is failing). | **partial** — sensing exists for ideas, missing for self-weakness; the pick step is dead |
| 2 | Research (web, codebase, history) | Planner has `web_search`, `http_fetch` (walled, ADR 0014/0028 D3), `read` of the repo (write-denied only, `protected-paths.ts:77`), `bash` under Seatbelt (D12), `wiki_build/refine`. Self-history: `houge_status`, episodic facts, wiki. No read of `sessions.md`/`ROADMAP`/ADRs in the prompt (`composer.ts` has no repo-docs injection; `core-worker.ts:2940` reads only `AGENTS.md` for the research brief). The ledger is not a tool. | Reader wall on web/mail; repo reads yolo | 956 web_search, 58 http_fetch, 39 shell, 6 fs_read, 5 self_diagnose (Codex read-only consult, `coding-agent.ts:81-82`) | **present** for web; **partial** for codebase (can read, rarely does: 6 fs_read + 39 shell vs 956 searches); **missing** for its own history (no ledger/git-log tool, no doc memory) |
| 3 | Parallelise with subagents | None. One planner per chat, `--tools read,edit,write` (`planner-session.ts:15`); omp's `task` tool is excluded. One-shot seats exist (reader, judges, chair, reviewer) but are code-dispatched, never model-dispatched. Bridge serialises one `call` per turn (ADR 0028 build decision 10). | — | 0 | **missing (build gap, with a design edge)** — ADR 0028 chose a single supervised planner; nothing forbids a bounded `task` seat, but every subagent would need the bridge's gates |
| 4 | Summarise & propose options | Prompt rules only: `LOOP_PLAIN_PROPOSAL_RULE` (`composer.ts:161-164`: symptom → cause → change → check). Panel chair produces a ranked shortlist with rationale (`idea-panel.ts`). No structured "options A/B/C with trade-offs" artifact; no `/propose` surface. | none | 7 self-write proposals since cutover, each a chat message | **partial** — single-fix proposals in prose; no options, no written artifact |
| 5 | Ask human, wait across sessions | Two mechanisms: (a) approval cards (`tool-approval-sink.ts:61`, TTL `approvalTimeoutMs`; Approve/Deny buttons) for `external_write`/`destructive`; (b) chat go-ahead (`LOOP_GO_AHEAD_RULE` `composer.ts:149-153`) — "go" executes the last proposal. Decisions are not persisted: an unanswered proposal dies with the turn (`self_write_propose` "ENDS this turn", `tools/self_write_propose.json`); a session reset on a lesson change drops it (ADR 0028 memory A1). Only `scheduled_tasks` and `pending_rating` survive restarts; neither is a decision queue. | Approve tap = Paco's authenticated callback | 12 approvals (2 expired, 2 denied); 0 persisted decisions | **partial** — can ask and wait minutes; cannot hold a decision across sessions |
| 6 | Write a spec / design doc | Nothing. `wiki_build` writes *world* knowledge pages (`wiki_pages`, 7 active), not design docs. The `focus` field (≤2000 chars, `self_write_propose.json`) is the whole "spec" the writer and reviewer get. Repo `docs/` is write-denied to the planner (`protected-paths.ts:77`). | repo write-denied | 0 specs; largest focus 479 chars | **missing** (build gap; docs are not on the protected list, only the repo-write deny of D5/decision 3 blocks them) |
| 7 | Review the spec (second model) | None for specs. The *diff* reviewer exists (`diff-reviewer.ts:45-48`, omp reviewer seat default, Codex fallback, writer≠reviewer family check at `:56-64`). Panel judges review *ideas*, not designs. | — | 0 | **missing** |
| 8 | Plan into tasks | None. No todo/plan tool in the planner (omp `todo`, `plan`, `--plan-yolo` excluded by `--tools read,edit,write`). Scheduler holds recurring goals, not task graphs. | — | 0 | **missing** |
| 9 | Implement in isolated workspace | **Present and real.** `self_write_propose` → `runSelfWrite` (`core-worker.ts:1181-1375`): fresh worktree of HEAD under `<data>/selfwrite` (`run/worktree.ts:24-30`), Codex `exec --sandbox workspace-write` (`coding-agent.ts:103-104`, writer pinned to codex `self-write-writer.ts:26-27`), ≤3 write passes (`:1226`), guard `checkSelfWriteDiff` (`self-write-guard.ts:237`), branch publish (`branch-publish.ts`). Planner's own `edit/write` cannot touch the repo (decision 3). | Protected surface `PROTECTED_DIRS/FILES` (`self-write-guard.ts:67-128`: `src/policy`, `docs/decisions`, `src/omp`, `dist`, gates, kill switch, `AGENTS.md`, `package.json`…); existing tests immutable (`TESTS_DIR`) | 18 proposals → 8 branches; 19 Codex writer legs; 2026-10-01 empty-diff bug (`lessons.md` "blanket no shell") fixed | **present** — but write-time only; no plan, no multi-file task decomposition, one shot of ≤3 refines |
| 10 | Typecheck / tests | `runTestGateAsync` (`run/test-gate.ts:7-22`): typecheck → vitest → build, 300 s cap, inside the worktree; red feeds back to the writer. Re-run post-merge (`self-write-merge.ts:195-198`). | code-owned, protected file | 4 of 9 failures were "tests red" | **present** |
| 11 | Code review by second model | `reviewDiff` (`diff-reviewer.ts`), adversarial JSON verdict, nonce-fenced, `pass/reject` with `fixes_task/introduces_bugs/scope_creep`; reject → refine. | protected file; writer≠reviewer family warning only (`:56`) | 4 rejects, 1 double-unparseable; 8 passes | **present** (one reviewer, one lens; the Claude Code flow runs 4 parallel lenses + Codex) |
| 12 | Live verification / gate | None autonomous. `scripts/live-gate-*.mjs` are operator scripts (`CONTRIBUTING.md` "Definition of done"); `scripts/eval-replay.mjs:1-4` is manual ("SP4 wires it into the self-write test gate; today it is a manual comparison"). `evals/` has fixtures/golden/suites for `src/eval/eval-runner.ts` (hermetic). Post-restart health probe (ADR 0012 §5, S-3) **not built** (`ROADMAP.md:138` "❌ pending"). | — | 0 Houge-initiated live gates | **missing** — and ADR 0012 names it the engine |
| 13 | Deploy & roll back | `mergeAndReload` (`self-write-merge.ts:156-240`): preMergeRef → merge → build → test gate → `writeReloadMarker` → detached `launchctl kickstart`; red → `git reset --hard`, no restart. Rollback is pre-restart only; no post-boot auto-rollback (S-3). | Paco's authenticated `[Merge & reload]` tap (ADR 0011 Am. 2); autonomy flip gated on S-3 + 2-week soak (`ROADMAP.md:324-333`) | `reload_marker` **empty**; 8 self-write commits on main landed by hand/ff (`4431d13` single parent); boots: 0 self-write reloads | **partial by design** — merge is Paco's hand (ADR 0011/0012); the button path shows no live use |
| 14 | Learn from outcome | Lessons (`lesson_write`, themed, capped, A1), session ratings (`session-rating.ts:5-15`, attribution to applied lessons), reuse/decay, episodic memory, wiki decay. Self-write outcomes are **not** fed back: no row links `self_write_failed` reasons to a lesson or to the next proposal; distill now *drops* dev-talk on purpose (ADR 0028 2026-10-02). `tasks/lessons.md` is written by Claude, not Houge. | lessons = user-gated; `lesson_write` refused on schedule turns | 31 lesson_write, 11 ratings (last 09-25), 0 self-write post-mortems | **partial** — learns preferences, not engineering outcomes |

## (a) Build gaps vs design gaps

**Design gaps (an ADR forbids or Paco's hand is required):**
- Merge/deploy by Houge alone — ADR 0011 §5 + Amendments 1–2, ADR 0012 §5 (human tap until auto-rollback S-3 + soak), `ROADMAP.md:144-160` non-negotiable 2.
- Editing the protected surface (gates, `src/omp`, `src/policy`, ADRs, `AGENTS.md`, `package.json`, existing tests) — `self-write-guard.ts:67-128`; by construction the self-write lane can never fix a runtime/floor bug, which is most of what the last two weeks shipped.
- Claude Code CLI / metered API as a seat — ADR 0028 D7, ADR 0019. Houge cannot invoke the orchestrator that runs Paco's lifecycle.
- One planner per chat, bridge serialised, `--tools read,edit,write` — ADR 0028 shape + decision 10. Not an invariant in words, but the floor (every tool through `CapabilityRunner`) makes model-spawned subagents a security build, not a flag.
- Repo write-denied to the planner (ADR 0028 build decision 3): specs, plans, `sessions.md` can only reach the repo via the self-write lane (Codex writer, test gate, reviewer, Paco's tap) — for a markdown file.
- Mac mini: 2018 Intel, one daemon; parallel Codex worktrees + vitest runs contend (memory note "Mac mini hardware").

**Build gaps (nothing forbids them):**
- Weakness mining over the ledger → ranked proposals (SP4 bullet, unbuilt).
- A decision queue: persisted proposal + Paco's answer across sessions (today: approval TTL or chat go-ahead only).
- Spec/plan artifacts and a spec reviewer seat (the diff reviewer pattern already exists; a "design reviewer" is the same seat on a different prompt).
- A `task`/todo surface for the planner (omp has both; see (b)).
- `eval-replay.mjs` inside the test gate; a post-restart health probe (S-3) — explicitly sequenced, unbuilt.
- Houge reading its own history: a ledger/git-log read tool and `sessions.md`/`ROADMAP.md`/`tasks/todo.md` in the planner's context. Today the only repo doc the code ever reads for Houge is `AGENTS.md` (`core-worker.ts:2940`).
- Closing the loop on self-write outcomes (failure reason → lesson/AVOID).
- `/idea pick` wiring to anything downstream (10 shortlists, 0 picks, and a pick writes only `picked_idea_id`).

## (b) What omp 18.4.4 already provides that Houge switches off

From `src/tools/builtin-names.ts` and `omp --help` (read-only, no login):
- **Subagents**: `task` tool (`src/task/index.ts`: bundled agents `task`, `sonic`, plus prompt agents `scout`, `reviewer`, `security-reviewer`; `~/.omp/agent/agents/*.md` and `.omp/agents/*.md`; parallel = parallel calls; `task/worktree.ts` + `isolation-runner.ts` give per-task **git worktree isolation**; `rpc-subagents.ts` streams subagent frames over the RPC mode Houge already uses). Houge: `--tools read,edit,write`, so `task` is never offered.
- **Plan mode**: `--plan=<model>`, `--plan-yolo` (read-only plan → auto-approve → implement on a cheaper model), `tools/plan-mode-guard.ts`, `todo` tool. Houge: none.
- **Skills**: `--skills <globs>`, `manage_skill`, `skill` registry, `.claude/skills/*/SKILL.md` discovery (`discovery/claude.ts:597`). Houge: `--no-skills` on every seat; skills composer-injected (ADR 0028 decision 5, "native omp skills move to SP4").
- **Goals / review / eval**: `goal` tool with `token_budget` (`goals/tools/goal-tool.ts`), `autoresearch` mode (goal → experiments → git log), `advisor` (`--advisor`: a second model reviews each turn), `judgment` (`judge` role — the System One that ADR 0029 is designing by hand), `cleanse` (parallel file-disjoint fix subagents + test suites), `checkpoint`/`rewind`, `eval`, `github`.
- Houge uses omp as a tool-calling loop with a transcript; every lifecycle organ omp ships is excluded by the spawn flags or unverified (decision 5).

## (c) The single biggest missing piece

**Stage 12/14 together: Houge has no verifier it can run and no memory of its own engineering outcomes, so nothing it does to itself compounds.** ADR 0012 said it in June: "the eval loop is the engine; without it autonomy is a confident random walk." Four months on, the evidence:
- The only autonomous gate is hermetic tests + one diff reviewer; the live gate, the replay eval and the health probe are operator scripts or unbuilt (`ROADMAP.md:138`, `eval-replay.mjs:3-4`).
- 18 proposals, 8 branches, 9 failures with four reasons — and zero rows connect a failure to the next attempt. The 2026-10-01 empty-diff pattern recurred three times before Claude, not Houge, found the cause (`lessons.md` "blanket no shell").
- Rating signal has stopped (last 2026-09-25); the radar shortlist has never been picked (0/10); `reload_marker` is empty.

Everything upstream (sense → spec → plan → subagents) can be bolted on with omp's own tools, but it would produce more unverified change faster. The one piece that converts Houge's lifecycle from "propose and hope" into Paco's "research → verify → learn" is a Houge-runnable verifier plus an outcome ledger it reads before proposing: `eval-replay.mjs` in the gate, a post-restart probe, and self-write outcomes fed back as AVOID lessons. That is SP4's first bullet, and it is a build gap, not a design gap.
