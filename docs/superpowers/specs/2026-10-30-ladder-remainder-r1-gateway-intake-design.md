# Decision ladder, remainder slice R1 — `intake.rate_limit`, `intake.rating_reply` and `intake.budget_fuse` on the ladder (Rev 1.3)

**Status:** Rev 1.1 — after the senior review (Sonnet 5.5; Fable rate-limited, 429; probed live code + a DB copy: 0 blockers, 6 warnings, 4 suggestions, every one verified first-hand and applied, §Rev 1.1 changes). Rev 1.2 — codex review (of Rev 1: 2 blockers, 5 warnings, 1 suggestion; blocker 1 and the suggestion were already closed by Rev 1.1, the rest verified first-hand and applied, §Rev 1.2 changes). Codex scoped re-review of Rev 1.2: 16 closed, 1 open (digest count lines) → applied in Rev 1.3; no new blocker. **APPROVED by Paco 2026-10-30: Decisions 1-A, 2-A, 3-A.**
**Date:** 2026-10-30
**Amends:** `docs/ROADMAP.md` (the Stage 3 remainder line); ADR 0030 gets an amendment row (drafted under the approved spec, awaiting Paco's signature), including the §6.1 table corrections in Decision 2.
**Depends on:** ADR 0030 §4.1 (entry), §6.1 (inventory rows A2, A4, A5), §6.2 (move, don't improve); ladder design `docs/superpowers/specs/2026-10-12-decision-ladder-design.md` §6.1 (`:366`; "the plan's first task re-walks the inventory at its base commit and fixes this table", `:389`); Stage 3 spec `2026-10-24-ladder-stage-3-pretool-safety-design.md` §2 (`:41–44`, the deferred families by name); Stage 4C (`2026-10-30-ladder-stage4c-admit-design.md`, shipped `01331a3`) for the pattern, the stamped merge-base differential and the rollback check.

## 1. Goal

Put the three intake rows that `Gateway.intake` owns on the registry as rule-only entries that **record and never steer**:

- `intake.rate_limit` (A2): the per-chat Telegram limiter (command window, active runs, pending approvals);
- `intake.rating_reply` (A4): an active rating ask consumes, forwards or lets go of the next message;
- `intake.budget_fuse` (A5, **locked**, ADR 0003): the global 24 h circuit breaker refuses a new run.

Each wraps today's code unchanged; the raw answer keeps driving the branch (Stage 4B ruling R1). The proof is the stamped merge-base differential, extended with one corpus: zero behaviour differences.

This spec also re-walks the whole remainder (§2) and fixes the order of the slices after it (Decision 1) and two §6.1 rows (Decision 2), so one tap approves the order and slice R1.

## 2. The remainder, re-walked at `main@aec1d4f`

Lesson 2026-10-30: "the next Stage N item is defined by the specs, not by a numbering in a delta". The Stage 3 spec deferred four families by name (`:41–44`). Against `ENTRY_IDS` (`src/decisions/entry-ids.ts:5`, 23 ids), the unregistered ids are **19, not 20**: the ROADMAP delta said pre-model ×10; §6.1's pre_model column minus `ENTRY_IDS` leaves 9 (`turn.handler` and `turn.gear` are registered and wired, `core-worker.ts:3097`, `:3199`). Read-only probes of every call site (three parallel readers, Sonnet; slice-R1 facts re-read first-hand) give:

| id | row | L | code today | model/Jev? | run at the decision? | seam a recorder needs | slice |
|---|---|---|---|---|---|---|---|
| `intake.rate_limit` | A2 | — (exemption locked, §4.1) | `Gateway.intake` `gateway.ts:165–191`, `RunStore.checkTelegramRateLimit` `run-store.ts:2651` | no | no (`run_id` null) | `Gateway.runStore` (have) | **R1** |
| `intake.rating_reply` | A4 | — | `Gateway.captureRatingReply` `gateway.ts:311–399` | no | no | `Gateway.runStore` (have) | **R1** |
| `intake.budget_fuse` | A5 | L | `Gateway.handleTaskIntake` `gateway.ts:1074–1120`, `computeBreaches` `budget/global-budget-ledger.ts:86` | no | no | `Gateway.runStore` (have) | **R1** |
| `turn.contract` | A7 | — | `compileTurnContract` `contracts/task-contract.ts:155–175`, called `gateway.ts:1075` | no | no (compiled before `createOrGet`) | `Gateway.runStore` | R2 |
| `intake.sender` | A1 | L | `authorizeTelegramUpdate` `triggers/telegram-auth.ts:14–31` via `normalizeTelegramUpdate` `telegram-trigger-adapter.ts:123`, `:258` | no | no | none: a pure adapter; recorder via the poll loop's options (beside `skippedUpdateStore`, `:611`) | R2 |
| `intake.bare_ack` | A10 | L | `isBareAck` `omp/bare-ack.ts:11`, `PlannerSupervisor.submit` `planner-supervisor.ts:364`, `nudgeAck` `:373` | no | yes | `d.store` (have); harness: a `PlannerSupervisor` fixture (new) | R3 |
| `intake.steer_or_queue` | A9 | — | `PlannerSupervisor.submit` `:359–371`, `steer` `:453` | no | yes | same | R3 |
| `planner.crash_guard` | D2 | — | `crashLooping` `planner-supervisor.ts:1007`, latch + counter | no | not always (warm start) | same | R4 |
| `turn.retry` | D9 | — | `mayRetry` `:890`, `retryNextLeg` `:874`, `promptRetry` `:896`, `classifyOmpError` `omp-frames.ts:69` | no | yes | same | R4 |
| `context.recall` | A25 | — | `retrieveForOmpTurn` `core-worker.ts:2417`, `admit` `run/relevance-gate.ts:32` (code bar over an embedding cosine) | embedding score, code bar | yes | `TurnContextDeps` (`omp/turn-context.ts:22`) has none: add one | R5 |
| `context.catch_up` | A26 | — | `catchUp` `turn-context.ts:326`, `renderCatchUp` `:318` | no | yes | same | R5 |
| `turn.clarify_cap` | A27 (cap only) | — | `clarifyCapReached` `turn-context.ts:123` | no | yes | same | R5 |
| `context.lessons` | A23 | — | `buildSystemPrompt` `turn-context.ts:185`, `renderLessonSection` `run/lesson-render.ts:68` | no | no (spawn/refresh, chat only) | same | R5 |
| `lookup.rewrite` | A21 | — | `lookupQuery` `core/lanes/lookup-lane.ts:55`; `needsRewrite`/`validateQuery` `lane-compose.ts:63`, `:78` | Tiny model between two code rungs | yes | `d.recorder` (have; the lane already records `tool.wall`, `reader.family`) | R6 |
| `lookup.thin` | A21 | — | `readStep`/`thinFetch` `lookup-lane.ts:93–130` | code trigger on the reader's field | yes | same | R6 |
| `turn.model` | A22 | — | `resolveRole` `omp/model-roles.ts:134`, `RoleResolver.candidates` `role-resolver.ts:83` (called per seat, many times a turn) | no | at the supervisor's pin/step-up point only | supervisor | R6 |
| `attach.path` | E2+E11 | L | `parseAttachments` `omp/attachments.ts:11` (supervisor; drops a refused marker silently); `TelegramNotificationAdapter.sendAttachments` `notifications/telegram-notification-adapter.ts:57–107` (no store, no run) | no | E2 yes, E11 no | two seams; the outbox row already has `run_id` (`run-store.ts:297`, `NotificationIntent` `notification-types.ts:28`) but the dispatch record the adapter receives does not (`:52`): propagate it there; notifications with no run record `run_id` null | R7 |
| `memory.rule_save` | A19 | — | absorbed: every A19 refusal is already `memory.lesson_admit` (`lesson-write.ts:222`, `:224`) or `memory.kind` (`:256–272`); the save-or-not choice is `saveFor` (`src/jev/tree-policy.ts:136`, `sets_rule` zone `yes`) inside `turn.handler`'s route, whose verdict effects declare the save-first (`entries/turn-handler.ts:29–35`) and whose detail table `jev_verdicts` (linked by `decision_id`, ladder spec §5.3) stores `sets_rule`, `rule_scope` and `save_outcome` on every routed turn, the no-save path included (`save_outcome = 'none'`: 37 of 38 live rows) | — | — | — | **none** (Decision 2) |
| `notify.page` | E12 | — | `openAlertedIncident` `run/incident-alert.ts:30–39`, ~15 callers (supervisor, sweep, daemon, `decisions/record.ts:75`) | no | rarely (`detail.run_id`) | — | **none** (Decision 2) |

**Order (Decision 1).** Slice by seam, not by §6.1 column: each slice is one recorder seam, one harness extension, ≤ 4 entries, one live gate, one rollback check (4C's size). R1 first because it needs **no new seam**: `Gateway` already holds `runStore` (`gateway.ts:149`), the harness already drives `Gateway.intake` (`scripts/stage4-bridge-seam.mjs:57`), and `Gateway` is in the loader's export map (`stage4-diff-lib.mjs:17–30`). R3/R4 share the new `PlannerSupervisor` fixture; R5 adds a recorder to `TurnContextDeps`; R7 is last because E11 needs the run carried into the outbox.

**Live traffic** (`VACUUM INTO` copy, 30 days to 2026-10-30): 126 Telegram runs, 57 scheduled runs, 181 user turns (~6 a day); `telegram_command_audit` denials, rating captures and fuse trips are rare. Existing `decisions` rows: 358 in total, `tool.injection` the largest (143). Recording every intake decision would add about 10 rows a day; this slice records less (§4).

## 3. Live facts for R1 (`main@aec1d4f`, read first-hand)

**Order inside `Gateway.intake` (`gateway.ts:160`).** (1) rate limit, Telegram source only and not exempt (`:165`); (2) memory-lane "Dig deeper" prep (`:195`); … (3) for `type === "turn"`, the rating capture (`:285`) — `consumed` returns, `forward` re-enters `handleTaskIntake` with the comment as the goal; (4) `handleTaskIntake` (`:1074`): contract compile, then the budget fuse, then `createOrGet`. The order is kept exactly.

### 3.1 `intake.rate_limit` (A2)
- **Exemption.** `RATE_LIMIT_EXEMPT` (`gateway.ts:139`): `kill`, `decision_review`, `improvement_tap`, `jev_accept_tap` (ADR 0018 + ladder plan ruling 16; the §6.1 text names only `kill` — widened since). The window count excludes the three taps again in SQL (`run-store.ts:2658`, `NOT IN ('decision_review', 'improvement_tap', 'jev_accept_tap')`): the exemption lives in two places.
- **Checks, first match wins** (`run-store.ts:2651–2688`): `command_window` (≥ `TELEGRAM_MAX_COMMANDS_PER_WINDOW` accepted audit rows for this actor and chat in the window), `active_runs` (≥ `TELEGRAM_MAX_ACTIVE_RUNS` runs queued/running/waiting for the actor), `pending_approvals` (≥ `TELEGRAM_MAX_PENDING_APPROVALS` pending approvals for the actor).
- **Denial:** one `telegram_command_audit` row (`decision: "denied"`, `reason_code` = the check) then `{ ok: false, error: { code: "TELEGRAM_RATE_LIMITED", … } }`; no reply. The poll runner treats the code as a handled denial (`telegram/telegram-poll-runner.ts:45`).
- **Allow:** nothing at this point; the accepted audit row is written later by the handler that admits the event (`recordTelegramAccepted`, `gateway.ts:1214`) and is the limiter's own counter.

### 3.2 `intake.rating_reply` (A4)
`captureRatingReply` returns `undefined` (the message is a normal turn) for: a scheduled source (B10b), a non-Telegram target, a replayed trigger whose stored result is neither capture marker, no pending ask, an inactive ask, an ask older than `HOUGE_RATING_PENDING_MINUTES`. Then:
- **replay** of a recorded capture → `consumed` with the stored result, or `forward` with the stored comment; an idempotency **conflict** → `consumed` with `{ ok: false }` (A6 idempotency is mechanics, §6.1);
- an active ask and a message that is **not** a rating (`parseBareRating`, `capabilities/session-rating.ts:69`) → `cancelPendingRating`, then `undefined` (the ask lapses silently);
- a **digit with a comment** → banks the rating, writes the `rating_comment_captured` marker, `forward` (no ack);
- a **bare digit** → banks the rating, enqueues `RATING_ACK_TEXT` (`:rating` key), records the trigger and an accepted audit row, `consumed`.
Banking (`recordSessionRating`, `applyRatingToLessons`, `noteRating`, `markLowRating` at ≤ 1, `applyRatingToWikiPages`) is mechanics and stays where it is.

### 3.3 `intake.budget_fuse` (A5, locked)
`checkGlobalBudget(caps, now)` (`run-store.ts:2747`) → `computeBreaches` over the three kinds `runs`, `tool_calls`, `gated_attempts` (`global-budget-ledger.ts:18`; a cap is breached when usage has reached it). On a breach, in order: the `global_budget_fuse` ledger event (`recordGlobalBudgetFuse`), the 0→1 latch with one alert per episode (`global-budget-fuse:<since>`), a denied audit row for a Telegram source (`reason_code: "global_budget_fuse"`), then `{ ok: false, error: { code: "GLOBAL_BUDGET_FUSE", … } }`. Control commands never reach `handleTaskIntake`.

## 4. The entries (pattern: `entries/approval-bind.ts` locked, `entries/schedule-admit.ts` unlocked)

All three: `version: 1`, `stage: "intake"`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`, no Jev or model rung. Rows carry `run_id: null` (no run exists yet; the column is nullable, `run-store.ts:1112`) and `tool_call_id: null`. The recorder is `storeRecorder(this.runStore)`, built lazily once in `Gateway` like `CoreWorker`'s (`core-worker.ts:560`, no `env` option). `Gateway` has no env member, so a `decision_record_failed` alert pages `process.env.HOUGE_TELEGRAM_CHAT_ID`: the differential and the live gate clear or pin that variable, or the fault path would queue an alert to Paco's real chat.

### 4.1 `intake.rate_limit`
- `input: "tool"` (counts from the store, not Paco's words); verdicts `allow | limit`; `defaultVerdict: "allow"`; `fail: "limit"` (never acted on, the raw answer drives; but the entry is consulted only after a denial, so a throwing rule must not write an `allow` row for a denied user and count it toward `decision_fallback`); **no `alwaysRecord`**: only a `limit` leaves a row (the allow path is already counted by the accepted audit row).
- Input `{ result: TelegramRateLimitResult }`; `reasonCodes`: `command_window`, `active_runs`, `pending_approvals` — the existing `reason` strings verbatim.
- Effects: `allow` none; `limit` `tighten`, reversible, announced none.
- **The exemption stays outside the entry.** The `RATE_LIMIT_EXEMPT` check stays in `Gateway.intake` before `decideSync`; an exempt command never reaches the entry. Reason: `intake.rate_limit` is unlocked, so a later ladder move could add a rung; keeping the exemption in code ahead of the entry means no rung can ever delay `kill` or a review tap (the §6.1 "locked rule inside it", realised as code in front of the entry rather than a rung inside it). A test pins `RATE_LIMIT_EXEMPT` minus `kill` equal to the SQL `NOT IN` list (`run-store.ts:2658`; `kill` is absent from the SQL on purpose — it is never an accepted row that counts), and a `Gateway` test asserts an exempt command on a saturated window never calls the recorder. This realisation of §6.1's wording is Decision 3.
- Call site: one `decideSync` after `checkTelegramRateLimit` returns `ok: false`, before the denied audit row.

### 4.2 `intake.rating_reply`
- `input: "paco"` (the message is Paco's own); verdicts `consume | forward | lapse`; `defaultVerdict: "lapse"`; `fail: "lapse"`; **`alwaysRecord: true`** — the entry is only consulted once an active, in-window ask meets a message (a handful a week), and each of the three verdicts changes the turn's path.
- Input `{ outcome: "consume" | "forward" | "lapse" }`; the rule is a 1:1 map: `consume` → `bare_digit`, `forward` → `digit_comment`, `lapse` → `not_rating`.
- Effects: `consume` `reply`, reversible false (the rating is banked), announced none (the ack is the reply); `forward` `effect`, reversible false, announced none; `lapse` `none`. (R12's condition binds Jev and model rungs over Paco's words; `effectProblems` returns early for an entry with no Jev or model rung — `registry.ts:84–100`.)
- Call sites: at the three fresh-decision returns only — lapse `gateway.ts:351–354`, forward `:376–380`, consume `:383–400` — as each returns, after the existing writes (`recordTriggerProcessed`, `recordTelegramAccepted`). A crash between those writes and the row loses the row, never the rating (accepted: the row is an audit of a decision the store already holds). The expired-ask return (`:349`) records nothing. **Not** at the replay or conflict returns (A6, mechanics; recording a replay would write a second row for one decision) and not at the `undefined` exits before an active ask is found.

### 4.3 `intake.budget_fuse` (locked)
- `locked: true` (in `LOCKED_ENTRY_IDS` since stage 1, `entry-ids.ts:14`); `input: "tool"`; verdicts `admit | refuse`; `defaultVerdict: "admit"`; `fail: "refuse"`; **no `alwaysRecord`**: only a trip leaves a row (an admitted run is already a `global_budget_events` row).
- Input `{ breaches: GlobalBudgetBreach[] }`; `reasonCodes`: `runs`, `tool_calls`, `gated_attempts` — the **first** breached kind in `GLOBAL_BUDGET_KINDS` order (a row holds one reason; the full list stays in the `global_budget_fuse` event).
- Effects: `admit` none; `refuse` `tighten`, reversible, announced none (the 0→1 alert is the existing announcement, unchanged).
- Call site: one `decideSync` after `checkGlobalBudget` returns `ok: false`, before `recordGlobalBudgetFuse`.

### 4.4 Failure behaviour (Stage 4B R2, Stage 4C §4.4 carried over)
(a) the store insert fails inside `storeRecorder` → `decision_record_failed` opens; (b) a recorder that throws past itself → `decideSync` catches and logs, no incident. Neither changes the intake result, the audit row, the ledger, the gateway's own outbox rows or their order. **Stated delta, as for every entry since stage 1:** fault (a) adds the `decision_record_failed` incident and, through `openAlertedIncident`, its one alert row to the outbox. Each rule is a total map over a closed input.

**Placement relative to existing writes.** `intake.rate_limit`: after `checkTelegramRateLimit`, before the denied audit row (`gateway.ts:177`). `intake.budget_fuse`: after `checkGlobalBudget`, before `recordGlobalBudgetFuse` (`:1085`); when the fuse runs inside `admitMemLaneAsk`'s transaction (`:1190`) the row commits with it (an `ok: false` return commits). `intake.rating_reply`: after the existing writes (§4.2). `decideSync` never throws (fault (b)), so no placement can skip an existing write.

## 5. What does not change
- Every `GatewayIntakeResult`, error code and message, `telegram_command_audit` row, ledger event, outbox row (ack, fuse alert), rating and lesson/wiki row, and their order — byte-identical.
- The exemption set, the SQL exemption list, the thresholds, the fuse latch and its one-alert-per-episode rule.
- `/status` gains a count line per new id once rows exist (`countLines`, called only by `status-view.ts:30`; no new copy). The daily digest prints no per-entry count lines (`countLines`'s doc comment, `digest.ts:90`, says it does — stale; a follow-up, not this slice) and is untouched. The digest's chat-bound review deliberately skips `run_id`-null rows (`digest.ts:309`): intake rows are stored and counted but never offered as a per-chat review item (intended: no run to label).

## 6. The differential (extends `scripts/check-ladder-stage4-differential.mjs`)
**Harness work this needs (a plan task):** the `--old-dist-r1` pair, the `r1` entry in `NEW_ROW_IDS` plus the three ids in the existing sets, the whole-DB dump with its table-coverage self-test (the lib compares a projection today), the export-map entries the corpus needs. Old side: the merge base, stamped (`scripts/stamp-dist.mjs`, `verifyStampedDist`) as in 4C; the flag that names the stamped pair takes the slice's own build (`--old-dist-r1`, its provenance file `gateway/gateway.js`, the file this slice changes — lesson 2026-10-29 on a provenance check keyed on an untouched file). The existing pairs and corpora rerun unchanged.

New corpus `scripts/stage4-corpora/intake/`, every item through `new Gateway(store, caps).intake(event, now)` on its own fresh DB copy, fixed `now`, caps injected:
- **rate limit:** each check at its threshold and one under; each of the four exempt commands at a saturated window (no row, admitted); a tap command at a saturated window (window count unchanged by taps); a scheduled source (never limited).
- **rating:** bare digit, digit + comment (zh and en punctuation), non-rating text, each with an active in-window ask; an expired ask; an inactive ask; no ask; a scheduled source; a replayed bare digit and a replayed comment (no second row); an idempotency conflict; a low rating (≤ 1, `markLowRating`).
- **budget fuse:** each kind breached alone, two kinds, under cap; first trip (latch 0→1, one alert) and second trip (no second alert); a Telegram and a scheduled source.
Compared projection: the intake result and a **whole-DB dump** of every table's rows written by the item (forward and lapse items continue into `createOrGet` and write `runs` and run-state rows; a low rating writes `jev_verdicts` through `markLowRating` → `updateJevVerdict` + `recordCorrection`, `gateway.ts:1169–1174`, so its item seeds a verdict), in order, under 4C's ordered relabelling (never dropping a key); a self-test fails if a table gains rows the dump misses. Row filter: the three new ids are added to **every** pair's `NEW_ROW_IDS` set (`stage4-diff-lib.mjs:142`: the branch build is the new side of the s3, s4a and s4b pairs too, so an existing corpus that trips a limiter would otherwise show a spurious difference) and to a new `r1` set; new rows are asserted separately (count, verdict, reason per item; `run_id` null). `HOUGE_TELEGRAM_CHAT_ID` is cleared for every item. PASS: 0 differences, every expected row present, the self-test (a mutated copy) fails.

## 7. Live gate — `scripts/live-gate-ladder-remainder-r1.mjs` (on `dist/`, a VACUUM copy, never the live DB for writing; refuses outside `.worktrees/`)
1. A sixth Telegram command inside the window → `TELEGRAM_RATE_LIMITED`, one row `limit/command_window`, `run_id` null, denied audit row present.
2. `kill` on the same saturated window → admitted, no `intake.rate_limit` row.
3. An active rating ask + bare `3` → ack queued, one row `consume/bare_digit`; a replay of the same update → same result, still one row.
4. An active ask + `2 太长了` → the turn runs on `太长了`, row `forward/digit_comment`; an active ask + an ordinary message → ask cancelled, row `lapse/not_rating`.
5. Caps lowered so `runs` is breached → `GLOBAL_BUDGET_FUSE`, one alert, row `refuse/runs`; a second message → no second alert, a second row.
6. The store's decision insert faulted → `decision_record_failed` opened, every intake result unchanged (silent-degradation line); separately a recorder that throws → logged, no incident, results unchanged.
7. `/status` shows a count line for each of the three ids.
8. `insertLadderMove` naming `intake.budget_fuse` → refused (locked).
The gate pins `HOUGE_TELEGRAM_CHAT_ID` to a stub chat (line 6 must not page Paco). The slice updates the hard-coded entry counts — `tests/decisions/registry.test.ts:132`, `:142` and `scripts/live-gate-ladder-stage4b.mjs:172` (23 → 26; the 4C gate has no literal) — extends the locked-entries test (`registry.test.ts:122–132`, today `approval.bind` and `secret.redact`) with `intake.budget_fuse` and the two unlocked intake entries, and reruns the 4B and 4C live gates.

## 8. Rollback check — `scripts/check-ladder-remainder-r1-rollback.mjs`
The previous build opens a copy carrying the new rows (`run_id` null among them), runs its readers (`/status`, digest, `decisions` readers) without error, every stored row still present (rows a chat-bound reader omits by design, §5, are not "lost"), and its `ENTRY_IDS`-validated writer (`review_ok`) refuses a new id cleanly. No migration.

## 9. Protected files touched (Tier A under the approved spec)
`src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `src/decisions/entries/intake-rate-limit.ts`, `intake-rating-reply.ts`, `intake-budget-fuse.ts`. Not protected: `src/gateway/gateway.ts`. `docs/decisions/0030-decision-ladder.md` (amendment, drafted, awaiting Paco's signature).

## 10. Risks
- **Rows with no run.** Not new: `tool.manifest` already writes `run_id` null (`omp/bridge-handler.ts:222`; 24 live rows), and `fetch.ssrf` passes null (`http-fetch.ts:37`). The readers tolerate it (digest `:85`, `:310` guard it; `listDecisionOutcomesAfter` LEFT JOINs `runs`, `run-store.ts:5380`; count lines, fallback counting and `shouldRecord` never read it). The rollback check still runs the old readers over the new null rows.
- **A rate-limited flood.** `limit` rows are bounded by the denials, which are already one audit row each; a flood of denials doubles the row count, not the work per message.
- **Fuse volume.** `recordGlobalBudgetFuse` already writes one ledger event per refused admission during an episode; the `refuse` row doubles that (scheduled fires during an episode included), bounded by admissions attempted.
- **Replay double-count** (§4.2): mitigated by recording only fresh decisions; the corpus's replay items assert one row.
- **Exemption drift** (§4.1): the two-literal test.

## Decision needed (Paco, at the spec tap)

**Decision 1 — the remainder's order.**
- **1-A (recommended):** the seam order of §2: R1 gateway intake (this spec) → R2 `intake.sender` + `turn.contract` (pre-run, adapter and gateway) → R3 `intake.bare_ack` + `intake.steer_or_queue` (supervisor fixture) → R4 `planner.crash_guard` + `turn.retry` (same fixture) → R5 `context.*` + `turn.clarify_cap` (recorder on `TurnContextDeps`) → R6 `lookup.rewrite`, `lookup.thin`, `turn.model` → R7 `attach.path`. Each its own spec; ROADMAP order then chains without a tap.
- **1-B:** §6.1 column order (intake, pre-model, supervision, settle). Same entries, but intake would mix three seams in one slice.

**Decision 2 — two §6.1 rows that fail the entry test.**
- **2-A (recommended):** no entry for either; §6.1 and ADR 0030 record why (removing a row from the §6.1 inventory is Paco's ruling, hence this Decision). `memory.rule_save` (A19) is absorbed: every refusal it named is now a `memory.lesson_admit` or `memory.kind` row, and the save-or-not choice is recorded on every routed turn in `turn.handler`'s detail row (`jev_verdicts.sets_rule`, `rule_scope`, `save_outcome`, §2) — a third entry would record the same decision twice. `notify.page` (E12) fails §6.1's own entry test — it does not change a turn's path (`:368`) — and runs outside any turn from ~15 callers; that is the reason. A secondary hazard: wrapping it inside `openAlertedIncident` ahead of its open-incident dedupe would loop, unbounded unless exempted: a failed `notify.page` row opens `decision_record_failed` (`record.ts:70–78`), which pages through the same function and records another `notify.page` row (monitors must not observe their own output).
- **2-B:** keep both; `memory.rule_save` as a record-only alias row, `notify.page` recorded outside `openAlertedIncident` with `decision_record_failed` exempt. Two slices of work for rows no outcome reads.

**Decision 3 — where `intake.rate_limit`'s exemption lives** (§6.1 says the `kill` exemption is "a locked rule inside it"; the registry has no rule-inside-an-unlocked-entry, and the exempt set is now four commands, ruling 16).
- **3-A (recommended):** the exemption stays code in front of the entry (§4.1): an exempt command never reaches it, so no future rung can delay `kill` or a review tap; two tests pin it (the TS/SQL literals, the recorder never called). The ADR amendment corrects §6.1's wording.
- **3-B:** make `intake.rate_limit` locked as a whole, with the exemption as the first branch of its rule. Holds §6.1's letter, but locks the limiter's thresholds against any later ladder move.

## Rev 1.1 changes (senior review, Sonnet 5.5; each verified first-hand)
- W1 null `run_id` is not new (24 `tool.manifest` rows) → §10 restated. W2 the exemption realisation changes §6.1's wording → Decision 3 + recorder test + the TS-minus-`kill`/SQL test. W3 `fail: "limit"`; the rating rule a 1:1 map. W4 the differential compares a whole-DB dump (missed `jev_verdicts`, `runs`); new ids join every pair's `NEW_ROW_IDS`. W5 the real 23s are `registry.test.ts:132`, `:142` and the 4B gate; the 4C gate has none; locked-entries test extended. W6 recorder has no env → `HOUGE_TELEGRAM_CHAT_ID` cleared/pinned in the differential and gate.
- S1 recursion "unbounded unless exempted". S2 line cites corrected. S3 fuse volume named. S4 rating write ordering stated.

## Rev 1.2 changes (codex, of Rev 1; each verified first-hand)
- B1 projection missed `runs`, `jev_verdicts`, `incidents` → already closed by Rev 1.1's whole-DB dump (incidents included).
- B2 `memory.rule_save` evidence: the save choice (`saveFor`) is not a refusal; it is recorded in `turn.handler`'s detail row (`jev_verdicts.sets_rule`/`rule_scope`/`save_outcome`, the no-save path as `none`) → §2 row and Decision 2 now cite that, and say the removal is Paco's ruling.
- W recorder fault adds `decision_record_failed` + its alert → stated as a delta in §4.4; placement against each existing write specified.
- W digest count lines change and chat-bound review skips null rows → §5, §8 restated.
- W recursion depends on placement → Decision 2 rests on the entry test; the loop is a secondary, placement-dependent hazard.
- W attachment seam: the outbox row has `run_id`, the dispatch record lacks it → §2 row corrected.
- S count sites → closed by Rev 1.1.

## Rev 1.3 changes (codex scoped re-review)
- Digest: the daily digest has no per-entry count lines; only `/status` calls `countLines` → §5 corrected; the stale doc comment noted as a follow-up.
