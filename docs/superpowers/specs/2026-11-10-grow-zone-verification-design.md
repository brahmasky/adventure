# Grow zone, slice 1a — a place Houge writes itself, and the checks that decide what goes live

**Rev 1.0 · 2026-11-10 · status: DRAFT, not reviewed, not approved.** Written with Paco in chat 2026-11-10
(decisions D1–D10 below are his). Next: spec-review-senior against the live system and a codex design pass; no
code until every blocker is closed and Paco approves the reviewed spec. This spec changes what ADR 0011 and
ADR 0032 mean (§8), which is Tier C: it lands only on Paco's approval.

## 1. Why

Houge's charter says he improves himself. The live system on 2026-11-10 says he does not:

| Fact (probed 2026-11-10) | Value |
|---|---|
| Skills in `skills/` | 3 (two commanded on 2026-07-28, one on 2026-10-01) |
| `improvement_jobs` rows, ever | 0 |
| `improvement_proposals` rows | 0 |
| `improve_ticks` rows / `improve_signals` rows | 19 / 7 (most ticks: 0 groups) |
| Commits, last 30 days | 376 docs / 244 fix / 204 test / 196 feat, all built by the orchestrator |
| Source / tests / docs | 62k / 87k / 129k lines |

Paco's finding: **capability lands as hand-written TypeScript in `src/`, which only the build orchestrator
touches, so the orchestrator evolves Houge and Houge does not evolve himself.** The existing skills layer (ADR
0011) did not change that. A skill is prose only, it is authored through a background job (`skill_author`: Gate A,
then a model-run anchor gate, then Paco's tap), and nothing feeds that job.

The fix has two halves. Houge needs a place he may write without a build. And, before he writes anything, the
system needs a way to decide what goes live that does not cost Paco's attention: an agent that iterates on itself
without verification produces volume, and the human then pays for it in review ("verification tax").

## 2. Decisions (Paco, in chat 2026-11-10)

- **D1** Keep Houge; do not rebase onto Hermes or OpenClaw. Add a grow zone beside a small kernel.
- **D2** Kernel test: *can this file weaken a floor, leak a secret, or stop Houge running?* Yes: kernel (`src/`,
  full build flow). No: grow zone. Existing TypeScript features stay as built; the rule applies forward.
- **D3** The grow zone is its own local git repository under the data dir, never pushed (the code repo is public).
- **D4** No human gate on a grow-zone write. A write lands in staging and goes live only when the checks pass
  (this replaces the earlier "free write": still no approval, but never live on Houge's say-so). Every live
  write is a commit, one command reverts it, and it shows in `/changes`, not as a Telegram push.
- **D5** Only the planner writes. A turn that saw raw outside text cannot write in that turn.
- **D6** Verification follows three practices: a map of what exists plus a CLI that drives and checks an item
  (poteto's verification skill); risk tiers set by code, model review only where the tier asks for it, every miss
  turned into a check (the Claude Code team's review practice); whatever a script can decide, a script decides
  (yetone's loop). The two strongest levers are good examples to copy and formal checks.
- **D7** The verifier is out of Houge's reach: the pipeline is kernel code, and an item's saved cases are
  append-only for Houge.
- **D8** Multi-agent comes by delegation: sync `delegate` first (slice 1b), standing agents and async jobs after
  (slice 2). Children are barred from the Anthropic pool, which Paco's own Claude Code shares.
- **D9** Slice 1 is split: **1a** (this spec) builds the grow zone and the verification pipeline and proves them
  on skills, which already run today; **1b** adds `delegate`, agent files and the quota broker on the same pipeline.
- **D10** Success is measured after 30 days by the grow zone's own numbers (§11), not by slices shipped.

## 3. Scope

**In 1a:** the grow-zone repository and its layout; the skill item format (prose, optionally with scripts); the
write door (`grow_submit`); the verification pipeline with tiers, cases, a reviewer seat and a fix-cycle cap; the
write guard (planner cannot write the zone directly, taint rule, append-only cases); loading by index with
read-on-demand and a use count; `houge grow` CLI and `/grow`; the `/changes` line; two exemplar skills; migration
of the three existing skills; unarming the old `skill_author` door; the ADR and AGENTS.md changes.

**Not in 1a:** `delegate`, agent files, quota broker (1b). Schedules, async jobs, pacing (slice 2). The post-turn
nudge, the daily tick writing to the grow zone, pruning by use, deleting the old skill-author code (slice 3).
Rewriting any existing TypeScript feature as a skill.

## 4. The live system this builds on (probed, not assumed)

- Skills today: `skills/<scope>/<name>.md` under the project root (gitignored), frontmatter `name, scope, when,
  anchors, version, score, last_verified`; `SkillStore` (`src/skills/skill-store.ts`) folds up to
  `HOUGE_SKILL_MAX_PER_SCOPE` (4) whole bodies per scope into the prompt (`readScopeBlock`), alphabetical, the
  rest dropped. The omp planner gets both scopes concatenated (`src/omp/turn-context.ts`).
- The planner's built-in tools are `read`, `edit`, `write`, `todo` plus bridge tools
  (`src/omp/extension/houge-policy.ts`); `bash` is a bridge tool that runs daemon-side under `sandbox-exec`
  with the floor-A denies (ADR 0032 D12).
- `tool.shell_netread` (`src/decisions/entries/shell-netread.ts`) decides in code whether a shell command reads
  the network; a network verdict raises the turn's trust state (`turn.trust.raise("shell_netread", …)`,
  `src/omp/bridge-handler.ts:486`). The four read tools sit behind the reader wall (ADR 0032 D3).
- `skill_author` is an armed bridge tool (`src/omp/tools/skill_author.json`) that starts the background job.
- A `reviewer` role exists (`src/omp/model-roles.ts`: Kimi high, then Opus through Antigravity), and one-shot
  seats run with `--no-tools` (`src/llm/providers/omp.ts`).
- A sealed-run room exists (`src/omp/cleanroom-run.ts`, network denied by `CLEANROOM_NETWORK_RULES`).
- The data dir is `options.omp?.dataDir ?? projectRoot`; chat workspaces are `<data>/omp/workspace/chat-<id>`.

## 5. Design

### 5.1 Layout

```
<data>/omp/grow/            its own git repository; created at boot if absent
  skills/<name>/
    SKILL.md                frontmatter + prose (the standard skill shape)
    scripts/…               optional; bash or node only in 1a
    cases/<id>.json         saved cases, append-only for Houge
  MAP.md                    generated by the kernel after every commit; never hand-written
<repo>/grow-seed/skills/…   exemplars, in the public repo, kernel-owned (§5.12)
```

`agents/` and `schedules/` are added by later slices. The grow root is read-allowed and **write-denied** to the
planner and to every sandboxed child, at both layers ADR 0032 uses for protected paths: the Seatbelt profile and
the policy hook's path gate. The daemon is the only writer.

### 5.2 A skill item

`SKILL.md` frontmatter, all validated by code:

| Field | Rule |
|---|---|
| `name` | slug `[a-z0-9-]{3,48}`, equals the folder name |
| `description` | one line, 20–200 chars: when to use it. This is what the planner sees in the index |
| `example` | one line: a request this skill answers. Required, so the map always says how to exercise an item |
| `effects` | `none` or `network`. What the item's scripts do; checked against the scripts (§5.5) |
| `anchors` | optional list, kept from ADR 0011 for skills that rest on world facts |
| `exemplar` | set only by the kernel on seeded items |

Body: the procedure, at most 8,000 chars. An item holds at most 20 files and 64 KB in total. A script is called
from the body as a plain command (`bash <grow>/skills/<name>/scripts/x.sh …`), so it runs through the planner's
ordinary sandboxed `bash`: a skill script gains no privilege the planner did not already have.

`cases/<id>.json`: `{ "run": ["scripts/x.sh", "arg", …], "exit": 0, "stdout_match": "<regex>" }`. `run` is an
argv relative to the item folder, executed without a shell. An item with scripts must hold at least one case.

**A limit, stated plainly:** a prose-only skill has no behaviour a script can test, and all three of today's
skills are prose-only, so most new ones will be too. Formal checks can confirm only its shape. Three things
answer that (open decision O1, §12a): every **new** item is read by the reviewer seat whatever it contains
(§5.5), the reviewer's task for prose is concrete (§5.7), and stage 1 fails a prose skill whose body contains a
fenced command block of more than three lines, with the message "move this into `scripts/` and add a case", so
the exact part of a procedure ends up where a case can pin it. Proof by use (§5.9) comes after, not instead.

### 5.3 The write door

One new bridge tool, `grow_submit`, side-effect level `local_write`, armed only for the planner:

```
grow_submit({ kind: "skill", name, from })   // from: a folder inside the chat workspace
```

The planner drafts the item in its own workspace with the tools it has, then submits the folder. The daemon
copies it into a staging directory outside the grow root, runs the pipeline (§5.4), and on PASS copies it into
the grow root and commits (`author: Houge`, message `skill(<name>): add|update — run <run_id>`). The tool returns
`PASS` with the tier, or `FAIL` with the stage, the failing line, and the path of the nearest exemplar. Nothing
else writes the grow root.

Refused before any check, each with a fixed code: `grow_disabled` (§5.15), `turn_untrusted` (§5.8),
`name_is_exemplar`, `parked` (§5.6), `rate_capped` (20 submits per local day), `zone_full` (200 items).

### 5.4 The pipeline

Cheapest first; the first failure ends the run. Stages 1–3 spend no model tokens.

1. **Form.** Frontmatter rules of §5.2; file count and sizes; allowed extensions (`.md`, `.sh`, `.mjs`,
   `.json`); no symlinks; secret scan (the patterns the log redactor already uses, plus the secret paths of ADR
   0032 §3.2 as literals); `bash -n` / `node --check` on every script.
2. **Ratchet.** On an update, every existing `cases/*.json` must be present and byte-identical (§5.6).
3. **Cases.** Every case runs in the sandbox (§5.7 says which), 10 s each, 60 s per item; exit code and
   `stdout_match` must hold.
4. **Tier** (§5.5), decided by code.
5. **Review**, medium tier only (§5.7).

Each run writes one `grow_events` row with the stage reached, the result and the evidence digest (§5.14).

### 5.5 Tiers

Decided by code from what the staged item contains:

- **Low**: an update to an existing prose-only item that stays prose-only. Live after stages 1–2.
- **Medium**: every new item; any script; an update that adds or changes a script; an item whose name was
  reverted before (§5.6). Live after stages 1–3 and a passing review.
- **Refused** (`tier_high`): a script line that `tool.shell_class` classifies as an external write or a
  destructive delete, or that `tool.shell_netread` cannot read statically (`eval`, `-c`, code on stdin). Such a
  capability is not grow-zone material in 1a; the refusal says so.

The declared `effects` must match the scripts: every script line is run through `tool.shell_netread`; a
`network` line under `effects: none` fails stage 4. `effects: network` is allowed (a skill may fetch), and it is
what makes the runtime rule of §5.8 possible.

### 5.6 Cases, reverts and the cycle cap

- **Append-only.** Houge may add cases. He may not change or delete one. A changed script must still pass every
  saved case. This is the answer to an agent that edits its own verifier: the pipeline is kernel code, and the
  cases only accumulate. Deleting a case is Paco's action (`houge grow drop-case <name> <id>`).
- **Revert.** `/grow undo <name>` (or the CLI) reverts the item's last commit, or removes the item if that was
  its first, by a new commit. Paco may add a reason. The reason is stored, the next submit under that name is
  medium tier whatever it contains, and the reviewer is shown every stored reason.
- **Cycle cap.** Three consecutive FAILs for one name park it: further submits return `parked` until
  `/grow unpark <name>`. One line in `/status`, no push.

### 5.7 The reviewer seat and the sandbox

**Reviewer.** A one-shot seat on the `reviewer` role, no tools. Input: the staged files, the diff against the
live version, the case results, stored revert reasons, and the nearest exemplar. For a prose skill the task is
fixed and concrete: work the item's own `example` through the procedure step by step, then report any step that
is wrong, missing, ambiguous or not checkable, any stated fact it believes false, and whether an existing live
item already covers the same ground (the index is in its input). Output: strict JSON
`{ "pass": boolean, "findings": [{ "file", "line", "problem" }] }`, validated; anything else counts as a seat
failure. The reviewer's family must differ from the family of the model that ran the authoring turn; when the
first leg matches, the next leg is used. A seat failure or outage leaves the item staged as `review_pending`; the
daily tick retries it once per day for three days, then marks it failed. It never goes live unreviewed, and the
outage shows in `/status`.

The reviewer reads text Houge wrote. Its prompt frames the item as data, and its only power is a boolean: a
reviewer that is talked into `pass: true` lets through an item that already passed stages 1–4, which is the same
residual a low-tier item carries.

**Sandbox for cases.** Cases run through the same `sandbox-exec` shell path the planner's `bash` uses, with the
floor-A denies, with network denied, in a copy of the staged item. So running a case gives the item nothing the
planner could not have done itself in the turn that wrote it. Whether the sealed room (`cleanroom-run.ts`) is the
right executor or the plain shell adapter with network rules added is a question for the spec review to settle
by probing (§12).

### 5.8 The taint rule

`grow_submit` is refused with `turn_untrusted` when the turn's trust state has been raised by `shell_netread`
(raw network output reached the planner in this turn). Reader digests from the four wall tools do not raise it;
that is ADR 0032 D3's line, unchanged.

At run time, a `bash` command whose program path lies under a grow-zone item with `effects: network` is treated
as a network read by the same code path: the turn's trust state is raised. So a skill cannot be used to fetch
raw text and write a new skill in the same turn.

### 5.9 Loading, and proof by use

- The prompt gets an **index**, not bodies: one line per live item (`name — description`), most-used first, at
  most 40 lines and 4,000 chars, plus one sentence saying where the files are and that the grow zone is Houge's
  to extend through `grow_submit`. The planner reads `SKILL.md` with `read` when it decides to use one. Scopes
  are dropped (the omp planner already receives every scope).
- A `read` of `<grow>/skills/<name>/SKILL.md` counts one **use** for that item in that run (the policy hook
  already sees every built-in path). `MAP.md` and `/grow` show uses and the last-used date.
- A new item is **on probation** until three uses in runs that did not end in a correction signal
  (`improve_signals` rows for that run). 1a records and shows this; pruning on it belongs to slice 3.

### 5.10 The map and the CLI

- `MAP.md` is generated from frontmatter and the DB after every commit: per item, description, example, tier,
  effects, case count, state, uses, last verified. Because it is generated, map and files cannot drift; the
  required `example` field is what a hand-kept map's parity check would otherwise enforce.
- `houge grow list | show <name> | verify <name|--all> | log | undo <name> [reason] | unpark <name> |
  drop-case <name> <id>`. `verify` runs stages 1–3 against the live item and prints PASS, or FAIL with the
  failing line; it is the same code the door runs, and the daily tick runs `verify --all` so an item that stops
  passing (a tool moved, a case rotted) is parked and shown in `/status`.
- Telegram: `/grow` (list with state and uses), `/grow undo <name> [reason]`, `/grow unpark <name>`. `/skills`
  stays as an alias of `/grow`; its `retire` / `restore` forms answer with the `/grow undo` hint.
- `/changes` gains one weekly line: added, updated, rejected by checks, reverted, parked, used.

### 5.11 Exemplars and migration

- **Exemplars.** Two skills written by the orchestrator to a high standard and reviewed like kernel code, in
  `grow-seed/skills/` in the public repo (so they hold nothing personal): one prose-only, one with a script and
  cases. At boot the kernel copies a missing or changed exemplar into the grow zone and commits it. Houge cannot
  submit over an exemplar's name. The index sentence and every FAIL result point at them.
- **Migration.** A one-shot, idempotent boot step moves the three existing skills to
  `skills/<name>/SKILL.md` (`when` → `description`; `anchors` kept; `example` written by the orchestrator in
  the migration data, since three files is cheaper to write than to derive), runs stages 1–2, and commits. The
  old `skills/` folder is left in place, renamed `skills.migrated-<date>`.

### 5.12 The old door

`skill_author` is removed from the bridge manifest and the tick stops queueing skill jobs, so there is exactly
one way into the grow zone. `HOUGE_SKILL_REVERIFY_*` and the job tables stay untouched and unused. Deleting
that code (`skill-author`, `skill-router`, `skill-reverify`, `promote`, `core/skill-job`, the `/skills` job
cards) is slice 3's work, together with the tick's rewiring; 1a deletes nothing it does not replace.

### 5.13 State

Migration 43:

- `grow_items(name PK, kind, tier, state CHECK IN ('live','review_pending','parked','removed'), effects,
  fail_streak, uses, last_used_at, last_verified_at, head_commit, created_at, updated_at)`
- `grow_events(id PK, at, run_id, name, action CHECK IN ('submit','verify','undo','unpark','drop_case','seed',
  'migrate'), stage, result, code, tier, reviewer_model, evidence_digest, reason)`

Git is the truth for content; the DB is the truth for state and counts. A boot reconcile compares
`head_commit` with the repository and repairs the DB from git, never the reverse.

### 5.14 Configuration

- `HOUGE_GROW_ENABLED`: default `on` after the live gate; `false` refuses every `grow_submit` with
  `grow_disabled` and drops the index sentence about writing. Reading and using live items continues.
  `/disarm` forces it off, as it does `HOUGE_SKILLS_ENABLED`, which keeps its meaning (no skills in the prompt).
- No other env var. Caps (20 submits a day, 200 items, sizes, timeouts, 40-line index) are code constants.

### 5.15 Failure handling

Every pipeline exit is one fixed code; none throws into the turn. A crash between "copied to the grow root" and
"committed" is repaired at boot (`git status` in the grow root: uncommitted changes are discarded, the staged
copy is re-run). A missing `git` binary, an unwritable data dir, or a corrupt repository disables the door with
an incident and leaves reading untouched. A failing reviewer seat never blocks a low-tier write (a prose update); a new item waits for it.

## 6. Threats and what answers them

| Threat | Control | Residual |
|---|---|---|
| Injected text becomes a persistent skill | Reader wall (unchanged) + taint rule §5.8 + reviewer on anything with a script | A reader digest that carried an instruction can still shape a prose skill; low tier, visible in `/changes`, one-command revert |
| A script hides an external write from the `/approve` matcher | Stage 4 classifies every script line with the same code that gates `bash`; unreadable forms refused | The matcher is best-effort (ADR 0032 D12); a form it misses in `bash` it misses here too. Not widened: the planner can already write and run a script in its workspace |
| Houge weakens his own checks | Pipeline in kernel; cases append-only; grow root write-denied to the planner | A weak first case set. Answered over time by reverts forcing review |
| Secrets written into the zone | Stage 1 secret scan; the zone is never pushed; floor A already denies reading the secret paths | Personal detail that is not a secret can land in a skill; the repo is local |
| The zone fills with unused items | Rate cap, item cap, probation shown in `/grow`; pruning in slice 3 | Until slice 3, growth is bounded but not pruned |
| A bad skill degrades answers | Index-only loading (a skill acts only when the planner reads it), probation, `/grow undo` | Detection depends on correction signals, which are sparse today (7 in 19 ticks) |
| Hard line (a): Houge's own operation | The door fails closed on any error; reading is independent of writing; no grow-zone file is executed by the daemon outside the sandbox | — |

## 7. What Paco sees

No cards, no pushes. `/grow` on demand; one weekly line in `/changes`; `/status` lines for a parked item, a
pending review older than a day, or a disabled door. A grow-zone event reaches Telegram unasked only as an
incident (door disabled, repository corrupt).

## 8. Rules this changes

- **New ADR 0035, "Grow zone and its verification".** Records D1–D7 and D9 as rules G1–G7: the kernel test;
  one write door; staged-then-live with no human gate; planner-only and the taint rule; verifier out of reach
  (kernel pipeline, append-only cases); tiers decided by code; children of a later `delegate` never write.
- **ADR 0011 (three layers) — amended.** The skills layer's gate changes from "anchor assertions run by a
  walled model, then the user" to "formal checks and saved cases, then a different-model reviewer where the tier
  asks". ADR 0011's reason for rejecting trajectory-distilled skills (they encode one model's behaviour and fail
  on transfer) still holds, and holds more strongly once other models run skills in 1b: this spec meets it with
  scripts and cases, which are model-independent, not with the anchor ensemble. `anchors` stay as an optional
  field.
- **ADR 0032 — amended.** D8's tool set loses `skill_author` and gains `grow_submit`; §5.1's protected paths
  gain the grow root (write-denied, read-allowed).
- **ADR 0013 — restated, not changed.** Code owns the gates; the model composes between them, and now also owns
  the grow zone's content. Every gate in this spec is code.
- **Conformance tests in `tests/adr/`, one per checkable rule:** `0035-g2-one-door` (no code path writes the grow
  root except the door, the seeder and the migration), `0035-g4-taint` (an untrusted turn's submit is refused),
  `0035-g5-append-only` (a changed or missing case fails), `0035-g6-tier-by-code` (a script forces review; an
  external-write line is refused), `0032-grow-root-denied` (profile and hook both deny a planner write).
- **`AGENTS.md` — Paco's hand.** Build flow: the full flow for the kernel and the protected surface; for other
  `src/` code, tests + one different-model review + live gate, with a spec and ADR only when a rule changes; the
  grow zone has no build flow. Invariants gain: "new capability starts in the grow zone; it moves into `src/`
  only when it fails the kernel test". The exact wording is drafted on the branch for Paco to sign.

## 9. Tests

Hermetic, real SQLite and a real temp git repository: each pipeline stage's pass and every fixed failure code;
tier decisions over fixture items; ratchet (changed case, deleted case, added case); cycle cap and unpark;
revert of a first commit and of an update; reviewer JSON validation, family-differs rule, outage →
`review_pending` → retry → failed; taint refusal; network-skill run raises trust; index rendering and caps; use
counting; boot reconcile and crash repair; migration idempotence; exemplar seeding and name protection;
`/grow`, `/changes`, `/status` renders; docs parity for the new commands and env var.

## 10. Live gate (`scripts/live-gate-grow.mjs`, real daemon, Paco's chat)

PASS only if every line holds; "got an answer" is not a pass.

1. Paco asks in Telegram for a skill with a small script, and for a second, prose-only one. Houge drafts it, submits it, the reviewer runs on a
   non-author family, and the item is live: `grow_events` shows stages 1–5, the repository shows one commit.
2. In the next turn, a request matching the skill makes the planner read `SKILL.md` and run the script; uses = 1.
   No build and no restart happened between 1 and 2 (same pid).
3. A direct `write` and a `bash` redirect into the grow root are both denied.
4. A turn that ran `curl` and then calls `grow_submit` gets `turn_untrusted`.
5. An update that edits a saved case fails at the ratchet; an update that adds a case passes.
6. A staged item with `curl -X POST` in a script is refused `tier_high`; one with a secret-shaped string fails
   stage 1.
7. `/grow undo <name> wrong unit` removes it; the next turn's index does not list it; a resubmit is forced to
   medium tier and the reviewer input contains the reason.
8. Three forced FAILs park the name; a fourth submit returns `parked`.
9. With the reviewer role forced down, a new skill (prose or script) stays `review_pending` and is not in the
   index; a prose-only update to a live prose skill still goes live.
10. `houge grow verify --all` passes on the three migrated skills and both exemplars.

## 11. How we know it works (30 days after 1a and 1b are live)

From `grow_events`: items added by Houge; reject rate at each stage; revert rate; share of live items with at
least three uses. Against it: feature commits by the orchestrator outside the kernel. If Houge's items are few,
or mostly reverted or unused, the design failed and is revisited; shipping the slices is not the measure.

## 12. For the spec review to probe on the live system

1. Can the planner `read` and execute under `<data>/omp/grow/` today, and do the Seatbelt profile and the policy
   hook both accept a new write-deny for it without breaking the chat workspace beside it?
2. Is the sealed room usable for cases, or is the plain shell adapter with network rules the right executor?
3. Does the policy hook see enough on a `read` to count a use, and on a `bash` call to recognise a grow-zone
   script path through wrappers (`env`, `bash x.sh`, a relative path)?
4. Does `turn.trust` expose "raised by `shell_netread` in this turn" as a queryable state at tool-call time?
5. Which model family ran the authoring turn: is it available where `grow_submit` is handled?
6. Does anything else read `skills/<scope>/*.md` or the `skill_author` tool (the composer, `/skills`, the
   improve tick, boot reconcile, disarm posture, docs parity tests) that unarming would break?
7. Is `tool.shell_class` usable line-by-line on a script file, or only on a single command string?
8. The index replaces whole bodies in the prompt: does any existing turn rely on a skill body being present
   without a `read`?

## 12a. Open decision for Paco

**O1 — prose-only skills.** The draft reviews every new item, prose included, and leaves only prose updates on
formal checks. Cost: one reviewer-seat call per new skill (Kimi, then Opus through Antigravity; never the
Anthropic pool), bounded by the 20-a-day cap. Alternatives: (a) no model on prose at all, formal checks plus
proof by use, which is cheapest and lets a wrong procedure live until someone notices; (b) review every write,
prose updates included, which closes the update gap and spends a seat call on every small edit. Recommended: the
draft's middle position.

## 13. After 1a

**1b**: agent files as a second item kind on the same door and pipeline; sync `delegate` with leaf rules in the
policy hook; quota broker over `omp usage --json`, one child per pool, children barred from Anthropic.
**Slice 2**: schedules, async jobs, queue, weekly pacing. **Slice 3**: post-turn nudge, the daily tick writing
through the door, pruning by use, corrections turned into cases, deletion of the old skill-author code.
