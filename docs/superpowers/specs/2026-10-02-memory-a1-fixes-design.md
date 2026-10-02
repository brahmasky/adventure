# Memory A1 — make facts, lessons and wiki behave as designed

Date: 2026-10-02
Status: **Rev 2 — after the senior spec review (live probes) and the Codex design pass; awaiting Paco**
Author: Paco + Claude
Stage: A1 of the memory plan (A1 fixes → A2 Jev-first decision cascade → B shape → C credit), agreed 2026-10-02.
Governs: ADR 0005 (memory), ADR 0010/0012 (lessons, reconcile), ADR 0020 (wiki), ADR 0028 (omp runtime). Amendment lines
go to ADR 0028 and ADR 0005 on ship.

The repo is public: this spec names memory rows by id only. Lesson texts, probe messages and anything personal live in
the untracked plan file `.superpowers/memory-a1/plan.json` (excluded from git), which the migration and the live gate
read.

## Why

A three-track review on 2026-10-02 (facts pipeline, lessons and wiki, external research), with every load-bearing
claim re-checked against the live DB, the live system prompt and the omp binary, found that the memory stores do not
behave as their ADRs describe. Junk is admitted, credited for being injected and kept, while good rows are lost.

1. **Most lessons are not in the prompt.** `readLessonBlock` (`run-store.ts:1267-1279`) admits the first bullet always
   and stops at the first that overflows a hard-coded 1200-char cap (`:7833`). From 09-11 to 10-01 one 1503-char
   merged lesson (#39) was the only lesson in the prompt; #1, #2, #7, #21 were out yet counted "applied". Its successor
   #43 (2048 chars rendered, ranked last at reuse 1.0) can never fit.
2. **Research-scope lessons and skills are never read under omp** (`turn-context.ts:93,105-108` read scope `ask`
   only). Lesson #44 has `applied_count` 0.
3. **Lessons grow without bound.** The 240-char cap (`distill.ts:94`) applies only to a fresh candidate; UPDATE stores
   merged text unchecked (`run-store.ts:1432-1442`); consolidation's only floor is "not shorter than the longest
   member" (`lesson-consolidate.ts:131-134`). #43 grew 78 → 1580 chars (+456 avoid) across 12 merges of unrelated
   themes and absorbed a test probe. #42 is 629 + 195 chars across three themes. `avoid` has no cap anywhere.
4. **"Applied" means "retrieved".** `touchApplied` runs on every `getActiveLessons` row, rendered or not
   (`turn-context.ts:136,148`). UPDATE creates the new row at reuse 1.0, so a rewrite drops in rank.
5. **Retrieval has no relevance gate.** The pool is FTS hits ∪ the 50 newest rows with a 0.05 relevance floor
   (`episodic-retrieval.ts:44,75`; `wiki-retrieval.ts:33,63`); 5.84 of 6 fact slots fill per turn; one wiki page was
   injected 155 times, into unrelated turns.
6. **Biography is lost while a wrong fact is always on.** `mergeEpisodicFacts` drops `is_core` (`run-store.ts:3052`;
   live: core #70 → non-core #73); the core band is never touched, so core #54 and #88 were pruned by decay; #149, a
   false attribute minted from a question, is active and core.
7. **Fact extraction cannot be audited.** No question/assertion rule (`episodic-extract.ts:42-69`); one sampled call
   sets `core`; `source_turn_ids` is the whole window (`:402`); transcript lines carry no numbers (`:72-82`).
8. **Fact reconcile uses the lesson prompt** (`reconcile.ts:16`, "ONE revised imperative rule"); neighbours come
   from FTS, which cannot segment CJK, else the 8 newest facts (`run-store.ts:2863-2867`); the candidate is embedded
   only after reconcile (`episodic-extract.ts:318-323`).
9. **A lesson change cannot remove a habit.** omp's `open_session` resumes the newest transcript in `--session-dir`
   (omp cli.js, verified); the probe sign-off persists by imitation after the rule left the prompt.

Cosine probe on the live `embeddinggemma` vectors (8 messages): message → best active fact is ≤ 0.41 where no memory
is relevant and 0.55–0.73 where one is. Wiki pages embed lower (long documents): the one relevant pair scored 0.36,
unrelated pairs ≤ 0.25. Too few pairs to fix defaults on; §3 makes the gates measurable and flag-tunable.

## Goals

- Every active lesson reaches the planner, or its absence is ledgered and raised.
- Nothing is credited for anything but being in the prompt.
- Facts and wiki pages enter a turn only when relevant to the message.
- Biography survives merges and decay; every new fact points to the user turn and span it came from.
- Lessons are small (≤ 240 text, ≤ 120 avoid), carry a theme, and never merge across themes.
- A lesson change takes effect at the next turn, without resuming the old transcript and without losing the thread.
- Each behaviour change has a flag, so rollback is an `.env` edit, not a revert.

## Non-goals (later stages)

- Jev, the decision-function module and replayable decision rows (A2; both reviews: no consumer in A1).
- Itemised one-rule lessons with retire/edit/Undo, themes for facts and wiki, provenance class and candidate tier,
  bi-temporal facts, entity tags, store routing, the fact lifecycle (decay redesign), wiki rewire-or-retire (B).
- Cited-id credit, implicit feedback, private memory eval (C).
- No runtime dependency (ADR 0001); no change to `memory_correct`'s trust gates.

## Design

### 1. Lessons reach the model

- **New `renderLessonSection(scopes)`** returns `{block, ids, skipped}` for omp only. `readLessonBlock` keeps its
  contract for its other callers (composer `lessonsReader`, self-diagnose, self-write: `core-worker.ts:742,875,899,
  1120,1140,1191,2121`), so the Codex task does not grow.
- Renders every active lesson of `ask` and `research`, ordered **theme, then id** (stable: a rating or decay never
  reorders it). Each bullet is `- [<theme>] <text>` plus `  AVOID: <avoid>` when present.
- **Cap `HOUGE_LESSON_CHAR_CAP`** (default 4000). Skip-and-continue: a lesson that does not fit is skipped, the next is
  tried. Each skip appends `lesson_dropped {lesson_id, chars, cap}` and opens a `lesson_dropped` incident (one per
  lesson, resolved when it renders again; added to the sweep's closed kind list, `invariant-sweep.ts:80`, and raised at
  render time too, since the sweep runs every 12 h). The 20-per-scope cap stays and is the only count cap.
- Skills: the omp `skillsReader` concatenates `ask` and `research` (`skillsScope` is a single string,
  `composer.ts:320`).
- **The rendered ids are stored on the supervisor at spawn** (the session holds the spawn-time prompt) and are what
  each turn's attribution and `touchApplied` use (§2).

### 2. Size caps everywhere a lesson is written

- `LESSON_MAX_CHARS` (240) for text and new `LESSON_AVOID_MAX_CHARS` (120) for avoid, checked in `saveReconciledLesson`
  for every verdict. An **UPDATE whose merged text or avoid exceeds a cap is not saved**: the prior lesson stays,
  `lesson_write_capped {verdict, target_id, chars, avoid_chars}` is ledgered (every verdict is capped), and `lesson_write` returns a code-owned result telling the
  planner the rule was not saved because the merge was too large, so it can tell Paco or save a separate narrower rule.
  (Falling back to ADD would store a near-duplicate — the reconciler just said it overlaps.)
- UPDATE inherits the target's `reuse_value`, `applied_count` and `theme`.
- **Consolidation is switched off for A1** (Paco sets `HOUGE_LESSON_CONSOLIDATE_ENABLED=false`): its preserve-all
  merge cannot fit two lessons into 240 chars, so under the caps it would only spend calls. The growth floor is removed
  and an over-cap merge rejected, so turning it back on is safe; B replaces it with itemised delta curation.

### 3. Relevance gates for facts and wiki

- **Pool:** with a query embedding, every active row of the chat that has an embedding (facts ≤ 200 per chat, pages a
  handful — one in-memory pass); without one (Ollama down), FTS hits only.
- **Admission:** with both embeddings present, `cosine ≥ HOUGE_EPISODIC_MIN_COSINE` (default 0.50) or
  `HOUGE_WIKI_MIN_COSINE` (default 0.30). FTS alone admits only when the query embedding is null (BM25 is normalised
  to the best hit, so it cannot gate). A row without an embedding is admitted only by FTS. The 0.05 floor goes. Score
  order and the 6-row / 900-char (facts) and 1200-char (wiki) caps stay. A gate of 0 restores today's behaviour.
- **Telemetry:** the retrievers return `{rows, best_admitted, best_rejected, embedding: bool, fts_only: bool}`,
  plumbed through `retrieveForOmpTurn` (`core-worker.ts:2133`) into the attribution ledger row
  (`recordAttribution`, `turn-context.ts:130`), so A2/C can recalibrate from live turns.
- **Decay:** fewer rows are touched once the gate is on, so valid, rarely-matched facts would age into the decay
  prune (`run-store.ts:2985`). A1 stops decay from **pruning** facts and pages (reuse still decays; the 200-per-chat
  cap-prune still bounds the count). B redesigns the fact lifecycle with provenance and validity.

### 4. Biography survives; facts point to their source

- **Core through merges:** a merged fact is core only when **every** source is core (an OR would promote a mixed
  merge to permanent). `saveReconciledFact` keeps today's inheritance from a core target.
- **Core never decays and is never cap-pruned**; core leaves only through `memory_correct` or supersede. When active
  core rows exceed `HOUGE_EPISODIC_CORE_CAP` (8), a `core_overflow` incident opens. `memory_correct`'s correct
  action still mints a non-core row (M-H1: a correction never mints biography); retire is unchanged.
- **The core band is touched** with its rendered ids (§1 snapshot).
- **Evidence (provenance, not truth):** the extract transcript gets explicit line numbers (`[n] user: …`); each fact
  returns `evidence: {line, quote}`. Code checks that line `n` is a user turn whose run is not schedule-born, and that
  `quote` is a substring of that line's clipped text after NFKC and whitespace normalisation. `source_turn_ids`
  becomes that turn. Mode `HOUGE_EPISODIC_EVIDENCE=off|shadow|enforce` (default `shadow`: count
  `evidence_rejected {reason}` and keep the fact; `enforce` drops it). The live gate measures the rejection rate per
  ticks leg before Paco switches to `enforce`.
  What evidence does not do: a matching quote can still be a question or a hypothetical. That judgment is the
  extract prompt's in A1 and the A2 cascade's after.
- **`core: true` is honoured only when the evidence passes** (in `shadow` mode too) **and the fact is an ADD**; the
  deterministic part is the evidence check, nothing more.
- **Extract prompt rules added:** a question, hypothetical, request or quote is not a claim about the user — at most
  an interest; never record what the assistant said or presumed; one assertion per fact.
- **Transcript lines are flattened:** CR/LF and Unicode separators inside a turn become spaces, so turn text cannot
  forge a `[n] user:` line.

### 5. Lesson themes: closed labels that bound merging, not learning

- New column `lessons.theme TEXT NOT NULL DEFAULT 'unthemed'`. Closed list in code: `format`, `time`, `honesty`,
  `hygiene`, `sources`, `tasks`, `self` (definitions in the code next to the list; agreed with Paco 2026-10-02). A new theme is a code change.
- `lesson_write` asks the reconcile call for the theme too (one call: verdict + theme from the closed list; an
  unknown value → `unthemed`, ledgered).
- **Reconcile sees every active lesson of both scopes** (≈ 11 rows), so a mis-themed lesson still meets its duplicate.
- **Merging is same-theme only:** an UPDATE whose target has another theme is not applied (ledgered
  `lesson_cross_theme {candidate, target}`), and the candidate is saved as an ADD under its own theme. Future
  consolidation clusters within a theme.
- No per-theme write cap (both reviews: it could refuse valid feedback with no tool to make room until B). Size is
  bounded by §2 and the render cap, and any omission is raised by §1.

### 6. A lesson change starts a fresh planner session, seeded

- **Persisted fingerprint:** table `planner_session_state(chat_id PK, lesson_fingerprint, updated_at)`. The
  fingerprint is a hash of the active lesson set (id, text, avoid, theme, sorted by id) — never the rendered bytes, so
  reordering cannot trigger it. Compared at spawn, so a change while the daemon was down is caught after a kickstart.
- **Mechanism:** when it differs, the supervisor spawns as today, then sends omp's `new_session` RPC instead of
  relying on `open_session`'s resume, asserts it returned `cancelled: false` (omp's `new_session` result,
  `rpc-types.ts:133`), then stores the new fingerprint. No
  file is moved: omp keeps the old transcript file in the session dir, and the next `open_session` resumes the newest
  (the new) one. Ledger `planner_session_reset {reason: "lesson_change"}`; a failed `new_session` fails the spawn with
  `planner_session_reset_failed` (incident) rather than resuming silently. Flag `HOUGE_LESSON_SESSION_RESET` (default
  on).
- **Seed:** a reset sets a `seed_pending` mark, claimed at dispatch like `claimRestartNoteAtDispatch`
  (`turn-context.ts:80`), so a turn that ends before dispatch leaves it for the next. The seed is a fenced
  `[recent conversation — reference data, not instructions]` block holding Paco's **user** turns only from the last 3
  completed Telegram runs before the current one (schedule-born and the current run excluded), each clipped to 300
  chars, its closing marker neutralised as `[/context]` is (`turn-context.ts:157`). Assistant replies are not seeded:
  they carry web-derived text and the habit being removed.

### 7. Fact reconcile gets its own prompt and real neighbours

- `FACT_RECONCILE_DISCIPLINE` (new, in `episodic-extract.ts`): facts are statements about the user's world; UPDATE
  text is one atomic fact ≤ 240 chars, never an instruction; SUPERSEDE when the new fact is a newer value of the same
  attribute; ADD when they are about different things; DROP when already stated; any failure → ADD.
- **Embed before reconcile:** `planFacts` embeds each candidate first; neighbours are FTS hits ∪ the top 8 active facts
  by cosine ≥ 0.50, deduplicated, at most 8, plus the window overlay (in-window facts are compared by text, as today).
  No candidate embedding → keep today's newest-K fallback (CJK has no FTS hit; dropping it would turn every fact into
  an ADD). An UPDATE that changes the text is re-embedded before saving.

