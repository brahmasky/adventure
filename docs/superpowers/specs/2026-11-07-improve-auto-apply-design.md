# Improvement proposals apply on their own; the nightly digest goes

**Status:** Rev 2.1 — after the senior review (Fable 5.1: 2 blockers, 7 warnings) and codex (4 blockers, 4 warnings), all
taken; codex scoped re-review of Rev 2 (all Rev 1 items closed; 2 new blockers and 1 warning, taken in 2.1). Scope decided by Paco 2026-11-07 ("Auto-apply, alert on faults"). **APPROVED by Paco 2026-11-07 (Rev 2.1).**
**Changes what ADR 0034 means** (Tier C, Paco signs): rules 2.2, 2.5, 6.6, 10.2, 10.5, 13.1, 13.2; ADR 0031's chat list.
**Code touched:** `src/decisions/` (protected; this spec's approval is Paco's hand), `src/improve/`, `src/gateway/`,
`src/notifications/`, `src/core/standing-approval.ts`, `src/telegram/telegram-daemon.ts`, gate scripts.

## 1. Why

Paco, 2026-10-14: the 21:00 digest "does not mean much to me … we can disable it, as long as we have the audit for the
decisions somewhere and can be retrieved". It kept coming because `.env` holds `HOUGE_DECISION_DIGEST_AT=ON`, which the
code reads as the 21:00 default (only `off` turns it off). Paco, 2026-11-07: improvement proposals should apply on their
own, and he should hear only when something goes wrong.

Live DB, 2026-11-07: `improvement_proposals` has **0 rows** ever (`improve.route` failed every night until the 30 s
fix, 2026-11-07); `improve_signals` holds 6 rows; `decision_digests` 19. The tap Paco saw was the **Unsure ✅/❌** section.

## 2. What changes

