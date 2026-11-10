# Grow zone, slice 1a — a place Houge writes itself, and the checks that decide what goes live

**Rev 1.3 · 2026-11-10 · status: REVIEWED TWICE; P1–P3 and the AGENTS.md wording decided by Paco 2026-11-10;
awaiting his acceptance of one named residual (§5.7, R1) and his approval of the whole.** Rev 1.0 was reviewed
against the live code by spec-review-senior (Opus 5.5: 8 BLOCKER, 15 WARNING, 6 SUGGESTION) and a codex design
pass (6 BLOCKER, 4 WARNING, 1 SUGGESTION); Rev 1.2 by a codex re-review (5 BLOCKER, 6 WARNING, 1 SUGGESTION). The
orchestrator verified the cited lines first-hand. §14 is the record of confirmed and rejected findings. No code
until Paco approves. This spec changes what ADR 0011, ADR 0032 and ADR 0034 mean (§9): Tier C, his hand.

## 1. Why

Houge's charter says he improves himself. The live system on 2026-11-10 says he does not:

| Fact (probed 2026-11-10) | Value |
|---|---|
| Skills in `skills/` | 3, all prose (two commanded 2026-07-28, one 2026-10-01) |
| `improvement_jobs` rows, ever | 0 |
| `improvement_proposals` rows | 0 |
| `improve_ticks` / `improve_signals` rows | 19 / 7 (most ticks: 0 groups) |
| Commits, last 30 days | 376 docs / 244 fix / 204 test / 196 feat, all built by the orchestrator |
| Source / tests / docs | 62k / 87k / 129k lines |