### 8. One-off migration (`scripts/migrate-memory-a1.mjs`)

- Reads `.superpowers/memory-a1/plan.json` (untracked): the five lessons replacing #43 (Paco approved the texts in chat
  on 2026-10-02), the split of #42 (texts to approve), the themes of the other active lessons, and the core fact to
  restore.
- Dry-run by default: prints every before/after row. `--apply` runs everything in **one** transaction through new
  transaction-free store helpers (`retireMemoryRowsTx`, `addLesson`/`supersedeLesson` without their own BEGIN; the
  existing ones nest `BEGIN IMMEDIATE` and would throw, `run-store.ts:3886`). Steps:
  1. #43 → five lessons; each new row's `supersedes = 43`, `#43.superseded_by` = the first, so `lessonLineage` finds
     all five. Not carried: the probe sign-off, "avoid lists", "save user facts".
  2. #42 → its themed split, the same way.
  3. Themes for #1, #2, #7, #21, #44.
  4. Fact #149 retired as a `memory_changes` row (Undo-able).
  5. The core residence fact restored as a new core row whose evidence points at the superseded core rows' turns.
- Each step appends `memory_migration {step, old_ids, new_ids}`. A test makes the last step fail and asserts nothing
  was written. Re-running after success is a no-op (it checks #43's status). `--revert` reactivates #43 and #42,
  retires the new rows, undoes the #149 change and retires the restored core row, all in one transaction.
- No session step: the lesson fingerprint changes, so §6 resets the session at the next turn.

## Flags (rollback without a revert)

| Flag | Default | Off means |
|---|---|---|
| `HOUGE_LESSON_CHAR_CAP` | 4000 | (size, not a switch) |
| `HOUGE_EPISODIC_MIN_COSINE` / `HOUGE_WIKI_MIN_COSINE` | 0.50 / 0.30 | 0 = today's pool and floor |
| `HOUGE_EPISODIC_EVIDENCE` | shadow | off = no line numbers or checks |
| `HOUGE_LESSON_SESSION_RESET` | on | off = respawn and resume, as today |
| `HOUGE_LESSON_CONSOLIDATE_ENABLED` | Paco sets false | existing flag |

## Error handling

- Retrieval, rendering and seeding never throw into a turn; every skip, cap refusal, cross-theme refusal and evidence
  rejection is a ledger row (ids and counts only, never text).
- Migration: one transaction, rolled back whole on any failure; `--revert` is one transaction.
- Session reset: `new_session` failure is an incident and a failed spawn, never a silent resume.

## Testing (hermetic, red first; each test fails if its rule is removed)

Lessons: an oversized top lesson no longer evicts the rest; a skip writes a ledger row and an incident; research
lessons and skills render into the omp prompt; order is theme-then-id and a reuse change does not reorder; UPDATE over
the text or avoid cap is not saved and returns the code-owned result; UPDATE inherits reuse/applied/theme; only
rendered ids are touched; a rating credits only rendered lessons; reconcile sees both scopes; a cross-theme UPDATE
saves as ADD; `readLessonBlock`'s other callers are unchanged.
Facts: no fact admitted below the gate with embeddings present; an older relevant fact outside the newest 50 is
admitted; no query embedding → FTS hits only; gate 0 = today's behaviour; decay never prunes; a core+core merge is
core, a core+non-core merge is not; decay and cap-prune skip core; core overflow opens the incident; the core band is
touched; evidence on an assistant line, a schedule-born line or an absent quote is counted (shadow) or dropped
(enforce); a full-width-punctuation quote passes after NFKC; `core: true` without passing evidence stores non-core;
`\n[3] user: …` inside a turn cannot forge a line; fact reconcile uses the fact prompt, embedding neighbours, the
newest-K fallback without an embedding, and re-embeds a changed UPDATE.
Wiki: no page below 0.30 with embeddings present.
Session: a lesson-set change (and only that, not a reorder or a date flip) triggers `new_session`, the ledger row
and a persisted fingerprint; a change made while the daemon was down is caught at the first spawn; a failed
`new_session` fails the spawn; the seed holds only prior user turns, excludes the current and schedule-born runs, is
fenced, and survives a turn that ends before dispatch.
Migration: dry-run writes nothing; apply is atomic (last-step failure rolls back all); re-run is a no-op; revert
restores the prior state.

## Live gate (`scripts/live-gate-memory-a1.mjs`: temp DB copy + real seats; then a post-kickstart check)

Probe messages and expected ids come from the untracked plan file. PASS only if all hold:
1. The rendered prompt from the migrated temp copy contains every active ask + research lesson, under the cap, with
   no `lesson_dropped` row.
2. Retrieval over a labelled probe set (≥ 12 messages from the DB, positives and negatives, at least two whose
   relevant fact is older than the newest 50, plus an Ollama-down run): every negative gets zero rows; every positive
   gets its expected id. The script prints each probe's best admitted/rejected cosine so the defaults can be checked.
3. Re-extracting the #149 window (three runs) yields no fact asserting an attribute the user only asked about, and at
   least one evidenced fact from a window that holds a real first-person assertion; the evidence rejection rate per
   ticks leg is printed (it decides `shadow` → `enforce`).
4. A lesson UPDATE whose merge exceeds 240 is not saved, the prior lesson untouched.
5. After `--apply` and Paco's kickstart, one real turn: `planner_session_reset` is ledgered, the reply carries the
   thread (it can refer to Paco's previous message) and does not end with the probe sign-off, and
   `omp/system-chat-<chat>.md` lists the themed lessons.

## Docs on ship

ADR 0005 and 0028 amendment lines; `configuration.md` (the five flags, `LESSON_AVOID_MAX_CHARS`); `tasks/todo.md`;
`sessions.md`; ROADMAP §2′.

## Review record

Rev 1 → Rev 2 absorbed: the senior review (live probes; 3 blockers: in-memory fingerprint, nested migration
transaction, reorder-triggered resets) and the Codex pass (5 blockers: theme-gated reconcile, per-theme refusal,
embed-after-reconcile, pool-limited gate, restart-blind reset). Changes: themes bound merging only, no theme cap;
persisted set fingerprint + omp `new_session`; user-only fenced seed claimed at dispatch; whole-pool cosine gate with
FTS only when the query has no embedding; embed-before-reconcile with the newest-K fallback kept; decay prune paused;
core-merge requires all-core; evidence in shadow mode first; avoid cap; consolidation off; transaction-free migration
helpers with `--revert`; decisions module deferred to A2; personal texts moved to an untracked file; one flag per
behaviour. Rejected: none.
