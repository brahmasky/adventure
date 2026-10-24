# Decision ladder, stage 3 — pre-tool safety and read wall

- **Date:** 2026-10-24
- **Status:** draft for Paco's review
- **Spec series:** 2026-10-12 decision ladder (stage 1 §13 row 3; roadmap "migrate the remaining families onto the registry", decomposed per Paco's 2026-10-24 choice = family clusters, not one block)
- **Amends:** ADR 0030 (entries gain the pre-tool family; no new behavioural capability, so no ADR decision change beyond the entry inventory)
- **Prerequisite:** ADR 0030 cleanup (done 2026-10-24), which retired `decision_bar_stale`; model/version moves are now judged by the Jev version check.

## 1. Goal

Migrate the pre-tool decision family (and its read-wall neighbours) onto the decision
ladder's registry, so every one of them is recorded as a decision row, judged at the
same checkpoints, and eligible — where it is not locked — for improvement signals and
ladder moves. Behaviour is unchanged: existing functions become rung 1 (code rule),
exactly as stage 1's §6.2 prescribes. No new judge is armed at ship except where an
entry is already non-monotone and fail-open today (none in this cluster; see §4).

The concrete change a reader should notice: a blocked or allowed tool call, a refused
read path, an SSRF deny, a self-write guard tripping, a budget fuse, a read-wall
application, and a bash class now each leave a `decisions` row with an entry id and a
verdict, instead of being a silent branch.

## 2. Scope (and what is explicitly NOT this stage)

In scope — ten inventory rows from `docs/superpowers/specs/2026-10-12-decision-ladder-design.md` §6.1:

| Entry id            | Inventory row                     | Locked? | Existing seam                                              |
|---|---|---|---|
| `tool.manifest`     | B2+B7  tool manifest              | no      | `src/omp/bridge-handler.ts` tool-list filter / manifest     |
| `tool.policy`       | B10+B19 tool policy               | no      | `src/policy/capability-policy.ts`                          |
| `tool.shell_class`  | B11 bash class                    | no      | `src/omp/command-matcher.ts` `classifyCommand`             |
| `tool.path`         | B16+B17 gate path                 | yes (L) | `src/omp/gate-path.ts` `gateTargets`                       |
| `tool.budget`       | B15 per-tool budget               | no      | global budget ledger / tool budget check                   |
| `fetch.ssrf`        | B22 SSRF on fetch                 | yes (L) | fetch tool SSRF check                                      |
| `selfwrite.guard`   | B25 protected-path guard          | yes (L) | `src/capabilities/self-write-guard.ts`                     |
| `tool.wall`         | C1+C4 reader wall (which cross)   | yes (L) | bridge read-side crossing decision                         |
| `reader.family`     | C3 reader model family            | no      | reader chain selection                                     |
| `posture.kill`      | B6 kill-switch floor              | yes (L) | intake/authority kill floor                               |

Out of scope, later stages (named so the spec review cannot creep):
- Intake: `intake.sender`, `intake.rate_limit`, `intake.rating_reply`, `intake.budget_fuse`, `intake.steer_or_queue`, `intake.bare_ack`.
- Pre-model: `turn.contract`, `lookup.rewrite`/`lookup.thin`, `turn.model`, `context.lessons`, `context.recall`, `context.catch_up`, `turn.clarify_cap`, `memory.rule_save`.
- Supervision: `planner.crash_guard`, `turn.retry`.
- Settle/notify: `attach.path`, `secret.redact`, `notify.page`.
- `memory.lesson_admit`, `schedule.admit` (stage 4, with trust/standing approvals).
- No Jev rung is added for any entry in this cluster (§4).

Locked entries remain *code-rule-only, forever*, per ADR 0030 §6.1 and the `LOCKED_ENTRY_IDS` table; the registry test rejects a judge on a locked id.

## 3. Move, don't improve (§6.2 restated for this cluster)

For every entry in §2:

1. **Pin.** A characterisation table `input → today's verdict` covering every existing test corpus, plus a fuzz/edge slice. For `tool.shell_class` and `tool.path` the inventory already demands the corpora (`omp/command-matcher.ts` known patterns + known misses; `gate-path.ts` every form), and these become the first task's exit criterion.
2. **Wrap.** The existing function, unchanged, becomes rung 1 (code rule). The runner calls rung 1; rung 1 returns the same value the caller got today. No internal change.
3. **Record.** Every invocation writes a `decisions` row with `entry`, `rung: "code"`, `verdict`, `stage` derivable from the entry id, inside the existing transaction so a rolled-back action rolls back its row. The recorded `reason` is always a closed code from the entry's `reasonCodes` (or `null`); raw paths, commands or URLs are never stored, even on a block.
4. **Deny ladders (locked only).** Locked entries declare no judge and no ladder move; `insertLadderMove` refuses them regardless of stage. This is already enforced from stage 1 for the ids in `LOCKED_ENTRY_IDS`; this stage *adds* the pre-tool locked ids to that set is not needed because they are listed there already (`tool.path`, `fetch.ssrf`, `selfwrite.guard`, `tool.wall`, `posture.kill`, `turn.trust`).

Deliverable test of success for a single entry: the characterisation snapshot (todays outputs) equals the post-migration outputs on the same inputs, and a new `decisions` row appears for each invocation in the test DB.

## 4. No new judges at ship (R6 / proven policy)

Every entry in this cluster ships *armed on its code rule only*. R6 ("all new judges armed at ship") does not require a Jev rung to exist; these entries have none until a later stage proposes one, and that proposal must clear R12/R13 plus a calibrated row.

This is deliberate: the safety-critical locked entries are defined by the rule "code decides, the model never does" (ADR 0030 §6 decision 3, monotone rule). A non-locked entry in the cluster (e.g. `tool.policy`, `reader.family`) *could* take a judge later, but none is proposed here. Keeping them code-only in stage 3 keeps the diff to behaviour-free plumbing and lets the soak produce real outcome labels (the per-entry health line) before anyone designs a rung for them.

Bars: none added; no provisional bars, no golden items, and the invariant sweep is unchanged (no new judge means no new bar). If Paco wants a judge on any of these entries, that is a separate, later spec.

## 5. Seam map (what touches what)

- `src/omp/bridge-handler.ts` — tool manifest/deny for `tool.manifest`, `tool.policy` consult, read/wall crossing for `tool.wall`, `reader.family`.
- `src/policy/capability-policy.ts` — `tool.policy`.
- `src/omp/command-matcher.ts` (pure function, no I/O) — `tool.shell_class`; already exported, already tested. Easiest characterisation target.
- `src/omp/gate-path.ts` (pure function) — `tool.path`; already has `tests/omp/gate-path.test.ts`.
- `src/capabilities/self-write-guard.ts` — `selfwrite.guard` (protected file: Paco's hand; migration must not change its content, only its call site recording).
- fetch SSRF check site — `fetch.ssrf` (locate at spec review).
- budget code — `tool.budget`.
- `src/omp/tool-approval-sink.ts` / approval cards — `posture.kill` floor.
- `src/decisions/`: `entry-ids.ts` (add the ten ids), `registry.ts` (ten entries, all `locked` for the five L, `armed: on` for all, rung 1 = wrapped function reference), `entry-types` unchanged.
- `src/jev/decide.ts` and the runner are unchanged in signature; only add entry ids is not a change to them.

`self-write-guard.ts` is a protected file (AGENTS.md). The migration adds a `decisions` write at its *caller*, not inside the guard. The guard's own function signature stays byte-for-byte. This boundary is the whole point of the rule.

## 6. Transaction and recording shape

Reuse stage 1's queued-row pattern (decision rows queued at decide time, written inside the existing transaction) so a denied/errored action does not leave a half row. Each wrapped call returns `{ verdict }` for the runner and the original raw value for the caller, unchanged. No new DB migration is expected: `decisions` already exists from stage 1 and its columns take any entry id; if a column has an enum, it is widened (additive, per R13).

## 7. Characterisation snapshots

- One table per entry in `tests/decisions/<entry>.test.ts` (or next to the seam's existing test file where one exists, following the local convention of the more recent tests).
- `tool.path` and `tool.shell_class` reuse their existing corpora first; gaps (the known-miss lists) become new cases.
- `selfwrite.guard` and `tool.wall` and `fetch.ssrf` and `posture.kill` use a planted-adversary corpus: a fixed set of paths/commands/reads that today are blocked and a fixed set that today pass, plus a boundary each. Both sets must keep their verdict after migration (a blocker otherwise).
- Golden-set / bars: unchanged.

## 8. Gates

- `npm run typecheck && npm test && npm run build` clean, hermetic (PINNED_ENV for any new flag — none expected; R13 forbids an off switch, so no `HOUGE_*` flag is added).
- Rollback check: previous build boots on the migrated DB (additive only), via `scripts/check-decisions-rollback.mjs` pattern or its stage-3 equivalent — the final task proves it and commits the path.
- Live gate: a new `scripts/live-gate-ladder-stage3.mjs` exercising each entry with one allowed and one blocked example over real omp, asserting the row landed and the behaviour is unchanged (no new approval card shapes, no new pages).
- Independent review: correctness, security, testing, codex whole-diff, per global build flow §5. Adversarial on `tool.path` and `tool.shell_class` specifically (parser miss classes).

## 9. Risks and guards against them

- **Scope creep (outcome-mutation temptation).** Migration must not "improve" a branch. Every task's checklist property: the characterisation snapshot passes byte-for-byte before and after; if a test changes, the task fails spec compliance.
- **Protected-file violation.** `self-write-guard.ts` is touched by no edit; enforcement is a reviewer check (diff must be empty for it) plus the guard tests (unchanged) still green.
- **Hidden coupling.** `tool.manifest`/`tool.policy` influence which tools omp sees; recording must happen after the decision, not inside the filter's hot predicate if that changes allow/deny. If recording there is not transaction-safe, the fallback is to record at the bridge's decision point (rung 1 returns; bridge calls recorder separately) and document which — an explicit open question for the plan's Task 1.
- **Stage-1 precedent.** Stage 1's §"R13 removes the off switch" and rollback proof is the template; the final task is the rollback check, not afterthought.

## 10. Success criteria (Paco can observe)

- `houge` (CLI) `decisions` shows the ten entry ids among registered entries; `entryProblems` clean.
- Every blocked tool/SSRF/self-write/path/read in a week shows up as a row with a verdict, where today it vanished.
- No approval card wording changes, no new pages, no new flags; the approval budget is unchanged.
- Suite count rises by the characterisation corpus; zero skipped tests.
- Kickstart only (daemon runs built JS); no migration is required to roll back (revert + rebuild + kickstart).

## 11. Deliverables

- Spec (this file), committed.
- Implementation plan via `writing-plans` (next step after Paco approves the spec).
- ADR 0030 is already amended (2026-10-24 cleanup); no further ADR change unless an entry gains a judge (none here).
- `tasks/todo.md` top block updated on ship; `sessions.md` entry appended.

Spec self-review: scope is bounded to one family cluster; no TODO/TBD; no new judges or flags, which keeps it revertible (R13); ambiguity avoided by listing excluded families explicitly.

User review gate: please review this spec and let me know of any changes before we move to the implementation plan.