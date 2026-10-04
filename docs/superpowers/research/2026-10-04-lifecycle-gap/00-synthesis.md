# Why Houge cannot run Paco's lifecycle yet — synthesis (2026-10-04)

Paco's question: Claude Code, handed a request, runs research with subagents → summary → proposal → decision → spec +
review → implementation → tests + verification, end to end. Houge, built on a coding-agent runtime, cannot. What is
missing? Three reports answer it from three angles: the internal inventory (`10-`), the external harness evidence
(`11-`), the trust and governance dimension (`12-`). Numbers are from the live DB and the code at `main@ec01f16`.

## The answer in four lines

1. **The lifecycle is a harness property, not a model property.** The same Opus scores 68.9% in Claude Code and 66.1%
   in a thinner harness; SWE-agent lifted GPT-4 from 3.8% to 12.5% by interface alone. Houge's planner is the same
   model Paco uses; it lacks the harness around it.
2. **Most of that harness is already inside omp 18.4.4 and switched off by Houge's own spawn flag**
   (`--tools read,edit,write`, `src/omp/planner-session.ts:15`): `task` subagents with git-worktree isolation, plan
   mode and `todo`, native skills, `ask` (surfaced over RPC as `extension_ui_request`), hooks, ordered compaction,
   `goal`, `advisor`, `judgment`, `checkpoint`/`rewind`.
3. **Three things are missing by construction**, not by flag: (a) a goal record that outlives a Telegram turn (plan,
   phase, pending decision), so a decision can wait days without pinning the chat's planner; (b) a planner-reachable,
   test-runnable workspace for Houge's own code — today the repo, `dist/` and the self-write worktrees are write-denied
   to the planner and to `bash` (ADR 0028 decisions 3, 18), so the planner never iterates red → green, only
   `codex exec` does, once; (c) a verifier Houge can run itself plus a memory of its own engineering outcomes
   (`eval-replay.mjs` is manual, the post-restart health probe S-3 is unbuilt, zero rows link a self-write failure to
   the next proposal). ADR 0012 named (c) "the engine" in June.
4. **The gap is also governance.** Houge's harness is stronger per action than Claude Code's (Seatbelt, fail-closed
   guard, writer ≠ reviewer, test gate, merge tap) but has no notion of earned trust: every change class sits at a
   fixed rung, nothing promotes or demotes on evidence, and the only approvable artefact is a diff.

## Stage by stage

| Stage | Houge today | Verdict |
|---|---|---|
| Sense a need | idea radar + weekly panel (outward: what to build in the world); no weakness mining over the ledger; `/idea pick` never used (0 of 10 shortlists) | partial |
| Research | `web_search` 956 vs `fs_read` 6 + `shell` 39 in 90 d; no tool reads its own ledger, git log, `sessions.md` or ROADMAP | partial |
| Subagents | none; omp `task` excluded by `--tools` | missing (flag + a security build: children must cross the policy hook) |
| Summarise & propose | prose rule only; no options artefact | partial |
| Ask and wait | approval cards (TTL) or chat go-ahead; no decision survives a session reset | partial |
| Spec | nothing; the 2000-char `focus` field is the whole spec; repo write-denied | **forbidden-undesigned** |
| Spec review | nothing; the reviewer seat is bound to diffs | **forbidden-undesigned** |
| Plan | nothing; omp `todo`/plan mode excluded | **forbidden-undesigned** |
| Implement | real: Codex in a fresh worktree, guard, ≤ 3 refines, branch publish | present |
| Typecheck / tests | code-owned test gate, 300 s, red feeds the writer | present |
| Code review | one reviewer, one lens, writer ≠ reviewer | present (Claude Code runs 4 lenses + Codex) |
| Live gate | operator scripts only; no seam to gate a candidate build without touching the running process | **forbidden-undesigned** |
| Deploy | Paco's merge tap; red → reset before restart; no post-restart probe or auto-rollback | tapped (autonomous merge forbidden until S-3) |
| Push | `HOUGE_SELFWRITE_PUSH=false`; planner push is a card | tapped — **stays forbidden** |
| Learn | lessons, ratings (11, last 2026-09-25), memory; self-write outcomes not fed back | partial |