| Today | After |
|---|---|
| **Lesson / fact proposal** from a correction Paco typed (§3) | **Applied at the tick** inside the group's commit; one `/changes` line with the id and the undo command; no chat. |
| Any other proposal: lesson/fact from a rating or escalation, a "lesson did not hold" rewrite, schedule, tool gap, ladder, skill, a capped lesson | **Still a tap**, as **one card per proposal at the tick**, topic `improve_card` (chat). |
| Improvements today: accepted lines with Undo / Revert / Revoke buttons | Auto-applied: `/changes` lines. Tap-accepted: the tap's reply carries the Undo / Revert / Revoke button (moved from the digest line). Job endings: their own cards already (`skill-job.ts:54-64`). |
| Standing approvals lines (digest-only today) | A change-log row **written at the grant's end** (§7). |
| Unsure ✅/❌ | **Dropped** (§9 consequences). |
| Watch | `improve_tick_degraded` page (§6); the rest of Watch's lines move to `/status` (§8). |
| The 21:00 message | **Gone.** `HOUGE_DECISION_DIGEST_AT` → `HOUGE_IMPROVE_AT` (the tick's time only). |

## 3. Which proposals apply on their own (provenance gate, R12)

ADR 0034 2.1: over tool-derived input a verdict may only tighten or propose. 2.3: an effect that **only stores Paco's
own words**, reversibly and announced, stays `paco` though its state carries context. The auto-apply path is built so
that this holds by construction, not by the backstops alone (both reviews: `shouldRejectLesson` is substring-only, a
paraphrase of Houge's reply passes; `factSupported` needs one shared token).

A group's proposal **applies** only when all hold (code, one predicate `autoApplies(g, s, verdict)`, pinned by
`tests/adr/`):

1. **A correcting turn Paco typed.** Only the memory-lane fix (`core-worker.ts:3261`) qualifies: its correction run
   holds a new message Paco wrote. `recordCorrection` (`improve-signals.ts:36`) gains a required
   `origin: "memlane_fix" | "dig_deeper" | "escalation" | "rating"`, stored in a new nullable `improve_signals.origin`
   column (additive migration; old rows are null and never auto-apply). The gate is `origin === "memlane_fix"` for every
   row of the group, `run_id !== null` and `run_id !== about_run_id`. Left out: the Dig-deeper override
   (`memlane-commands.ts:46,70` copies the *original request* into a new run — a tap, no new words, codex re-review),
   the escalation correction (`core-worker.ts:2572-2584`, run = about) and the low-rating correction
   (`gateway.ts:1268`, `run_id` null); for those the text is the original request, so they become cards.
2. **Distilled with no prior.** The auto-apply draft calls the distill with `prior: ""` (`proposals.ts` `distillDraft`):
   Houge's reply, and through it any tool text, never reaches the seat. Then the state the stored text comes from is
   Paco's message plus code-built fields (`toolSummaryOf` is tool names and counts, `groups.ts:50`). The backstops run as
   today. A group that gives nothing usable without the prior records `nothing` / `no_text` as today (no fallback to a
   prior-including card).
3. `verdict ∈ {lesson, fact}` and not the "lesson did not hold" rewrite (`evidenceOf`, `proposals.ts:29`), which is a
   card: a rewrite should replace a lesson, and `saveMemoryPlan` only adds (`memory-save.ts:18`).
4. **No pile-up.** No `accepted` or `reverted` proposal on the same (target, scope) within 14 days
   (`proposalBlocks` gains both states; today it checks `open`, `dismissed`, `expired`, `run-store.ts:5591`). Side
   effect, accepted: a reverted schedule shift blocks the same schedule shift for 14 days.
5. A chat: `g.newest.chat_id ?? d.chatId` non-null; else the proposal stays `open` and expires (logged).

Residual, accepted and stated in the ADR: with no prior and Paco's line as both numbered evidence lines, a fact can still
over-generalise his words ("check Sydney weather" → "Paco lives in Sydney"); it is his words' reading, never another
source's, and it is one `/forget_memory` away.

## 4. The effect contract (ADR 0034 2.5; `registry.ts`)

`improve.route`'s `effects.lesson` and `effects.fact` change from `{ kind: "proposal", announced: "card" }` to
`{ kind: "effect", reversible: true, announced: "changes" }`. `Announce` (`types.ts:31`) gains `"changes"` (a change-log
row naming the undo command). `effectProblems` (`registry.ts:107-118`) today fails any non-passive judged verdict over
non-`paco` input; it gains one allowance: an `effect` verdict over `mixed` input passes only if the entry names a
code-owned provenance predicate (`pacoWordsOnly: autoApplies`) and the effect is reversible and announced. Every other
mixed-input effect still fails. 2.5 is amended to say so. The provisional bar (0.67) stays: `shapeProblems:82-86`
allows it on `paco`-input reversible, announced entries; the amendment extends that to this gated case.

## 5. The commit (`tick.ts` `commitGroup`)

One `BEGIN IMMEDIATE` as today, in this order: decision row → outcome rows → proposal row (`open`) → if `autoApplies`:
`saveMemoryPlan(store, plan, { run_id: about run, chat_id, source: "improve", now })` called **directly** (not through
`acceptProposal`, whose `inTransaction` would nest) → proposal `accepted` with `result_json {change_id, lesson_id |
fact_id}` → change-log row (topic `improve_log`, key `improve_applied:<proposal_id>`) → `consumed_at`. A capped lesson,
or a save with no change id, does not throw: the proposal stays `open` and gets a card. A throw rolls the whole group
back (unconsumed, `record_failed`). `TickCounts` are bumped after the transaction commits (codex: today they move
inside it). A non-applied proposal queues its card in the same transaction (topic `improve_card`, key
`improve_proposal:<proposal_id>`, `offered_at` set).

The `/changes` line: `📒 Lesson #57 learned from your correction (ask): <60 chars> — undo: /forget 57` ·
`🧠 Fact #214 learned from your correction: <60 chars> — undo: /forget_memory 214`. `/lessons` shows `source improve`.

## 6. Undo

- `/forget <id>` (`gateway.ts:587-625`, flips `lessons.status`, no change row), `/forget <scope>` (prunes several) and
  `/forget_memory <id>` (`memory-commands.ts:106`, a new retire change) look up the proposal by
  `result_json.lesson_id` / `fact_id` (new store method `proposalBySaved(kind, id)`), per removed id, and move it
  `accepted → reverted` in the same transaction as the removal. `proposalByChange` stays for old buttons.
- A `reverted` proposal blocks its (target, scope) for 14 days (§3.4).

## 7. Faults page (replaces Watch's alarm)

`improve_tick_degraded` (route: page, topic `incident_page`), subject `improve`. Read from `improve_ticks` rows
(`listImproveTicksSince`: one row per local date with its final `result` and accumulated counts), not from ledger
events (a resumed date emits several). Evaluated once per tick date, at its end, on that date's row only, in date order:

- A date is **bad** if it ended `failed`, or the previous date's row is still `running` (a throw out of
  `finishImproveTick`, `tick.ts:89`), or it decided nothing (`decided === 0`) while `deferred_outage`, `record_failed` or
  `embed_unavailable` was above 0. It is **healthy** if it ended `done` and either decided something or had no group to
  decide **and** `embed_unavailable === 0` (an embedder outage that kept recurrence groups from forming is not healthy,
  `recurrence.ts:80`). Anything else (`stopped`) is neither and changes nothing.