Paco's finding: **capability lands as hand-written TypeScript in `src/`, which only the build orchestrator
touches, so the orchestrator evolves Houge and Houge does not evolve himself.** The existing skills layer (ADR
0011) did not change that: a skill is authored through a background job (`skill_author`: a routing gate, a
model-run anchor gate, then Paco's tap), and nothing feeds that job.

The fix has two halves. Houge needs a place he may write without a build. And before he writes anything, the
system needs a way to decide what goes live that does not cost Paco's attention: an agent that iterates on itself
without verification produces volume, and the human pays for it in review.

## 2. Decisions already made (Paco, in chat 2026-11-10)

- **D1** Keep Houge; do not rebase onto Hermes or OpenClaw. Add a grow zone beside a small kernel.
- **D2** Kernel test: *can this file weaken a floor, leak a secret, or stop Houge running?* Yes: kernel (`src/`,
  full build flow). No: grow zone. Existing TypeScript features stay as built; the rule applies forward.
- **D3** The grow zone is its own local git repository, never pushed (the code repo is public).
- **D4** No human gate on a grow-zone write. A write is staged and goes live only when the checks pass. Every
  live write is a commit, one command reverts it, and it shows in `/changes`, not as a Telegram push.
- **D5** Only the planner writes, and outside text must not become a skill unchecked (the exact rule is P2).
- **D6** Verification follows three practices: a map of what exists plus a CLI that checks an item; risk tiers
  set by code, model review where the tier asks, every miss turned into a standing check; whatever a script can
  decide, a script decides. The two strongest levers are good examples to copy and formal checks.
- **D7** The verifier is out of Houge's reach.
- **D8** Multi-agent comes by delegation: sync `delegate` first, standing agents after. Children are barred from
  the Anthropic pool, which Paco's own Claude Code shares.
- **D9** Slice 1 is split: 1a proves the grow zone and its verification on skills; 1b adds `delegate`.
- **D10** Success is measured after 30 days by the grow zone's own numbers (§12), not by slices shipped.

## 2a. Decided by Paco 2026-11-10 after the reviews: P1 accepted, P2 reading C, P3 accepted

**P1 — 1a is prose skills only; skills with scripts become their own slice (1c).** Both reviews found that the
script half of Rev 1.0 rested on things the live system does not have:

- No executor seals the network. The sealed room allows outbound TCP and lists `curl`
  (`src/omp/seatbelt.ts:117-136`, "Cost: TCP egress only"); the plain shell profile is `(allow default)`.
- Houge's matchers read a command line, never a script's body. `bash file.sh` is plain by design
  (`src/omp/command-matcher.ts:200`); a node script can open a socket with no shell line to match. Reading
  script lines is a lint, not a gate.

Script skills are where deterministic verification lives, so they are not dropped. They need a case executor
that really denies network and a rule for what a script may do at run time; that is a kernel security build and
gets its own spec. **Decided:** 1a prose, 1b delegation, 1c scripts and cases. All three existing skills are
prose, so 1a still proves the point: Houge writes a verified skill with no build and no human gate.

**P2 — what a conversation that has read outside content may do.** Rev 1.0 said "a turn that saw raw network
output cannot write". The live system is stricter and wider than that sentence assumed:

- Any wall read (`web_search`, `http_fetch`, mail, calendar) makes the turn `untrusted`
  (`src/omp/bridge-handler.ts:565`), and the level **carries with the conversation** until `/fresh` or a
  session reset (ADR 0034 §8.3). Paco's conversation has been `untrusted` since 2026-11-06.
- Today's rule at `untrusted` is a tap before `skill_author`, `lesson_write`, `schedule_task`,
  `self_write_propose` (ADR 0034 §8.2), inside a budget of three added taps a day.

Three readings:

| | Rule for `grow_submit` | Effect |
|---|---|---|
| **A** | Refused unless the conversation is `clean` | Safest. Houge can write a skill only in a conversation with no web, mail or calendar read since the last reset: in practice, rarely |
| **B** | `untrusted` asks Paco by tap (today's rule for `skill_author`); `hostile` refused | Consistent with ADR 0034 as written. Puts Paco back as the gate for most writes, against D4 |
| **C** | `untrusted` is allowed with no tap, always reviewed, and the item is **marked born-untrusted: reading it makes that turn `untrusted`**. `hostile` refused | No human gate. The taint follows the content, so outside-derived text never gains trusted standing; every existing rule for untrusted turns then applies to whoever reads it |

**Decided: C.** It keeps D4, and it closes the one thing that makes persistence dangerous: text that came from
outside being read back later as if Houge's own. It changes ADR 0034 §8.2 (one entry leaves the ask list, one
rule is added), which is why it was Paco's decision.

**P3 — review of prose (was O1), decided as written.** Every new item is reviewed by a different-model seat. An update is unreviewed
only when it is small: at most 20 changed lines and at most 25% of the body, with `description` and `example`
unchanged. Anything larger is reviewed as new. (The senior review showed the Rev 1.0 rule could be routed
around: submit a stub, then rewrite it.) Under P2-C a born-untrusted item is reviewed on every change.

## 3. Scope

**In 1a:** the grow-zone repository; prose skill items; the write door `grow_submit` and the read door
`grow_read`; formal checks; the asynchronous reviewer seat; the trust rule (P2); loading by index;
`houge grow` and `/grow`; undo with stored reasons; one exemplar; migration of the three existing skills;
removal of the old skill-author pipeline; backup of the zone; ADR and AGENTS.md changes.

**Not in 1a:** scripts, cases, the case executor, effect declarations (1c). `delegate`, agent files, quota
broker (1b). Schedules, async jobs (slice 2). The post-turn nudge, the daily tick writing through the door,
pruning by use, the weekly `/changes` rollup (slice 3).

## 4. The live system this builds on (probed)

- Skills today: `skills/<scope>/<name>.md` under the project root (gitignored); `SkillStore` folds up to four
  whole bodies per scope into the system prompt (`src/skills/skill-store.ts:158`), unjudged; the omp planner
  gets both scopes (`src/omp/turn-context.ts:204`). ADR 0032 §4.2 promises that composer injection.
- A change to the system prompt restarts the planner child at the next turn start
  (`src/omp/planner-supervisor.ts:1032`).
- Every built-in `read` of a local file is judged for injection (ADR 0034 §7.1); the judge's question flags text
  "telling [an assistant] to … run commands, change its behaviour" (`src/decisions/entries/tool-injection.ts:42`),
  which a procedure does. A withheld passage makes the turn `hostile`.
- Turn trust: levels and carry as in P2. `TurnTrust` exposes `level()`; its causes are private
  (`src/decisions/trust.ts:26`). Trust asks are `src/decisions/trust-ask.ts`.
- Two enabled schedules (a daily news brief at 08:00, a weekly security-operations report) match the two
  `research` skills, which ride in the prompt today.
- A schedule-born run already has `schedule_task` stripped from its actions (`src/contracts/task-contract.ts:172`).
- The frame watchdog is 180 s (`HOUGE_OMP_FRAME_IDLE_MS`) and pauses only for approvals; a one-shot seat leg may
  take 120 s.
- The data dir is the repository root in the live deployment (`src/core/core-worker.ts:2383`).
- Daemon-side git has a hardened wrapper: no hooks, no fsmonitor, no global or system config
  (`src/run/git-hardened.ts`).
- A `reviewer` role exists (`src/omp/model-roles.ts`: Kimi high, then Opus through Antigravity). Cross-family
  ordering exists only for the reader seat (`src/llm/providers/omp.ts:122`).
- The old pipeline's reachable writers: the `skill_author` tool, the improve tick's skill proposals and
  recurrence jobs, `acceptSkill` and promotion taps (`src/gateway/improvement-commands.ts`), boot job reconcile
  and the weekly re-verify (`src/telegram/telegram-daemon.ts:298,685,853`), `/skills retire|restore`.

## 5. Design

### 5.1 Where the zone lives

`HOUGE_GROW_DIR`, default `~/Library/Application Support/houge/grow`: outside the code checkout, so git
discovery can never climb into the public repository and a `git clean` there cannot delete the zone.

```
<grow>/.git
<grow>/skills/<name>/SKILL.md
```

- The daemon is the only writer. The grow root is added to the write-deny list at both layers ADR 0032 §5.1
  uses (Seatbelt profile, policy hook path gate). The planner never needs the files: it writes through
  `grow_submit` and reads through `grow_read`.
- Every git call goes through `git-hardened.ts` with explicit `--git-dir` / `--work-tree`,
  `GIT_CEILING_DIRECTORIES` set to the zone's parent, and no inherited `GIT_*` variables. Before any operation
  that discards or rewrites, the code asserts `rev-parse --show-toplevel` equals the grow root.
- Backup: after the nightly DB snapshot (ADR 0021) lands, the same step writes `<snapshot basename>.grow.bundle`
  (`git bundle create --all` to a `.tmp`, `git bundle verify`, rename). The DB backup is never held hostage by
  the zone: the latch advances once the DB snapshot is verified, whatever the bundle did; a failed bundle opens
  the incident `grow_backup_failed` and is retried the next night. Retention prunes a snapshot and its bundle
  together; a snapshot without a bundle is valid and is listed as such by `houge grow log`.

### 5.2 A skill item

`SKILL.md` is frontmatter plus a prose body. All rules are checked by code.

| Field | Rule |
|---|---|
| `name` | slug `[a-z0-9-]{3,48}`, equals the folder name |
| `description` | one line, 20–200 chars: when to use it. This is the index line |
| `example` | one line, 10–300 chars: a request this skill answers. The reviewer works it through |
| `origin` | set by the kernel: `clean`, `untrusted` (P2-C) or `exemplar` |
| `anchors` | optional list, kept from ADR 0011 |

Body: 200–8,000 chars. The kernel renders the file from the submitted fields; Houge never writes frontmatter.

### 5.3 The write door

A bridge tool, armed for the planner only, stripped from schedule-born runs:

```
grow_submit({ name, description, example, body, anchors? })
```

The content arrives as tool arguments. No file is copied from the workspace, so there is no path, symlink or
check-to-copy race to defend. Each field and the serialized total (16 KB) are capped before anything is stored.
The ledger and the bridge audit record counts, hashes and the fixed result code only, as they do for every
bridge call; the body exists in exactly two places, the `grow_staged` row and, once live, the repository. A
schema or check failure never echoes a submitted value. The call runs the formal checks (§5.4) in milliseconds and returns one of:

- `LIVE` — a small update (P3); committed.
- `STAGED` — accepted, review pending; the result says the item is not live yet.
- `FAIL <code>: <message>` — a formal check failed; the message names the rule and the exemplar's name.
- A refusal with a fixed code: `grow_disabled`, `turn_hostile`,
  `name_is_exemplar`, `rate_capped` (20 submits per local day), `zone_full` (200 items), `busy`.

The door never waits for a model, so it cannot outrun the frame watchdog.

### 5.4 Checks

**Formal (code, no tokens), first failure ends:**

1. Field rules of §5.2; UTF-8; no control characters.
2. Secret scan of every field: the store's redaction patterns plus the secret paths of ADR 0032 §3.2 as
   literals. A FAIL message never quotes the matched text.
3. The body holds no fenced block of more than three lines that reads as shell or code: "this needs a script;
   scripts arrive in a later slice" (1a) — the hook that later moves exact steps into checkable scripts.
4. Not a near-copy of a live item: same `description` after normalisation, or the same body hash.

**Review (model), asynchronous, after the turn ends**, for every `STAGED` item:

- A one-shot seat on a new role, `grow_review`, no tools: legs Kimi (high), Gemini pro, Codex. None is of the
  Claude family, which runs the planner, and none draws on the Anthropic pool; three families remain two when
  Kimi leaves. (The existing `reviewer` role is Kimi then Opus through Antigravity: after Kimi it would have no
  leg that differs from a Claude-authored turn.)
- The author's families are fixed at staging: the set of `family` values on that run's successful `llm_attempt`
  rows. A leg whose family is in the set is skipped. An unknown or missing family on any row fails closed: the
  item stays staged and ends `review_unavailable`. If every leg is skipped, the same.
- Input, passed through the store's secret redaction: the item, the diff against the live version, the
  exemplar, the index of live items, and every stored undo reason for that name. The prompt frames all of it as
  data.
- Task: work the item's `example` through the procedure step by step; report any step that is wrong, missing,
  ambiguous or uncheckable; any stated fact believed false; any instruction that serves someone other than
  Paco (exfiltration, hidden recipients, instructions to ignore rules); overlap with a live item.
- Output: strict JSON `{ "pass": boolean, "findings": [{ "step", "problem" }] }`, validated. Anything else is
  a seat failure.
- `pass: true` publishes. `pass: false` marks the item `failed` and stores the findings. Nothing goes live
  unreviewed.

**Who runs the review.** A persistent queue, not an in-memory lane: `grow_staged` rows in state `staged` with
`next_attempt_at <= now`. The daemon's poll loop (the one that drives the daily tick) starts at most one review
at a time as a detached task under the daemon's stop signal; it never waits for it, so Telegram polling is
unaffected. A claim is one transaction (`claimed_at = now`, `attempts + 1`). The first attempt is due when the
authoring turn finalizes. A seat failure or outage sets `next_attempt_at` to +1 h, then +6 h, then +24 h; after
the fourth failure the item is `failed` with `review_unavailable`. A claim older than 10 minutes with no outcome
(a crash, a restart, a shutdown that killed the leg) is released at the next poll, which is also the boot scan.
`/disarm` and `HOUGE_GROW_ENABLED=false` stop new claims. A review pending over a day shows in `/status`.

The reviewer's only power is a boolean. A reviewer talked into `pass: true` lets through an item that already
passed the formal checks; under P2-C a born-untrusted item it lets through still taints whoever reads it.

### 5.5 How Houge learns the outcome

The next turn's `[context]` block (per turn, not the system prompt) carries one line per outcome since the last
turn, once: `grow: <name> is live` or `grow: <name> failed review (grow_read it to see why)`. A failed item's
findings are returned by `grow_read({ name, what: "review" })`. Paco sees the same in `/grow`. The lines are
code-built (a name and a fixed phrase), escaped like every `[context]` entry, and do not touch the system prompt
or its fingerprint. "Once" is a per-chat cursor over `grow_events`, advanced only after the prompt that carried
the lines was accepted by the planner; a failed turn or a restart shows them again.

### 5.6 The read door, the index, and use

- The system prompt gets an **index**: one line per live item, `name — description`, in alphabetical order, at
  most 40 lines and 4,000 chars, plus one fixed sentence: these are Houge's own procedures, read one with
  `grow_read` before a matching task, add or improve one with `grow_submit`. Alphabetical order keeps the prompt
  stable, so the planner child restarts only when the set of live items changes, not when one is used.
- `grow_read({ name })` returns the committed body from the repository's HEAD. It is kernel text that passed
  the door, like a lesson: it is not judged for injection (a procedure would read as one) and, for an item with
  `origin: clean` or `exemplar`, does not raise trust. For `origin: untrusted` it raises the turn to
  `untrusted` before the result returns, through a new trust cause `grow_read_untrusted` (`CAUSE_LEVEL` and
  `CARRY_LEVEL` both `untrusted`). `grow_read` is registered on the bridge's plain branch, the one
  `houge_status` uses (ADR 0032 §4.6), never on the wall or judged-read branches; a test pins that.
- Each successful `grow_read` of a live item counts one **use** for that item in that run. `/grow` shows uses
  and the last-used date. 1a only counts; acting on the count belongs to slice 3.
- Skills no longer ride in the prompt as whole bodies. The two schedules that relied on that are covered by a
  live-gate line (§11.9).

### 5.7 Trust (P2, reading C)

- `hostile` conversation: `grow_submit` is refused with `turn_hostile`, in a preflight that runs before any
  trust ask. It is in no ask list, so no card can put a hostile turn's skill live.
- `untrusted` conversation: accepted, always `STAGED` (never the small-update path), and the item is stored
  with `origin: untrusted`. An item once born untrusted stays so until Paco clears it
  (`houge grow trust <name>`), whatever a later clean turn submits over it.
- `clean` conversation: `origin: clean`.
- **R1 — a residual for Paco to accept or refuse (Tier C).** Trust is carried by the conversation, not by
  facts or files (`src/decisions/trust.ts`). Episodic facts and wiki pages distilled from untrusted turns reach
  a clean turn's context without a mark (only `src/improve/proposals.ts` checks a turn's final trust), and a
  clean turn may read a workspace file an untrusted turn wrote if the injection judge passes it. So outside
  text can be laundered through memory into a clean turn and submitted as `origin: clean`; once reviewed, it is
  read back without taint. The same path reaches `lesson_write` today with no review at all, so the grow zone
  is no worse than lessons and adds a different-family review. Closing it means provenance on memory itself,
  which is a slice of its own. The only way to close it inside 1a is to mark every Houge-written item
  `untrusted`, which would turn every skill read into a trust downgrade and bring back the taps of ADR 0034
  §8.2 on most turns. *Recommended: accept R1 for 1a, recorded in `tasks/todo.md` as an accepted gap, and open
  "provenance for memory" as a named item on the roadmap.*

