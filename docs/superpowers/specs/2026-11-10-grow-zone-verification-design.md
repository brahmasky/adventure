# Grow zone, slice 1a — a place Houge writes itself, and the checks that decide what goes live

**Rev 1.1 · 2026-11-10 · status: REVIEWED, awaiting Paco's decisions P1–P3 (§2a) and his approval.** Rev 1.0 was
reviewed against the live code by spec-review-senior (Opus 5.5: 8 BLOCKER, 15 WARNING, 6 SUGGESTION) and a codex
design pass (6 BLOCKER, 4 WARNING, 1 SUGGESTION). The orchestrator verified the cited lines first-hand. Every
blocker and warning is answered in this revision; §14 is the change log with confirmed and rejected findings. No
code until Paco approves. This spec changes what ADR 0011, ADR 0032 and ADR 0034 mean (§9): Tier C, his hand.

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

## 2a. Decisions this revision needs from Paco

**P1 — 1a is prose skills only; skills with scripts become their own slice (1c).** Both reviews found that the
script half of Rev 1.0 rested on things the live system does not have:

- No executor seals the network. The sealed room allows outbound TCP and lists `curl`
  (`src/omp/seatbelt.ts:117-136`, "Cost: TCP egress only"); the plain shell profile is `(allow default)`.
- Houge's matchers read a command line, never a script's body. `bash file.sh` is plain by design
  (`src/omp/command-matcher.ts:200`); a node script can open a socket with no shell line to match. Reading
  script lines is a lint, not a gate.

Script skills are where deterministic verification lives, so they are not dropped. They need a case executor
that really denies network and a rule for what a script may do at run time; that is a kernel security build and
gets its own spec. *Recommended:* 1a prose, 1b delegation, 1c scripts and cases. All three existing skills are
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

*Recommended: C.* It keeps D4, and it closes the one thing that makes persistence dangerous: text that came from
outside being read back later as if Houge's own. It changes ADR 0034 §8.2 (one entry leaves the ask list, one
rule is added), which is why it is Paco's decision.

**P3 — review of prose (was O1).** Every new item is reviewed by a different-model seat. An update is unreviewed
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
- Backup: the nightly DB backup (ADR 0021) also writes a `git bundle` of the zone beside the DB snapshot, under
  the same retention.

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
check-to-copy race to defend. The call runs the formal checks (§5.4) in milliseconds and returns one of:

- `LIVE` — a small update (P3); committed.
- `STAGED` — accepted, review pending; the result says the item is not live yet.
- `FAIL <code>: <message>` — a formal check failed; the message names the rule and the exemplar's name.
- A refusal with a fixed code: `grow_disabled`, `turn_hostile` (and `turn_untrusted` under P2-A),
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