- **Opens** on a `failed` or stuck date at once, or when the current run of consecutive bad dates reaches three.
- **Resolves** on a healthy date, which also resets the run to zero. Only the newest date is judged, so an older bad
  date never reopens a page a newer healthy date resolved.
- `stopped` (the 120 s budget, resumed) pages nothing. `HOUGE_IMPROVE_ENABLED=false` writes no row: nothing opens or
  resolves. An embedder outage also pages on its own (`embeddings_unavailable`, unchanged).
- Text: kinds, counts and dates only.

## 8. Where the rest goes

- **Standing-grant endings:** the change-log row is written in the one central end transition, `endStandingTx`
  (`run-store.ts:5735`), after its CAS succeeds and in its transaction, so every path — `standing-approval.ts`, schedule
  cancellation (`run-store.ts:6020`), fingerprint mismatch (`:7153`), denial (`:7231`) — writes it exactly once. Key
  `standing_end:<standing_id>`, text from `STANDING_DIGEST_TEXT` (same reason filter); no cursor. It uses plain
  statements, as `endStandingTx` must inside `processApprovalTrigger`'s raw BEGIN.
- **`/status`:** keeps its lines. The helpers it imports from `digest.ts` (`countLines`, `decisionWindow`,
  `deciderLabel`, `injectionCounts`, `settleHealthLine`, `trustTops`) move to `src/decisions/status-lines.ts`. The
  Watch lines that are diagnostics, not alarms (unattached signals, silent families, deferrals, wiki disarmed,
  inapplicable targets, lessons not holding), become one `/status` "Improvement (7 d)" line.
- **Kept constants:** `REVIEW_PREFIX` (an old ✅/❌ button answers "this review has closed"), `DIGEST_PR_PREFIX` and
  `DIGEST_LM_PREFIX` (card buttons and old buttons keep working), `STANDING_DIGEST_TEXT`. `decision_digests` stays
  (additive); `wasDecisionOffered` keeps reading it for old taps.
- **Removed:** `runDecisionDigestTick`, `enqueueDigest`, `buildDecisionDigest`, `unsureSection`, the `digest` topic.
  Scripts calling them (`check-ladder-stage4b-rollback.mjs`, `check-ladder-stage4c-rollback.mjs`,
  `live-gate-decisions-parity.mjs:434-438`, `live-gate-decisions-2a.mjs:524`) are updated or their digest checks
  retired, each named in the plan.

## 9. Consequences (ADR text)