### 5.8 Publishing, concurrency and crashes

- One daemon-wide grow mutex covers every write to the zone and its tables. A second caller gets `busy`.
- Staged content lives in SQLite (`grow_staged`): nothing to sweep, nothing a child can touch, and it survives
  restarts. **Every** publish goes through a staged row, the small-update path included (it only skips review),
  so there is one state machine:

  `staged` → (review passes, or the update is small) → `publishing` → row deleted, item `live`
  `staged` → `failed` (review said no, or `review_unavailable`)

- Publish, under the mutex:
  1. One transaction: the row becomes `publishing`, carrying the content hash.
  2. `mkdir -p skills/<name>`; write `skills/<name>/SKILL.md.tmp`; rename it to `SKILL.md`.
  3. `git add` + `git commit`, the hash and run id in the message trailer.
  4. One transaction: the item becomes `live` with the commit id and hash; the staged row is deleted; the
     event is written.
- A failure at step 2 or 3 while the daemon is up: restore the tree to HEAD (after the toplevel assertion),
  leave the row `publishing`, retry once at the next poll. A second failure disables the write door with the
  incident `grow_publish_failed`; reading continues from HEAD.
- A failure of step 4 after a successful commit, or a crash anywhere: reconcile, at the next poll and at boot.
  For each `publishing` row: if HEAD's `SKILL.md` hash equals the row's hash, do step 4; otherwise remove any
  `.tmp`, restore the tree to HEAD and redo from step 2. Both branches are idempotent, and neither re-runs a
  review.
