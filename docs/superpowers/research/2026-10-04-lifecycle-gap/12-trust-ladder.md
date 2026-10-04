# 12 — Trust ladder and graduated autonomy (governance dimension)

Date 2026-10-04 · read-only over `main@ec01f16` and `houge.sqlite` (`sqlite3 -readonly`). Companion to the inventory (11) and harness (13) reports.

## 0. The gap in one paragraph

Claude Code owns the lifecycle because a human watches each step and the harness (permission prompts, git, a terminal) makes every action visible before it lands. Houge's harness is stronger per action (OS sandbox, fail-closed guard, writer≠reviewer, test gate, merge tap) but has **no notion of earned trust**: every change class sits at a fixed rung, nothing promotes or demotes with evidence, and the ledgered human decisions are 7 merge taps and 12 approval cards in 90 days. Houge can *propose* code; it cannot *decide, spec, plan, live-gate or deploy* it, and the only artefact Paco can approve is a diff. The missing layer is a **trust ledger plus a promotion rule**, not another gate.

## 1. Today's trust ladder, as built

| Change class | Initiates | Reviews | Approves | Verified by | Rollback | Where |
|---|---|---|---|---|---|---|
| **Lesson** | planner via `lesson_write` (Paco's own turn only; scheduled runs refused) | code backstop `shouldRejectLesson`, code-owned-phrase refusal, reconcile verdict on ticks seat | nobody (silent save) | rating attribution, decay | supersede chain | `lesson-write.ts:78,103-118,138`; ADR 0012 §2 |
| **Memory fact / wiki correct** | planner `memory_correct_write` | code trust limits (own turn, ids from this turn's search, ≤5/call) | **Paco's Approve tap** (`destructive` class) | Undo card | `memory_changes` undo | `omp-turn-wiring.ts:29-30`; ADR 0028 |
| **Skill** | planner `skill_author` | Gate A (is it a skill) → Gate B 3-pass anchor verifier; Gate B *error* never blocks | nobody; `/skills` is read-only | re-verify tick | supersede/retire frontmatter | `core-worker.ts:1585,1663,1671`; ADR 0011 §3 |
| **Code outside protected surface** | planner `self_write_propose` (armed by `HOUGE_SELFWRITE_ENABLED`, live `true`) | Codex writer ≤3 → guard → test gate in worktree → independent reviewer (omp seat, Codex fallback) | **Paco's [Merge & reload] tap** | post-merge build + test gate + stale-dist check, red → `reset --hard` | pre-merge ref captured; boot marker; **no post-restart health probe** | `self-write-writer.ts:77`, `self-write-guard.ts:237`, `diff-reviewer.ts:13-22`, `self-write-merge.ts:156-236`, `self-write-action-handler.ts:157-188`; ADR 0011 Am.1/2, 0012 §5 |
| **Code on protected surface** | nobody but Paco | — | — | guard denies `PROTECTED_DIRS`/`PROTECTED_FILES`, symlinks, type-changes, edits to existing tests | — | `self-write-guard.ts:67-127,306-318`; ADR 0011 §5, 0015 §7, 0018 §4 |
| **Config / `.env`** | Paco's hand | — | — | hermetic env pins (`PINNED_ENV`) | — | `tasks/lessons.md:52-55`; `src/config/load-env.ts` protected |
| **Deploy / restart** | merge path or Paco; planner `launchctl` → card (1, expired) | — | Paco | boot record `daemon_boots` | kill switch `/kill`, `/disarm` (`DISARM_FLAGS`) | `self-write-merge.ts:359-368`; ADR 0018 §1,§3; ADR 0028 D12 |
| **Docs / ADRs / AGENTS.md** | Paco + Claude Code | build-time reviewers | Paco | — | git | `self-write-guard.ts:69,106` |
| **Push to public repo** | merge tap with `HOUGE_SELFWRITE_PUSH` (live `false`); planner `git push` → card | — | Paco | — | — | `self-write-merge.ts:76-80`; ADR 0028 D6/L4 |

**Where Paco's tap sits.** Three places, all post-verification: the merge button, Approve/Deny cards on `external_write`/`destructive` actions (`task-contract.ts:51,141,176`), the memory-write card. Proposing, diagnosing, lessons, skills, wiki and plain shell under `$HOME` are tap-free (ADR 0028 D5).

**Taps given, last 90 days.** Merge taps: **7** self-write commits on `main` (git: 4 × 07-07, 07-13, 07-20, 10-02); the ledger has **no merge event** and `reload_marker`/`daemon_boots.reload_sha` are empty, so git is the only record. Approval cards: **12** (`tool_approvals`: 8 consumed — 2 `git push`, 6 `memory_correct`; 2 denied; 2 expired), all 2026-10-01/02. `/kill` 1. About **20 governance decisions in 90 days**, none on a spec, plan or design.

**Self-write record.** Lifetime: published 19, failed 17, blocked 1 (protected `run-store.ts`, 07-05); 18 commits merged; `self_write_propose` steps 34 (Jul), 7 (Sep), 7 (Oct). Since 09-01: 14 proposals → 2 published → **1 merged**; failures: 2 tests-red, 2 empty diffs (writer prompt, `lessons.md:315-320`), 1 real reviewer rejection, 1 reviewer unparseable. Incidents caused by self-changes: 0 of 6. One pipeline lost to an operator restart (`lessons.md:322-328`).

## 2. Where Claude Code's lifecycle hits Houge's gates

**A** autonomous · **T** tap · **F-d** forbidden, dangerous · **F-u** forbidden only because the safe version is undesigned.

| Stage | Houge | Why |
|---|---|---|
| Research | **A** | `fs_read`, read-only `bash`, `web_search`/`http_fetch` behind the reader wall, `houge_status`. |
| Propose | **A** | `self_diagnose` is `external_read`, tap-free; proposals already reach Paco in plain language. |
| Decide | **F-u** | No artefact: a decision is a Telegram "好" costing a 189K-token Opus turn and leaving no row. |
| Spec / Plan | **F-u** | The repo is write-denied to planner and `bash` (ADR 0028 build decision 3); the only repo write path is the self-write pipeline, which expects a diff that passes a *test* gate. |
| Spec review | **F-u** | The reviewer seat (`diff-reviewer.ts`) is bound to diffs; Houge can probe the DB/env but no tool records a verdict. |
| Implement | **A** to a branch | Codex in a throwaway worktree, guard + gate + reviewer. One shot per turn, ≤3 refinements, 300 s writer timeout, no multi-task plan. |
| Write tests | **A** net-new only | Existing tests immutable (`self-write-guard.ts:306-318`): **F-d** by design, correctly. |
| Diff review | **A** | Writer≠reviewer; family diversity warned, not enforced (`diff-reviewer.ts:52-55`). Rejections bite (10-01, 10-02). |
| Live gate | **F-u** | `scripts/live-gate-*.mjs` run `../dist/` against the real DB; the pipeline's gate is hermetic. No seam to gate a *candidate* build without touching the running process (hard line a). |
| Deploy | **T** | Merge tap; red → auto-revert before restart; **no post-restart health probe** (ADR 0012 §5, ROADMAP S-3). Autonomous merge is **F-d until S-3**. |
| Push (public repo) | **T**, keep **F-d** | `HOUGE_SELFWRITE_PUSH=false`; planner push is a card. The repo leaked an address once (A1 scrub). |
| Learn | **A** (memory-write **T**) | Closed loop exists; soft regressions ride ratings (11 total, all 2–3: too thin to grade). |
| Protected surface, `.env`, launchd | **F-d** | Guard + Seatbelt; Paco's hand. |

Four stages autonomous, two tapped, two forbidden-dangerous, and **five forbidden only because nothing was designed** (decide, spec, spec-review, plan, live-gate): the middle of Paco's lifecycle.

## 3. A graduated autonomy model (hard lines untouched)

Frame: Anthropic's RSP ties safeguards to evaluated capability thresholds, levels *earned*, not declared ([anthropic.com/responsible-scaling-policy](https://www.anthropic.com/responsible-scaling-policy)). Google's agent-security principles are the test for each lever: a defined human controller, limited powers per action, observable plans ([research.google](https://research.google/pubs/an-introduction-to-googles-approach-for-secure-ai-agents/)). OWASP LLM06 "Excessive Agency" is the failure to avoid: permissions ahead of evidence ([genai.owasp.org](https://genai.owasp.org/llm-top-10/)).

**L1. Trust ledger + per-class levels (foundation).** `trust_events(class, artefact, decision, by, outcome_after_7d)` for every tap; merge taps are not ledgered today. Levels: 0 forbidden · 1 propose · 2 auto-to-branch, Paco merges (today's code rung) · 3 auto-merge in a window with auto-rollback · 4 auto-merge + push. Promotion is code: N consecutive clean outcomes (merged, no revert, no incident, no Paco correction in 7 days) → up one; one revert or incident → down one (asymmetric, like an SRE error budget). *Evidence to grant:* a replay over the 18 merges shows the rule behaving (prompt-text would have reached L3 in July and dropped after September's tests-red pair). *Failure:* levels creeping on volume Houge lacks. *Amends* ADR 0011 (new §8), 0012 §5.

**L2. Spec-and-plan artefacts as the approvable unit** (closes the five F-u stages). A `proposal_write` path into `docs/superpowers/proposals/<run>.md` through the existing pipeline under a docs-only guard profile (`.md` under that dir only; gate = typecheck/build). Paco approves the *proposal* on a card, ledgered; the approved proposal becomes the writer task and the reviewer's spec. This is Codex's cloud model: sandbox work, a PR with test logs as the reviewable artefact, the human reviews intent and evidence ([openai.com/index/introducing-codex](https://openai.com/index/introducing-codex/)). *Evidence:* 5 proposals whose approval matched what Claude Code would have specced. *Failure:* a plausible proposal from a steered session (ADR 0014 residual); inert prose, and the diff still runs the full stack. *Amends* ADR 0011 §7, 0028 build decision 3.

**L3. Worktree + tests + live gate as the oracle, in a shadow daemon.** Hard line (a) forbids touching the running process, so run the candidate `dist/` as a second daemon on a temp DB copy (the `live-gate-omp.mjs --smoke` pattern) and let the pipeline run `scripts/live-gate-<name>.mjs` against it before publishing. SRE canarying: real traffic slice, code-owned metric, before rollout ([sre.google/workbook/canarying-releases](https://sre.google/workbook/canarying-releases/)). *Evidence:* a deliberately broken merge is caught and never offered. *Failure:* quota — a shadow spends real Opus turns; restrict to L2+ classes. *Amends* ADR 0012 §5, 0028.

**L4. Cross-family second review, enforced.** `reviewerDiversityWarning` becomes a gate for L3+ classes, plus a *probing* reviewer with read-only `bash` in the worktree: the build-time Criticals were found by reviewers who probed, not by a read-only pass (`lessons.md:263-268`). Two-person rule with the second party a different model family ([google.github.io/building-secure-and-reliable-systems ch.5](https://google.github.io/building-secure-and-reliable-systems/raw/ch05.html)). *Evidence:* 10 ledgered verdicts, ≥1 real catch. *Failure:* both reviewers steered by the same text; nonce fences already land (2026-10-01). *Amends* ADR 0011 §4.

**L5. Code-computed blast radius; Jev adds caution only.** From the diff, in code: files, prompt-text vs logic, lines, new deps (forbidden), tests added, boot-path modules. Radius sets *eligibility* (prompt/discipline single-file first, as ROADMAP Milestone A.4 already says); outcomes set *promotion*. The Jev spec keeps `blast_radius` in code (`2026-10-04-jev-system-one-design.md:343`) and allows Jev only `ask := code_ask ∨ (jev_flag ∧ conf ≥ τ)` (§4.1): a Jev `risk` score may demote a change one level, never promote. *Evidence:* replay over the 18 merged diffs orders them as Paco would. *Failure:* small diff, large semantics (`-rqF` → `-rqFw` was one flag). *Amends* ADR 0029, 0011.

**L6. Auto-rollback on incident + deploy windows** (Milestone A precondition). ROADMAP S-3: post-restart probe → revert to pre-merge ref, rebuild, restart, notify. Add a 24 h watch after any self-merge in which a new `incidents` row or `/kill` reverts it, and merge only inside a window Paco sets (NIST AI RMF "Manage": defined oversight points and response plans, [nist.gov](https://www.nist.gov/itl/ai-risk-management-framework)). *Evidence:* a broken merge self-reverts (ROADMAP A.1). *Failure:* soft regressions are invisible to a probe (ADR 0012 §5) and to 11 ratings; keep L3 to prompt-text until `scripts/eval-replay.mjs` (SP4) can score a candidate. *Amends* ADR 0012 §5, 0018, ROADMAP Milestone A.

**Forbidden regardless of evidence:** protected surface, `.env`, `package.json`, existing tests, DB migrations in autonomous scope, and autonomous **push**. D12 already grants two legs of the lethal trifecta ([simonwillison.net](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)); publishing is the third and stays a human act.

## 4. Honest assessment (~2 months)

**Volume.** 3.4 Paco turns/day over 90 days (4.1 over 30); 220 Telegram + 80 schedule runs in 90 days; 14 self-write proposals in 5 weeks, 1 merged. Claude Code + Paco: **546 commits in 90 days, 368 in 30**. The evolution channel runs under 1% of the build channel, and every promotion rule needs N clean outcomes: at ~3 proposals a week, L3 for one class is a 6–8 week soak.

**Realistic for Houge to own (Paco taps once per cycle):**
- Research → propose → **proposal artefact** → one tap (L1+L2): converts five F-u stages into one tapped stage and starts the trust ledger. Largest, cheapest win.
- Implement → tests → cross-family review → branch for prompt/discipline text and single-file fixes, with the shadow live gate where a gate script exists (L3, L4).
- Learn: lessons, skills, memory corrections are already closed-loop; add outcome rows.

**Stays with Claude Code + Paco, and why:**
- Multi-task slices (omp runtime: 16 tasks, 5 reviewers, 13 Codex passes; A1: 11 tasks, 21 findings). The defects that mattered lived *between* tasks (`lessons.md:208-215,263-268`); Houge's pipeline is one worktree, one writer call, one reviewer, 300 s. The planner that refused a safety self-test in two of three smoke runs is the same seat.
- Protected surface and trust boundaries: by invariant, and because the Criticals were found by probing subagents, not a tool-less one-shot.
- Deploy and push: one host, a public repo, OAuth stores in `$HOME` (D11), a bad restart costs Paco a terminal session. Until a broken merge self-reverts (S-3), the tap is the rollback.
- ADR-level decisions: Paco's hand (AGENTS.md).
- Quota: the Opus weekly cap is shared with Paco; shadow daemons and probing reviewers spend it, and autonomy that drains it degrades hard line (a).

**Verdict.** Within two months Houge can hold *propose → spec artefact → implement → review → branch* for small bounded classes under a trust ledger, moving Paco's tap from the diff to the proposal and the merge. Architecture decisions, multi-task builds, live gating on the real daemon, deploy and publish stay with Claude Code and Paco; publish and the protected surface permanently.
