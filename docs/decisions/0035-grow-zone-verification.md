# ADR 0035: Grow zone and its verification — a place Houge writes himself, and the checks that decide what goes live

- **Status:** accepted — signed by Paco 2026-11-10 (spec approval, Rev 1.3; Rev 1.3.1 and 1.3.2 add plan-time errata that change no decision, plus `/grow trust`); amends [0011](0011-self-evolution-architecture.md), [0032](0032-omp-runtime-consolidated.md), [0034](0034-decision-ladder-consolidated.md) (and [0030](0030-decision-ladder.md)'s carried text), [0018](0018-kill-switch.md), [0031](0031-chat-carries-what-needs-paco.md); restates [0013](0013-llm-inner-composition.md)
- **Date:** 2026-11-10
- **Deciders:** Paco
- **Spec:** [2026-11-10-grow-zone-verification-design.md](../superpowers/specs/2026-11-10-grow-zone-verification-design.md) (Rev 1.3.2; §2 D1–D10, §2a P1–P3, §14 review record, §15 errata). Plan: [2026-11-10-grow-zone-1a.md](../superpowers/plans/2026-11-10-grow-zone-1a.md).

## Context

Houge's charter says he improves himself. The live system on 2026-11-10 said he did not:

| Fact (probed 2026-11-10) | Value |
|---|---|
| Skills in `skills/` | 3, all prose (two commanded 2026-07-28, one 2026-10-01) |
| `improvement_jobs` rows, ever | 0 |
| `improvement_proposals` rows | 0 |
| `improve_ticks` / `improve_signals` rows | 19 / 7 |
| Commits, last 30 days | 376 docs / 244 fix / 204 test / 196 feat, all built by the orchestrator |

Capability lands as hand-written TypeScript in `src/`, which only the build orchestrator touches. The orchestrator
evolves Houge; Houge does not evolve himself. The skills layer of ADR 0011 did not change that: a skill was authored
by a background job (`skill_author`: a routing gate, a model-run anchor gate, then Paco's tap), and nothing fed the
job.

Two halves are needed. Houge needs a place he may write without a build. And before he writes, the system needs a way
to decide what goes live that does not cost Paco's attention: an agent that iterates on itself without verification
produces volume, and the human pays for it in review.

Facts of the live system this builds on (probed): the omp planner reads skills only as whole bodies folded into the
system prompt by the composer (ADR 0032 4.2), unjudged; any wall read makes a turn `untrusted` and the level carries
with the conversation until `/fresh` (ADR 0034 8.3), and Paco's conversation had been `untrusted` since 2026-11-06;
no executor denies the network to a script, and Houge's matchers read a command line, never a script body (so
scripts are not in 1a, spec P1); the data dir is the repository root in the live deployment; the public repository
(`brahmasky/adventure`) must never hold personal text.

## Decision

Houge gets a **grow zone**: his own local git repository, never pushed, where he writes prose skills through one door
and reads them through another. What goes live is decided by code and by a reviewer of another model family, not by
Paco's tap. Slice 1a covers prose skills only; delegation (1b), script skills and cases (1c) and later slices follow.

Rules G1–G7 below are the checkable form. Each names its conformance test (`tests/adr/0035-grow-zone.test.ts` unless
stated). A rule changes only by a new ADR and Paco's hand, and its test changes in the same commit.

### G1. The kernel test

A file belongs in the kernel (`src/`, the full build flow of AGENTS.md) if it can weaken a floor, leak a secret, or
stop Houge running. Otherwise it belongs in the grow zone. Existing TypeScript features stay as built; the rule
applies forward. The orchestrator writes no grow-zone item except the exemplar in `grow-seed/skills/`.

Conformance: `ADR 0035 G1: the orchestrator seeds only the exemplar` (`grow-seed/skills/` holds exactly the exemplar
`option-comparison`). The rest of the rule is a placement rule: AGENTS.md carries the wording; the final review of a slice asks
"was this built in `src/` though it passes the kernel test?"

### G2. One write door, one read door, the daemon the only writer

- **Write door** `grow_submit({ name, description, example, body, anchors? })`: a bridge tool, content by arguments
  (no file is copied from the workspace, so there is no path, symlink or check-to-copy race). **Read door**
  `grow_read({ name, what? })`: returns the committed body (or, with `what: "review"`, the stored findings).
- The daemon is the only writer. Inside the daemon, only the publish operation (`src/grow/ops.ts`), the exemplar
  seeder and the one-shot migration write the repository. Nothing writes `<repo>/skills/`; the one-shot migration only renames it aside.
- The zone lives at `HOUGE_GROW_DIR` (default `~/Library/Application Support/houge/grow`), outside the code checkout.
  The override is accepted only when absolute, at least three segments deep, not the home directory or an ancestor of
  it, and overlapping neither the checkout, the data dir nor `~/.omp`. Every git call goes through the hardened
  wrapper (`src/run/git-hardened.ts`) with explicit `--git-dir` / `--work-tree`, and the toplevel is asserted before
  any call that discards or rewrites. A repository is created only for an empty zone; items present and `.git` gone
  is a fault that disables the write door with the incident `grow_zone_unavailable`.
- The grow root **and the backup folder** are read- and write-denied to every child, at both layers of ADR 0032 5.1
  (Seatbelt profile and policy hook path gate), through `secretPaths` in `src/omp/protected-paths.ts`. Read-denied,
  because a shell `cat` of a born-untrusted skill would otherwise read it without the taint `grow_read` applies; the
  backup folder holds the zone's bundle beside the DB snapshots.
- Backup: the grow tick writes `<snapshot>.grow.bundle` for the newest DB snapshot that has none
  (`git bundle create --all` to a temp name, `git bundle verify`, rename). A failed bundle opens `grow_backup_failed`
  (log) and never holds the DB backup back.
- The write door is the only tool that changes the zone from a turn; both tools take the plain branch of the bridge
  (G4). Both are armed by `HOUGE_SKILLS_ENABLED` (already a disarm flag) and `grow_submit` is refused with
  `grow_disabled` when `HOUGE_GROW_ENABLED` is off.

Conformance: `ADR 0035 G2: one door into the zone's repository` (no caller of `writeAndCommit` / `removeAndCommit`
outside `src/grow/ops.ts`); `ADR 0035 G2: nothing in src writes the old skills folder` (no `join(…, "skills")` in `src` outside `src/grow/`); `tests/adr/0032-grow-root-denied.test.ts` (read and write deny by function and in both
profiles, run with data dir different from the repo so it cannot pass on the repo deny).

### G3. Staged, then live on checks; no human gate; every live write a commit

- A submit runs the formal checks in milliseconds and never waits for a model. Formal checks, first failure ends:
  field rules (name slug 3–48, description one line 20–200, example one line 10–300, body 200–8,000 chars, at most
  eight anchors, 16 KB total, UTF-8, no control characters); a secret scan of every field (the judge redactor
  without link-token and code masking, plus the secret paths of ADR 0032 3.2 as literals; a failure never quotes the
  match); no fenced block of more than three lines that is not marked as prose (an exact procedure needs a script, and
  scripts arrive in 1c); no near-copy of a live item (same normalised description, or same normalised body hash).
- The answer is `LIVE` (a small update of a clean live item), `STAGED`, `FAIL <code>` or a refusal with a fixed code:
  `grow_disabled`, `turn_hostile`, `name_is_exemplar`, `rate_capped` (20 submits per rolling 24 hours), `zone_full`
  (200 items), `busy`, `zone_unavailable`.
- **Review is an enforced gate.** An item that needs review is reviewed after the turn ends by a one-shot seat on the
  role `grow_review` (no tools; three legs (Kimi, Gemini pro, Codex; the static rollback list holds Kimi and Codex): none is of the Claude family that runs the planner, and
  none draws on the Anthropic pool). The author's families are read at claim time from the run's successful `compose`
  `llm_attempt` rows; a leg whose family is among them is skipped; an unknown family fails closed. The review is a
  persistent queue claimed from the daemon's poll loop (`grow_staged`, `next_attempt_at`), at most one at a time;
  an outage retries after 1 h, 6 h, 24 h and then ends `review_unavailable`. The verdict must be the reviewer's whole
  reply (strict JSON, one optional code fence); anything else is a seat failure. A pass is stored
  (`grow_reviews`: content hash, hash of the exact input sent, model, the author's families, number of undo reasons
  shown) and moves the row to `approved`. **Publishing refuses a row that needs review and has no passing review of
  its exact content.** Nothing goes live unreviewed.
- Every live write is a commit (the content hash and run id in the message trailer), published through the
  operation log: one transaction marks the row `publishing`, the file is written to a temp name and renamed, the
  commit lands, a second transaction records the item as live and deletes the staged row. A crash anywhere is
  reconciled at the next poll and at boot; neither branch re-runs a review. Git is the truth for content, the database
  is the truth for state, origin, uses, undo reasons and findings.
- One version of a name is in motion at a time: a newer submit supersedes an older pending one, an undo cancels a
  pending one, and a submit or undo first settles a publish already in motion. A publish that fails twice becomes
  `failed` (`publish_failed`) with the incident `grow_publish_failed` (page) and an outcome line for Houge; it is not
  retried. Only a zone that cannot be asserted disables the door.
- The reviewer's `pass` is an **admission check on content**, not a gate on an action (ADR 0034 2.4). Refusing and
  publishing are code decisions. A reviewer talked into `pass: true` lets through an item that already passed the
  formal checks; a born-untrusted item it lets through still taints whoever reads it (G4).
- Undo: `/grow undo <name> [reason]` (and `houge grow undo`) restores the previous published version, or removes the
  item if it had none, by a new commit. The request is queued and the daemon's grow tick runs it within one poll cycle
  (the zone has one git writer); the request key is the Telegram trigger's, so a redelivery cannot undo twice. Each
  undo steps back one published version. A reason is always stored ("(no reason given)" when none), and every later
  review of that name receives every stored reason.
- `/changes` shows one line per publish and per undo (topic `grow_log`). No Telegram card, no trust tap, no push (the send-back ask of G4 is the one exception, and only in that continuation).

Conformance: `ADR 0035 G3: review is an enforced gate` (a publish of a row that needs review and has no passing review is refused);
`ADR 0035 G6: review by size and provenance` (a new skill is staged, never live on submit); the review
gate itself is also pinned by `tests/grow/service.test.ts` (`I1: an unreviewed row is never published and creates no
operation`, `I1: a passing review of superseded content does not approve the newer content`).

### G4. The trust rule: hostile refused, untrusted reviewed and marked, a marked item taints its reader

- **`hostile` conversation:** `grow_submit` is refused with `turn_hostile` in a preflight that runs before any trust
  ask. The turn's level is the live turn's when bound, else its `turn_trust` ledger rows (a carried level is one of them). `grow_submit` is
  on no trust ask list, so no card can put a hostile turn's skill live.
- **`untrusted` conversation:** accepted, always `STAGED` (never the small-update path), always reviewed, stored with
  `origin: untrusted`. There is no trust tap: ADR 0034 8.2's ask for `skill_author` is gone with the tool, and `grow_submit`
  never asks for trust at any level. One ask remains, and it is not about trust: after a Jev-rung send-back it asks like every side effect (`settleAsk`, ADR 0034 2.4, 2b-R7), because it is not on the read-only list (`effectiveAsk`, `src/decisions/trust-ask.ts`). `grow_read` never asks, not even then.
- **`clean` conversation:** `origin: clean`.
- **The mark is per name.** It is kept in its own table, so a removed item, a failed submission or a row in flight
  cannot lose it. A name's mark survives every later submit, pending or live, whatever level it comes from. Only Paco
  clears it: `/grow trust <name>` or `houge grow trust <name>`. A passing review never does.
- **`grow_read` of a marked item** (its body, or its review findings) raises the turn to `untrusted` before the text
  returns, through the trust cause `grow_read_untrusted` (`CAUSE_LEVEL` and `CARRY_LEVEL` both `untrusted`). Reading a
  clean item or the exemplar raises nothing. `grow_read` never asks, at any level. Its output is kernel text that
  passed the door, so it is not judged for injection (ADR 0034 7.1; a procedure would read as one).
- Both tools are on the bridge's plain branch (`PLAIN_TEXT_ENTRIES`), the branch `houge_status` uses, and never on the
  wall or judged-read branches.
- The skills index is part of the system prompt (G2's read door's companion): one line per live item, `name —
  description`, alphabetical, at most 40 lines and 4,000 chars, plus two fixed sentences. Alphabetical order keeps the
  prompt stable: the planner restarts only when the index text changes (an item added, removed or re-described, or the door switching), never when one is used.

Conformance: `ADR 0035 G4: the trust rule` (`grow_submit` never asks for trust at untrusted, and asks after a send-back;  `grow_read` never asks at any
level; reading a born-untrusted item is an untrusted cause that carries as untrusted; the grow tools take the plain
branch); `ADR 0035 G4 clause a: a hostile turn's grow_submit is refused in the preflight` (a bound getter, and the
ledger's `carried_hostile` with none bound); `ADR 0035: index stable order`; `tests/decisions/trust-ask.test.ts` (the ADR 0034 8.2
trust table, updated in the same commit as the rule).

### G5. The verifier is out of Houge's reach, and an undo reason cannot be deleted

- `src/grow` is in `PROTECTED_DIRS` (`src/capabilities/self-write-guard.ts`): a self-write cannot edit the door, the
  checks, the review gate or the publisher.
- The grow root and the backup folder are write-denied to the planner and to `bash` (G2).
- `HOUGE_GROW_ENABLED` is in `DISARM_FLAGS`; `/disarm` stops new submissions and new review claims. Under `/disarm`
  `HOUGE_SKILLS_ENABLED` is off too, so the index and both tools are off; `grow_disabled` is the answer when only
  `HOUGE_GROW_ENABLED` is off, and then `grow_read` still works. A publish whose commit already landed is still
  recorded; approved content not yet committed waits.
- Undo reasons and review rows are append-only: no code path deletes a `grow_undo_reasons` or `grow_reviews` row, and
  Houge has no tool that reaches the table.

Conformance: `ADR 0035 G5: the grow machinery is on the protected surface` (`src/grow` in `PROTECTED_DIRS`;
`HOUGE_GROW_ENABLED` in `DISARM_FLAGS`); `ADR 0035 G5: undo reasons and reviews are append-only` (no source file deletes or
updates a `grow_undo_reasons` or `grow_reviews` row).

### G6. What is reviewed is decided by code

- Every **new** item is reviewed. An update is unreviewed only when it is small: at most 20 changed lines and at most
  25% of the body (changed lines counted in order, so a reordering is a change), with `description`, `example` and
  `anchors` unchanged. Anything larger is reviewed as new.
- An item with a stored undo reason is reviewed on every later submit, whatever its size; a name undone once stays
  reviewed.
- A marked (born-untrusted) item is reviewed on every change, however small.
- The reviewer's input passes through the store's secret redaction (`redactForImprove`) and frames all of it as data:
  the item, the live version's body, the exemplar, the index of live items and every stored undo reason of
  that name.

Conformance: `ADR 0035 G6: review by size and provenance` (a new skill is staged; a small edit of a live clean skill is
live at once; an edit over the size limit is staged; any edit of a marked skill is staged, however small).

### G7. Schedule-born runs, and from 1b delegated children, cannot submit

A schedule-born run keeps `grow_read` and loses `grow_submit` from its `allowed_actions`
(`src/contracts/task-contract.ts`, the same strip that removes `schedule_task`). The bridge manifest is built once per
planner child from the global action list, so the tool is still listed; the refusal is per call by the run's contract.
A schedule-born turn also gets no grow outcome or hint lines in its `[context]`. Delegated children (slice 1b) take the
same strip.

Conformance: `ADR 0035 G4: a schedule-born run may read the grow zone but not submit to it (G7 provenance strip)` (the
test lives in the G4 describe block and names G7).

### Supporting decisions

- **Recurrence feeds a hint, not a job.** `improve.route` is unchanged and a `skill` verdict stays a valid outcome.
  Its effect changes (ADR 0034 10.3–10.5): a rule-rung recurrence, or an accepted `skill` proposal, records a grow hint
  (one `grow_hints` row, keyed once per recurrence, plus a `hint` row in `grow_events`). The hint reaches the planner as
  a code-built `[context]` line in that chat's next turn: `grow: a task of kind <category> keeps recurring; consider
  grow_submit`. At most three recurrence hints per rolling 24 hours; Paco's skill Accept is not capped. The planner decides. `improvement_jobs` and
  `skill_reverify_state` stay as tables with no reader or writer.
  Conformance: `ADR 0035 / ADR 0034 §10.4: recurrence gives a hint, never a job` (the improve tick and the improvement
  taps start no skill job and record a grow hint; a second test, `no source file inserts an improvement job`,
  finds no `insertImprovementJob(`, `startSkillJob(` or `enqueueFromRecurrence(` in `src` outside `run-store.ts`).
- **ADR 0013 restated, not changed.** Code owns the gates (the checks, the review gate, refuse and publish); the model now also owns the grow zone's content.
- **Skills leave the prompt as bodies.** The composer injects the index only (ADR 0032 4.2). Conformance:
  `ADR 0035: skills leave the prompt` (no `readScopeBlock` or `skillsReader` in `src`, so no source file folds skill bodies
  into a prompt).
- **Outcomes reach Houge** through a per-chat cursor over `grow_events`: the next turn's `[context]` carries one line per
  outcome (`grow: <name> is live`, `grow: <name> failed review (grow_read it with what "review" to see why)`), advanced only after the
  planner accepted the prompt that carried them.
- **Use is counted**, not acted on: each successful `grow_read` of a live item counts one use for that run. Acting on
  the count belongs to slice 3.
- **Exemplar and migration.** One prose exemplar, `option-comparison`, written by the orchestrator, reviewed as kernel
  code and kept in `grow-seed/skills/`; Houge cannot submit over its name. The three existing skills were migrated once,
  `origin: clean`, formal checks only (they were verified under the old gate and accepted by Paco); the old folder is
  renamed `skills.migrated-2026-11` and gitignored. A migrated skill's `example` is derived from its `when` line;
  nothing of Paco's skills is in the public repository.
- **Orphans.** An item in the repository but unknown to the database is listed `orphan` in `/grow`, kept out of the index,
  and adopted as untrusted by `houge grow adopt <name>` (queued like undo).
- **Surface.** `houge grow list | show | check | log | undo | trust | adopt`; Telegram `/grow`, `/grow undo`, `/grow trust`;
  `/skills` is an alias of the `/grow` list for one release; `/status` shows a review pending over a day, a disabled door, orphans.
- **Incidents (ADR 0031).** `grow_zone_unavailable` (page), `grow_publish_failed` (page), `grow_seed_failed` (log),
  `grow_backup_failed` (log); notification topic `grow_log` (log).

## Residuals

- **R1. Laundering through memory (accepted by Paco 2026-11-10 for 1a, Tier C).** Trust is carried by the conversation,
  not by facts or files. Episodic facts and wiki pages distilled from untrusted turns reach a clean turn's context
  without a mark, and a clean turn may read a workspace file an untrusted turn wrote if the injection judge passes it.
  Outside text can be laundered through memory into a clean turn and submitted as `origin: clean`; once reviewed, it is
  read back without taint. The same path reaches `lesson_write` today with no review, so the grow zone is no worse than
  lessons and adds a different-family review. Closing it needs provenance on memory itself, a slice of its own, named
  on the roadmap. Marking every Houge-written item `untrusted` would close it inside 1a but would turn every skill read
  into a trust downgrade; it was rejected.
- **The reviewer is a model.** A wrong but honest procedure can pass; the answer is undo, and the stored reason binds every
  later review. A small update of a clean item escapes review (20 lines, capped at 20 submits a day).
- **Personal detail that is not a secret** can be in a skill. It stays on this machine and goes to the reviewer's
  provider.
- **Undone text outlives the undo** in the database snapshots and the zone's bundle until they rotate.
- **`/ask` and `/research` carry no skills:** the one-shot command paths have no tools, so they cannot call `grow_read`.
  Every run in the 30 days before the change was an omp turn.
- **No pruning of unused items** until slice 3; the item cap (200) and the rate cap bound growth.

## Consequences

- Skill bodies leave the system prompt. The planner reads one when it judges it relevant. The scheduled news brief and
  the security report may apply their skills less reliably; the live gate checks a one-off schedule, and the next real
  08:00 fire is observed and recorded.
- The planner child restarts once per change to the index text (an item added, removed or re-described, or the door switching), as it does per lesson change.
- `/skills` (as a command with its own meaning), the `skill_author` tool, the anchor gate, the weekly re-verify and the
  skill job with its promotion step are gone. The recurrence sensor now feeds the planner.
- A decision made once and kept: the AGENTS.md invariant and the flow-by-zone rule (below) put new capability in the grow
  zone first and keep the heavy build flow for the kernel.
- Follow-ups: 1b (agent files on the same doors, sync `delegate`, quota broker), 1c (script skills with a case executor
  that denies the network), slice 2 (schedules, async jobs), slice 3 (post-turn nudge, the tick writing through the door,
  pruning by use, the weekly rollup). Success is judged 30 days after 1a and 1b are live, from `grow_events` (items
  Houge added; share failing formal checks and review; undo rate; share read at least three times) against the
  orchestrator's feature commits outside the kernel.

## Alternatives considered

- **Keep Houge's skill job and add a tap** (ADR 0011's gate). Rejected: nothing fed it, and a tap puts Paco back as the
  gate for every write, against the point.
- **Rebase onto Hermes or OpenClaw** (D1). Rejected: add a grow zone beside a small kernel instead.
- **Trust reading A (refuse unless the conversation is `clean`).** Rejected: Paco's conversation was `untrusted` since
  2026-11-06, so Houge could almost never write.
- **Trust reading B (a tap at `untrusted`).** Rejected: puts Paco back as the gate for most writes.
- **Scripts and cases in 1a.** Rejected (P1): no executor denies the network and no matcher reads a script body; a case
  executor is a kernel security build of its own (1c).
- **A file door (copy a workspace folder).** Rejected: symlinks, races and echoed secrets; content by arguments instead.
- **A synchronous review inside the turn.** Rejected: it outruns the 180 s frame watchdog.
- **Order the index by use.** Rejected: it would restart the planner child every turn.

## History

| Date | What changed | Spec | Signed by Paco on |
|---|---|---|---|
| 2026-11-10 | This ADR: G1–G7; amends ADR 0011 (skills gate), 0032 (D8, 4.2, 4.3, 5.1, 6.3, 7.1), 0034 (1.5, 2.1, 2.4, 5.1, 7.1, 8.1–8.3, 10.3–10.5), 0030 (carried text), 0018 (disarm flags), 0031 (routes) | [grow zone](../superpowers/specs/2026-11-10-grow-zone-verification-design.md) (Rev 1.3.2) | 2026-11-10 (spec approval) |