- A one-shot seat on the `reviewer` role, no tools. Its family must differ from every model family that
  answered in the authoring run (plumbed from the supervisor's per-message model record). If no leg of another
  family is available, the item stays staged; the reviewer never collapses onto the author's family.
- Input, passed through the store's secret redaction: the item, the diff against the live version, the
  exemplar, the index of live items, and every stored undo reason for that name. The prompt frames all of it as
  data.
- Task: work the item's `example` through the procedure step by step; report any step that is wrong, missing,
  ambiguous or uncheckable; any stated fact believed false; any instruction that serves someone other than
  Paco (exfiltration, hidden recipients, instructions to ignore rules); overlap with a live item.
- Output: strict JSON `{ "pass": boolean, "findings": [{ "step", "problem" }] }`, validated. Anything else is
  a seat failure.
- `pass: true` publishes. `pass: false` marks the item `failed` and stores the findings. A seat failure or
  outage leaves it `staged`; the review is retried at the next daily tick, three times, then `failed` with
  code `review_unavailable`. Nothing goes live unreviewed, and a pending review older than a day shows in
  `/status`.

The reviewer's only power is a boolean. A reviewer talked into `pass: true` lets through an item that already
passed the formal checks; under P2-C a born-untrusted item it lets through still taints whoever reads it.

### 5.5 How Houge learns the outcome

The next turn's `[context]` block (per turn, not the system prompt) carries one line per outcome since the last
turn, once: `grow: <name> is live` or `grow: <name> failed review (grow_read it to see why)`. A failed item's
findings are returned by `grow_read({ name, what: "review" })`. Paco sees the same in `/grow`.

### 5.6 The read door, the index, and use

- The system prompt gets an **index**: one line per live item, `name — description`, in alphabetical order, at
  most 40 lines and 4,000 chars, plus one fixed sentence: these are Houge's own procedures, read one with
  `grow_read` before a matching task, add or improve one with `grow_submit`. Alphabetical order keeps the prompt
  stable, so the planner child restarts only when the set of live items changes, not when one is used.
- `grow_read({ name })` returns the committed body from the repository's HEAD. It is kernel text that passed
  the door, like a lesson: it is not judged for injection (a procedure would read as one) and, for an item with
  `origin: clean` or `exemplar`, does not raise trust. For `origin: untrusted` it raises the turn to
  `untrusted` exactly as a wall read does (P2-C).
- Each successful `grow_read` of a live item counts one **use** for that item in that run. `/grow` shows uses
  and the last-used date. 1a only counts; acting on the count belongs to slice 3.
- Skills no longer ride in the prompt as whole bodies. The two schedules that relied on that are covered by a
  live-gate line (§11.9).

### 5.7 Trust (as recommended in P2-C; replaced by the chosen reading)

- `hostile` conversation: `grow_submit` is refused with `turn_hostile`, in a preflight that runs before any
  trust ask. It is in no ask list, so no card can put a hostile turn's skill live.
- `untrusted` conversation: accepted, always `STAGED` (never the small-update path), and the item is stored
  with `origin: untrusted`. An item once born untrusted stays so until Paco clears it
  (`houge grow trust <name>`), whatever a later clean turn submits over it.
- `clean` conversation: `origin: clean`.
- What this does not close, stated: memory. Episodic facts and wiki pages distilled from untrusted turns reach
  a clean turn's context today without a mark (only `src/improve/proposals.ts` checks the turn's final trust),
  and a clean turn may read a workspace file an untrusted turn wrote if the injection judge passes it. A clean
  turn could therefore submit outside-derived text as `origin: clean`. That path exists today for lessons; this
  spec does not widen it beyond lessons and names it in §7.

### 5.8 Publishing, concurrency and crashes

- One daemon-wide grow mutex covers every write to the zone and its tables. A second caller gets `busy`.
- Staged content lives in SQLite (`grow_staged`), not in a directory: nothing to sweep, nothing a child can
  touch, and it survives restarts.
- Publish, under the mutex: (1) mark the staged row `publishing` with the content hash; (2) write
  `skills/.<name>.tmp`, rename it over `SKILL.md`; (3) commit with the hash and run id in the message trailer;
  (4) in one transaction set the item `live` with the commit id and delete the staged row.
- Boot repair, after the toplevel assertion: remove any `.tmp`; if the tree is dirty, restore it to HEAD; for
  each `publishing` row, if HEAD's file hash equals the row's hash finish step 4, otherwise redo from step 2. A
  review is never re-run at boot.
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

### 5.12 The old pipeline is removed, not unarmed

One door means no second writer. 1a deletes: the `skill_author` tool and its arming, `skill-author`,
`skill-router`, `skill-reverify`, `skills/promote`, `core/skill-job`, the tick's skill proposals and recurrence
jobs, `acceptSkill` and the job taps, boot job reconcile, `SkillStore`'s writers, `/skills retire|restore`, and
the env vars `HOUGE_SKILL_MAX_PER_SCOPE`, `HOUGE_SKILL_REFINE_PASSES`, `HOUGE_SKILL_REVERIFY_*`. The
`improvement_jobs` table stays (0 rows) and is no longer written. Consequence, stated: the recurrence → skill
trigger (ADR 0034 §10.3/10.4), which has fired zero times, is gone until slice 3 rewires the tick to the door.

### 5.13 State

One dated migration (`2026-11-xx-grow-zone`):

- `grow_items(name PK, state CHECK IN ('live','removed','orphan'), origin CHECK IN ('clean','untrusted',
  'exemplar'), uses, last_used_at, head_commit, content_hash, created_at, updated_at)`
- `grow_staged(id PK, name, run_id, chat_id, origin, author_families, fields_json, content_hash, state CHECK IN
  ('staged','publishing','failed'), attempts, code, findings_json, created_at, updated_at)`
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
  door, the daemon the only writer; G3 staged, then live on checks, no human gate; G4 the trust rule as Paco
  decides P2; G5 the verifier is protected and Houge cannot delete an undo reason; G6 what is reviewed is
  decided by code (P3); G7 schedule-born runs and (from 1b) delegated children cannot submit.