Four stages autonomous, two tapped, two forbidden as dangerous, **five forbidden only because nobody designed the safe
version** (decide, spec, spec review, plan, live gate) — the middle of the lifecycle. Where long autonomous runs break
in the literature: one early undetected error (recovered in 30.5% of runs, never detected in 38.5%) and premature
"done" (19% of failures); the cheapest counters are an oracle the model cannot satisfy by assertion and a plan artefact
re-read at every phase boundary — exactly (a) and (c).

## Evidence of real use (90 days)

Self-write: 18 proposals → 8 published / 9 failed (tests red 4, reviewer reject 4, unparseable 1); 8 self-write commits
on `main` (7 in July, 1 on 2026-10-02); 0 incidents caused by self-changes; `reload_marker` empty (merges landed by
hand). Approval cards 12; merge taps 7; ~20 governance decisions in total, none on a spec or plan. Volume: 3.4 Houge
turns/day against 546 Claude Code commits in 90 days — the evolution channel runs under 1% of the build channel, so
any promotion rule that needs N clean outcomes is a 6–8 week soak per class.

## What the evidence supports building

Only one self-improvement recipe has evidence outside benchmarks: **small bounded proposals + a hard external verifier
+ human merge**. Houge's self-write pipeline and the A1 lesson design already are that recipe; self-generated skill
libraries average −1.3 pp and drift. So the direction is not "more autonomy", it is "move Paco's tap from the diff to
the proposal, and give Houge the verifier and the memory to earn the next rung".

In order of value per risk:

1. **Goal record + decision card** (build gap). A `goals` table (plan file, phase, pending question) that outlives the
   turn; omp's `ask` routed to a Telegram option card (2–4 buttons, linked plan, recommendation marked); a parked goal is
   silent until the answer wakes it. Converts "decide" from a 189K-token "好" into a ledgered row.
2. **Proposal artefact as the approvable unit** (build gap; amends ADR 0011 §7, 0028 decision 3). A docs-only self-write
   profile writes `docs/superpowers/proposals/<run>.md` through the existing pipeline; Paco approves the proposal, and
   the approved proposal becomes the writer's task and the reviewer's spec. Closes four of the five undesigned stages.
3. **Verifier + outcome memory** (build gap; SP4's first bullet). `eval-replay.mjs` inside the test gate; the post-restart
   health probe (S-3) with auto-rollback; every self-write outcome written as a row the next proposal reads, failures
   becoming AVOID lessons. Precondition for any rung above "Paco merges".
4. **Trust ledger + per-class levels** (amends ADR 0011/0012). Levels 0 forbidden · 1 propose · 2 auto-to-branch,
   Paco merges · 3 auto-merge in a window with auto-rollback · 4 auto-merge + push. Promotion is code: N consecutive
   clean outcomes up one, one revert or incident down one. Code-computed blast radius sets eligibility; Jev may demote,
   never promote (ADR 0029 monotone rule).
5. **omp organs under the policy hook** (flag + probe): `todo` and plan files; `task` subagents only after probing that
   children inherit the single extension and cross the bridge gates; the Opus weekly cap, not the 2018 CPU, is the
   limit on fan-out.
6. **Planner-owned scratch worktree** (new ADR; hard line a). A test-runnable copy of Houge's code under `<data>` the
   planner may edit and test, with the code-owned gate kept; the one structural change that lets the planner iterate
   red → green on itself.

## What stays with Claude Code + Paco, and why

Multi-task slices (the defects that mattered lived between tasks; Houge's pipeline is one worktree, one writer call,
one reviewer, 300 s); the protected surface and trust boundaries (by invariant, and because the Criticals were found by
probing reviewers, not a tool-less pass); ADR-level decisions (Paco's hand); deploy until S-3 exists; and **publishing
to the public repo permanently** — ADR 0028 D12 already grants two legs of the lethal trifecta, the push is the third.

## Relation to the current builds

- ADR 0029 (Jev) gives this plan its demote-only risk signal and the decision-row habit.
- SP4 "self-evolution v2" is items 3–5 above; items 1–2 are the part SP4 did not name. Suggested order after lane 1 of
  the Jev layer: 1 → 3 → 2 → 4, each its own spec; 5 and 6 after a month of trust-ledger data.