- Git is the truth for content. The DB is the truth for state, origin, uses, undo reasons and review findings;
  those are never rebuilt from git. An item present in git and missing from the DB is listed as `orphan` in
  `/grow` and excluded from the index until Paco runs `houge grow adopt <name>`.
- A missing `git`, an unwritable zone or a failed assertion disables both doors with an incident (routed per
  ADR 0031) and leaves the rest of Houge untouched.

### 5.9 Undo

`/grow undo <name> [reason]` (and the CLI) reverts the item to its previous committed version, or removes it if
it had none, by a new commit. The reason is stored and never deleted by Houge; every later review of that name
gets every stored reason, and the next submit of that name is reviewed whatever its size. This is 1a's form of
"a miss becomes a standing check".

### 5.10 CLI and Telegram

- `houge grow list | show <name> | check [name] | log | undo <name> [reason] | trust <name> | adopt <name>`.
  `check` runs the formal checks against live items and prints PASS, or FAIL with the rule.
- Telegram: `/grow` (items with state, origin, uses; staged and failed items with their reason),
  `/grow undo <name> [reason]`. `/skills` is removed; it answers with the `/grow` hint for one release.
- `/changes`: one line per publish and per undo, from `grow_events` (the weekly rollup is slice 3).
- `/status`: a review pending over a day, a disabled door, orphans.