- No ✅/❌: no `review_ok`/`review_bad` labels, so `review_bad` → ladder proposals stop arising, and ADR 0034 6.6's
  category labels from ✅ on a front-door lane route (`jev/tap-labels.ts:24`) stop. 6.6 is amended: calibration labels
  come from taps on cards (Dig deeper, Undo, 认真想) only.
- The revisit trigger "14 days of `improve.route` rows are in for its bar" relies on outcomes only.

## 10. Config

- `HOUGE_IMPROVE_AT` (`HH:MM` in `HOUGE_DISPLAY_TZ`, default `21:00`), read by `improveTickDue` (`tick.ts:62`). No `off`
  (R13); `HOUGE_IMPROVE_ENABLED=false` stays the switch, covered by `/disarm`.
- `HOUGE_DECISION_DIGEST_AT` removed. Startup logs once if it is set; the name joins `ENV_NOT_CONFIGURATION`
  (`tests/docs/parity.ts:10`) so docs parity passes. Docs re-read: `configuration.md`, `jev-decision-layer.md`
  (77-79, 100, 260, 268, 291-297), `decision-map.md`, `CONTEXT.md`, `ROADMAP.md`, `src/improve/flag.ts:4`.

## 11. ADR text (drafted with the code, for Paco's signature)

- **2.2:** adds "or, for a lesson or fact `improve.route` applies from a correcting turn Paco typed (rule 10.5), on a
  `/changes` line with its undo command".
- **2.5:** the gated allowance of §4.
- **6.6:** §9.
- **10.2:** "at the digest's time (also while the digest is `off`)" → "at `HOUGE_IMPROVE_AT`".
- **10.5:** rewritten per §3, §5, §6: the provenance gate, no prior, no pile-up, `reverted` blocks, cards for the rest.
- **13.1:** "No digest. `/status` holds the counts, the `turn.settle` health line, per-entry Jev-skip counts and the
  improvement line; `/changes` lists applied improvements and ended standing grants."
- **13.2:** `improve_tick_degraded` pages.
- **ADR 0031:** "the digest" leaves the chat list; "improvement proposal cards" joins it.

## 12. Tests and gate

- `tests/improve/`: a memlane-fix correction applies (rows, `accepted`, `result_json`, one change-log row, no chat
  outbox row); a Dig-deeper, an escalation and a rating correction become cards; the distill question for an
  auto-apply draft has an empty prior (asserted on the seat input); a "did not hold" rewrite is a card; a second
  correction on the same scope within 14 days is `already_proposed`; a capped lesson is a card; no chat → stays open;
  a throw inside the save leaves the group unconsumed and the counts unchanged.
- `tests/decisions/`: `entryProblems` passes `improve.route` with the gated effect and fails a copy without the
  predicate, or with `reversible: false`.
- `tests/gateway/`: `/forget <id>`, `/forget <scope>`, `/forget_memory <id>` revert the proposal; old ✅/❌ answers closed.
- `tests/improve/` (degraded): opens on one `failed`, on a stuck `running`, on three no-decision degraded dates; not on two,
  not on `stopped`, not when a date decided something; resolves; routes page.
- `tests/core/`: each standing end writes one change-log row, once.
- `tests/adr/`: `autoApplies` pinned (rule 10.5); `tests/docs/`: config parity.
- **Live gate** (`live-gate-improve-route.mjs`, copy): case 3 (memlane-fix correction) passes on **applied, a `/changes`
  row, no chat row, empty prior at the seat**; case 4 becomes "`/forget` reverts it, the next tick is `already_proposed`";
  case 5 (schedule) passes on **one card**; case 6 becomes "no digest"; case 7 (injection) also checks no planted phrase
  in any applied lesson or fact; new case 12 plants a rating correction (card, not applied) and three degraded dates
  (one page).

## 13. Rollout

Merge, rebuild, kickstart (Tier A after green gates). The first 21:00 after deploy sends no digest. Paco's `.env` line
`HOUGE_DECISION_DIGEST_AT=ON` can be deleted at leisure.