- **ADR 0011 — amended.** The skills gate changes from "anchor assertions by a walled model, then the user" to
  "formal checks, then a different-family reviewer". Its reason for rejecting trajectory-distilled skills (they
  encode one model's behaviour and fail on transfer) still holds, and more strongly once other models read
  skills in 1b; a reviewer of another family reading the procedure cold is the 1a answer, cases in 1c the
  stronger one.
- **ADR 0034 — amended.** §1.5 (`promote.ts` leaves the protected list with its deletion; "nothing reaches the
  active skills tree without Paco's tap" is replaced by G3); §2.1 (a lasting skill change derived from tool
  input: no longer a proposal for a tap, governed by G4); §5.1 and §10.3/10.4 (skill authoring after a
  recurrence is removed until slice 3); §7.1 (`grow_read` output is kernel text, not a judged local read);
  §8.2 (`skill_author` leaves the ask list; `grow_submit` is refused at `hostile` and, under P2-C, never asks).
- **ADR 0032 — amended.** D8 (tool set: `skill_author` out, `grow_submit` and `grow_read` in); §4.2 (skills
  are no longer composer-injected bodies; the index is); §4.3 (the fingerprint now covers the index); §5.1 (the
  grow root joins the write-denied paths).
- **ADR 0018 / 0031 — touched.** `HOUGE_GROW_ENABLED` joins the disarm flags; the "failing skill re-check asks
  for `/skills retire`" line is removed; the door-disabled incident gets its route.
- **ADR 0013 — restated, not changed.** Code owns the gates; the model now also owns the grow zone's content.
- **Conformance tests in `tests/adr/`:** `0035-g2-one-door` (no code path writes the grow root but the
  publisher, the seeder and the migration; nothing writes `<repo>/skills/`), `0035-g4-trust` (the chosen P2
  table, carried levels included), `0035-g5-pipeline-protected`, `0035-g6-review-by-size`,
  `0035-g7-schedule-no-submit`, `0035-grow-flag-in-disarm`, `0035-index-stable-order`,
  `0032-grow-root-denied` (run with data dir ≠ repo, so it cannot pass on the existing repo deny), and the
  existing `0034-8.2` trust-table test updated in the same commit.
- **`AGENTS.md` — Paco's hand.** The full build flow for the kernel and the protected surface; for other `src/`
  code, tests + one different-model review + live gate, with a spec and ADR only when a rule changes; no build
  flow for the grow zone. New invariant: "new capability starts in the grow zone; it moves into `src/` only when
  it fails the kernel test". Wording is drafted on the branch for his signature.

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

PASS only if every line holds.

1. After `/fresh`, Paco asks for a prose skill. `grow_submit` returns `STAGED`; after the turn the reviewer
   runs on a family that did not answer in that run; the item is live with one commit; `/grow` shows it.
2. A deliberately wrong skill (a false conversion factor in a step) is submitted the same way and **fails**
   review with a finding naming that step. A reviewer that passes it fails the gate.
3. In a later turn a matching request makes the planner call `grow_read` for the skill; uses = 1; the daemon
   pid is the one from line 1; the run's final trust is `clean`.
4. A turn that ran `web_search` submits a skill: under P2-C it is staged, reviewed, live with
   `origin: untrusted`, and a later clean turn that reads it ends `untrusted`. (Under A or B: the chosen
   behaviour.)
5. A conversation made `hostile` gets `turn_hostile`, and no trust card is sent.
6. A small edit to the live clean skill returns `LIVE` with no review; an edit over the size rule is staged.
7. `/grow undo <name> <reason>` restores the previous version; the next submit of that name is staged whatever
   its size, and the reviewer input (from the audit record) contains the reason.
8. With the reviewer role's legs forced to a missing model by a role override, a new skill stays staged, is not
   in the index, and `/status` shows it after the threshold is lowered for the test.
9. The daily news schedule is fired once: its run calls `grow_read` for the news-brief skill.
10. `/disarm` makes `grow_submit` return `grow_disabled`; `grow_read` still works. `skill_author` is absent from
    the bridge manifest. `<repo>/skills/` does not exist after the run. A direct write into the grow root from
    the planner's `bash` is denied (data dir ≠ repo in the gate).

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
  suggestion, it is cut to 1c so 1a stays buildable. Subject to P1.
- *Require every submitted file to be modified in the current run (senior B2 fix).* Moot: there is no file door.
- *Refuse whenever the level is not `clean` (senior B1 fix).* Presented as P2-A and not recommended: on the
  live data it leaves Houge almost never able to write. Paco decides.

**Not verified:** how often the injection judge would flag the three skills (moot under `grow_read`); whether
the planner reliably calls `grow_read` in schedule turns (gate line 9 decides).