### 5.11 Exemplar and migration

- **Exemplar.** One prose skill written by the orchestrator and reviewed like kernel code, in
  `grow-seed/skills/` in the public repo (nothing personal). At boot the seeder runs the formal checks on it;
  on a pass it publishes a missing or changed exemplar, on a failure it opens an incident and publishes
  nothing. Houge cannot submit over its name.
- **Migration.** A one-shot, idempotent boot step publishes the three existing skills (`when` → `description`;
  `anchors` kept; `example` supplied in the migration data), `origin: clean`, formal checks only (they were
  verified under the old gate and accepted by Paco). The old `skills/` folder is renamed
  `skills.migrated-2026-11`, and a test asserts nothing recreates `<repo>/skills/`.

### 5.12 The old pipeline: a removal matrix

One door means no second writer. What goes, what is rewired, what stays:

| Thing | 1a |
|---|---|
| Authoring machinery: `capabilities/skill-author`, `skill-router`, `skill-reverify`, `skills/promote`, `core/skill-job`, the job cards and taps in `gateway/improvement-commands`, boot job reconcile and the weekly re-verify in `telegram-daemon`, the `skill_reverify` notification topic | **Deleted**, with their tests |
| `skill_author` tool: `omp/tools/skill_author.json`, `capability-map`, `tool-arming`, `core/omp-turn-wiring`, `contracts/task-contract`, `prompt/composer`, `decisions/trust-ask`, `jev/labels`, `jev/triage-replay` | **Removed** from each; `grow_submit` / `grow_read` added where the chain needs them |
| `SkillStore` | **Replaced** by the grow store; the composer's `skillsReader` becomes the index |
| `/skills` (parser and gateway) | **Replaced** by `/grow`; `/skills` answers with the hint for one release |
| `improve.route` (the registry entry, its targets, reasons, Jev question, golden runs) | **Kept unchanged.** A `skill` verdict stays a valid outcome |
| The tick's effect for a `skill` verdict (rule-rung recurrence, or a `skill` proposal Paco accepts) | **Rewired**: it no longer starts a job. It writes one `grow_events` hint, which reaches the planner as a `[context]` line in that chat's next turn: `grow: a task of kind <category> keeps recurring; consider grow_submit`. Code-built text, no Paco text, at most three hints a day (the old queue cap), once per recurrence key. The planner decides, and the door's rules apply as for any submit |
| `skillExists` / `alreadyAuthored` in `improve/groups` | **Rewired** to `grow_items` and to the hint's idempotency key |
| `HOUGE_RECURRENCE_COSINE_GATE` | **Kept** (it still gates recurrence); its docs row is corrected |
| `HOUGE_SKILL_MAX_PER_SCOPE`, `HOUGE_SKILL_REFINE_PASSES`, `HOUGE_SKILL_REVERIFY_*` | **Removed**, with their docs rows |
| Tables `improvement_jobs` (0 rows), `skill_reverify_state` | **Kept** for migration compatibility; no live reader or writer |
| Live-gate scripts that assert the old path (`live-gate-omp`, `live-gate-improve-route`, `improve-sanity`) | **Updated** to the new effect |
| Reference docs (README, CONTEXT, `configuration.md`, `decision-map.md`, `jev-decision-layer.md`, ROADMAP) | **Re-read and corrected** (docs sync); dated specs and plans stay as history |

The hint is the first trigger of the grow zone: the recurrence sensor that fed a job nobody ran now feeds the
planner. The post-turn nudge and the tick submitting on its own remain slice 3.

### 5.13 State

One dated migration (`2026-11-xx-grow-zone`):

- `grow_items(name PK, state CHECK IN ('live','removed','orphan'), origin CHECK IN ('clean','untrusted',
  'exemplar'), uses, last_used_at, head_commit, content_hash, created_at, updated_at)`
- `grow_staged(id PK, name, run_id, chat_id, origin, author_families, fields_json, content_hash, needs_review,
  state CHECK IN ('staged','publishing','failed'), attempts, claimed_at, next_attempt_at, code, findings_json,
  created_at, updated_at)`
- `grow_context_cursor(chat_id PK, last_event_id)`
- `grow_events(id PK, at, run_id, name, action, result, code, reviewer_model, commit_id)`
- `grow_undo_reasons(id PK, name, at, reason)`

### 5.14 Configuration and switches

- `HOUGE_GROW_ENABLED`, default **on**. `false` refuses `grow_submit` with `grow_disabled` and drops the index
  sentence about writing; the index and `grow_read` continue. It joins `DISARM_FLAGS`
  (`src/config/disarm-posture.ts`), so `/disarm` forces it off.
