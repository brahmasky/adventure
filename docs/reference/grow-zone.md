# Grow zone

Operator reference for the grow zone: what it is, how a skill goes live, how Houge uses one, what keeps it safe,
every command, and what to do when it breaks. Env vars are in [configuration.md](configuration.md#self-evolution-phase-2a--skills-in-the-grow-zone)
and are not repeated here. Decision record: [ADR 0035](../decisions/0035-grow-zone-verification.md). Domain words:
[CONTEXT.md](../../CONTEXT.md).

## 1. What it is

Houge has two parts. The **kernel** is the code in `src/`, written by the build orchestrator under the full build
flow. The **grow zone** is where Houge writes new capability for himself. The rule that sorts them (ADR 0035 G1):
a file belongs in the kernel if it can weaken a floor, leak a secret, or stop Houge running. Everything else starts in
the grow zone.

In slice 1a the only thing in the zone is the **skill**: a reusable procedure Houge writes for himself, as prose.
A skill executes no logic. It is one item with a name, a one-line description (when to use it), a one-line example
(a request it answers), a body (numbered steps in prose) and optional anchors (facts the steps rest on).

- **Where.** A separate local git repository at `HOUGE_GROW_DIR` (default
  `~/Library/Application Support/houge/grow`), one `skills/<name>/SKILL.md` per item. It lives outside the code
  checkout and is never pushed. The default, the placement rules and what an override must satisfy are in
  [configuration.md](configuration.md#self-evolution-phase-2a--skills-in-the-grow-zone).
- **Who writes.** Houge, through one door, the `grow_submit` tool. The daemon is the only process that commits to
  the repository. Any other process (`houge run`, a gate) can read the zone and answers `not_the_daemon` to a
  submit.
- **Who reads.** The planner, through `grow_read`, and Paco, through `/grow` and `houge grow`.
- **The orchestrator's only items** are the exemplars in `grow-seed/skills/` (today one: `option-comparison`). They
  publish unreviewed, so `grow-seed/` is on the protected surface. Houge cannot submit over an exemplar's name
  (`name_is_exemplar`), and `/grow undo` refuses it.

## 2. How a skill goes live

```
grow_submit
  -> formal checks (milliseconds, in the turn)
       fail                      FAIL <code>: nothing stored, the planner can fix and resubmit
       pass, small clean update  LIVE at once (one git commit)
       pass, anything else       STAGED
  -> STAGED waits for the authoring turn to settle
  -> review by a different model family (daemon grow tick, role grow_review)
       fail / unavailable        failed row, findings kept
       pass                      approved
  -> publish: one git commit carrying "Grow-Op: <id>", then the database rows
  -> next turn in that chat: "grow: <name> is live" in [context]
```

### Formal checks

The door answers `FAIL <code>` with a message and the exemplar hint (`src/grow/checks.ts`).

| Code | Meaning |
|------|---------|
| `bad_name` | Name is not 3-48 characters of `a-z`, `0-9`, hyphen. |
| `bad_description` | Not one line of 20-200 characters. |
| `bad_example` | Not one line of 10-300 characters. |
| `bad_body` | Body is not 200-8000 characters. |
| `bad_anchors` | More than 8 anchors, or an anchor that is not one line of at most 300 characters. |
| `too_large` | The submission exceeds 16 KB. |
| `control_chars` | A field has a hidden character (control, zero-width, joiner, variation selector, bidi, private-use, unassigned). Emoji sequences are refused for the same reason. |
| `secret_shape` | A field holds something shaped like a secret, a known secret value, or a secret path (`~/.ssh`, `.env`, ...). |
| `needs_script` | A fenced block of more than three lines that is not marked as prose (`text`, `md`, `output`, `quote`, ...). Scripts arrive in slice 1c. |
| `duplicate` | A different live skill has the same description or the same body. Update that one. |
| `zone_full` | 200 live skills already (a new name only). |
| `publish_failed` | A small update was accepted but the commit failed twice. |

Other answers are `REFUSED <code>`, covered in [section 4](#4-trust-and-safety).

### STAGED or LIVE

A submit goes **LIVE at once** only when all of these hold:

- the skill is already live and was never undone;
- its name is not marked "from outside content";
- the turn is `clean`;
- `description`, `example` and `anchors` are unchanged;
- the body change is small: at most 20 changed lines and at most 25% of the larger body's lines, and at most 800
  changed characters and at most 25% of the old body's characters. Lines are compared in order, so a reordering counts
  as a change.

Everything else is **STAGED**: a new skill, a larger change, any change to a name that was ever undone (a stored
undo reason makes every later submit reviewed), any change to a marked name, and every submit from an `untrusted`
turn. The planner is told `STAGED ... it is not live yet` and should report "staged", not "saved".

### Review

| Step | Rule |
|------|------|
| When | On the daemon's grow tick, once per poll, at most one review per tick. A staged row waits until its authoring turn has written its final trust level. |
| Who | Seat `grow_review`. Legs are listed in [configuration.md, Model roles](configuration.md#model-roles). None is Claude family. |
| Family rule | The reviewer must be a different model family from every family that composed the authoring turn. If the author's families are unknown, empty or unrecognised, there is no review (`no_family`). A leg of the author's family is skipped; if none is left, `no_reviewer`. The family that actually answered is checked again. Fail closed. |
| Input | The skill, the live version, every stored undo reason of that name, the live index and the exemplar, all passed as data and through the secret redaction. |
| Output | Strict JSON `{pass, findings[]}` as the whole reply. Anything else counts as an outage (`bad_json`). |
| Outage | Retried after 1 h, then 6 h, then 24 h. The fourth outage ends the row as `review_unavailable`. |
| Never settles | A row whose authoring turn ended without a final trust level, or that waited a day unsettled, is failed `run_unsettled` with no review. |
| Claim | A review claim is freed after 10 minutes. A shutdown aborts a review, the row is unclaimed and the next grow tick takes it. |

A passing review stores its evidence (content hash, hash of what was sent, reviewer model, author families, number of
undo reasons shown) and moves the row to `approved`. Publishing refuses a row that needs review and has no passing
review of its exact content.

### Row states

| State | Meaning | Next |
|-------|---------|------|
| `staged` | Checks passed, waiting for review. | `approved`, or `failed`. |
| `approved` | Review passed, or no review needed. | `publishing` on the same tick or the next poll. Stays `approved` while `HOUGE_GROW_ENABLED` is off. |
| `publishing` | An operation exists; the commit may or may not have landed. | `done` (live), or `failed` with `publish_failed` after two failed write tries. |
| `failed` | Ended. Code says why. | A new submit starts a new row. |

A newer submit of the same name supersedes an older pending row (`superseded`). An undo cancels a pending row
(`undone`). Neither is a failure: they print no outcome line and `/grow` does not list them.

Failure codes you may see on a failed row: `review_failed`, `review_unavailable`, `run_unsettled`,
`publish_failed`, plus `duplicate`, `zone_full` and `name_is_exemplar` when the check no longer holds at publish time.

### Publishing and what Houge sees

A publish is one git commit whose message ends with `Grow-Op: <id>`. The commit is written after the operation row
and before its database effects, so a crash between the two is finished by the next reconcile, never repeated. The
change log (`/changes`) gets one line: `Houge added the skill <name>.` or `Houge updated the skill <name>.`

In that chat's next turn the planner's `[context]` carries one line per outcome (at most 10):

- `grow: <name> is live`
- `grow: <name> failed review (grow_read it with what "review" to see why)`

Reading the findings: the planner calls `grow_read` with `what: "review"`. Paco reads the same findings in `/grow`
(up to three, shown as a code span) for 14 days after the failure. Findings of a marked name are outside content, so
reading them taints the turn.

## 3. How skills are used

- **The index.** Every planner turn's system prompt carries an index of the live skills, never a body. Format:
  `- <name> — <description>`. Order is by name, so the prompt only changes (and the planner child restarts once) when
  a skill is added, removed or re-described, never when one is used. Cap: 40 skill lines and 4,000 characters; the
  rest are cut. Two fixed sentences frame it: read a matching procedure with `grow_read` first; and, only when
  writing is possible, add or improve one with `grow_submit`. That second sentence is left out when
  `HOUGE_GROW_ENABLED` is off, when the zone is latched, and in a process that is not the zone's writer.
- **Marked skills** show their name only: `- <name> — (from outside content; grow_read it to see it)`. The
  description returns after `/grow trust`.
- **`grow_read`** `{name, what?}` returns `# <name>`, `When: <description>`, then the body. `what: "review"` returns
  the findings of the last failed submission instead. An unknown or non-live name answers `REFUSED unknown_skill`.
- **Uses.** Each successful `grow_read` of a live skill counts one use for that run. `/grow` shows `used N×`.
  Nothing acts on the count yet (pruning is slice 3).
- **Recurrence hints.** When the same kind of request recurs (three turns in 14 days) or Paco accepts a skill
  proposal, a `[context]` line reaches the planner in that chat's next turn:
  `grow: a task of kind <category> keeps recurring; consider grow_submit`. At most 3 recurrence hints per rolling
  24 hours. `/disarm` and `HOUGE_SKILLS_ENABLED` off hold them. The planner decides whether to write a skill.
- **Schedule-born turns** may `grow_read` but cannot `grow_submit` (refused per call by the run's contract), and get no
  outcome or hint lines, so those stay for Paco's next conversation.
- `/ask` and `/research` carry no skills: those one-shot paths have no tools.

## 4. Trust and safety

### Turn levels

Every turn has a trust level (see the decision ladder in [configuration.md](configuration.md#decision-ladder-adr-0034)).

| Level | `grow_submit` | `grow_read` |
|-------|---------------|-------------|
| `clean` | Allowed. Item gets `origin: clean`. | Allowed. |
| `untrusted` (the turn read outside content) | Accepted, always `STAGED`, always reviewed, and the name is marked. Refused `pending` while any version of the name is in motion. | Allowed. |
| `hostile` | Refused `turn_hostile` before any ask: "this conversation read text aimed at the assistant, so nothing from it can become a skill. /fresh starts a clean conversation." | Allowed. |

`grow_submit` never asks Paco for a trust tap at any level. The one ask that remains is the ordinary side-effect ask
after a Jev send-back (ADR 0034 2b-R7). `grow_read` never asks.

### The mark

- The mark is per **name**, kept in its own table, so a removed item, a failed submission or a row in flight cannot
  lose it. It survives every later submit, pending or live, whatever level it comes from.
- It outlives a failed review (accepted residual R7).
- A marked skill is shown name-only in the index, labelled "from outside content" in `/grow`, and reviewed on every
  change however small.
- **Reading a marked skill (or its review findings) raises the turn to `untrusted`** before the text returns (trust
  cause `grow_read_untrusted`). The planner's later actions in that turn are judged accordingly. A clean or exemplar
  skill raises nothing.
- Only Paco clears a mark: `/grow trust <name>` or `houge grow trust <name>`. A passing review never does.
- **Trust is refused while a version is pending** (a staged, approved or publishing row, or a pending operation of
  that name). Otherwise the mark would be cleared for text Paco has not seen and it would publish clean. Wait until
  the version is live or failed, read it, then trust.
- The exemplar is the one carve-out: its seed publish clears a mark on its name.

### Caps and refusals

| Answer | When | What to do |
|--------|------|-----------|
| `rate_capped` | 20 accepted submits in a rolling 24 h, or 5 for untrusted turns (their own budget; it does not use up the 20). Failed checks and refusals count toward neither. | Wait. `/status` shows the line while a cap is hit. |
| `pending` | An untrusted turn submitted a name that has a version in motion. | Nothing; a clean turn can still replace it. |
| `not_the_daemon` | The calling process is not the daemon. | Expected for `houge run` and gates. |
| `grow_disabled` | `HOUGE_GROW_ENABLED` is off (also under `/disarm`). | Re-enable by hand (see below). |
| `zone_unavailable` | The zone is latched or a write faulted. | See [section 8](#8-troubleshooting). |
| `busy` | The zone's lock is held; the planner never waits. | The planner can retry. |
| `turn_hostile`, `name_is_exemplar`, `zone_full` | As described above. | |

### What stops a skill from doing harm

- **Sandbox.** The grow directory and the `backups/` folder are read- and write-denied to every sandboxed child
  (omp, `bash`). A shell `cat` therefore cannot read a born-untrusted skill without the taint `grow_read` applies,
  and nothing but the daemon can edit the repository or its history.
- **Secrets.** A field with a secret value, a secret-shaped token or a secret path is refused (`secret_shape`). The
  scan also reads the text with hidden characters dropped and compatibility forms folded, so a secret split by a soft
  hyphen or written fullwidth is caught.
- **Hidden characters** and emoji sequences are refused by Unicode class (`control_chars`). The message names the
  class and never quotes the character.
- **Git.** Every zone git call names its own git dir and work tree and inherits no `GIT_*` variable. The repository
  is created only in an absent or empty directory. `.git/config` must be byte-for-byte the canonical one, so a planted
  filter, hooks path or alias never runs. `commondir`, `config.worktree` and any `.gitattributes` in the tree make
  the zone refuse every call. Global and system attribute and ignore files are off. Publishes add with `-f`, and a
  restore to HEAD runs `clean -ffdqx`.
- **Reviewer input** is framed as data, passed through the secret redaction, and has runs of `<` and `>` (including
  fullwidth and combining-mark disguises) broken so an item cannot close its own block.
- **Undo reasons and reviews are append-only.** No source file deletes them.

### Switches

| Switch | Effect |
|--------|--------|
| `/disarm` | Forces `HOUGE_GROW_ENABLED` and `HOUGE_SKILLS_ENABLED` (and the other `DISARM_FLAGS`) off, live and across restarts. Index and both tools disappear. Re-enabling is by hand: [configuration.md](configuration.md). |
| `HOUGE_SKILLS_ENABLED` off | The index leaves the prompt and both `grow_*` tools are gone. Recurrence hints are held. |
| `HOUGE_GROW_ENABLED` off | `grow_submit` answers `grow_disabled`; the index drops its write sentence; the index and `grow_read` keep working. No new commit is created: an approved row waits. A publish whose commit already landed is still recorded. |

Rows for both switches are in [configuration.md](configuration.md#self-evolution-phase-2a--skills-in-the-grow-zone).

### Accepted residuals

From [ADR 0035 Residuals](../decisions/0035-grow-zone-verification.md#residuals). Each is accepted; none is closed.

- **R1.** Outside text can be laundered through memory (distilled facts, a workspace file) into a clean turn and
  submitted as `clean`. Same path as `lesson_write`. Closing it needs provenance on memory, a later slice.
- **The reviewer is a model.** A wrong but honest procedure can pass; the answer is undo. A small update of a clean
  skill escapes review.
- **Personal detail that is not a secret** can be in a skill. It stays on this machine and goes to the reviewer's
  provider.
- **Undone text outlives the undo** in database snapshots and the zone bundle until they rotate.
- **`/ask` and `/research`** carry no skills.
- **No pruning** of unused skills until slice 3. The 200-item cap and the rate cap bound growth.
- **R7.** The mark outlives a failed review. An untrusted submit can make a clean live skill name-only and taint its
  readers until `/grow trust` (at most 5 names a day).
- **R8.** A `.gitattributes` present only in the index or HEAD can convert text but cannot run a command.

## 5. Commands

### Telegram

| Command | What it does |
|---------|--------------|
| `/grow` or `/grow list` | Lists skills. Failures first, then reviews waiting, then live skills, then orphans. `/skills` (any arguments) is a one-release alias. |
| `/grow undo <name> [reason]` | Steps back one published version, or removes the skill if it had none. Queued; the daemon confirms. The reason is stored and shown to every later reviewer of that name. |
| `/grow trust <name>` | Clears the "from outside content" mark now. Refused while a version is pending. |

Replies:

```
/grow
🌱 **Grow zone**
**option-comparison** · exemplar · used 3×
`how to compare options when deciding between them`

**refund-lookup** · from outside content · used 0×
`how to look up a refund status in the vendor portal`
/grow trust refund-lookup clears the mark

**weekly-recap** · failed (review_failed)
`step 3: asks for the account number before checking the order`

Undo one: /grow undo <name> [reason]
```

Entries read: `written by Houge`, `from outside content` or `exemplar`; waiting rows read
`waiting for review`, `approved, waiting to publish` or `publishing`; an orphan reads `in the repository but unknown to
me · houge grow adopt <name>`. Descriptions and findings are shown in a code span with `/`, `@`, `#`, `$` and
dotted domains defanged, so nothing in them is tappable. The list is cut at 3,800 characters on a whole entry, with
`… and N more — run houge grow list on the Mac`. A failure is listed for 14 days.

| Command | Reply |
|---------|-------|
| `/grow undo <name> [reason]` | `⏳ Undoing <name>; I will confirm in a moment.` Then `↩️ <name> restored to its previous version. Its next version will be reviewed.` or `↩️ <name> removed. Its next version will be reviewed.` |
| `/grow undo` of a name not live | `No live skill of that name. /grow lists them.` |
| `/grow undo` of the exemplar | `That one is an exemplar and cannot be undone.` |
| `/grow undo` when the zone cannot be written | `The grow zone could not be written. See /status.` |
| `/grow trust <name>` | `✅ <name> now reads as Houge's own. Reading it no longer marks the conversation.` |
| `/grow trust` of a clean name | `Nothing to clear: <name> is not a skill marked as outside content.` |
| `/grow trust` while pending | `A new version of <name> is waiting for review; trust it once it is live or failed.` |
| `/grow foo` | `/grow takes nothing (or: list), or: undo <name> [reason], or: trust <name>` |

The undo is a request the daemon runs on its next poll (it never touches git from the gateway). Redelivered Telegram
updates cannot undo twice.

### `/status` grow lines

`/status` prints nothing about the grow zone while it is healthy.

| Line | Meaning and what to do |
|------|------------------------|
| `Grow zone: writing is paused (the zone could not be written)` | The write door is latched. Check the grow directory; see [section 8](#8-troubleshooting). |
| `Grow zone: a skill write finished but I could not record it yet; writing continues` | The commit landed; the database half is being retried. Usually clears itself on the next poll. |
| `Grow zone: a finished skill was dropped after repeated write failures; writing continues` | A publish failed twice and was dropped. Houge writes it again if it matters. Clears with the next publish that lands. |
| `Grow zone: N review(s) pending over a day · /grow` | Staged rows older than 24 h. Check the reviewer legs and `houge grow log`. |
| `Grow zone: N skill(s) in the repository unknown to me · /grow` | Orphans. Read them with `houge grow show`, then `houge grow adopt <name>`. |
| `Grow zone: N skill(s) from outside content (shown by name only) · /grow` | Marked live skills. Read one with `houge grow show <name>`, then `/grow trust <name>` if it is fine. |
| `Grow zone: 20 skills accepted in 24 hours, the cap; new submits wait` | The clean cap is reached. Wait or ignore. |
| `Grow zone: 5 skills from outside content accepted in 24 hours, the cap; more from outside content wait` | The untrusted cap is reached. |

### CLI

Run from the checkout: `npm run houge -- grow <sub>`. Usage:
`houge grow list | show <name> | check [name] | log | undo <name> [reason] | trust <name> | adopt <name>`.

| Command | Prints | Writes |
|---------|--------|--------|
| `list` | One line per item: `name  state  origin  uses` (state `live`, `orphan` or `removed`; origin `clean`, `untrusted` or `exemplar`), or `(empty)`. | Nothing. |
| `show <name>` | The committed skill file at HEAD, or `no skill named <name> at HEAD`. | Nothing. |
| `check [name]` | `PASS <name>` or `FAIL <name>: <code>` per live skill, rerunning the formal checks on what is committed (`unreadable` if the file cannot be parsed). `(nothing to check)` when none. | Nothing. |
| `log` | The last 30 grow events, newest first (`<time> <action> <name> <result>`), then one line per database snapshot: `houge-<stamp>.sqlite  bundle: yes\|no`. | Nothing. |
| `trust <name>` | `trusted <name>`, `nothing to clear for <name>`, or the pending refusal. | The database, at once. |
| `undo <name> [reason]` | `queued: the daemon runs it within a minute`, or `already queued`. | Only a request row; the daemon commits. |
| `adopt <name>` | Same as `undo`. Adopts an orphan as a live, untrusted, marked skill; its HEAD content becomes its first version. | Only a request row; the daemon commits. |

Refusals: a bad subcommand, or a name outside `a-z`, `0-9`, hyphen (3-48 characters), prints the usage line and exits 1.
`undo`, `trust` and `adopt` also refuse under the kill-switch tombstone (the parked message). Outside the checkout
(no `houge.sqlite` in the current directory) every subcommand prints
`houge grow: no houge.sqlite here; run from the Houge checkout` and exits 1, so it cannot create an empty database or
queue a request nobody drains. A queued `undo` or `adopt` only runs while the daemon is up.

## 6. Day to day

What you do, mostly nothing:

- Glance at `/grow` now and then, and at `/status` when something looks off.
- Undo a skill you do not like, and say why in the reason: every later version of that name is reviewed with it.
- Trust a marked skill once you have read it.
- Watch `/status`: grow lines appear only when something needs a look.

Three examples.

**(a) Houge saves a new skill in a normal chat.** You ask for a weekly recap and correct the format twice. Houge calls
`grow_submit`. The door passes it and answers `STAGED`. Houge tells you it is staged. On the next grow tick the
reviewer (a non-Claude model) works the example through the steps and passes it. The daemon commits it. In your next
message in that chat Houge sees `grow: weekly-recap is live`, and `/changes` shows `Houge added the skill weekly-recap.`
Nothing for you to do.

**(b) A skill written while reading a web page.** Houge reads a page, the turn becomes `untrusted`, and he submits
`vendor-portal-steps`. It is staged, marked and reviewed. Once live, `/grow` shows `from outside content` and
`/status` says `1 skill from outside content (shown by name only)`. The index lists only its name. When Houge reads it
with `grow_read` the turn is raised to `untrusted`. You run `houge grow show vendor-portal-steps`, read it, and send
`/grow trust vendor-portal-steps`. From then on it reads as Houge's own and its description returns to the index.
If you trust it while a new version is pending, you get the refusal; wait until that version is live or failed.

**(c) A bad skill.** A skill gave a wrong answer. You send `/grow undo weekly-recap it asked for the account number
too early`. Houge replies `⏳ Undoing weekly-recap; I will confirm in a moment.` and then
`↩️ weekly-recap restored to its previous version. Its next version will be reviewed.` (or `removed` if it had no
earlier version). The reason is stored. The next time Houge submits that name, even a one-line edit, it is reviewed
and the reviewer sees your reason; a submission that repeats the fault fails.

## 7. First boot after upgrading

At daemon start (`bootGrowZone`), in this order:

1. **Create or check the zone.** A repository is created only in an absent or empty directory. If skills exist in the
   database and the repository is gone, that is a fault: the door stays latched and `grow_zone_unavailable` opens; an
   empty zone never silently replaces a real one.
2. **Reconcile.** Pending operations are finished and approved rows published (only if `HOUGE_GROW_ENABLED`).
3. **Sync with HEAD.** Anything committed to the repository that the database does not know is recorded: a file
   unknown to the database becomes an **orphan** (listed in `/grow`, kept out of the index, adoptable by
   `houge grow adopt`); a live skill whose file changed by hand becomes a new version, untrusted and marked; a live
   skill whose file is gone is marked removed.
4. **Seed exemplars.** Each folder in `grow-seed/skills/` passes the formal checks and is published as `origin:
   exemplar`, only if it is missing or changed. A removed or hand-edited exemplar is restored.
5. **Migrate the old skills.** `skills/<scope>/*.md` from the previous gate: each file is parsed, passes the formal
   checks and is published as a live, clean skill (its `example` is derived from its old `when` line). Names the zone
   already knows are left alone. When every file migrated, the folder is renamed to `skills.migrated-<YYYY-MM>`
   (kept; gitignored). If any file is invalid (a repeated name, the exemplar's name, a symlink, a failed check or
   publish), the folder keeps its name and `grow_seed_failed` opens; the valid ones are already live.

Every poll after that, the daemon writes `<snapshot>.grow.bundle` beside the newest database snapshot in `backups/`
when that snapshot has none. A snapshot without a bundle is valid; `houge grow log` lists which have one.

## 8. Troubleshooting

### Incidents

| Incident | Routed | Meaning | What to do |
|----------|--------|---------|------------|
| `grow_zone_unavailable` (subject `zone`) | page | The zone cannot be written (not a git repository there, an unexpected `.git/config` or attribute file, git failed, the work tree could not be restored). Reading still works. | Run `npm run houge -- grow list`, check the grow directory (`git status` there with the zone's own git dir), fix it. The door reopens on the next successful ensure. |
| `grow_zone_unavailable` (subject `apply`) | page | A commit landed but its database effects could not be recorded; retried each poll. | Usually nothing. If it persists, check the database for errors. |
| `grow_publish_failed` | page | A finished skill failed to publish twice and was dropped. | Nothing; Houge writes it again if it matters. Check the zone if it repeats. |
| `grow_seed_failed` | log | An exemplar or an old skill could not be brought in at start-up. | Check the boot log for which; fix the file; restart. A clean boot closes it. |
| `grow_backup_failed` | log | The bundle beside the snapshot failed this round. | The next poll retries. Check the zone with `houge grow list`. |

### A stuck review

A skill sits in `/grow` as waiting and `/status` says `N reviews pending over a day`. Cases: no reviewer leg is
reachable (outage; retries at 1 h, 6 h, 24 h, then it fails `review_unavailable`); the authoring turn never settled
(fails `run_unsettled` within a day); or `HOUGE_GROW_ENABLED` is off (approved rows wait). Look at `houge grow log`.
A failed row is not retried; the planner or Paco can ask Houge to submit again.

### An orphan in the zone

`/status` and `/grow` show it as unknown to the database. Read it (`houge grow show <name>`). Adopt it with
`houge grow adopt <name>`: it becomes live, untrusted and marked, and you then `/grow trust` it if it is yours.
There is no command to discard an orphan; it stays listed until adopted.

### Restoring from a snapshot and bundle

There is no restore command. Only with the daemon stopped, and as Paco's decision:

1. Restore the database snapshot (`backups/houge-<stamp>.sqlite`) over `houge.sqlite`.
2. Move the broken grow directory aside.
3. `git clone <snapshot>.grow.bundle <grow dir>`.
4. Replace `<grow dir>/.git/config` with the canonical config (a `[core]` section only: `repositoryformatversion = 0`,
   `filemode = true`, `bare = false`, `logallrefupdates = true`; see `CANONICAL_CONFIG` in `src/grow/zone.ts`). Without
   this the zone refuses every call (`not_toplevel`), because a clone adds a remote.
5. Start the daemon. Boot reconcile and sync with HEAD bring the database and repository into line; anything that
   disagrees is shown as an orphan, a changed skill or a removed one.

Use a snapshot that has a bundle (`houge grow log`). Pairing them is the point: a bundle is the zone as it was when
the snapshot was taken.

## 9. Design and decisions

- Spec: [2026-11-10-grow-zone-verification-design.md](../superpowers/specs/2026-11-10-grow-zone-verification-design.md),
  including section 15, the plan-time and final-review errata (items 37 and later change the trust, index, cap and
  Unicode rules). Where the spec differs from the code, the code wins.
- Plan: [2026-11-10-grow-zone-1a.md](../superpowers/plans/2026-11-10-grow-zone-1a.md).
- ADR: [0035 grow zone](../decisions/0035-grow-zone-verification.md), rules G1-G7, with its Residuals. It amends
  ADR 0011, 0018, 0030/0034, 0031 and 0032. Index: [decisions/README.md](../decisions/README.md).
- Comes next ([ROADMAP](../ROADMAP.md)): **1b** a synchronous `delegate`, agent files on the same doors, and a quota
  broker over the subscription pools (children barred from the Anthropic pool); **1c** script skills with a sealed
  case executor; **slice 2** standing agents and async jobs; **slice 3** a post-turn nudge, the tick writing through
  the door, and pruning by use. Memory provenance (R1) is a named open item.