- `HOUGE_SKILLS_ENABLED` keeps its meaning: off removes the index and `grow_read`.
- `HOUGE_GROW_DIR` (§5.1). Caps are code constants.
- The pipeline lives in `src/grow/`, which joins `PROTECTED_DIRS`: a self-write cannot edit the verifier.

## 6. What Paco sees

No cards. `/grow` on demand, lines in `/changes`, `/status` for the three conditions in §5.10. An unasked
message only as an incident (a door disabled).

## 7. Threats and what answers them

| Threat | Control | Residual |
|---|---|---|
| Outside text becomes a persistent skill | P2-C: `hostile` refused; `untrusted` reviewed and marked, and reading a marked item taints the reader | A reviewer fooled on a marked item: the item is live but never gains trusted standing |
| Outside text laundered through memory or a workspace file into a clean turn | Review of every new item, including a question about instructions that serve someone else | Open, and not new: the same path reaches `lesson_write` today (§5.7) |
| Skill text read back as trusted | `grow_read` returns only committed, door-checked text; origin decides the trust effect | A wrong but honest procedure: undo, and the reason binds every later review |
| Houge weakens his own verifier | Pipeline in protected `src/grow/`; zone write-denied to the planner; undo reasons append-only | — |
| Secrets in the zone or sent to the reviewer | Formal secret scan; redaction of reviewer input; zone never pushed; floor A unchanged | Personal detail that is not a secret can be in a skill; it stays on this machine, and goes to the reviewer's provider |
| A stub is approved, then rewritten unreviewed | P3's size rule; a born-untrusted item is always reviewed | 20 lines of unreviewed change per update, capped at 20 submits a day |
| Zone growth and noise | Rate cap, item cap, duplicate check, uses shown | No pruning until slice 3 |
| Hard line (a) | Doors fail closed and alone; nothing in the zone is executed; git is asserted before any destructive call | — |

## 8. What changes for existing behaviour

- Skill bodies leave the system prompt; the planner reads one when it judges it relevant. The scheduled news
  brief and security report may apply their skills less reliably; §11.9 checks it on the real schedules.
- The planner child restarts once per change to the set of live items, as it does today per lesson change.
- `/skills`, `skill_author`, the anchor gate and the weekly re-verify go away.

## 9. Rules this changes

- **New ADR 0035, "Grow zone and its verification".** Rules: G1 the kernel test; G2 one write door and one read
  door, the daemon the only writer; G3 staged, then live on checks, no human gate; G4 the trust rule of §5.7 (hostile refused; untrusted reviewed and marked; a marked item taints its reader); G5 the verifier is protected and Houge cannot delete an undo reason; G6 what is reviewed is
  decided by code (P3); G7 schedule-born runs and (from 1b) delegated children cannot submit.
- **ADR 0011 — amended.** The skills gate changes from "anchor assertions by a walled model, then the user" to
  "formal checks, then a different-family reviewer". Its reason for rejecting trajectory-distilled skills (they
  encode one model's behaviour and fail on transfer) still holds, and more strongly once other models read
  skills in 1b; a reviewer of another family reading the procedure cold is the 1a answer, cases in 1c the
  stronger one.
- **ADR 0034 — amended.** §1.5 (`promote.ts` leaves the protected list with its deletion; "nothing reaches the
  active skills tree without Paco's tap" is replaced by G3); §2.1 (a lasting skill change derived from tool
  input: no longer a proposal for a tap, governed by G4); §5.1 (skill authoring into a pending area on
  Paco's tap is replaced by the door); §7.1 (`grow_read` output is kernel text, not a judged local read);
  §8.2 (`skill_author` leaves the ask list; `grow_submit` is refused at `hostile` and never asks; a new line: reading
  a born-untrusted grow item raises the turn to `untrusted`); §2.4 (stated precisely: refusing and publishing
  are code decisions; the reviewer's `pass` is an admission check on content, not a gate on an action, so the
  one named exception stays the only one); §8.1 and §8.3 (the new cause `grow_read_untrusted` and its carry);
  §10.3–10.5 (recurrence → a grow hint to the planner, never a job; an accepted `skill` proposal → the same
  hint).
- **ADR 0032 — amended.** D8 (tool set: `skill_author` out, `grow_submit` and `grow_read` in); §4.2 (skills
  are no longer composer-injected bodies; the index is); §4.3 (the fingerprint now covers the index); §5.1 (the
  grow root joins the write-denied paths, placed after the `$HOME` allow in the profile and before the workspace
  allow in `isDeniedWrite`); §6 (`grow_read` is a named exception to the read wall, on the §4.6 precedent of
  `houge_status`); §7 (the new role `grow_review`).
- **ADR 0018 / 0031 — touched.** `HOUGE_GROW_ENABLED` joins the disarm flags; the "failing skill re-check asks
  for `/skills retire`" line is removed; the door-disabled incident gets its route.
- **ADR 0013 — restated, not changed.** Code owns the gates; the model now also owns the grow zone's content.
- **Conformance tests in `tests/adr/`:** `0035-g2-one-door` (no code path writes the grow root but the
  publisher, the seeder and the migration; nothing writes `<repo>/skills/`), `0035-g4-trust` (the §5.7
  table, carried levels included), `0035-g5-pipeline-protected`, `0035-g6-review-by-size`,
  `0035-g7-schedule-no-submit`, `0035-grow-flag-in-disarm`, `0035-index-stable-order`,
  `0032-grow-root-denied` (run with data dir ≠ repo, so it cannot pass on the existing repo deny), `0035-grow-read-plain-branch`, `0035-recurrence-hint-not-job`, and the
  existing `0034-8.2` trust-table test updated in the same commit.
- **`AGENTS.md` — wording APPROVED by Paco 2026-11-10; applied on the 1a branch in the same merge as the code**
  (the text names ADR 0035, `HOUGE_GROW_DIR`, `grow_submit`, `src/grow` and `grow-seed/`, none of which exist
  before that merge; the file is protected surface and this approval is Paco's hand for the edit).
  - Invariants, new bullet: "Kernel and grow zone (ADR 0035). New capability starts in the grow zone (Houge's own
    git repo at `HOUGE_GROW_DIR`), written by Houge through `grow_submit`. It moves into `src/` only when it fails
    the kernel test: can this file weaken a floor, leak a secret, or stop Houge running? The orchestrator writes
    no grow-zone item except the exemplars in `grow-seed/`."
  - Build flow, new bullet: "Flow by zone. Kernel (the protected surface, `src/omp`, `src/policy`,
    `src/decisions`, `src/grow`, and anything an ADR rule names): the global flow in full. Other `src/` code:
    tests, one different-model review, live gate; a spec and ADR only when a rule changes. Grow zone: no build
    flow; the door's checks are the gate."
  - The protected-surface line gains `src/grow`.

## 10. Tests

Hermetic, real SQLite and a real temporary git repository: every formal rule and failure code; the P3 size
rule at its boundaries; the trust table for clean, untrusted, hostile and carried levels; origin stickiness;
`grow_read` raising trust for a marked item only; reviewer JSON validation, family-differs with a multi-family
run, no collapse, outage → retry → `review_unavailable`; redaction of reviewer input; publish and each crash
point of §5.8; the mutex; orphan handling; undo of a first version and of an update, reasons reaching the next
review; index order, caps and fingerprint stability across a use; context outcome lines shown once; schedule
strip; disarm; seeder pass and fail; migration idempotence; hostile git config in the zone ignored; the
toplevel assertion refusing a zone whose `.git` is missing; removal of the old pipeline (no reference left);
docs parity for commands, tools and env vars.

## 11. Live gate (`scripts/live-gate-grow.mjs`, real daemon, Paco's chat)

PASS only if every line holds. Evidence is read from the grow tables, `llm_attempt` and trust events, not from
the reply text.

1. After `/fresh`, Paco asks for a prose skill. `grow_submit` returns `STAGED`; a `grow_review` attempt exists
   whose request hash covers the staged content hash and whose family is not in the run's author families; the
   item is live with one commit whose trailer carries that hash.
2. A deliberately wrong skill (a false conversion factor in one step) fails review with a finding naming that
   step. A reviewer that passes it fails the gate.
3. In a later turn a matching request makes the planner call `grow_read`; the returned body's hash equals the
   committed hash; the reply uses a value that appears only in the skill; uses = 1; the daemon pid is the one
   from line 1; the run's final trust is `clean`.
4. After `/fresh`, a turn that ran `web_search` submits a skill: staged, reviewed, live with
   `origin: untrusted`, no trust card sent. After another `/fresh`, a turn whose only outside contact is
   `grow_read` of that item shows a trust event with cause `grow_read_untrusted` and ends `untrusted`.
5. A conversation made `hostile` gets `turn_hostile`, and no trust card is sent.
6. A small edit to the live clean skill returns `LIVE` and **no** `grow_review` attempt exists for it; an edit
   over the size rule is staged and reviewed.
7. `/grow undo <name> <reason>` restores the previous version; the next submit of that name is staged whatever
   its size, and its review's stored input record (kept in `grow_staged` for the gate) contains the reason.
8. With `grow_review` overridden to a missing model, a new skill stays staged and is absent from the index; the
   daemon is restarted; the claim is released and retried (attempts = 2); `/status` shows the pending review
   once the threshold is lowered for the test; restoring the role lets it publish.
9. A one-off schedule created for the gate fires in its own slot with a goal matching the exemplar: the
   schedule-born run calls `grow_read` for it, and a `grow_submit` from that run is not offered (the tool is
   absent from its manifest). The next real 08:00 news fire is then observed and recorded in `tasks/todo.md`:
   it must call `grow_read` for the news-brief skill; if it does not, the slice is reopened.
10. `/disarm` makes `grow_submit` return `grow_disabled`; `grow_read` still works. `skill_author` is absent from
    the bridge manifest. `<repo>/skills/` does not exist after the run. With the grow dir outside the repo, a
    `bash` write, a built-in `write`, and a write through a symlink alias into the grow root are all denied.
11. A recurrence planted in the inbox produces one hint event and one `[context]` line in the next turn, and no
    `improvement_jobs` row.

## 12. How we know it works (30 days after 1a and 1b are live)

From `grow_events`: items added by Houge; share failing formal checks and failing review; undo rate; share of
live items read at least three times. Against it: feature commits by the orchestrator outside the kernel. If
Houge's items are few, or mostly undone or unread, the design failed and is revisited.

## 13. After 1a

**1b** agent files on the same doors; sync `delegate` with leaf rules; quota broker over `omp usage --json`,
one child per pool, children barred from Anthropic. **1c** script skills: a case executor with network fully
denied, saved cases that only accumulate, run-time rules for what a skill script may do. **Slice 2** schedules,
async jobs, pacing. **Slice 3** post-turn nudge, the tick writing through the door, pruning by use, the weekly
rollup.

## 14. Review record (Rev 1.0 → 1.1)

**Confirmed first-hand and fixed:**

| Finding (source) | Answer |
|---|---|
| Sealed room allows TCP egress and has no node; plain shell allows network (both) | Scripts and cases leave 1a (P1) |
| Line classification of scripts is not a gate; shebang false positives; `bash file.sh` plain (both) | Same (P1) |
| Reader digests do raise trust; the taint rule was weaker than today's and its premise false (senior B1) | §5.7 rewritten on `level()`; decision P2 |
| Cross-turn laundering through a workspace draft (both) | No file door (§5.3); the remaining memory path named (§5.7, §7) |
| Skill reads through `read` would be judged, could turn a turn hostile (senior B3) | `grow_read` as kernel text (§5.6); ADR 0034 §7.1 amended |
| ADR 0034 rules 1.5, 2.1, 5.1, 8.2, 10.3/10.4 and ADR 0032 §4.2/4.3, 0018, 0031 missing (senior B4; codex) | §9 |
| Nested repo inside the public checkout; discovery climbing; no backup (senior B6; codex) | §5.1 |
| Daemon copying a planner-named folder: symlinks, races, secrets echoed (senior B7; codex) | Content by arguments (§5.3); FAIL never quotes a secret match |
| Synchronous review outruns the 180 s watchdog (senior B8) | Review after the turn (§5.4) |
| Unarming leaves writers of the old layout (both) | Removed in 1a (§5.12) |
| Commit and DB not one transaction; two chats at once (codex; senior W9, W11) | §5.8 |
| Index ordered by use restarts the planner every turn (senior W1) | Alphabetical (§5.6) |
| Schedule-born turns could submit (senior W5) | Stripped (§5.3) |
| New switch must be a disarm flag; default unstated (senior W7) | §5.14 |
| Pipeline location unprotected (senior W8) | `src/grow/` protected (§5.14) |
| States lacked `failed`; staging location unspecified; migration id form (senior W10) | §5.13 |
| Reviewer: no cross-family ordering, collapse, off-box input unredacted (senior W12) | §5.4 |
| Low tier allowed wholesale unreviewed rewrites (senior W13 and O1 view) | P3 |
| Gate lines that pass with no new code or a rubber-stamp reviewer (senior W15) | §11 lines 2, 3, 9, 10 |
| Git hooks and config in the zone (codex) | §5.1 |
| Trust causes are private; refusing on a cause changes ADR 0034 (codex) | Level-based rule; §9 |
| A committed `MAP.md` can drift (codex) | No map file; the index and `/grow` are rendered on demand |

**Rejected, with reason:**

- *Keep bash scripts in 1a with a new "cases" clean room (senior S1).* The executor is a security build of its
  own (a new Seatbelt profile, a live network matrix, room seeding); taken together with codex's opposite
  suggestion, it is cut to 1c so 1a stays buildable (P1, decided).
- *Require every submitted file to be modified in the current run (senior B2 fix).* Moot: there is no file door.
- *Refuse whenever the level is not `clean` (senior B1 fix).* Put to Paco as P2-A with the live data (the
  conversation `untrusted` since 2026-11-06, so Houge could almost never write); he chose reading C.

**Not verified:** how often the injection judge would flag the three skills (moot under `grow_read`); whether
the planner reliably calls `grow_read` in schedule turns (gate line 9 decides).

**Rev 1.2 → 1.3, codex re-review (5 BLOCKER, 6 WARNING, 1 SUGGESTION), all confirmed and answered:**

| Finding | Answer |
|---|---|
| Laundering through memory still open | Not closable in 1a without provenance on memory; put to Paco as residual R1 (§5.7) |
| Publish: impossible rename path; no handling for a failed commit while up, a failed final transaction, or the small-update path | One state machine and exact paths (§5.8) |
| No owner for the after-turn review (the evolution lane is in-memory) | A persistent queue claimed from the poll loop (§5.4) |
| Deleting jobs breaks `improve.route`'s recurrence rung and ADR 0034 §10.3–10.5 | The entry is kept; its effect is rewired to a hint (§5.12); §9 amended |
| Backup pairing and latch order | §5.1; the DB backup is not made to wait for the bundle (codex suggested advancing the latch only after both: rejected, a zone fault must not stop DB backups) |
| Argument caps; body never in ledger or audit | §5.3 |
| `grow_read` needs a named trust cause and the plain branch | §5.6, §9 |
| Outcome line "once" across failures | Per-chat cursor (§5.5) |
| Reviewer families: only Kimi and Opus in `reviewer` | New role `grow_review` with three non-Claude legs (§5.4) |
| Grow-root deny is needed (`$HOME` is writable) and rule order matters | §9 (ADR 0032 §5.1), gate line 10 |
| ADR 0034 §2.4, §8.3, §10.5 and ADR 0032 §6, §4.6 missing | §9 |
| Gate lines that pass while broken | §11 rewritten on stored evidence; line 9 no longer fires a real schedule out of its slot |
| Deletion inventory incomplete | Removal matrix (§5.12) |

