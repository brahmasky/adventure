# Decision ladder, stage 1 "Engine + door" — Implementation Plan (Rev 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every decision gets one shape (a registry entry with a ladder of deciders, recorded after it decides), proved on the front door: `turn.handler` and `turn.gear` run through the new runner with byte-identical behaviour, then every automatic lesson save is announced on the memory card with Undo (Paco's Q1 ruling), a daily digest surfaces unsure verdicts for Paco's ✅/❌, and ADR 0030 lands first.

**Architecture:** A new protected `src/decisions/` holds the types, the runner (`decideSync` / `decide`), the recorder, the registry with its two entries and the digest. The store gains `decisions`, `decision_outcomes`, `ladder_moves` and a digest latch, plus two link columns. `CoreWorker.triageTurn` keeps every handler (lanes, save-first, settle) and only moves the *decision* (gate rule → Jev tree → Tiny cascade, planner as `fail`) behind the runner. The front door's ledger rows are queued at decide time and written inside `settleTriage`'s transaction, so a lost turn writes nothing and a rolled-back save takes its row with it. A pinned characterisation snapshot written on the pre-ladder code proves nothing persisted changed, and the P6 dual run proves it on Paco's last 200 texts. There is no off switch (ruling R13): a fundamentally wrong build is reverted, rebuilt and kickstarted, and the final task proves the previous build runs on the migrated DB.

**Tech Stack:** Node + TypeScript (ES2024, NodeNext, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest 4. Zero runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-10-12-decision-ladder-design.md](../specs/2026-10-12-decision-ladder-design.md) (Rev 8: approved by Paco 2026-10-12 at Rev 7, amended with rulings R12 and R13). This plan covers spec §13 row 1 only.

## Changelog

### Rev 3 (2026-10-12): Paco's Q1 and egress rulings, and the two Rev 2 re-reviews

Inputs: the codex re-review of Rev 2 (3 open blockers: Rev 1 B2 partial, B5 partial, new #8) and the senior re-review
(1 BLOCKER · 3 WARNING · 6 SUGGESTION). Dispositions: appendix "Review dispositions (Rev 2 re-reviews)".

- **New Task 8c** (Q1 → "Add the card"): every automatic lesson save is announced on the memory card with Undo. The lane
  card gains the ↩️ Undo button when its turn saved; every inform path (planner route, a lane that fell through, a lost
  turn, a throw after the save) queues an Undo-only memory card keyed by the change id. 8c moves the effect table to its end
  state, makes `entryProblems` reject `announced: "reply"`, and regenerates exactly the snapshot it names
  (`rule-on-lookup.json`). This closes the senior BLOCKER (lane saves hidden behind `reply`) and codex #5 / senior W5.
- **Task 6 states today's truth until 8c**: `answer` and `lookup` are `effect` (they save first on a confident `sets_rule`),
  announced in the reply's 📒 line (`"reply"`), as is the planner route's `[memory]` note; `entryProblems` accepts
  `"reply"` only until 8c removes it (stage 1 merges as one, so the exception never ships).
- **Gate classification** (codex #2): a structural difference that persists after its one retry is a **mismatch**, never
  inconclusive; only a pair with identical structure whose sides failed Jev the same way may be inconclusive. `parse` is
  retryable, and a structural difference with differing Jev answers gets its retry too (senior W2, partly).
- **Gate keyboard** (codex #8): the render check asserts each rendered pair's exact `dec:rv:<offered id>:ok|bad`, and the
  ❌ tap feeds the rendered ❌ button's `callback_data` into the gateway.
- **Gate determinism probe** (senior W3): a `--limit 10` run first; more than one nondeterministic pair in ten stops the
  run for Paco. A deterministic shortfall explained by inconclusive pairs is INCONCLUSIVE, not FAIL (S3).
- **`decision_fallback` for the front door clears only on a cascade answer** (senior W1), since only cascade failures
  count there.
- Smaller: `npm ci` in the feature worktree (S1); `floor_held` names the rung that set the floor (S2); configuration.md
  notes that health counts applied rungs only and what a reverted build does with digests and taps (S4, S6); the front
  door's ladder queue is cleared after a committed non-`inTx` settle (S5).
- Gate egress ruling recorded in Task 12.

### Rev 2 (2026-10-12): Paco's rulings R12 and R13, and the two Rev 1 reviews

Inputs: spec Rev 8 (commit 1b65de4); the senior review of Rev 1 (2 BLOCKER · 13 WARNING · 11 SUGGESTION) and the codex
review of Rev 1 (5 BLOCKER · 1 WARNING · 1 SUGGESTION). Every finding has a disposition in the appendix "Review
dispositions". What changed, and why:

- **R12 (spec §4.1) replaces "Jev never causes an effect".** Entries declare `input: "paco" | "tool" | "mixed"` (`mixed`
  is treated as `tool`), and every verdict's effect declares `kind`, `reversible` and `announced`. `entryProblems` (Task 6)
  fails a Jev or model rung that can cause an unannounced or irreversible effect, and any non-tightening effect over tool
  input. `turn.handler` now declares its real effects: `memory` (the instant lesson save, card with Undo) and `planner`
  (save-first on a confident `sets_rule`, announced through the `[memory]` note) are `effect`. Rev 1's ruling 5 (the A19
  save as a grandfathered exception until stage 3) and ADR 0030's grandfather paragraph are gone; ADR 0030 (Task 1) states
  R12 and R13. This also closes codex B5.
- **R13 (spec §5.4) removes the off switch and every designed shadow state.** `HOUGE_DECISIONS_OFF`, `off-switch.ts`, the
  boot warning, `effectiveTriageMode`, `gearOff`, their tests and their docs are deleted. `armed: "shadow"` survives only as
  the runner's input that reproduces today's configured `HOUGE_JEV_TRIAGE_ENABLED=shadow`; the registry test fails any
  registered entry armed other than `on`. `HOUGE_JEV_LANES_OFF` is untouched (no "alias" wording). The final task (13)
  boots the 3bff437 build against a DB copy the new build migrated and asserts it runs.
- **Front-door rows are written atomically with the verdict** (codex B1, senior W4). The triage call site uses a deferred
  recorder; `settleTriage` writes the `turn.handler` and `turn.gear` rows inside its own transaction, after its
  lost-turn check. A killed turn writes no `decisions` row; a rolled-back lane save rolls its row back. The digest also
  ignores a front-door row its verdict does not link.
- **The pin cannot be weakened silently** (senior W1). `state_hash` stays in the projection; the pin runs with `CI=1`;
  Tasks 8b and 13 check `git diff --exit-code <task-2 sha>` over the snapshots, the pin tests and the harness. New pin
  cases: no turn state, a Jev parse failure, a rolled-back lane finalisation, and a policy throw after Jev answered.
- **`routed_by` is now really pinned** (codex B4): the projection carries every `llm_attempt.routed_by` of the run, and a
  new end-to-end test (Task 2, kept green in 8b) drives a routed turn through the real supervisor and asserts the first
  planner attempt's `routed_by` is the verdict row's id.
- **"Prove the pin bites" can fail now** (senior B1): the mutation is `choice: 0.6 → 0.4`, and the three cases that must
  flip are named.
- **Task 8 is split** (senior W13) into 8a (the pure glue module and its tests, no `core-worker.ts` edit) and 8b (the
  `core-worker.ts` rewrite, the pin, the consumer suites). 8b keeps today's skipped-`error` settle for a throw in
  `treeArmed`/`routeTree` (senior W2) and for a throwing ack check.
- **`decision_fallback` paging fixed** (senior W3): only a Jev or model answer clears it; the card is damped by the same
  10-minute reopen window as every alerted incident (`ALERT_REOPEN_QUIET_MS`, E12); `budget` never counts; for
  `turn.handler` and `turn.gear` a Jev-rung failure does not count (the Jev incidents already page it: one call, one page).
- **`decisions.fallback_rung`** (codex W6, senior S2): the rung kind of the first failure, so "Jev skips" counts Jev
  failures only.
- **No closed-enum CHECK on sets that later stages extend** (senior W7): `stage`, `fallback_reason` and outcome `signal`
  are validated in code at insert (`DecisionRejected`, `OutcomeRejected`); CHECKs stay only on sets the spec fixes (rung
  kinds, armed mode, source, granted_by, move state). Stage B's lane widening needed a full table rebuild
  (`run-store.ts:7124`); this avoids repeating it.
- **Review taps are exempt from the 5-a-minute command limit and do not count toward it** (senior W8).
- **The live gate** (Task 12) builds only in the feature worktree, never in the main checkout (senior W11); classifies
  structure before Jev failures (codex B2); retries a pair once and paces calls (senior W10); has a coverage floor
  (senior W9); seeds an offered decision into copy B so the ❌ tap can fail, and prints `LIVE GATE: INCONCLUSIVE` with exit
  3 instead of PASS when a required check could not run (codex B3, senior B2); renders the digest through
  `TelegramNotificationAdapter` with a stub transport (codex S7).
- **Protected-files table** gains `telegram-notification-adapter.ts` (Task 10) and `run-store.ts` for Task 11 (senior W6).
- Smaller: `snippetOf` splits on code points; a digest whose enqueue conflicts latches `sent: 0`; the gate clears copy B's
  `decision_digest:%` outbox rows; `ladder_moves.paco_callback_id` is unique; a monotone judge held by the floor is
  recorded as the floor's rung with reason `floor_held`; pre-flight line drifts fixed; ADR 0030 notes that the `turn.handler`
  Jev policy glue lives in unprotected `src/core/turn-handler-ladder.ts`.

### Paco's rulings recorded in Rev 3 (2026-10-12, binding)

- **Q1 → "Add the card".** The memory card with Undo appears whenever a lesson is saved automatically, whatever route the
  turn took: the planner inform path (`two_request`, a cascade pick with a rule) and the answer/lookup lane saves
  (`laneBranch` save → `laneRoute` → `saveFirst`, `core-worker.ts:2931-2934`, announced today only by the card's 📒 line).
  It lands in stage 1 as **Task 8c**, after the front-door migration (8b), so the pin proves move-don't-improve first; 8c
  then updates the pin and effect-table tests deliberately. End state of stage 1: every automatic lesson save is a
  reversible effect announced on a card with Undo; `entryProblems` no longer accepts `announced: "reply"`; `turn.handler`
  declares `answer`, `lookup`, `memory` and `planner` as effects announced on a `"card"`.
- **Gate egress → "Yes, 200 messages".** The P6 gate keeps shape-only redaction (no broker) for the last 200 Telegram texts
  and their stored context (Task 12's egress note).

## Global Constraints

- `dependencies: {}` stays empty (ADR 0001, 0016). Node stdlib plus devDeps only.
- Functions under 50 lines (reviewers enforce it). Match surrounding style. Every changed line traces to this plan.
- Tests live in `tests/<area>/` mirroring `src/`; each test says in a comment why the behaviour matters.
- **Every task runs in one feature worktree**: `git worktree add .worktrees/decision-ladder-stage-1 -b feat/decision-ladder-stage-1 main && (cd .worktrees/decision-ladder-stage-1 && npm ci)`.
  Never run `npm run build` (or anything else that writes `dist/`) in the main checkout
  (`/Users/xiaochuan/Projects/adventure`): the daemon executes that `dist/`, so a KeepAlive relaunch or a kickstart would run
  unreviewed code and apply its migration to the live DB. The main checkout's `dist/` is rebuilt only after Paco's merge
  (AGENTS.md "Rebuild `dist/` after merge"). Gates run from the worktree with `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env`.
- Never open `houge.sqlite` from code under test or from a gate: gates work on a `VACUUM INTO` copy under a temp root and refuse to write outside it.
- No hard-coded model or tool versions in ADR decision text (ADR 0028 amendment 2026-10-09).
- Telegram output goes through the outbox and the rich renderer (`TelegramNotificationAdapter` → `markdownToTelegramHtml`), never `sendMessage` directly.
- The ledger never holds read text or state (spec §5.2: no state column; `reason_code` is a code-owned enum per entry, never model or tool text).
- Recording never changes a decision (spec §4.1): the runner decides, then records; a failed write opens `decision_record_failed` and the verdict stands.
- Stage 1 changes no routing behaviour: the Task 2 pin and the Task 12 P6 dual run must show zero difference on every persisted `jev_decisions`, `jev_verdicts` and `triage` column.
- **R12** (spec §4.1): what a Jev or model verdict may do depends on what it read. Over tool input it only tightens or
  proposes; over Paco's own message it may cause an effect that is reversible and announced. The registry test enforces it.
- **R13** (spec §4.1, §5.4): no off switch (`HOUGE_DECISIONS_OFF` does not exist) and no designed shadow state. Every
  migration is additive (new tables, nullable link columns), so rollback is revert, rebuild, kickstart. `HOUGE_JEV_LANES_OFF`
  keeps exactly its stage B meaning.
- Commits: Conventional Commits, one concern per commit, stage files by name (never `git add -A`). Commit only when the controller says so; the commit steps below are the intended boundaries.
- Definition of done (CONTRIBUTING.md): `npm run typecheck && npm test && npm run build` green in the worktree **and** the Task 12 live gate shown **and** the Task 13 rollback check shown.

### Protected files this plan touches (Paco's hand-merge)

| Task | Protected file | Why protected |
|---|---|---|
| 1 | `docs/decisions/0030-decision-ladder.md` (new), `docs/decisions/0011-…`, `0014-…`, `0028-…`, `0029-…`, `docs/decisions/README.md` | `PROTECTED_DIRS` `docs/decisions` |
| 1 | `AGENTS.md` | `PROTECTED_FILES` |
| 3, 5, 6, 10 | everything under `src/decisions/` (new) | joins `PROTECTED_DIRS` in Task 7 (spec §6.3) |
| 4, 11 | `src/run/run-store.ts` | `PROTECTED_FILES` |
| 7 | `src/capabilities/self-write-guard.ts` | `PROTECTED_FILES` (self-protection) |
| 8b, 8c | `src/core/core-worker.ts` | not in `PROTECTED_FILES`, but listed for Paco's merge in spec §13 row 1 |
| 10 | `src/notifications/telegram-notification-adapter.ts` | `PROTECTED_FILES` (`self-write-guard.ts:120`, the attachment check, C2) |

Not touched: `turn-context.ts`, `planner-supervisor.ts`, `run-ledger.ts`, `src/llm/registry.ts`, `src/policy/`, any `src/omp/*` file. If a task finds it needs one, stop and report.

## Pre-flight: every existing symbol this plan relies on (code verified at main @ 3bff437; 3bff437..1b65de4 changes docs only)

| Symbol | Where | Used by |
|---|---|---|
| `OmpTurnState` (`threadCutAt`, `turnCtx.recentTurns`, `turnCtx.turnChars`, `quote`, `triageFinalized`, `lessonSavedThisTurn`) | `src/core/core-worker.ts:230-245` | 8b |
| `TriageSettle`, `AnsweredSettle`, `SettleFor`, `SaveStep` | `src/core/core-worker.ts:254-264` | 8b |
| `interface TriageHeld { thinkHarder; quote; answered? }` | `src/core/core-worker.ts:267` | 8b |
| `ACTED`, `UNARMED`, `NO_SCORES` | `src/core/core-worker.ts:269-271` | 8a, 8b (`UNARMED` moves) |
| `CoreWorker` constructor (13 params; `broker` 8th, `ompOptions` 13th) | `src/core/core-worker.ts:437-467` | 8b, 12, 13 |
| `private readonly ompTurns` | `src/core/core-worker.ts:496` | 8b |
| `submitTurn(run_id)`, `shutdownPlanners()` | `src/core/core-worker.ts:2086, 2172` | 2 |
| `supervisorDeps(...).triage: (i) => this.triageTurn(i)` | `src/core/core-worker.ts:2226` | unchanged |
| `ompRouteEnd` (consumer: `getJevVerdictForRun`, `closePendingJevVerdict`, `updateJevVerdict`) | `src/core/core-worker.ts:2400-2419` | consumer list |
| `closeVerdict` (consumer: `closePendingJevVerdict`, `failLaneReplyVerdict`) | `src/core/core-worker.ts:2425-2433` | consumer list |
| `breakLaneCardForTest`, `breakMemoryLaneCardForTest`, `breakLaneFinalizeOnceForTest` | `src/core/core-worker.ts:2618, 2626, 2631` | 2 |
| `jevClient(run_id)` | `src/core/core-worker.ts:2636-2645` | 8b |
| `triageEvent`, `verdictInsert`, `markThinkHarder` | `src/core/core-worker.ts:2647-2673` | 8b |
| `settleTriage(i, state, lang, f, o)` (lost-turn check first, then one transaction) | `src/core/core-worker.ts:2681-2700` | 8b |
| `laneLost`, `triageOff`, `triageSkip`, `quoteRef` | `src/core/core-worker.ts:2702-2727` | 8b |
| `triageTurn`, `triageTurnInner`, `routeAnswered`, `checkJevModel` | `src/core/core-worker.ts:2733-2803` | 8b (rewritten) |
| `statusLane`, `saveFirst`, `saveThenRoute`, `memoryLaneEnd` | `src/core/core-worker.ts:2809-2875` | 8b (unchanged) |
| `cascadeRoute`, `cascadePick`, `cascadeCall` | `src/core/core-worker.ts:2882-2919` | 8b |
| `laneRoute`, `runLane`, `patchLaneVerdict`, `recordLaneReplyRow`, `laneSeat` | `src/core/core-worker.ts:2931-3010` | 8b (unchanged) |
| `turnRoute`, `quoteField`, `decisionFor`, `numbersOf`, `scoresOf` | `src/core/core-worker.ts:3994-4016` | 8b |
| `CASCADE_TIMEOUT_MS = 20_000`, `parseCascadePick`, `withinMs` | `src/core/core-worker.ts:4024-4051` | 6, 8b |
| `URL_IN_TEXT`, `urlRule` | `src/core/core-worker.ts:4055-4065` | 8a (moved verbatim) |
| `TurnRoute`, `QuoteRef`, `TriageOutcome`, `TriageInput` | `src/omp/planner-supervisor.ts:63-72` | 8b (read only) |
| `routeEnd?` input type | `src/omp/planner-supervisor.ts:57-60` | 2 |
| inform note prepended to the planner prompt | `src/omp/planner-supervisor.ts:479` | 6, 8c (R12 effect table; Q1 ruling) |
| `routeTurn` (`turn.routedBy = route?.verdict_id`), `audit` (first compose attempt carries `routed_by`) | `src/omp/planner-supervisor.ts:494-499, 797-803` | 2 |
| `TurnRole`, `Lane`, `LaneSwitch`, `TREE_THRESHOLD_VERSION` | `src/jev/tree-policy.ts:15-23` | 6, 8a |
| `preJudge` | `src/jev/tree-policy.ts:35-39` | 8b |
| `TREE_BAR_DEFAULTS` (`choice: 0.6`) | `src/jev/tree-policy.ts:43` | 2, 6, 8a |
| `Armed`, `treeArmed` | `src/jev/tree-policy.ts:46, 60-69` | 8a |
| `RouteReason`, `Route`, `RoutePlan` | `src/jev/tree-policy.ts:83-91` | 6, 8a |
| `fallbackRoute`, `ACK_ROUTE` | `src/jev/tree-policy.ts:99-104` | 8b |
| `routeTree`, `applyCascade` | `src/jev/tree-policy.ts:236, 255` | 2 (mocked), 8a, 8b |
| `SkipReason` (16 values), `Decision`, `topProbOf`, `recordSkip`, `persistDecisionRows`, `decide` (Jev) | `src/jev/decide.ts:14-106` | 4, 6, 8a, 8b |
| `JevTriageMode`, `resolveJevTriageMode`, `resolveJevLanesOff` | `src/jev/jev-flags.ts:6-54` | 6, 8a, 8b |
| `calibrationRows`, `CALIBRATED_ROWS` | `src/jev/calibration.ts:54, 27` | 8b, 12 |
| `CATEGORIES`, `TREE_BREADTH`, `TREE_REASONING`, `TREE_ACTIONS`, `TREE_QUESTIONS`, `LastHougeTurn`, `lastHougeTurnOf`, `quotedTurnFromRow`, `QuotedTurn`, `buildTreeState` | `src/jev/questions/tree.ts:15-145` | 6, 8b |
| `Question` | `src/jev/questions/types.ts:28` | 3 |
| `isBareAck` | `src/omp/bare-ack.ts:11` | 8a |
| `TurnModality` | `src/media/media-config.ts:9` | 6 |
| `JevDecisionRow`, `JevVerdictInsert`, `JevVerdictRow`, `JevVerdictPatch` | `src/run/run-store.ts:932-962` | 4 |
| `VERDICT_PATCH_COLUMNS` | `src/run/run-store.ts:965` | 4 (new types go after it) |
| `JEV_VERDICTS_LANES_DDL`; the stage B rebuild that widened `lane` | `src/run/run-store.ts:968-993, 7124` | 4 (read only; why growing enums are validated in code) |
| `RunStore.getLedgerEvents`, `recordChatTurn`, `getRecentChatTurns`, `claimRun` | `src/run/run-store.ts:1167, 1199, 1230, 2071` | 2, 12 |
| `llm_attempt` ledger payload carries `routed_by` | `src/run/run-store.ts:1983` | 2 |
| `checkTelegramRateLimit` (window query: accepted commands in 60 s) | `src/run/run-store.ts:2237-2249` | 11 |
| `plannerLastAnsweredAt`, `laneTurnsSince` (consumers of `jev_verdicts`) | `src/run/run-store.ts:2744-2786` | 2 |
| `inTransaction` (no nesting) | `src/run/run-store.ts:4277-4291` | 4, 8b, 10 |
| `insertJevDecision`, `listJevDecisions` | `src/run/run-store.ts:4405-4431` | 4 |
| `insertJevVerdict`, `updateJevVerdict`, `closePendingJevVerdict`, `failLaneReplyVerdict`, `getJevVerdictForRun`, `latestJevVerdictForChat` | `src/run/run-store.ts:4433-4487` | 4, consumer list |
| `triageOverrideFor`, `userTurnTextForRun` | `src/run/run-store.ts:4541, 4558` | 8b, 10 |
| `incidentFingerprint`, `openIncident`, `findOpenIncident`, `findRecentlyResolvedIncident`, `resolveIncident`, `listOpenIncidents` | `src/run/run-store.ts:4779-4885` | 5, 9 |
| `countJevCalls`, `hasAnsweredJevCallSince` | `src/run/run-store.ts:5049-5067` | 9 (unchanged) |
| `countLaneTurns`, `hasLaneReplySince` (consumers of `jev_verdicts`) | `src/run/run-store.ts:5122-5137` | consumer list |
| `enqueueNotification` (idempotent per target + key; returns `status: "conflict"` on a different payload) | `src/run/run-store.ts:5991-6013` | 5, 10 |
| `claimNextNotification` | `src/run/run-store.ts:6085` | 12 |
| `migrate()` list, last entry `applyLaneRepliesMigration()` | `src/run/run-store.ts:6928-6998` | 4 |
| `applyLaneRepliesMigration` (pattern) | `src/run/run-store.ts:7148-7166` | 4 |
| `tableColumns` | `src/run/run-store.ts:8728` | 4 |
| `TELEGRAM_COMMAND_WINDOW_SECONDS = 60`, `TELEGRAM_MAX_COMMANDS_PER_WINDOW = 5` | `src/run/run-store.ts:8908-8909` | 11 |
| migration count test (`toBe(33)`, two places) | `tests/run/run-store-approvals.test.ts:586-591` | 4 |
| `ALERT_REOPEN_QUIET_MS` (10 min), `openAlertedIncident`, `resolveOpenIncidents` | `src/run/incident-alert.ts:25, 28-41, 86-93` | 5 |
| `checkJevSkipRate`, `jevViolations`, `checkLaneFallthrough`, `detectViolations`, `SWEEP_INCIDENT_KINDS` (has `jev_skip_rate`), `JEV_SKIP_RATE_*` | `src/run/invariant-sweep.ts:83-275` | 9, 13 |
| `formatInstantInZone`, `resolveDisplayZone` | `src/run/schedule-spec.ts:132-149` | 10 |
| `NotificationButton`, `NotificationPayload`, `NotificationDispatchRecord` | `src/notifications/notification-types.ts:8-18, 50-59` | 10, 12 |
| `TelegramNotificationAdapter.send`; `toReplyMarkup(buttons)` (one row only) and its call in `sendText` | `src/notifications/telegram-notification-adapter.ts:46, 115, 146-151` | 10, 12 |
| `LC_UUID`, `parseMemLaneCallback` | `src/triggers/telegram-command-parser.ts:317-331` | 11 |
| `normalizeCallbackQuery` (allowlist check, then parsers) | `src/triggers/telegram-trigger-adapter.ts:244-280` | 11 |
| `buildMemLaneTapEvent` (pattern) | `src/triggers/telegram-trigger-adapter.ts:332-346` | 11 |
| `TaskEventType` union and its type test | `src/domain/types.ts:4`, `tests/domain/types.test.ts:29-32` | 11 |
| `Gateway.intake` rate-limit block (`event.type !== "kill"`) | `src/gateway/gateway.ts:154-175` | 11 |
| `GatewayIntakeResult`, `memlane_undo` dispatch, `accepted` | `src/gateway/gateway.ts:59-92, 187, 1175` | 11 |
| `oncePerTrigger`, `replyTo` | `src/gateway/memory-commands.ts:19-36` | 11 |
| `recordTriageOverride` (consumer of `jev_verdicts`) | `src/gateway/memlane-commands.ts:56-69` | 2, consumer list |
| `runSignalPathTick` (`checkMeteredCeiling` call), `errorCode` | `src/telegram/telegram-daemon.ts:479-516, 506` | 10 |
| `PROTECTED_DIRS`, `PROTECTED_FILES` and the test table | `src/capabilities/self-write-guard.ts:67-73, 75-127`, `tests/capabilities/self-write-guard.test.ts:108-148` | 7 |
| `ompWorker`, `until`, `drainOutbox` test helpers | `tests/helpers/omp-worker.ts:21-55` | 2, 5, 8b, 10 |
| `pinOmpEnv`, `useFakeOmp`, `shortTmp`, `pinEnabledFlags` | `tests/helpers/omp-env.ts:21, 40, 58, 68` | 2 |
| `createQueuedTurnRun` (telegram source) | `tests/helpers/runs.ts:8-23` | 2, 8b |
| `LANE_PREFACE`, `REWRITE_INSTRUCTION` | `src/core/lanes/lane-compose.ts` (exported; used by `tests/core/core-worker-lanes.test.ts:5`) | 2 |
| `scripts/live-gate-jev-tree.mjs` `copyDb` (read-only `VACUUM INTO`) and `clearTickLatch` (path guard) | `scripts/live-gate-jev-tree.mjs:148-151, 521-528` | 12 (pattern) |

### The `jev_verdicts` consumers (spec §5.3: every one keeps working; Task 8b runs each one's tests)

| # | Consumer | Reads / writes | Test that must stay green |
|---|---|---|---|
| 1 | `CoreWorker.settleTriage` + `verdictInsert` (`core-worker.ts:2658-2700`) | inserts the row, patches handler/model | `tests/core/core-worker-triage.test.ts`, Task 2 pin |
| 2 | `CoreWorker.ompRouteEnd` (`:2400-2419`) | `closePendingJevVerdict`, model, `fast_used_tool`, `pin_failed`, `escalation` | triage test "routeEnd …" cases, pin case `routed-then-routeEnd` |
| 3 | `CoreWorker.closeVerdict` (`:2425-2433`) | `planner_done` / `planner_failed`, `fallthrough:run_failed` | triage test "every terminal path…" |
| 4 | `CoreWorker.markThinkHarder` (`:2670-2673`) | `latestJevVerdictForChat` → `think_harder` | pin case `think-harder-correction` |
| 5 | `CoreWorker.memoryLaneEnd` / `patchLaneVerdict` (`:2866, 2978-2987`) | `lane_reply`, `fallthrough:aborted`, route_outcome | `tests/core/core-worker-lanes.test.ts`, pin |
| 6 | `recordTriageOverride` (`src/gateway/memlane-commands.ts:56-69`) | `ask_anyway`, per-lane `triage_overrides` page | `tests/gateway/memlane-commands.test.ts`, pin case `dig-deeper` |
| 7 | `Gateway` low-rating label (`src/gateway/gateway.ts:1145-1146`) | `latestJevVerdictForChat` → `low_rating` | `tests/gateway/rating-capture.test.ts` |
| 8 | `checkLaneFallthrough` (`src/run/invariant-sweep.ts:248-260`) via `countLaneTurns` / `hasLaneReplySince` (`run-store.ts:5122-5137`) | the sweep's lane fall-through rate (correctness path) | `tests/run/invariant-sweep*.test.ts` |
| 9 | `RunStore.plannerLastAnsweredAt` (`run-store.ts:2744-2750`), called from `src/omp/turn-context.ts:329` | the catch-up boundary (correctness path) | `tests/run/*lane*`, `tests/omp/`, pin `catch_up` field |
| 10 | `RunStore.laneTurnsSince` (`run-store.ts:2777-2786`), called from `src/omp/turn-context.ts:329` | the catch-up block | `tests/core/core-worker-lanes.test.ts`, `tests/omp/`, pin `catch_up` field |
| 11 | `llm_attempt.routed_by` = verdict id (`planner-supervisor.ts:499, 797-803`; lanes `answer-lane.ts:42`) | the verdict → model-call join | `tests/omp/planner-supervisor.test.ts` routed_by cases; Task 2 `turn-handler-routed-by.test.ts` (real supervisor over `triageTurn`); pin `routed_by` field |
| 12 | `scripts/live-gate-jev-tree.mjs:181, 220, 655` | one verdict per gate turn | not run in this stage (its own gate) |

The triage event (`run-ledger.ts:311` required fields) keeps its payload exactly; stage 1 adds no field to it.

### Inventory re-walk (spec §6.1 "first task re-walks the inventory")

Stage 1 migrates only rows A12–A18. Re-walked at 3bff437: A12 flag/mode (`core-worker.ts:2756-2757`), A13 override/posture/modality/state (`:2758-2761`), A14 ack rule (`:2767-2769`, `tree-policy.ts:35-39`), A15 tree state + Jev (`:2771-2776`), A16 gear (`tree-policy.ts:151-155` inside `routeTree`), A17 lanes/route (`routeTree`, `urlRule` `:4061`), A18 cascade (`:2882-2908`). No row moves columns. **Ruling 18 (for Paco to accept):** the full re-walk of A1–E12 is deferred to the stage 3 and stage 4 plans, whose tasks migrate those rows; re-walking them now would go stale before they move.

### Spec ambiguities resolved in this plan (rulings)

1. **Rung shape.** Spec §4.1's `jev` rung names one `question`. `turn.handler` asks six questions in one call and `turn.settle` (stage 2b) four, so the rung carries `questions: readonly Question[]` plus `recordedP` (which question's p is recorded, spec §5.2). Rungs that need I/O get an executor from the call site (`DecideCtx.exec`); the runner itself does no I/O beyond the recorder (spec §5.1). Rung results may carry a typed `detail` (Jev's rows, the plan) so the handlers keep today's settle exactly.
2. **`turn.handler` records every decision** (`alwaysRecord`), so every new `jev_verdicts` row links to a `decisions` row (spec §5.3). About 5 rows a day.
3. **`turn.gear` is recorded, not driving.** Its verdict is the role on the route the tree produced (the same Jev call, spec §4.4); the planner keeps pinning `route.role`. A Task 8b test asserts the two are equal on every path.
4. **No off switch (R13).** Today's configured triage shadow (`HOUGE_JEV_TRIAGE_ENABLED=shadow`) reaches the runner as `DecideCtx.armed = { jev: "shadow", model: "shadow" }`, and the gate rule skips the ack rule in shadow exactly as today. Registered entries declare `armed` all `on`; `entryProblems` fails anything else.
5. **The effect table (R12).** `turn.handler` reads Paco's own message (`input: "paco"`). Task 6 declares today's behaviour: `status` is a `reply` (code-rendered card with Dig deeper); `memory` is an `effect` (the instant lesson save, memory-lane card with Undo); `answer`, `lookup` and `planner` are `effect`s too, because each saves a lesson first on a confident `sets_rule`, announced today only in the reply (the lane card's 📒 line; the planner's `[memory]` note) — `announced: "reply"`, accepted by `entryProblems` only until Task 8c. Task 8c (Paco's Q1 ruling) puts the Undo card on every automatic save, moves those three to `announced: "card"` and removes `"reply"` from what `entryProblems` accepts. `turn.gear`'s verdicts cause nothing beyond which model answers (`none`). A registry test pins `turn.handler`'s whole effect table at each step.
6. **Foreign keys** are declared (`REFERENCES decisions(decision_id)`) but not enforced: the store never enables `PRAGMA foreign_keys` (no table does today), and turning it on is a behaviour change for every table.
7. **`decision_outcomes` value sets.** Signals with a stage 1 producer or an obvious closed set validate now (`review_*` → a registered entry id, `correction` → a category, `dig_deeper` → a lane, `rating` 0–3, `recurrence` ≥ 1). The rest reject every value until the stage that adds their producer defines the set (a protected edit). `review_ok` is added to the signal enum: ✅ is a label calibration needs. The signal itself is validated in code, not by a CHECK (ruling 15).
8. **Per-entry `jev_skip_rate`.** Computed from `decisions` rows whose `fallback_rung` is `jev` for every entry with a Jev rung (digest health line and sweep). `turn.handler` and `turn.gear` keep today's `jev_decisions`-based incident and subject for stage 1 (one call, one page); the per-entry incident (subject `decision:<entry>`) pages from stage 2 entries on.
9. **`decision_fallback`** counts only `fail` rows with a named failure other than `budget` (an oversized state is not a failure). For `turn.handler` and `turn.gear`, a failure on the Jev rung does not count: `openJevIncident` and the triage `jev_skip_rate` already page it (one call, one page), so only a cascade (model rung) failure counts there. Only an answer from a rung whose failures count clears it — a Jev or model answer for most entries, a cascade answer only for `turn.handler` / `turn.gear`; a rule answer (a photo, an ack) proves nothing about the judge. A reopen within `ALERT_REOPEN_QUIET_MS` (10 minutes, E12) records the row but sends no card. A shadowed or abstained walk that ends on `fail` is not a fallback.
10. **Unsure line text.** For entries decided over Paco's own message (`intake`, `pre_model` stages) the line shows the first 40 code points of his text from `chat_turns`, markdown-stripped; later stages show no text (spec §8.1 "no tool text").
11. **Digest buttons.** One message with up to 8 ✅/❌ pairs needs more than Telegram's 8 buttons per row, so the payload gains `button_rows` and the adapter renders rows.
12. **Stale review taps.** A tap counts only for a decision offered in a digest in the last 7 days, once; anything else answers "Already handled." and writes nothing.
13. **Urgent cards in stage 1** are a skeleton (`enqueueUrgentCard`) used by `decision_fallback:<entry>`; the other §8.2 cards arrive with their stages.
14. **Front-door rows are written with the verdict.** The triage call site passes a deferred recorder: the runner's `record` call queues the row, and `settleTriage` writes it inside its transaction after the lost-turn check. A killed turn writes no row; a lane save that rolls back takes its row with it, and the fallback settle that follows writes it once. The digest still ignores a front-door row its verdict does not link (defence in depth for a future path).
15. **Growing enums are validated in code.** `decisions.stage`, `decisions.fallback_reason` and `decision_outcomes.signal` have no CHECK; `insertDecision` throws `DecisionRejected` and `insertDecisionOutcome` throws `OutcomeRejected` on a value outside the TS constant. A later stage extends a set by editing the constant (a protected edit) with no table rebuild. Sets the spec fixes keep their CHECK.
16. **Review taps and the command limit.** `decision_review` is exempt from `checkTelegramRateLimit` (like `kill`) and its audit rows do not count toward the 5-a-minute window: a digest offers up to 8 pairs, and a dropped tap would look labelled when it is not. A tap is allowlisted, one-shot and writes one closed-enum label.
17. **A monotone judge held by the floor.** When a judge's verdict is less cautious than the floor, the floor stands and the row names the rung that set the floor (`rung: "rule"` for a rule's floor), `reason: "floor_held"`, without the judge's p, so stage 2a calibration never credits Jev with the rule's verdict.
18. **Inventory re-walk** of A1–E12 is deferred to the stage 3 and 4 plans (see above).
19. **A throw keeps today's settle.** A throw in `calibrationRows`, `treeArmed` or `routeTree` (before today's `held.answered`) settles skipped `error` with Jev's rows dropped, as today; only a throw in `urlRule` (after it) settles the answered fallback. A throw in the ack check settles skipped `error`, as today.
20. **`decisions.fallback_rung`** (a rung kind, nullable) records which rung failed first, so a cascade failure is never counted as a Jev skip.

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `docs/decisions/0030-decision-ladder.md` | new | ADR 0030 (Task 1) |
| `docs/decisions/0011-…`, `0014-…`, `0028-…`, `0029-…`, `README.md`; `AGENTS.md` | mod | amendments, index row, Jev invariant sentence (Task 1) |
| `tests/helpers/triage-harness.ts` | new | shared triage fakes and harness (Task 2) |
| `tests/core/turn-handler-pin.test.ts`, `tests/core/turn-handler-pin-throws.test.ts`, `tests/core/__pins__/turn-handler/*.json` | new | characterisation pin (Task 2) |
| `tests/core/turn-handler-routed-by.test.ts` | new | the verdict → planner `routed_by` join, end to end (Task 2) |
| `src/decisions/types.ts` | new | Entry, Rung, bars, effects, results, signals, recorder/ctx types |
| `src/decisions/entry-ids.ts` | new | `ENTRY_IDS`, `LOCKED_ENTRY_IDS` (leaf; the store imports it) |
| `src/decisions/decide.ts` | new | `decideSync`, `decide` |
| `src/decisions/outcomes.ts` | new | outcome value sets, `checkOutcomeValue` |
| `src/decisions/record.ts` | new | `shouldRecord`, `storeRecorder`, record-failure and fallback incidents |
| `src/decisions/urgent.ts` | new | `enqueueUrgentCard` |
| `src/decisions/entries/turn-handler.ts`, `entries/turn-gear.ts` | new | the two entries, their rules, reason lists, effect tables |
| `src/decisions/registry.ts` | new | `REGISTRY`, `entryById`, `entryProblems` (R12, R13 as data) |
| `src/decisions/digest.ts` | new | digest build + daily tick |
| `src/core/turn-handler-ladder.ts` | new | pure glue: `planTree`, `treeDetailOf`, `jevSkipReason`, `fallbackOfSkip`, `urlRule` (moved), `UNARMED` (moved) |
| `src/run/run-store.ts` | mod | migration, decision/outcome/move/digest methods, link columns (Task 4); review taps outside the command window (Task 11) |
| `src/jev/decide.ts` | mod | `recordSkip` / `persistDecisionRows` carry `ladder_decision_id` |
| `src/core/core-worker.ts` | mod | triage decision through the runner; deferred front-door rows (8b); the Undo card on every automatic lesson save (8c) |
| `src/core/memory-lane-card.ts` | mod | `memlaneUndoButton` exported (8c) |
| `tests/core/lesson-save-card.test.ts` | new | every automatic save announced once, on a card with Undo (8c) |
| `src/capabilities/self-write-guard.ts` | mod | `src/decisions` protected |
| `src/run/invariant-sweep.ts` | mod | per-entry skip rate |
| `src/notifications/notification-types.ts`, `telegram-notification-adapter.ts` | mod | `button_rows` |
| `src/triggers/telegram-command-parser.ts`, `telegram-trigger-adapter.ts`, `src/domain/types.ts` | mod | `dec:rv:` tap → `decision_review` event |
| `src/gateway/decision-commands.ts` (new), `src/gateway/gateway.ts` | new/mod | the review tap handler; rate-limit exemption |
| `src/telegram/telegram-daemon.ts` | mod | digest tick |
| `scripts/live-gate-decisions-parity.mjs` | new | P6 dual run + digest + tap gate |
| `scripts/check-decisions-rollback.mjs` | new | R13 rollback check: the previous build on a migrated DB copy (Task 13) |
| `docs/reference/configuration.md`, `docs/reference/jev-decision-layer.md`, `CONTEXT.md` | mod | docs sync (Task 13) |

**Task order (from the import graph):** 1 (docs only) · 2 (pin, before any `core-worker.ts` or `src/jev/` change) · 3 → 4 → 5 → 6 · 7 (independent) · 8a (needs 2, 3, 6) · 8b (needs 2, 4, 5, 8a) · 8c (needs 8b) · 9 (needs 4, 6) · 10 (needs 4, 5, 6) · 11 (needs 4, 10) · 12 (needs all) · 13 (needs 12's worktrees). No task imports anything Task 1 writes.

---

## Task 1: ADR 0030 "Decision ladder", the four amendments, the index row and the AGENTS.md sentence (draft for Paco's hand)

**Files:**
- Create: `docs/decisions/0030-decision-ladder.md`
- Modify: `docs/decisions/0029-jev-system-one.md` (Status line 3; append a section at the end, after line 291)
- Modify: `docs/decisions/0028-omp-runtime.md` (Status line 3; append at the end)
- Modify: `docs/decisions/0014-dual-llm-privilege-separation.md` (Status line 3; append at the end)
- Modify: `docs/decisions/0011-self-evolution-architecture.md` (Status line 3; append at the end)
- Modify: `docs/decisions/README.md` (rows for 0011, 0014, 0028, 0029; new row 0030 after 0029)
- Modify: `AGENTS.md:16` (the Jev sentence)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing code imports. Protected: the controller commits this on its own branch for Paco to merge by hand; no later task waits for the merge to compile or test.

- [ ] **Step 1: Write `docs/decisions/0030-decision-ladder.md`**

```markdown
# ADR 0030: Decision ladder — every decision on one list, a ladder of deciders, improved from outcomes

- **Status:** proposed 2026-10-12 (design approved by Paco section by section, 2026-10-12; rulings R12 and R13 the same day)
- **Date:** 2026-10-12
- **Deciders:** Paco
- **Amends:** [0029](0029-jev-system-one.md) (the front door becomes the `turn.handler` entry; decision 2 applications;
  one named exception to "no Jev in any deny path"; decision 4 egress; decision 5 shadow and provisional bars),
  [0028](0028-omp-runtime.md) (D5, D12), [0014](0014-dual-llm-privilege-separation.md) (an injection judge before the
  reader), [0011](0011-self-evolution-architecture.md) (`src/decisions/` joins the protected surface)
- **Spec:** [2026-10-12-decision-ladder-design.md](../superpowers/specs/2026-10-12-decision-ladder-design.md) (Rev 8);
  research [2026-10-12-in-loop-decisions](../superpowers/research/2026-10-12-in-loop-decisions/00-synthesis.md)

## Context

Houge takes about 85 decisions between a Telegram message and the delivered reply. They were 85 hand-written branches
with 85 logging styles and 85 implicit failure directions. Jev decided one of them, at the front door, and "System One
shortcut, else the planner" became the architecture. Paco called that tree stiff and declined to add judges on top of
it as a patch (2026-10-12). The middle of the turn was blind in five places: tool output was screened for injection only
on the four read tools and only as a note; "done" was never verified; there was no loop detection beyond the call cap;
output was trimmed by size, not relevance; notify-now-or-later was never decided. Learning paths were each wired to one
trigger, and nothing measured whether an improvement worked.

## Decision

We will hold every decision that changes a turn's path, and whose answer an outcome could show wrong, as one entry in a
code-owned registry under `src/decisions/`. Everything else stays plain code (mechanics).

1. **Entry.** An entry has a stable id, a version bumped on any wording, rung or bar change, a stage, the input source it
   reads (`paco`, `tool` or `mixed`; `mixed` is treated as `tool`), a closed verdict set that always includes an escape
   value, a `fail` verdict used when no rung answers, a default verdict, the outcome signals that can show it wrong, and,
   for each verdict, what it causes (`none`, `reply`, `tighten`, `proposal`, `effect`) and whether that is reversible and
   how it is announced.
2. **Ladder.** Deciders are tried in order: code rule, then Jev, then a model, then Paco. Code goes first, and a rule
   answer ends the walk. A rule that wants a judge consulted abstains; "eligible for judging" is an abstention, never a
   pass. A thrown rule, a timeout or an outage is an abstention, so `fail` decides, never an accident.
3. **Monotone rule, restated.** On an entry declared monotone, a Jev or model rung can only tighten: its verdict applies
   only when it is at least as cautious as the verdict so far, which starts at the abstaining rule's floor. A Jev or
   model rung never opens a gate, and never allows or denies an action (ADR 0029 decision 2), with the one exception
   named under the 0029 amendment below.
4. **What a Jev or model verdict may do depends on what it read (R12).** ADR 0029's accepted risk stands: Jev is
   steerable by injected text, so its labels stay advisory or monotone and steering degrades quality, never safety.
   - Over **tool-derived input** (web, mail, calendar, shell output, files, tool results) a verdict may only tighten:
     withhold a passage, add a tap, or send the planner back once. Any lasting change it suggests (a lesson, fact, skill
     or wiki page) is a proposal for Paco's tap.
   - Over **Paco's own message** a verdict may cause an effect directly, if the effect is reversible and announced.
     Examples: a `turn.handler` lane reply (Dig deeper), and the memory shortcut's instant lesson save (stage A,
     unchanged and permanent; Undo on its card). Every automatic lesson save, whatever route the turn took, is announced
     on the memory card with Undo (Paco, 2026-10-12).
   - A registry test fails any entry whose Jev or model rung can cause an unannounced or irreversible effect, or any
     effect other than tightening or a proposal from tool input.
5. **Ledger.** The runner decides, then records; recording never changes a decision. A failed write opens incident
   `decision_record_failed` and the verdict stands. A `decisions` row is written when the verdict differs from the
   default, a rung beyond the first rule answered or was asked in shadow, Paco was involved, or the entry always
   records. Rows hold ids, closed enums and numbers only: no state column, never read text. A row whose decision belongs
   to a turn is written with that turn's own records, so a turn that is lost writes no row. `decision_outcomes` holds
   closed-enum outcome signals per decision, validated at insert. Domain detail stays in the entry's own table
   (`turn.handler` keeps `jev_verdicts`, which gains `decision_id`; `jev_decisions` gains `ladder_decision_id`).
6. **Locked entries.** Gates whose logic must never be judged (sender, budget fuse, bare-ack consent, kill posture,
   approval binding, path floor, SSRF, self-write guard, the reader wall, attachment path, secret redaction, turn trust)
   are locked: no rung added and no ladder move, refused in code by a registry test and at run time by the ladder-move
   store.
7. **Ladder moves.** A move changes who decides, recorded in `ladder_moves`. Houge may move on its own, from code rungs
   only: standing approvals (after three consecutive approvals of one action and one proven sealed run), skill authoring
   after a recurrence pattern (into the inert pending area; active only on Paco's tap), and lessons through the existing
   save path for a stated rule, with Undo. Only the standing-approval code may insert an automatic row, only for
   `tool.policy`, enforced in the store. Every other loosening (trusting a source, retiring a judge, lowering a bar) is a
   proposal for Paco's tap; callbacks pass the sender allowlist and are one-shot.
8. **Improvement as a decision.** Corrections, review taps and failures go through one entry, `improve.route`, which
   routes each to what it points at (fact, lesson, skill, ladder move, schedule, wiki page, tool gap) and is itself
   measured by whether its signal recurs. A pattern is needed before behaviour changes, except an explicit stated rule.
9. **Bars.** A Jev rung arms on calibrated rows as ADR 0029 decision 5 requires, or on a **provisional bar** taken from
   an external measurement, kept in the entry's registry code, allowed only on monotone or fail-open entries, and covered
   by golden-set items in the invariant sweep. Golden-set drift pages (`decision_golden_drift:<entry>`) and does not
   disarm. On a model or wording change a provisional rung stays armed on its bar, incident `decision_bar_stale:<entry>`
   pages once naming the new model, and the digest flags the entry until Paco commits a calibrated row. The migrated
   front door keeps ADR 0029 decision 5's existing disarm-on-model-move for its calibrated tree rows, unchanged.
10. **No off switch, no shadow by design (R13).** Once built, the decision system is not switched off and no entry is
    designed to run in shadow: a new entry ships armed and stays armed. The runner's `shadow` mode exists only so the
    migrated front door keeps today's configured triage shadow mode exactly. If a build is fundamentally wrong, the
    remedy is revert, rebuild `dist/`, kickstart. Every stage's migrations are additive (new tables, nullable link
    columns), so the previous build runs on the migrated DB, and every stage plan's final task proves it by booting the
    previous build against a migrated DB copy.
11. **Review.** A daily digest lists unsure verdicts (probability within 0.15 of the bar) with ✅/❌ taps that write
    outcome labels, counts per entry and rung, and per-entry health; urgent cards go out at once for events that cannot
    wait. Silence writes nothing.
12. **Egress (R11).** Paco approved, on 2026-10-12, sending web, mail and calendar content, shell output, files and the
    final reply to TypeSafe for judging, after the judge redactor (`src/decisions/egress.ts`: known secret values,
    credential shapes, named secrets with single-run values, URL userinfo, query values and fragments, this turn's
    extracted codes and links; redacted before splitting). Credential stores are read-denied to the planner and never
    sent; a content check keeps PEM blocks, service-account JSON, cookie jars and dense named secrets on the code floor.

## Consequences

- Easier: a new judgment call is an entry plus a rung, not a branch; every decision has one record, one failure
  direction and one outcome trail; Paco reviews uncertain verdicts in one daily message.
- Harder: every migrated decision needs characterisation tests and a behavioural differential before its call site
  moves; the registry is protected surface, so every rung or bar change is Paco's merge. Without an off switch, a bad
  build is a revert and a kickstart, so each stage's live gate carries more weight.
- The `turn.handler` Jev policy glue (arming, bars and the URL rule, `src/core/turn-handler-ladder.ts`) stays outside the
  protected directory, as `src/jev/tree-policy.ts` already is; the entry itself is protected. Acceptable for a non-gate
  entry; a gate entry's glue must live under `src/decisions/entries/`.
- Accepted residuals: a secret with no recognisable name, shape or content, in output the planner read, can reach
  TypeSafe (Paco approved the class, R11); the planner itself can still send what it reads to its own model provider, as
  today.

## Alternatives considered

- **Judges on top of the existing tree:** rejected by Paco as a patch on "if not System One, then the planner".
- **Judge approval (a model opens a gate):** rejected; approval stays Paco's or a Paco-authorised standing rule.
- **"Jev never causes an effect on its own"** (spec Rev 2–7): replaced by R12. It stretched AGENTS.md's "never gates an
  action" without a decision, and contradicted the memory shortcut Paco armed.
- **An off switch (`HOUGE_DECISIONS_OFF`) and shadow-before-arm for new entries** (spec Rev 1–7): dropped by R13.
- **omp's built-in TypeSafe judges:** rejected because their verdicts cannot be ledgered, calibrated or reviewed; not
  because of where the Jev key lives (ADR 0015's reason no longer holds: the child already holds subscription logins).
- **Migrating every branch:** rejected; mechanics stay code. Clean means every decision, not every branch.
- **A tally table for routine passes:** rejected as a second accounting path before any volume problem.

## Assumptions

- Houge's omp extension can rewrite a built-in `read` result before the model sees it, and can send a turn back once at
  settle (probes P1, P2, run 2026-10-12). Checkable: the stage 2b gate.
- Hook handlers in the extension are bounded at 30 s by omp and fail open to the raw result (probe P4); Houge's own 5 s
  extension timers keep the floor ahead of that.
- Jev answers within its 1.5 s bound on the front door, and the extra in-loop volume (about 25–50 calls a day) stays
  within TypeSafe's limits at ten times that (P5).
- The decisions ledger stays small: about 10–15 rows per turn at about 5 turns a day (DB copy, 30 days to 2026-10-12).
- The front-door migration changes no persisted row: the stage 1 pin and the P6 dual run over the last 200 texts show
  zero mismatches.
- Each stage's migrations are additive, so the previous build runs on a migrated DB: checked by each stage plan's final
  task.

## Revisit when

- omp emits judge verdict events (its built-in judges could then be ledgered).
- TypeSafe ships adversarial hardening or a retention commitment.
- The `decisions` table passes 1 million rows.
- A provisional bar's golden-set drift pages twice in 30 days.
- A locked entry needs a judgment the code cannot make.
- A stage needs a migration that is not additive (then rollback is no longer revert, rebuild, kickstart, and R13 needs
  Paco again).
- Any assumption above is shown false by its check.

## Amendments to prior ADRs (appended 2026-10-12 to 0029, 0028, 0014, 0011)

- **0029.** The front door becomes the entry `turn.handler` (ack rule → Jev tree → Tiny cascade, the planner its `fail`
  value), with `turn.gear` a separate entry on the same Jev call. **Decision 2** stands word for word; this ADR records
  three applications under it: withholding a passage is a data transform, not an action deny; `turn.settle`'s send-back
  is one bounded continuation in which, after a Jev-rung send-back, every side effect asks, and after a code-rung
  send-back the normal gates apply; the built-in `edit`/`write` redirect in a hostile turn is the ask form of a gate that
  cannot wait. **"No Jev in any deny path, ever"** gains one named exception: the code-owned redirect of a built-in
  `edit`/`write` to its asking equivalent (`bash`, which asks Paco) in a turn the injection judge marked hostile. Every
  other Jev verdict stays out of deny paths. What a Jev verdict may cause follows decision 4 above (R12): the memory
  shortcut's instant save stays, permanently. The added-tap budget (3 a day) also counts trust asks. **Decision 4:**
  Paco's R11 approval (decision 12 above) is recorded as the approval of web, mail and calendar content, shell output,
  files and replies, with the judge redactor and the residual above. **Decision 5** (shadow before arm): new entries
  never shadow (R13); a stale bar or golden drift pages instead of disarming; provisional bars (decision 9 above) are an
  explicit exception, under Paco's R6, for monotone or fail-open entries only. The front door's calibrated tree rows keep
  decision 5's disarm on a model move, unchanged.
- **0028.** D5's tap-free local writes become conditional on the turn's trust level (`turn.trust`); D12's network shell
  output gets the `tool.injection` judge.
- **0014.** An injection judge (`tool.injection`) runs on wall-tool output before the quarantined reader; it withholds
  passages, never decides whether the wall applies.
- **0011.** `src/decisions/` joins `PROTECTED_DIRS`: if the registry decides the gates, editing it can open a gate, so
  it is Paco's hand only.
```

- [ ] **Step 2: Append the amendment pointers to the four ADRs and update their Status lines**

Append this section at the end of each of the four files, with the file's own bullet (copy the matching bullet from the
ADR 0030 "Amendments" section verbatim):

```markdown

---

## Amendment (2026-10-12): decision ladder

Amended by [ADR 0030](0030-decision-ladder.md). <the matching bullet from ADR 0030 § Amendments, verbatim>
```

Status-line edits (append to the existing line, keep everything already there):
- `0029-jev-system-one.md:3`: append `; amended 2026-10-12 by [ADR 0030](0030-decision-ladder.md) (front door as the turn.handler entry; one named exception to "no Jev in any deny path"; Jev effects by input source (R12); R11 egress; no shadow for new entries, provisional bars — see end)`
- `0028-omp-runtime.md:3`: replace `accepted` with `accepted; amended 2026-10-12 by [ADR 0030](0030-decision-ladder.md) (D5 conditional on turn trust; D12 output judged — see end)`
- `0014-dual-llm-privilege-separation.md:3`: append `; **amended 2026-10-12 by [ADR 0030](0030-decision-ladder.md)** (injection judge before the reader — see end)`
- `0011-self-evolution-architecture.md:3`: append ` · **amended 2026-10-12 by [ADR 0030](0030-decision-ladder.md)** (src/decisions/ protected — see end)`

- [ ] **Step 3: Update `docs/decisions/README.md`**

Append `; amended 2026-10-12 by [0030](0030-decision-ladder.md)` to the Status cell of rows 0011, 0014, 0028 and 0029,
and add after the 0029 row:

```markdown
| [0030](0030-decision-ladder.md) | Decision ladder — every decision on one registry with a ladder of deciders (code rule → Jev → model → Paco), recorded after it decides, judged inside the loop at checkpoints Houge owns, improved from outcomes (monotone rule restated; what Jev may cause depends on what it read (R12); no off switch or designed shadow (R13), rollback is revert + rebuild; locked entries; ladder moves; provisional bars; R11 egress; amends [0029](0029-jev-system-one.md), [0028](0028-omp-runtime.md), [0014](0014-dual-llm-privilege-separation.md), [0011](0011-self-evolution-architecture.md)) | proposed 2026-10-12 |
```

- [ ] **Step 4: Edit `AGENTS.md:16`**

Replace the last sentence of the line, `Jev (TypeSafe System One), a non-generative typed decider, sits in front of the chains under ADR 0029; it never gates an action and every outage reaches Paco.`, with:

```markdown
Jev (TypeSafe System One), a non-generative typed decider, is one rung of the decision ladder (ADR 0029, ADR 0030): what it may cause depends on what it read — over tool output it only tightens or proposes, over Paco's own message it may cause a reversible, announced effect (a lane reply, the memory shortcut's lesson save) — it never gates an action, and every outage reaches Paco.
```

- [ ] **Step 5: Check**

Run: `grep -n "18\.7\|jev-1\.13\|1\.13\.0" docs/decisions/0030-decision-ladder.md`
Expected: no output (no hard-coded versions in the ADR).
Run: `grep -c "0030-decision-ladder" docs/decisions/README.md docs/decisions/0011-*.md docs/decisions/0014-*.md docs/decisions/0028-*.md docs/decisions/0029-*.md`
Expected: README ≥ 5, each ADR ≥ 2.
Run: `grep -n "HOUGE_DECISIONS_OFF\|never causes an effect\|grandfather" docs/decisions/0030-decision-ladder.md AGENTS.md`
Expected: hits only on the two "Alternatives considered" bullets that name what R12 and R13 replaced; none in `AGENTS.md`, and no "grandfather" anywhere.

- [ ] **Step 6: Commit (protected: on its own branch for Paco's hand-merge)**

```bash
git add docs/decisions/0030-decision-ladder.md docs/decisions/0011-self-evolution-architecture.md docs/decisions/0014-dual-llm-privilege-separation.md docs/decisions/0028-omp-runtime.md docs/decisions/0029-jev-system-one.md docs/decisions/README.md AGENTS.md
git commit -m "docs(adr): ADR 0030 decision ladder; amend 0029, 0028, 0014, 0011; AGENTS.md Jev sentence"
```

## Task 2: Pin today's `turn.handler` behaviour (characterisation snapshot, written on the pre-ladder code)

Spec §6.2 step 1. This task must run before any change to `src/core/core-worker.ts` or `src/jev/`; Task 8b must keep
every snapshot byte-identical without `-u`, and must not touch any file this task writes. It adds tests only.

**Files:**
- Create: `tests/helpers/triage-harness.ts`
- Create: `tests/core/turn-handler-pin.test.ts`
- Create: `tests/core/turn-handler-pin-throws.test.ts`
- Create: `tests/core/turn-handler-routed-by.test.ts`
- Create (generated by the test run): `tests/core/__pins__/turn-handler/*.json`

**Interfaces:**
- Consumes: `ompWorker`, `until` (`tests/helpers/omp-worker.ts:21, 41`), `pinOmpEnv`, `pinEnabledFlags`, `shortTmp`, `useFakeOmp` (`tests/helpers/omp-env.ts`), `createQueuedTurnRun` (`tests/helpers/runs.ts:8`), `CoreWorker.triageTurn`, `submitTurn`, `shutdownPlanners`, `breakLaneFinalizeOnceForTest`, `recordTriageOverride`.
- Produces (used by Tasks 8a, 8b and 12's reasoning): `triageHarness(fetch, o)`, `treeSays(o)`, `cat`, `only`, `scope`, `level`, `LIGHT`, `NONE`, `HEAVY`, `jevDown`, `jevStatus`, `jevNotJson`, `scriptedLlm(s)`, `picks`, `webOk()`, `calibrationFile()`, `ARM`, `SHADOW`, `sinkOf(worker)`, `projectRun(store, run_id, outcome, ids)`, `IdMap`.
- The frozen set (Tasks 8b and 13 check it with `git diff --exit-code <task-2 sha>`): `tests/helpers/triage-harness.ts`, `tests/core/turn-handler-pin.test.ts`, `tests/core/turn-handler-pin-throws.test.ts`, `tests/core/turn-handler-routed-by.test.ts`, `tests/core/__pins__/`.

- [ ] **Step 1: Write `tests/helpers/triage-harness.ts`**

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { CoreWorker } from "../../src/core/core-worker.js";
import { LANE_PREFACE, REWRITE_INSTRUCTION } from "../../src/core/lanes/lane-compose.js";
import { CATEGORIES, TREE_CATEGORY, TREE_QUESTIONS, type Category } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TREE_ANSWER_ARM_ID, TREE_LOOKUP_ARM_ID, TREE_STATUS_ARM_ID } from "../../src/jev/tree-policy.js";
import type { TurnModality } from "../../src/media/media-config.js";
import type { TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { ompWorker } from "./omp-worker.js";
import { createQueuedTurnRun } from "./runs.js";

/**
 * One triage harness for the pin (Task 2) and the ladder tests (Task 8b): a fake Jev answer, the test-injected seat told
 * apart by its prompt, and every arming row in a gate-only calibration file. Tests only. Frozen after Task 2: a change
 * here could hide a behaviour change from the pin.
 */
export const REPORTED = "jev-1.13.0";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const n = CATEGORIES.length;
/** A category answer: the given probabilities, the rest split evenly (sums to 1, as Jev's do). */
export function cat(p: Partial<Record<Category, number>>) {
  const used = Object.values(p).reduce((a, b) => a + (b ?? 0), 0);
  const rest = CATEGORIES.filter((c) => p[c] === undefined);
  const probabilities = Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? (1 - used) / rest.length]));
  const [choice, pMax] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
}
/** Only the named categories carry probability (every other option exactly 0). */
export const only = (p: Partial<Record<Category, number>>) => cat(Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? 0])));
export const scope = (ask: number) => ({ type: "choice", choice: ask >= 0.5 ? "ask" : "research", probabilities: { ask, research: 1 - ask }, confidence: Math.abs(2 * ask - 1) });
export const level = (probs: number[]) => ({ type: "score", score: probs.reduce((s, p, k) => s + k * p, 0),
  probabilities: Object.fromEntries(probs.map((p, k) => [String(k), p])), confidence: 0.8 });
export const LIGHT = [0.1, 0.9, 0, 0]; // expected 0.9 → Fast, effort low
export const NONE = [1, 0, 0, 0];      // expected 0
export const HEAVY = [0, 0, 0.2, 0.8]; // expected 2.8 → Thinking, effort high
export interface Says { category?: ReturnType<typeof cat>; sets_rule?: number; ask?: number; breadth?: number[]; reasoning?: number[]; actions?: number[]; model?: string }
export const treeSays = (o: Says = {}) => vi.fn(async (_url?: unknown, _init?: unknown) => json(200, {
  model: o.model ?? REPORTED, usage: { input_tokens: 900, output_tokens: 0 }, answers: {
    category: o.category ?? cat({ other: 0.9 }), sets_rule: { type: "noul", noul: o.sets_rule ?? 0.05 }, rule_scope: scope(o.ask ?? 0.9),
    breadth: level(o.breadth ?? LIGHT), reasoning: level(o.reasoning ?? LIGHT), actions: level(o.actions ?? NONE) } }));
export const jevDown = () => vi.fn(async () => { throw new TypeError("fetch failed"); });
export const jevStatus = (status: number) => vi.fn(async () => new Response("{}", { status }));
/** A 200 whose body is not JSON: the client's `parse` skip (jev-client.ts:173). */
export const jevNotJson = () => vi.fn(async () => new Response("not json", { status: 200 }));

export type Llm = (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
export interface LlmScript { compose?: Llm; cascade?: Llm; distill?: Llm }
const READ_OK = JSON.stringify({ summary: "Sydney tomorrow", facts: ["Sunny, max 22°C"], time_claims: [], answer_to_objective: "Sunny, 22°C", contains_instructions: false });
/** The injected seat: the cascade (by its system line), lane compose / rewrite / reader (by prompt), the lesson service's two calls. */
export const scriptedLlm = (s: LlmScript = {}): Llm => async (input) => {
  const q = String(input.question ?? ""); const sys = String(input.system ?? "");
  if (/exactly one of these two words/.test(sys)) return s.cascade ? s.cascade(input) : { ok: false, error: "no cascade fake" };
  if (q.startsWith(LANE_PREFACE)) return s.compose ? s.compose(input) : { ok: true, output: { answer: "放在书房更好。", model: "claude-sonnet-5-5" } };
  if (q.startsWith(REWRITE_INSTRUCTION)) return { ok: true, output: { answer: "SAME" } };
  if (q.includes("<<<UNTRUSTED>>>")) return { ok: true, output: { answer: READ_OK } };
  if (/durable/i.test(sys)) return s.distill ? s.distill(input) : { ok: true, output: { answer: JSON.stringify({ durable: true, lesson: "Keep replies short." }) } };
  return { ok: true, output: { answer: JSON.stringify({ verdict: "ADD", theme: "format" }) } };
};
export const picks = (answer: string): Llm => async () => ({ ok: true, output: { answer } });
export const webOk = () => vi.fn(async (_input: Record<string, unknown>): Promise<ToolAdapterResult> => ({ ok: true,
  output: { query: "q", provider: "tavily", results: [{ title: "BOM", url: "https://weather.example/sydney", content: "Tomorrow: sunny, max 22." }] } }));

/** The gate-only rows: the six questions and the three lane pseudo-rows, zh + en, on REPORTED. */
export function calibrationFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), "hpin-cal-")), "rows.json");
  const ids = [...TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)] as const),
    ...[TREE_STATUS_ARM_ID, TREE_ANSWER_ARM_ID, TREE_LOOKUP_ARM_ID].map((id) => [id, criteriaHash(TREE_CATEGORY)] as const)];
  writeFileSync(f, JSON.stringify(ids.flatMap(([question_id, criteria_hash]) => (["zh", "en"] as const).map((lang) =>
    ({ question_id, criteria_hash, model: REPORTED, lang, approved: "test", evidence: "test" })))));
  return f;
}
export const ARM: Record<string, string> = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" };
export const SHADOW: Record<string, string> = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "shadow" };

export interface HarnessOptions { env?: Record<string, string>; llm?: Llm; web?: Llm; jevNow?: () => Date }
/** `noState`: skip buildOmpTools, so the turn has no OmpTurnState (today's `!state` exit, skip reason `error`). */
export interface TurnOptions { signal?: AbortSignal; modality?: TurnModality; posture?: string | null; noState?: boolean }
/** Env first (the worker reads boot-time switches in its constructor), then the store and the worker. */
export function triageHarness(fetchImpl: unknown, o: HarnessOptions = {}) {
  vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", calibrationFile()); vi.stubEnv("HOUGE_JEV_GATE", "1"); vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  for (const [k, v] of Object.entries(o.env ?? ARM)) vi.stubEnv(k, v);
  const store = RunStore.openInMemory();
  const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hpin-")), { llm: o.llm ?? scriptedLlm(), jevFetch: fetchImpl as typeof fetch,
    ...(o.web ? { web: o.web } : {}), ...(o.jevNow ? { jevNow: o.jevNow } : {}) });
  const turn = (text: string, t: TurnOptions = {}) => {
    const run_id = createQueuedTurnRun(store, text);
    const claim = store.claimRun(run_id, "w", 120)!;
    if (!t.noState) worker.buildOmpTools(claim, "555");
    return { run_id, input: { claim, text, userText: text, modality: t.modality ?? "text", posture: t.posture ?? null, signal: t.signal ?? new AbortController().signal } };
  };
  return { store, worker, turn };
}
export type Harness = ReturnType<typeof triageHarness>;
export const sinkOf = (w: CoreWorker) => (w as unknown as { ompOutcomeSink: (chat: string) => TurnOutcomeSink }).ompOutcomeSink("555");

/** Ids become stable placeholders in first-seen order, so two runs of the same case compare equal. */
export class IdMap {
  private readonly seen = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  map(s: string): string {
    return s.replace(/\b(run|jv|jd|lc|dec|ct)_[0-9A-Za-z-]{6,}/g, (id, prefix: string) => {
      const hit = this.seen.get(id);
      if (hit) return hit;
      const k = (this.counts.get(prefix) ?? 0) + 1;
      this.counts.set(prefix, k);
      const ph = `<${prefix}#${k}>`;
      this.seen.set(id, ph);
      return ph;
    });
  }
  deep<T>(x: T): T { return x === undefined ? x : JSON.parse(this.map(JSON.stringify(x))) as T; }
}

/**
 * Columns that are ids or clocks: dropped from the projection. `state_hash` is KEPT (senior W1): with no prior Houge turn
 * and no quote the tree state carries no clock, so its hash pins the Jev request content that Task 8b moves.
 */
const DROP: ReadonlySet<string> = new Set(["decision_id", "ladder_decision_id", "run_id", "verdict_id", "created_at", "updated_at", "latency_ms",
  "thread_cut_at", "state_built_at"]);
function clean(row: object, ids: IdMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!DROP.has(k)) out[k] = typeof v === "string" ? ids.map(v) : v;
  return out;
}

/** The verdict → model-call join (consumer 11): each llm_attempt's role and routed_by, ids mapped. */
function attemptsOf(events: ReturnType<RunStore["getLedgerEvents"]>, ids: IdMap): Array<[unknown, string | null]> {
  return events.filter((e) => e.event_type === "llm_attempt").map((e) => {
    const p = e.payload as { role?: unknown; routed_by?: string };
    return [p.role ?? null, p.routed_by === undefined ? null : ids.map(p.routed_by)];
  });
}

/** Everything triage persists for one run, ids mapped: decision rows, the verdict (with its id, so links show), the route's link, model calls, the triage event(s), saves. */
export function projectRun(store: RunStore, run_id: string, outcome: unknown, ids: IdMap): Record<string, unknown> {
  const v = store.getJevVerdictForRun(run_id);
  const events = store.getLedgerEvents(run_id);
  const routeVerdict = (outcome as { route?: { verdict_id?: string | null } } | null)?.route?.verdict_id;
  return {
    outcome: ids.deep(outcome),
    jev_decisions: store.listJevDecisions(run_id).map((r) => clean(r, ids)),
    verdict: v ? { id: ids.map(v.verdict_id), ...clean(v, ids) } : null,
    // the supervisor sets routed_by from route.verdict_id (planner-supervisor.ts:499): it must name this run's verdict row
    route_links_verdict: routeVerdict === undefined ? null : routeVerdict === (v?.verdict_id ?? null),
    llm_attempts: attemptsOf(events, ids),
    triage: events.filter((e) => e.event_type === "triage").map((e) => ids.deep(e.payload)),
    lessons_saved: events.filter((e) => e.event_type === "lesson_saved").length
  };
}
```

- [ ] **Step 2: Write `tests/core/turn-handler-pin.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordTriageOverride } from "../../src/gateway/memlane-commands.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import {
  ARM, cat, HEAVY, IdMap, jevDown, jevNotJson, jevStatus, LIGHT, only, picks, projectRun, scriptedLlm, SHADOW, sinkOf, treeSays, triageHarness, webOk,
  type Harness, type HarnessOptions, type Says, type TurnOptions
} from "../helpers/triage-harness.js";

// Spec §6.2 step 1 ("pin"): today's turn.handler behaviour over a corpus covering every exit and every later mutation a
// consumer makes, projected as what triage persists — jev_decisions (state_hash included), the jev_verdicts row, the
// route's link to it, the run's llm_attempt routed_by values, the triage event, the outcome, lane_replies and the catch-up
// boundary — with ids mapped and clocks dropped. The files were written on the pre-ladder code (main @ 3bff437); the
// migration (Task 8b) must leave every one byte-identical. A projection that still matches after a behaviour change would
// be a hole, so it keeps every column a consumer reads (see the consumer table in the plan).

const RULE: Says = { category: cat({ memory: 0.9 }), sets_rule: 0.95 };
const notDurable = scriptedLlm({ distill: async () => ({ ok: true, output: { answer: JSON.stringify({ durable: false }) } }) });

interface PinCase {
  name: string; text: string; fetch: () => unknown; opts?: HarnessOptions; turn?: TurnOptions;
  before?: (h: Harness) => Promise<string[]> | string[]; // earlier runs to project too (in order)
  prepare?: (h: Harness, run_id: string) => void;        // after the run exists, before triage
  breakCard?: "memory" | "lane" | "finalize";
  after?: (h: Harness, run_id: string, outcome: unknown) => void;
}

/**
 * Cases whose Jev state carries a wall-clock age (a prior Houge turn's "minutes ago"): only their state_hash is masked.
 * Expected empty; Step 4 adds a case here only if its state_hash flips between runs, and only a prior-turn case may be added.
 */
const CLOCK_CASES: ReadonlySet<string> = new Set<string>([]);
const PRIOR_TURN_CASES: ReadonlySet<string> = new Set(["ack-rule", "think-harder-correction"]);

function maskStateHash(projection: Record<string, unknown>): void {
  for (const r of projection.jev_decisions as Array<Record<string, unknown>>) if (r.state_hash !== null) r.state_hash = "<clock>";
}

async function runCase(c: PinCase): Promise<Record<string, unknown>> {
  const h = triageHarness(c.fetch(), c.opts ?? {});
  const ids = new IdMap();
  const earlier = c.before ? await c.before(h) : [];
  const t = h.turn(c.text, c.turn ?? {});
  c.prepare?.(h, t.run_id);
  if (c.breakCard === "memory") h.worker.breakMemoryLaneCardForTest();
  if (c.breakCard === "lane") h.worker.breakLaneCardForTest();
  if (c.breakCard === "finalize") h.worker.breakLaneFinalizeOnceForTest();
  const outcome = await h.worker.triageTurn(t.input);
  c.after?.(h, t.run_id, outcome);
  const isStatus = h.store.getJevVerdictForRun(t.run_id)?.lane === "status" && (outcome as { kind?: string }).kind === "lane_reply";
  const shown = isStatus ? { ...(outcome as object), text: "<status text>" } : outcome; // houge_status renders live clocks
  const result = {
    earlier: earlier.map((r) => projectRun(h.store, r, null, ids)),
    run: projectRun(h.store, t.run_id, shown, ids),
    catch_up: h.store.laneTurnsSince("555", null).map((l) => ({ run_id: ids.map(l.run_id), lane: l.lane, verdict_id: l.verdict_id ? ids.map(l.verdict_id) : null, catch_up: l.catch_up })),
    planner_last_answered: h.store.plannerLastAnsweredAt("555") === null ? null : "set"
  };
  if (CLOCK_CASES.has(c.name)) for (const p of [...result.earlier, result.run]) maskStateHash(p);
  h.store.close();
  return result;
}

/** A plain Houge answer as the chat's last turn (the ack rule needs one). */
const seedPlainAnswer = (h: Harness): string[] => {
  const run_id = createQueuedTurnRun(h.store, "明天悉尼天气怎么样？");
  h.store.recordChatTurn({ chat_id: "555", run_id, role: "user", text: "明天悉尼天气怎么样？" });
  h.store.recordChatTurn({ chat_id: "555", run_id, role: "assistant", text: "明天悉尼晴，最高 22 度。", intent: "loop" });
  return [];
};
/** One routed turn first, so the next one can label it (think harder) or be compared against it. */
const priorRouted = async (h: Harness): Promise<string[]> => {
  const t = h.turn("帮我查一下明天悉尼天气");
  await h.worker.triageTurn(t.input);
  return [t.run_id];
};

const CASES: PinCase[] = [
  { name: "off", text: "以后回复短一点", fetch: () => vi.fn(), opts: { env: { HOUGE_JEV_ENABLED: "0" } } },
  { name: "off-think-harder", text: "认真想：以后回复短一点", fetch: () => vi.fn(), opts: { env: { HOUGE_JEV_ENABLED: "0" } } },
  { name: "posture", text: "以后回复短一点", fetch: () => vi.fn(), turn: { posture: "killed" } },
  { name: "modality-photo", text: "这是什么？", fetch: () => vi.fn(), turn: { modality: "photo" } },
  { name: "override", text: "明天悉尼天气怎么样？", fetch: () => treeSays(),
    prepare: (h, run_id) => recordTriageOverride(h.store, createQueuedTurnRun(h.store, "原来的消息"), run_id, "555") },
  { name: "no-turn-state", text: "以后回复短一点", fetch: () => treeSays(RULE), turn: { noState: true } },
  { name: "ack-rule", text: "谢谢", fetch: () => treeSays(), before: seedPlainAnswer },
  { name: "state-too-large", text: "长".repeat(8_001), fetch: () => treeSays() },
  { name: "jev-transport", text: "以后回复短一点", fetch: jevDown },
  { name: "jev-429", text: "以后回复短一点", fetch: () => jevStatus(429) },
  { name: "jev-parse", text: "以后回复短一点", fetch: jevNotJson },
  { name: "jev-transport-think-harder", text: "认真想：这个怎么办", fetch: jevDown },
  { name: "shadow", text: "以后回复短一点", fetch: () => treeSays(RULE), opts: { env: SHADOW } },
  { name: "uncalibrated-model", text: "明天悉尼天气怎么样？", fetch: () => treeSays({ model: "jev-9.9.9" }) },
  { name: "routed-other-light", text: "帮我整理一下这周的待办", fetch: () => treeSays({ category: cat({ other: 0.9 }) }) },
  { name: "routed-research-heavy", text: "帮我比较三款 NAS", fetch: () => treeSays({ category: cat({ research: 0.9 }), breadth: HEAVY, reasoning: HEAVY, actions: HEAVY }) },
  { name: "think-harder-correction", text: "认真想：再比较一下", fetch: () => treeSays({ category: cat({ research: 0.9 }) }), before: priorRouted },
  { name: "correction", text: "那条规则不对，删掉它", fetch: () => treeSays({ category: cat({ memory: 0.9 }), sets_rule: 0.5 }) },
  { name: "bare-ack-guard-status", text: "好", fetch: () => treeSays({ category: only({ status: 0.95, other: 0.05 }) }) },
  { name: "cascade-pick", text: "这个周末去哪玩", fetch: () => treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }) }), opts: { llm: scriptedLlm({ cascade: picks("lookup") }) } },
  { name: "cascade-failed", text: "这个周末去哪玩", fetch: () => treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }) }) },
  { name: "cascade-pick-with-rule", text: "以后都用摄氏度，这周末去哪", fetch: () => treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }), sets_rule: 0.95 }),
    opts: { llm: scriptedLlm({ cascade: picks("answer") }) } },
  { name: "status-lane", text: "你刚才重启过吗？", fetch: () => treeSays({ category: only({ status: 0.95, other: 0.05 }) }) },
  { name: "memory-lane-saved", text: "从现在起，回复请控制在三句话以内。", fetch: () => treeSays(RULE) },
  { name: "memory-lane-not-durable", text: "从现在起，回复请控制在三句话以内。", fetch: () => treeSays(RULE), opts: { llm: notDurable } },
  { name: "memory-card-throws-after-save", text: "从现在起，回复请控制在三句话以内。", fetch: () => treeSays(RULE), breakCard: "memory" },
  { name: "memory-lane-finalize-rolled-back", text: "从现在起，回复请控制在三句话以内。", fetch: () => treeSays(RULE), breakCard: "finalize" },
  { name: "two-request", text: "以后用摄氏度。顺便帮我订明天的会议室", fetch: () => treeSays({ ...RULE, actions: HEAVY }) },
  { name: "rule-on-lookup", text: "以后温度都用摄氏度。明天悉尼天气怎么样？", fetch: () => treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.95, actions: LIGHT }), opts: { web: webOk() } },
  { name: "answer-lane", text: "你觉得 NAS 放在客厅还是书房更好？", fetch: () => treeSays({ category: cat({ answer: 0.9 }) }) },
  { name: "answer-lane-compose-failed", text: "你觉得呢？", fetch: () => treeSays({ category: cat({ answer: 0.9 }) }),
    opts: { llm: scriptedLlm({ compose: async () => ({ ok: false, error: "all lane legs failed" }) }) } },
  { name: "answer-lane-card-throws", text: "你觉得呢？", fetch: () => treeSays({ category: cat({ answer: 0.9 }) }), breakCard: "lane" },
  { name: "answer-lane-off", text: "你觉得呢？", fetch: () => treeSays({ category: cat({ answer: 0.9 }) }), opts: { env: { ...ARM, HOUGE_JEV_LANES_OFF: "answer" } } },
  { name: "lookup-lane", text: "明天悉尼天气怎么样？", fetch: () => treeSays({ category: cat({ lookup: 0.9 }), actions: LIGHT }), opts: { web: webOk() } },
  { name: "lookup-url-rule", text: "帮我看看 https://weather.example/sydney 说了什么", fetch: () => treeSays({ category: cat({ lookup: 0.9 }), actions: LIGHT }) },
  { name: "routed-then-routeEnd-escalation", text: "帮我整理一下这周的待办", fetch: () => treeSays({ category: cat({ other: 0.9 }) }),
    after: (h, run_id, out) => {
      h.store.appendRunLedgerEvent(run_id, "routed_escalation", "core", { from: "default", to: "thinking", kind: "timeout" });
      const verdict_id = (out as { route?: { verdict_id?: string } }).route?.verdict_id ?? "";
      sinkOf(h.worker).routeEnd!({ run_id, verdict_id, handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: true, pin_failed: false });
    } },
  { name: "routed-then-complete", text: "帮我整理一下这周的待办", fetch: () => treeSays({ category: cat({ other: 0.9 }) }),
    after: (h, run_id) => sinkOf(h.worker).complete({ run_id, worker_id: "w", text: "好的", attachments: [], duration_ms: 1, tool_calls: 0 }) },
  { name: "answer-lane-then-dig-deeper", text: "你觉得 NAS 放在客厅还是书房更好？", fetch: () => treeSays({ category: cat({ answer: 0.9 }) }),
    after: (h, run_id) => recordTriageOverride(h.store, run_id, createQueuedTurnRun(h.store, "你觉得 NAS 放在客厅还是书房更好？"), "555") }
];

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("turn.handler pin (spec §6.2: behaviour, not only verdicts)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const result = await runCase(c);
      await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./__pins__/turn-handler/${c.name}.json`);
    });
  }

  // A killed turn writes nothing after Jev (the abort lands while Jev answers): the pin of "nothing" is the point.
  it("aborted-during-jev", async () => {
    const ctl = new AbortController();
    const says = treeSays(RULE);
    const h = triageHarness(vi.fn(async (u: unknown, i: unknown) => { ctl.abort(); return says(u, i); }));
    const t = h.turn("从现在起，回复请控制在三句话以内。", { signal: ctl.signal });
    const outcome = await h.worker.triageTurn(t.input);
    const ids = new IdMap();
    await expect(`${JSON.stringify(projectRun(h.store, t.run_id, outcome, ids), null, 2)}\n`).toMatchFileSnapshot("./__pins__/turn-handler/aborted-during-jev.json");
    h.store.close();
  });

  // The clock mask may only ever cover a case with a prior turn: anything else would hide the Jev request content.
  it("masks state_hash only for prior-turn cases", () => {
    for (const name of CLOCK_CASES) expect(PRIOR_TURN_CASES.has(name)).toBe(true);
  });
});
```

- [ ] **Step 3: Write `tests/core/turn-handler-pin-throws.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdMap, projectRun, treeSays, triageHarness } from "../helpers/triage-harness.js";

// Plan ruling 19 / spec §6.2 step 4 (failure behaviour matches): a throw in the tree policy after Jev answered but before
// today's `held.answered` (core-worker.ts:2782-2786 at 3bff437) settles skipped `error` and drops Jev's answered rows.
// Task 8b moves that call into turn-handler-ladder.ts; this snapshot holds it to today's settle. Its own file because
// vi.mock replaces the module for the whole file.
const fault = vi.hoisted(() => ({ next: false }));
vi.mock("../../src/jev/tree-policy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/jev/tree-policy.js")>();
  return {
    ...real,
    routeTree: (...a: Parameters<typeof real.routeTree>) => {
      if (fault.next) { fault.next = false; throw new Error("policy fault (test)"); }
      return real.routeTree(...a);
    }
  };
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fault.next = false; });

describe("turn.handler pin: a policy throw after Jev answered", () => {
  it("routeTree-throws-after-answer", async () => {
    const h = triageHarness(treeSays());
    const t = h.turn("帮我整理一下这周的待办");
    fault.next = true;
    const outcome = await h.worker.triageTurn(t.input);
    expect(fault.next).toBe(false); // the fault fired: the snapshot is the throw path, not a normal route
    await expect(`${JSON.stringify(projectRun(h.store, t.run_id, outcome, new IdMap()), null, 2)}\n`)
      .toMatchFileSnapshot("./__pins__/turn-handler/routeTree-throws-after-answer.json");
    h.store.close();
  });
});
```

- [ ] **Step 4: Write `tests/core/turn-handler-routed-by.test.ts`**

```ts
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreWorker } from "../../src/core/core-worker.js";
import { RunStore } from "../../src/run/run-store.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp, useFakeOmp } from "../helpers/omp-env.js";
import { ompWorker, until } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { ARM, calibrationFile, cat, treeSays } from "../helpers/triage-harness.js";

// Consumer 11 (spec §5.3): a routed turn's first planner llm_attempt carries routed_by = its jev_verdicts row id — the join
// every precision report reads. The pin sees the route's verdict id; this drives the real supervisor over triageTurn
// (core-worker.ts:2226) so the join itself is checked, before (Task 2) and after (Task 8b) the ladder moves the decision.
pinOmpEnv();
pinEnabledFlags();
let worker: CoreWorker | undefined;
let store: RunStore | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await worker?.shutdownPlanners();
  store?.close();
  cleanup?.();
  worker = undefined; store = undefined; cleanup = undefined;
  vi.unstubAllEnvs();
});

describe("routed_by joins the planner's first model call to the verdict row", () => {
  it("a routed planner turn: the first compose attempt's routed_by is the verdict id; later attempts carry none", async () => {
    const tmp = shortTmp("hrb-");
    cleanup = tmp.cleanup;
    vi.stubEnv("HOUGE_TOMBSTONE_PATH", join(tmp.dir, "houge.kill"));
    vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", calibrationFile()); vi.stubEnv("HOUGE_JEV_GATE", "1"); vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    for (const [k, v] of Object.entries(ARM)) vi.stubEnv(k, v);
    useFakeOmp({ "*": { rpcText: "好的，已整理。" } }, tmp.dir);
    store = RunStore.openInMemory();
    const s = store;
    worker = ompWorker(s, tmp.dir, { jevFetch: treeSays({ category: cat({ other: 0.9 }) }) as unknown as typeof fetch });
    const run = createQueuedTurnRun(s, "帮我整理一下这周的待办");
    worker.submitTurn(run);
    await until(() => s.getRunState(run) === "completed");
    const v = s.getJevVerdictForRun(run);
    expect(v).toMatchObject({ lane: "planner", reason: "routed" });
    const compose = s.getLedgerEvents(run).filter((e) => e.event_type === "llm_attempt" && (e.payload as { role?: string }).role === "compose")
      .map((e) => (e.payload as { routed_by?: string }).routed_by ?? null);
    expect(compose.length).toBeGreaterThan(0);
    expect(compose[0]).toBe(v!.verdict_id);
    expect(compose.slice(1).every((r) => r === null)).toBe(true);
  });
});
```

- [ ] **Step 5: Generate the snapshots on the untouched code**

Run: `git diff --quiet main -- src/core/core-worker.ts src/jev/ && echo CLEAN`
Expected: `CLEAN` (the pin must be written by today's code).
Run: `npx vitest run tests/core/turn-handler-pin.test.ts tests/core/turn-handler-pin-throws.test.ts -u`
Expected: PASS, 41 tests (38 cases, `aborted-during-jev`, the clock-mask check, the throw case), 40 files written under
`tests/core/__pins__/turn-handler/`.
Run: `npx vitest run tests/core/turn-handler-routed-by.test.ts`
Expected: PASS on today's code. If it fails, the fixture is wrong (not the code): fix the test until it passes here,
before any code changes, and say what was fixed in the commit body.

- [ ] **Step 6: Prove the snapshots are deterministic**

Run three times: `CI=1 npx vitest run tests/core/turn-handler-pin.test.ts tests/core/turn-handler-pin-throws.test.ts`
Expected: PASS each time with no snapshot written (`CI=1` makes vitest refuse to write a missing snapshot). If a case
flips between runs, find the field. A live status text is normalised in `runCase` the way `<status text>` is; a
`state_hash` that flips is allowed only for a case in `PRIOR_TURN_CASES` and is added to `CLOCK_CASES`; anything else is
a determinism bug in the harness to fix. Regenerate with `-u`, and name the field and case in the commit body. Then open
four files and check by eye: `status-lane.json` shows `lane: "status"`, `handler_outcome: "lane_reply"`;
`cascade-pick.json` shows `cascade: "tiny"`, `reason: "cascade"`, `cascade_between`; `aborted-during-jev.json` shows no
decision rows and `verdict: null`; `routeTree-throws-after-answer.json` shows one skipped row with `skip_reason: "error"`.

- [ ] **Step 7: Prove the pin bites**

Temporarily change `TREE_BAR_DEFAULTS.choice` in `src/jev/tree-policy.ts:43` from `0.6` to `0.4`, run
`CI=1 npx vitest run tests/core/turn-handler-pin.test.ts`, and expect at least `cascade-pick`, `cascade-failed` and
`cascade-pick-with-rule` to FAIL: their top probability 0.45 now clears the bar, so `routeTree` routes `answer` as a final
route (the answer lane: `reason`, `cascade`, `cascade_between` and the lane change) instead of the cascade. Revert with
`git checkout src/jev/tree-policy.ts` and confirm `git diff --quiet main -- src/jev/ && echo CLEAN`.

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/triage-harness.ts tests/core/turn-handler-pin.test.ts tests/core/turn-handler-pin-throws.test.ts tests/core/turn-handler-routed-by.test.ts tests/core/__pins__/turn-handler
git commit -m "test(core): pin turn.handler behaviour before the decision ladder"
```

Record this commit's sha in the task report as `<task-2 sha>`: Tasks 8b and 13 diff the frozen set against it.

## Task 3: Decision types and the runner (`decideSync`, `decide`)

**Files:**
- Create: `src/decisions/types.ts`
- Create: `src/decisions/entry-ids.ts`
- Create: `src/decisions/decide.ts`
- Test: `tests/decisions/decide.test.ts`

**Interfaces:**
- Consumes: `Question` (`src/jev/questions/types.ts:28`, type only).
- Produces (exact names later tasks import):
  - `types.ts`: `DECISION_STAGES`, `DecisionStage`, `RUNG_KINDS`, `RungKind`, `DecidedBy`, `ArmedMode`, `RecordedArmedMode`, `FALLBACK_REASONS`, `FallbackReason`, `DECISION_SIGNALS`, `DecisionSignal`, `RUNNER_REASON_CODES`, `InputSource`, `EffectKind`, `Announce`, `VerdictEffect`, `ProvisionalBar`, `CalibratedBar`, `BarRef`, `PromptRef`, `RungAnswer<V, D>`, `RungAbstain<V, D>`, `RungFailed<D>`, `RungResult<V, D>`, `RuleRung<S, V, D>`, `JevRung`, `ModelRung`, `PacoRung`, `Rung<S, V, D>`, `Entry<S, V, D>`, `AnyEntry`, `RungOutcome<V, D>`, `DecideResult<V, D>`, `AnyDecideResult`, `DecisionRecorder`, `RungExecutors<S, V, D>`, `DecideCtx<S, V, D>`.
  - `entry-ids.ts`: `ENTRY_IDS`, `LOCKED_ENTRY_IDS`.
  - `decide.ts`: `decideSync<S, V extends string, D = never>(entry: Entry<S, V, D>, s: S, ctx: DecideCtx<S, V, D>): DecideResult<V, D>` and `decide<S, V extends string, D = never>(entry: Entry<S, V, D>, s: S, ctx: DecideCtx<S, V, D>): Promise<DecideResult<V, D>>`. Neither throws for a rung failure; `decideSync` throws only on a non-rule rung (a programming error the registry test prevents).

- [ ] **Step 1: Write `src/decisions/types.ts`**

```ts
import type { Question } from "../jev/questions/types.js";

/**
 * The decision ladder's shapes (ADR 0030, spec §4). One entry per decision; a ladder of deciders tried in order
 * (code rule → Jev → model → Paco); the runner decides, then records. Ids, closed enums and numbers only reach the ledger.
 */
export const DECISION_STAGES = ["intake", "pre_model", "pre_tool", "post_tool", "supervision", "settle", "after_turn"] as const;
export type DecisionStage = (typeof DECISION_STAGES)[number];
export const RUNG_KINDS = ["rule", "jev", "model", "paco"] as const;
export type RungKind = (typeof RUNG_KINDS)[number];
/** The rung a decision names: one of the four, or `fail` when no rung answered and the entry's `fail` verdict stands. */
export type DecidedBy = RungKind | "fail";
/** `shadow` and `off` exist for the runner's input only: R13 forbids them on a registered entry (registry.ts). */
export type ArmedMode = "on" | "shadow" | "off";
/** How a recorded row's non-rule rungs ran; `late` is a verdict that arrived after its caller stopped waiting (stage 2b). */
export type RecordedArmedMode = "on" | "shadow" | "late";
export const FALLBACK_REASONS = ["timeout", "outage", "parse", "threw", "stale_bar", "budget"] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];
/** Spec §7.4's outcome signals, plus `review_ok` (✅ is a label calibration needs). Values are validated per signal in outcomes.ts. */
export const DECISION_SIGNALS = ["correction", "dig_deeper", "review_ok", "review_bad", "review_unsure", "approval_denied", "approval_expired", "rating",
  "settle_sent_back", "planner_failed", "recurrence", "abandoned", "lesson_unfollowed"] as const;
export type DecisionSignal = (typeof DECISION_SIGNALS)[number];
/** Reason codes the runner itself produces; recordable for every entry (record.ts). */
export const RUNNER_REASON_CODES = ["no_executor", "floor_held"] as const;

/** Spec §4.1 (R12): what the entry's judges read. `mixed` is treated as `tool`. */
export type InputSource = "paco" | "tool" | "mixed";
/** What a verdict causes: nothing, a reply, a tightening (withhold, add a tap, send back once), a proposal for Paco's tap, or an effect. */
export type EffectKind = "none" | "reply" | "tighten" | "proposal" | "effect";
/** How Paco learns of it: a code-built card (with its Undo / Dig deeper), the turn's reply, or not at all. */
export type Announce = "card" | "reply" | "none";
/**
 * Spec §4.1 (R12): each verdict's effect, declared. registry.ts `entryProblems` fails a Jev or model rung that can cause an
 * effect that is not reversible or not announced, and anything but `none` / `tighten` / `proposal` over tool input.
 */
export interface VerdictEffect { kind: EffectKind; reversible: boolean; announced: Announce; what?: string }

/** Spec §4.2: a bar from an external measurement, kept in registry code; monotone or fail-open entries only. */
export interface ProvisionalBar { kind: "provisional"; question: string; criteriaHash: string; model: string; p: number; source: string }
/** ADR 0029's calibrated rows (calibration.ts), named by question id; `p` is the entry's single probability bar, when it has one. */
export interface CalibratedBar { kind: "calibrated"; questionIds: readonly string[]; p?: number }
export type BarRef = ProvisionalBar | CalibratedBar;
export interface PromptRef { id: string; version: number }

export interface RungAnswer<V, D = never> { verdict: V; reason?: string; p?: number; detail?: D }
/** "Not mine to decide": the walk goes on. `floor` is the initial monotone verdict (spec §4.1). */
export interface RungAbstain<V, D = never> { abstain: true; floor?: V; reason?: string; detail?: D }
/** A thrown rung, a timeout, an outage: an abstention that names why (`decisions.fallback_reason`). */
export interface RungFailed<D = never> { failed: FallbackReason; reason?: string; detail?: D }
export type RungResult<V, D = never> = RungAnswer<V, D> | RungAbstain<V, D> | RungFailed<D>;

export interface RuleRung<S, V, D = never> { kind: "rule"; name: string; decide: (s: S) => V | RungAnswer<V, D> | RungAbstain<V, D> }
/** `questions`: one Jev call may ask several (turn.handler asks six); `recordedP` names whose p the row records (spec §5.2). */
export interface JevRung { kind: "jev"; name: string; questions: readonly Question[]; bars: BarRef; timeoutMs: number; recordedP?: string }
export interface ModelRung { kind: "model"; name: string; role: "tiny" | "fast"; prompt: PromptRef; timeoutMs: number }
/** Asynchronous; review taps are outcomes, not a rung. */
export interface PacoRung { kind: "paco"; name: string; surface: "card" | "approval" }
export type Rung<S, V, D = never> = RuleRung<S, V, D> | JevRung | ModelRung | PacoRung;

export interface Entry<S, V extends string, D = never> {
  id: string;
  /** Bumped on any wording, rung or bar change. */
  version: number;
  stage: DecisionStage;
  /** What the judges read (R12): Paco's own message, tool-derived input, or both (treated as tool). */
  input: InputSource;
  question: string;
  /** Closed, always including an escape value. */
  verdicts: readonly V[];
  ladder: readonly Rung<S, V, D>[];
  /** What stands when no rung answers (timeout, outage, throw, every rung abstained). */
  fail: V;
  /** Least cautious first; later rungs may only move toward the end. */
  monotone?: { order: readonly V[] };
  locked?: true;
  /** The routine answer: not given a row on its own (spec §5.2). */
  defaultVerdict: V;
  alwaysRecord?: true;
  outcomes: readonly DecisionSignal[];
  /** Every registered entry is armed `on` (R13); the type keeps the runner's modes for tests and for ctx.armed. */
  armed: Partial<Record<RungKind, ArmedMode>>;
  effects: Readonly<Record<V, VerdictEffect>>;
  /** The code-owned reason codes a row may carry (plus RUNNER_REASON_CODES); anything else is recorded as null. */
  reasonCodes: readonly string[];
}
/** Any entry, for the registry and the recorder (a rule's state parameter is contravariant, so `never` accepts all). */
export type AnyEntry = Entry<never, string, unknown>;

/** One rung's turn in the walk; `result: null` = the rung was off and not asked. */
export interface RungOutcome<V, D = never> { kind: RungKind; name: string; mode: ArmedMode; result: RungResult<V, D> | null }
export interface DecideResult<V, D = never> {
  verdict: V;
  rung: DecidedBy;
  p?: number;
  reason: string | null;
  /** The first failure in the walk (null when none failed), and the kind of rung that failed (codex W6). */
  fallbackReason: FallbackReason | null;
  fallbackRung: RungKind | null;
  armedMode: RecordedArmedMode;
  /** The `decisions` row, or null when none was written (routine, or the write failed). */
  decisionId: string | null;
  detail?: D;
  walk: readonly RungOutcome<V, D>[];
  latencyMs: number;
}
export type AnyDecideResult = DecideResult<string, unknown>;

/** Writes the row (or not). Must not throw; the runner still catches, so a recorder bug never changes a decision. */
export interface DecisionRecorder {
  record(entry: AnyEntry, r: AnyDecideResult, ctx: { run_id: string | null; tool_call_id: string | null }): string | null;
}
export interface RungExecutors<S, V, D> {
  jev?: ((rung: JevRung, s: S, prior: readonly RungOutcome<V, D>[]) => Promise<RungResult<V, D>>) | undefined;
  model?: ((rung: ModelRung, s: S, prior: readonly RungOutcome<V, D>[]) => Promise<RungResult<V, D>>) | undefined;
  paco?: ((rung: PacoRung, s: S, prior: readonly RungOutcome<V, D>[]) => Promise<RungResult<V, D>>) | undefined;
}
export interface DecideCtx<S, V, D> {
  run_id: string | null;
  tool_call_id?: string | null | undefined;
  recorder: DecisionRecorder;
  /**
   * Overrides the entry's arming for this call. Only the migrated front door passes it, to keep today's configured
   * `HOUGE_JEV_TRIAGE_ENABLED=shadow` (R13: no off switch, no designed shadow). Ignored for locked entries.
   */
  armed?: Partial<Record<RungKind, ArmedMode>> | undefined;
  exec?: RungExecutors<S, V, D> | undefined;
  clock?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
}
```

- [ ] **Step 2: Write `src/decisions/entry-ids.ts`**

```ts
/**
 * Every registered entry id (registry.ts holds the entries; tests/decisions/registry.test.ts keeps the two equal). A leaf
 * module with no imports, because the store imports it (outcome values, ladder-move refusals).
 */
export const ENTRY_IDS = ["turn.handler", "turn.gear"] as const;

/**
 * Spec §6.1's locked entries (L): no rung added, no ladder move, no off switch. `insertLadderMove` refuses them from
 * stage 1 on, before stages 3 and 4 register them.
 */
export const LOCKED_ENTRY_IDS = ["intake.sender", "intake.budget_fuse", "intake.bare_ack", "posture.kill", "approval.bind", "tool.path",
  "fetch.ssrf", "selfwrite.guard", "tool.wall", "attach.path", "secret.redact", "turn.trust"] as const;
```

- [ ] **Step 3: Write the failing tests `tests/decisions/decide.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { decide, decideSync } from "../../src/decisions/decide.js";
import type { AnyDecideResult, DecisionRecorder, Entry, RungResult } from "../../src/decisions/types.js";

// Spec §4.1 / §5.1: code goes first; a thrown rule, a timeout or an outage is an abstention, so `fail` decides, never an
// accident; a monotone judge can only tighten; a shadow rung (the front door's configured shadow, R13) is asked and never
// applied; recording never changes a decision.
type V = "pass" | "ask" | "deny";
const NO_FX = { kind: "none", reversible: true, announced: "none" } as const;
type S = { rule: V | "abstain" | "throw"; floor?: V };
const recorded: AnyDecideResult[] = [];
const recorder: DecisionRecorder = { record: (_e, r) => { recorded.push(r); return "dec_test"; } };
const rule = (s: S) => {
  if (s.rule === "throw") throw new Error("rule bug");
  if (s.rule === "abstain") return s.floor ? { abstain: true as const, floor: s.floor } : { abstain: true as const };
  return { verdict: s.rule, reason: "code" };
};
function entry(o: Partial<Entry<S, V>> = {}): Entry<S, V> {
  return {
    id: "test.entry", version: 1, stage: "pre_tool", input: "paco", question: "q", verdicts: ["pass", "ask", "deny"],
    ladder: [{ kind: "rule", name: "r", decide: rule }, { kind: "jev", name: "j", questions: [], bars: { kind: "calibrated", questionIds: [], p: 0.5 }, timeoutMs: 50 },
      { kind: "model", name: "m", role: "tiny", prompt: { id: "p", version: 1 }, timeoutMs: 50 }],
    fail: "ask", defaultVerdict: "pass", outcomes: [], armed: { rule: "on", jev: "on", model: "on" },
    effects: { pass: NO_FX, ask: NO_FX, deny: NO_FX }, reasonCodes: ["code", "judge"], ...o
  };
}
const answers = (v: V, p = 0.9) => vi.fn(async (): Promise<RungResult<V>> => ({ verdict: v, p, reason: "judge" }));
const fails = (why: "outage" | "parse") => vi.fn(async (): Promise<RungResult<V>> => ({ failed: why }));

afterEach(() => { recorded.length = 0; vi.useRealTimers(); });

describe("decide: the walk", () => {
  it("a rule answer ends the walk and no judge is asked (code goes first)", async () => {
    const jev = answers("deny");
    const r = await decide(entry(), { rule: "pass" }, { run_id: "run_1", recorder, exec: { jev } });
    expect(r).toMatchObject({ verdict: "pass", rung: "rule", reason: "code", decisionId: "dec_test" });
    expect(jev).not.toHaveBeenCalled();
  });
  it("an abstaining rule reaches the Jev rung (eligible for judging is an abstention, never a pass)", async () => {
    const jev = answers("deny", 0.8);
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { jev } });
    expect(jev).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ verdict: "deny", rung: "jev", p: 0.8, fallbackReason: null, fallbackRung: null });
  });
  it("a failing Jev rung passes to the model; the first failure and its rung kind are recorded (a model answer is not a Jev skip)", async () => {
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { jev: fails("outage"), model: answers("pass") } });
    expect(r).toMatchObject({ verdict: "pass", rung: "model", fallbackReason: "outage", fallbackRung: "jev" });
  });
  it("every rung failing: the entry's fail verdict stands, rung fail", async () => {
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { jev: fails("outage"), model: fails("parse") } });
    expect(r).toMatchObject({ verdict: "ask", rung: "fail", fallbackReason: "outage" });
  });
  it("a thrown rule is an abstention (threw), never a crash; the walk goes on", async () => {
    const log = vi.fn();
    const r = await decide(entry(), { rule: "throw" }, { run_id: null, recorder, log, exec: { jev: answers("deny") } });
    expect(r).toMatchObject({ verdict: "deny", rung: "jev", fallbackReason: "threw", fallbackRung: "rule" });
    expect(log.mock.calls[0]?.[0]).toMatch(/test\.entry rung r threw/);
  });
  it("a hung rung is cut at its timeout (timeout)", async () => {
    vi.useFakeTimers();
    const p = decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { jev: () => new Promise(() => {}), model: answers("pass") } });
    await vi.advanceTimersByTimeAsync(60);
    expect(await p).toMatchObject({ verdict: "pass", rung: "model", fallbackReason: "timeout" });
  });
  it("a verdict outside the closed set is a parse failure, not an answer", async () => {
    const odd = vi.fn(async () => ({ verdict: "maybe" } as unknown as RungResult<V>));
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { jev: odd } });
    expect(r).toMatchObject({ verdict: "ask", rung: "fail", fallbackReason: "parse" });
  });
  it("a rung with no executor is an outage (no_executor), never a silent pass", async () => {
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder });
    expect(r).toMatchObject({ rung: "fail", fallbackReason: "outage", reason: "no_executor" });
  });
  it("later rungs see the earlier outcomes (the cascade reads the tree's plan)", async () => {
    const model = vi.fn(async (_r: unknown, _s: S, prior: readonly { kind: string }[]): Promise<RungResult<V>> => ({ verdict: prior.length === 2 ? "deny" : "pass" }));
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, exec: { jev: fails("outage"), model } });
    expect(r.verdict).toBe("deny");
  });
});

describe("decide: monotone, shadow, locked", () => {
  const mono = (o: Partial<Entry<S, V>> = {}) => entry({ monotone: { order: ["pass", "ask", "deny"] }, ...o });
  // Ruling 17: the floor's verdict is the rule's, so the row must not credit Jev with it (stage 2a calibrates on these rows).
  it("a judge less cautious than the rule's floor cannot loosen it; the floor's rung is named, floor_held, no judge p", async () => {
    const r = await decide(mono(), { rule: "abstain", floor: "ask" }, { run_id: null, recorder, exec: { jev: answers("pass") } });
    expect(r).toMatchObject({ verdict: "ask", rung: "rule", reason: "floor_held" });
    expect(r.p).toBeUndefined();
  });
  it("a judge more cautious than the floor tightens", async () => {
    const r = await decide(mono(), { rule: "abstain", floor: "ask" }, { run_id: null, recorder, exec: { jev: answers("deny") } });
    expect(r.verdict).toBe("deny");
  });
  it("no rung answering on a monotone entry: the more cautious of floor and fail", async () => {
    const r = await decide(mono({ fail: "pass" }), { rule: "abstain", floor: "ask" }, { run_id: null, recorder, exec: { jev: fails("outage"), model: fails("outage") } });
    expect(r).toMatchObject({ verdict: "ask", rung: "fail" });
  });
  it("a shadow rung is asked and recorded, never applied", async () => {
    const jev = answers("deny");
    const r = await decide(entry({ armed: { rule: "on", jev: "shadow", model: "off" } }), { rule: "abstain" }, { run_id: null, recorder, exec: { jev } });
    expect(jev).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ verdict: "ask", rung: "fail", armedMode: "shadow" });
    expect(r.walk.map((o) => [o.kind, o.mode, o.result === null])).toEqual([["rule", "on", false], ["jev", "shadow", false], ["model", "off", true]]);
  });
  it("ctx.armed (the front door's configured shadow) shadows a non-locked entry's judges", async () => {
    const r = await decide(entry(), { rule: "abstain" }, { run_id: null, recorder, armed: { jev: "shadow", model: "shadow" }, exec: { jev: answers("deny"), model: answers("deny") } });
    expect(r).toMatchObject({ verdict: "ask", rung: "fail", armedMode: "shadow" });
  });
  it("a locked entry ignores ctx.armed (no caller can shadow or switch off a locked gate)", () => {
    const locked = entry({ locked: true, ladder: [{ kind: "rule", name: "r", decide: rule }], armed: { rule: "on" } });
    const r = decideSync(locked, { rule: "deny" }, { run_id: null, recorder, armed: { rule: "off" } });
    expect(r).toMatchObject({ verdict: "deny", rung: "rule" });
  });
});

describe("decide: recording never changes a decision", () => {
  it("the recorder sees the final result, after the walk", async () => {
    await decide(entry(), { rule: "abstain" }, { run_id: "run_9", recorder, exec: { jev: answers("deny") } });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ verdict: "deny", rung: "jev" });
  });
  it("a recorder that throws leaves the verdict standing (decisionId null)", async () => {
    const bad: DecisionRecorder = { record: () => { throw new Error("disk full"); } };
    const r = await decide(entry(), { rule: "deny" }, { run_id: null, recorder: bad, log: () => {} });
    expect(r).toMatchObject({ verdict: "deny", rung: "rule", decisionId: null });
  });
});

describe("decideSync", () => {
  it("decides an all-rule ladder synchronously", () => {
    const sync = entry({ ladder: [{ kind: "rule", name: "r", decide: rule }] });
    expect(decideSync(sync, { rule: "abstain" }, { run_id: null, recorder })).toMatchObject({ verdict: "ask", rung: "fail" });
  });
  it("refuses a ladder with a non-rule rung (a hot path must never await)", () => {
    expect(() => decideSync(entry(), { rule: "pass" }, { run_id: null, recorder })).toThrow(/use decide/);
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `npx vitest run tests/decisions/decide.test.ts`
Expected: FAIL (`Cannot find module '../../src/decisions/decide.js'`).

- [ ] **Step 5: Write `src/decisions/decide.ts`**

```ts
import type {
  AnyDecideResult, AnyEntry, ArmedMode, DecideCtx, DecideResult, Entry, FallbackReason, JevRung, ModelRung, PacoRung, RuleRung, RungAnswer,
  RungKind, RungOutcome, RungResult
} from "./types.js";

/**
 * The runner (spec §5.1). Walks the ladder, applies the monotone rule, then records — in that order, so a ledger failure
 * can never change a decision. A thrown rule, a timeout or a missing executor is an abstention that names why.
 */
interface Walk<V, D> {
  outcomes: RungOutcome<V, D>[]; floor: V | undefined; floorRung: RungKind | undefined; fallback: FallbackReason | null; fallbackCode: string | null;
  fallbackRung: RungKind | null; shadowed: boolean;
}
type Decided<V, D> = { rung: RungKind; answer: RungAnswer<V, D> } | null;
const newWalk = <V, D>(): Walk<V, D> => ({ outcomes: [], floor: undefined, floorRung: undefined, fallback: null, fallbackCode: null, fallbackRung: null, shadowed: false });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function decideSync<S, V extends string, D = never>(entry: Entry<S, V, D>, s: S, ctx: DecideCtx<S, V, D>): DecideResult<V, D> {
  const clock = ctx.clock ?? Date.now;
  const started = clock();
  const w = newWalk<V, D>();
  for (const rung of entry.ladder) {
    if (rung.kind !== "rule") throw new Error(`decideSync: ${entry.id} has a ${rung.kind} rung; use decide`);
    const mode = modeOf(entry, rung.kind, ctx);
    if (mode === "off") { w.outcomes.push({ kind: rung.kind, name: rung.name, mode, result: null }); continue; }
    const answer = apply(entry, w, rung.kind, rung.name, mode, safeRule(entry.id, rung, s, ctx));
    if (answer) return record(entry, finish(entry, w, { rung: "rule", answer }, clock() - started), ctx);
  }
  return record(entry, finish(entry, w, null, clock() - started), ctx);
}

export async function decide<S, V extends string, D = never>(entry: Entry<S, V, D>, s: S, ctx: DecideCtx<S, V, D>): Promise<DecideResult<V, D>> {
  const clock = ctx.clock ?? Date.now;
  const started = clock();
  const w = newWalk<V, D>();
  for (const rung of entry.ladder) {
    const mode = modeOf(entry, rung.kind, ctx);
    if (mode === "off") { w.outcomes.push({ kind: rung.kind, name: rung.name, mode, result: null }); continue; }
    const raw = rung.kind === "rule" ? safeRule(entry.id, rung, s, ctx) : await runAsync(entry.id, rung, s, [...w.outcomes], ctx);
    const answer = apply(entry, w, rung.kind, rung.name, mode, raw);
    if (answer) return record(entry, finish(entry, w, { rung: rung.kind, answer }, clock() - started), ctx);
  }
  return record(entry, finish(entry, w, null, clock() - started), ctx);
}

/** A locked entry never reads ctx.armed (spec §4.1); otherwise ctx.armed (the front door's configured shadow) overrides the entry's arming. */
function modeOf<S, V extends string, D>(entry: Entry<S, V, D>, kind: RungKind, ctx: DecideCtx<S, V, D>): ArmedMode {
  if (entry.locked) return entry.armed[kind] ?? "on";
  return ctx.armed?.[kind] ?? entry.armed[kind] ?? "on";
}

function safeRule<S, V extends string, D>(id: string, rung: RuleRung<S, V, D>, s: S, ctx: DecideCtx<S, V, D>): RungResult<V, D> {
  try {
    const out = rung.decide(s);
    return typeof out === "string" ? { verdict: out } : out;
  } catch (e) {
    (ctx.log ?? console.error)(`decisions: ${id} rung ${rung.name} threw: ${message(e)}`);
    return { failed: "threw" };
  }
}

type AsyncRung = JevRung | ModelRung | PacoRung;
function executorFor<S, V, D>(rung: AsyncRung, ctx: DecideCtx<S, V, D>): ((s: S, prior: readonly RungOutcome<V, D>[]) => Promise<RungResult<V, D>>) | undefined {
  const x = ctx.exec;
  if (rung.kind === "jev") return x?.jev ? (s, p) => x.jev!(rung, s, p) : undefined;
  if (rung.kind === "model") return x?.model ? (s, p) => x.model!(rung, s, p) : undefined;
  return x?.paco ? (s, p) => x.paco!(rung, s, p) : undefined;
}

async function runAsync<S, V, D>(id: string, rung: AsyncRung, s: S, prior: readonly RungOutcome<V, D>[], ctx: DecideCtx<S, V, D>): Promise<RungResult<V, D>> {
  const exec = executorFor(rung, ctx);
  if (!exec) return { failed: "outage", reason: "no_executor" };
  const timeoutMs = rung.kind === "paco" ? undefined : rung.timeoutMs;
  try {
    return await withTimeout(exec(s, prior), timeoutMs);
  } catch (e) {
    (ctx.log ?? console.error)(`decisions: ${id} rung ${rung.name} threw: ${message(e)}`);
    return { failed: "threw" };
  }
}

function withTimeout<V, D>(p: Promise<RungResult<V, D>>, ms: number | undefined): Promise<RungResult<V, D>> {
  if (ms === undefined) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<RungResult<V, D>>((resolve) => { timer = setTimeout(() => resolve({ failed: "timeout" }), ms); });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

/** Records the outcome in the walk; returns the answer only when it applies (not shadow, not a failure, not an abstention). */
function apply<S, V extends string, D>(entry: Entry<S, V, D>, w: Walk<V, D>, kind: RungKind, name: string, mode: ArmedMode, raw: RungResult<V, D>): RungAnswer<V, D> | null {
  const result = checked(entry, raw);
  w.outcomes.push({ kind, name, mode, result });
  if (mode === "shadow") { w.shadowed = true; return null; }
  if ("failed" in result) {
    if (w.fallback === null) { w.fallback = result.failed; w.fallbackCode = result.reason ?? null; w.fallbackRung = kind; }
    return null;
  }
  if ("abstain" in result) {
    if (entry.monotone && result.floor !== undefined) {
      const next = cautious(entry, w.floor, result.floor);
      if (next !== w.floor) w.floorRung = kind; // the rung that set the floor (senior re-review S2)
      w.floor = next;
    }
    return null;
  }
  return result;
}

/** A verdict (or floor) outside the entry's closed set is a parse failure, never an answer. */
function checked<S, V extends string, D>(entry: Entry<S, V, D>, r: RungResult<V, D>): RungResult<V, D> {
  if ("verdict" in r && !entry.verdicts.includes(r.verdict)) return { failed: "parse" };
  if ("abstain" in r && r.floor !== undefined && !entry.verdicts.includes(r.floor)) return { failed: "parse" };
  return r;
}

function cautious<S, V extends string, D>(entry: Entry<S, V, D>, a: V | undefined, b: V): V {
  if (a === undefined || !entry.monotone) return b;
  const order = entry.monotone.order;
  return order.indexOf(b) >= order.indexOf(a) ? b : a;
}

function finish<S, V extends string, D>(entry: Entry<S, V, D>, w: Walk<V, D>, d: Decided<V, D>, elapsed: number): DecideResult<V, D> {
  const base = { fallbackReason: w.fallback, fallbackRung: w.fallbackRung, armedMode: w.shadowed ? ("shadow" as const) : ("on" as const), decisionId: null,
    walk: w.outcomes, latencyMs: Math.max(0, Math.round(elapsed)) };
  if (d === null) {
    const verdict = entry.monotone ? cautious(entry, w.floor, entry.fail) : entry.fail;
    return { ...base, verdict, rung: "fail", reason: w.fallbackCode };
  }
  const verdict = entry.monotone ? cautious(entry, w.floor, d.answer.verdict) : d.answer.verdict;
  // ruling 17: the floor held against a looser judge — the verdict is the floor's, so the row names the rung that set it
  if (verdict !== d.answer.verdict) return { ...base, verdict, rung: w.floorRung ?? "rule", reason: "floor_held" };
  return { ...base, verdict, rung: d.rung, reason: d.answer.reason ?? null, ...(d.answer.p !== undefined ? { p: d.answer.p } : {}),
    ...(d.answer.detail !== undefined ? { detail: d.answer.detail } : {}) };
}

function record<S, V extends string, D>(entry: Entry<S, V, D>, r: DecideResult<V, D>, ctx: DecideCtx<S, V, D>): DecideResult<V, D> {
  let decisionId: string | null = null;
  try {
    decisionId = ctx.recorder.record(entry as unknown as AnyEntry, r as unknown as AnyDecideResult, { run_id: ctx.run_id, tool_call_id: ctx.tool_call_id ?? null });
  } catch (e) {
    (ctx.log ?? console.error)(`decisions: ${entry.id} record threw past the recorder: ${message(e)}`);
  }
  return { ...r, decisionId };
}
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run tests/decisions/decide.test.ts && npm run typecheck`
Expected: PASS (19 tests); typecheck clean.

- [ ] **Step 7: Commit (protected dir from Task 7 on)**

```bash
git add src/decisions/types.ts src/decisions/entry-ids.ts src/decisions/decide.ts tests/decisions/decide.test.ts
git commit -m "feat(decisions): entry types and the ladder runner (decide, decideSync)"
```

## Task 4: The store — `decisions`, `decision_outcomes`, `ladder_moves`, the digest latch, two link columns

**Files:**
- Create: `src/decisions/outcomes.ts`
- Modify: `src/run/run-store.ts` — imports (top of file); types and DDL after `VERDICT_PATCH_COLUMNS` (`:965`); `JevDecisionRow` (`:932-940`), `JevVerdictInsert` (`:944-947`), `JevVerdictRow` (`:951-958`); `insertJevDecision` (`:4405-4416`), `insertJevVerdict` (`:4433-4442`); new methods after `latestJevVerdictForChat` (`:4487`); `migrate()` (`:6998`, append one call); new migration after `applyLaneRepliesMigration` (`:7166`)
- Modify: `src/jev/decide.ts:69-78` (`recordSkip`, `persistDecisionRows`)
- Modify: `tests/run/run-store-approvals.test.ts:585-591` (33 → 34)
- Test: `tests/run/decisions-store.test.ts`, `tests/decisions/outcomes.test.ts`

**Interfaces:**
- Consumes: `DECISION_STAGES`, `DECISION_SIGNALS`, `FALLBACK_REASONS`, `RUNG_KINDS`, `DecisionStage`, `DecidedBy`, `DecisionSignal`, `FallbackReason`, `RecordedArmedMode`, `RungKind` (Task 3 `types.ts`); `ENTRY_IDS`, `LOCKED_ENTRY_IDS` (Task 3 `entry-ids.ts`).
- Produces:
  - `outcomes.ts`: `CORRECTION_VALUES`, `DIG_DEEPER_VALUES`, `class OutcomeRejected extends Error`, `checkOutcomeValue(signal: string, value: string | number): string`.
  - `run-store.ts` types: `DecisionInsert` (with `fallback_rung: RungKind | null`), `DecisionRow`, `DecisionOutcomeRow`, `LadderMoveInsert`, `class LadderMoveRefused extends Error { code }`, `class DecisionRejected extends Error { column }`, `DecisionDigestRow`.
  - `RunStore` methods: `insertDecision(d: DecisionInsert): string` (`dec_<uuid>`; throws `DecisionRejected` on a stage or fallback reason outside the TS constant), `getDecision(id): DecisionRow | undefined`, `listDecisionsForRun(run_id): DecisionRow[]`, `listDecisionsBetween(since, until): DecisionRow[]`, `countDecisionFallbacks(entry_id, since, excludeJevRung?): number`, `countDecisionJevSkips(entry_id, since, until): { attempts: number; failed: number }`, `hasJevAnsweredDecisionSince(entry_id, since): boolean`, `insertDecisionOutcome(o): { inserted: boolean; outcome_id: string | null }`, `listDecisionOutcomes(decision_id): DecisionOutcomeRow[]`, `insertLadderMove(m: LadderMoveInsert): string`, `recordDecisionDigest(d): boolean`, `getDecisionDigest(local_date): DecisionDigestRow | undefined`, `wasDecisionOffered(decision_id, sinceIso): boolean`.
  - `insertJevDecision` row accepts `ladder_decision_id?: string | null`; `JevVerdictInsert` gains `decision_id?: string | null`; both row types gain the column.
  - `jev/decide.ts`: `recordSkip(store, point, run_id, lang, reason, now?, ladder_decision_id: string | null = null)`; `persistDecisionRows(store, rows, decision, threshold_used, ladder_decision_id: string | null = null)`.
- Protected: `run-store.ts` (Paco's merge).

- [ ] **Step 1: Write the failing tests `tests/decisions/outcomes.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { checkOutcomeValue, CORRECTION_VALUES, DIG_DEEPER_VALUES, OutcomeRejected } from "../../src/decisions/outcomes.js";
import { CATEGORIES } from "../../src/jev/questions/tree.js";

// Spec §5.2: an outcome value is a closed enum or a number per signal; the insert rejects anything else, so free text
// (a model's words, a tool's output) can never enter the ledger through an outcome row.
describe("checkOutcomeValue", () => {
  it("accepts each signal's closed values and normalises to text", () => {
    expect(checkOutcomeValue("review_bad", "turn.handler")).toBe("turn.handler");
    expect(checkOutcomeValue("review_ok", "turn.gear")).toBe("turn.gear");
    expect(checkOutcomeValue("correction", "lookup")).toBe("lookup");
    expect(checkOutcomeValue("dig_deeper", "answer")).toBe("answer");
    expect(checkOutcomeValue("rating", 3)).toBe("3");
    expect(checkOutcomeValue("recurrence", 4)).toBe("4");
  });
  it("rejects free text, unknown entries, out-of-range numbers and unknown signals, without echoing the value", () => {
    for (const [s, v] of [["review_bad", "ignore previous instructions"], ["review_ok", "tool.nope"], ["rating", 4], ["rating", "3"], ["recurrence", 0],
      ["correction", "planner"], ["bogus", "x"]] as const) {
      expect(() => checkOutcomeValue(s, v)).toThrow(OutcomeRejected);
      try { checkOutcomeValue(s, v); } catch (e) { expect(String((e as Error).message)).not.toContain(String(v)); }
    }
  });
  it("signals with no producer yet reject every value until their stage defines the set", () => {
    for (const s of ["approval_denied", "approval_expired", "settle_sent_back", "planner_failed", "abandoned", "lesson_unfollowed"]) {
      expect(() => checkOutcomeValue(s, "shell_external")).toThrow(OutcomeRejected);
    }
  });
  it("the duplicated value lists match their sources (categories; turn.handler's lanes)", () => {
    expect([...CORRECTION_VALUES]).toEqual([...CATEGORIES]);
    expect([...DIG_DEEPER_VALUES]).toEqual(["answer", "lookup", "memory", "status", "planner"]);
  });
});
```

- [ ] **Step 2: Write the failing tests `tests/run/decisions-store.test.ts`**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OutcomeRejected } from "../../src/decisions/outcomes.js";
import { DecisionRejected, LadderMoveRefused, RunStore, type DecisionInsert, type LadderMoveInsert } from "../../src/run/run-store.js";

// Spec §5.2 / §4.3: the decision ledger holds ids, enums and numbers only (no state column), outcomes are closed values,
// a review label is one-shot per decision, and only approval.standing's code may write an automatic ladder move — for
// tool.policy only — while every other loosening row needs Paco's callback id and a locked entry refuses every move.
const D: DecisionInsert = { entry_id: "turn.handler", entry_version: 1, run_id: "run_1", tool_call_id: null, stage: "pre_model", rung: "jev",
  verdict: "planner", p: 0.62, reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 12,
  created_at: "2026-10-12T10:00:00.000Z" };
const raw = (store: RunStore) => (store as unknown as { db: DatabaseSync }).db;
const MOVE: LadderMoveInsert = { entry_id: "tool.policy", scope: "fp:a0362e7ddf", from_rung: "paco", to_rung: "rule", evidence: ["dec_1", "dec_2", "dec_3"],
  granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true };

describe("decisions", () => {
  it("inserts and reads a row; the table has no state column and no text column beyond the closed values", () => {
    const store = RunStore.openInMemory();
    const id = store.insertDecision(D);
    expect(id).toMatch(/^dec_[0-9a-f-]{36}$/);
    expect(store.getDecision(id)).toMatchObject({ ...D, decision_id: id });
    const cols = raw(store).prepare("PRAGMA table_info(decisions)").all<{ name: string }>().map((c) => c.name);
    expect(cols).toEqual(["decision_id", "entry_id", "entry_version", "run_id", "tool_call_id", "stage", "rung", "verdict", "p", "reason_code",
      "fallback_reason", "fallback_rung", "armed_mode", "latency_ms", "created_at"]);
    store.close();
  });
  // Plan ruling 15 (senior W7): sets a later stage extends are checked in code, so extending one is a constant edit, not
  // the table rebuild stage B's lane widening needed (run-store.ts:7124); sets the spec fixes keep their CHECK.
  it("growing enums are refused in code (DecisionRejected), fixed ones by the schema; no CHECK freezes a growing set", () => {
    const store = RunStore.openInMemory();
    for (const bad of [{ stage: "lunch" }, { fallback_reason: "vibes" }]) {
      expect(() => store.insertDecision({ ...D, ...bad } as DecisionInsert)).toThrow(DecisionRejected);
    }
    for (const bad of [{ rung: "oracle" }, { armed_mode: "maybe" }, { fallback_rung: "oracle" }]) {
      expect(() => store.insertDecision({ ...D, ...bad } as DecisionInsert)).toThrow(/CHECK constraint failed/);
    }
    const sql = Object.fromEntries(raw(store).prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('decisions', 'decision_outcomes')")
      .all<{ name: string; sql: string }>().map((t) => [t.name, t.sql]));
    expect(sql.decisions).not.toMatch(/stage TEXT NOT NULL CHECK|fallback_reason TEXT CHECK/);
    expect(sql.decision_outcomes).not.toMatch(/signal TEXT NOT NULL CHECK/);
    store.close();
  });
  it("fallback and skip counts read fallback_reason and fallback_rung, per entry, in the window", () => {
    const store = RunStore.openInMemory();
    store.insertDecision({ ...D, rung: "fail", fallback_reason: "timeout", fallback_rung: "jev", created_at: "2026-10-12T10:01:00.000Z" });
    store.insertDecision({ ...D, rung: "fail", fallback_reason: "outage", fallback_rung: "jev", created_at: "2026-10-12T10:02:00.000Z" });
    store.insertDecision({ ...D, rung: "fail", fallback_reason: null, armed_mode: "shadow", created_at: "2026-10-12T10:03:00.000Z" });
    store.insertDecision({ ...D, rung: "rule", reason_code: "posture", created_at: "2026-10-12T10:04:00.000Z" });
    store.insertDecision({ ...D, rung: "fail", fallback_reason: "budget", fallback_rung: "jev", created_at: "2026-10-12T10:05:00.000Z" });
    store.insertDecision({ ...D, rung: "fail", fallback_reason: "outage", fallback_rung: "model", reason_code: "cascade_failed", created_at: "2026-10-12T10:05:30.000Z" });
    store.insertDecision({ ...D, entry_id: "turn.gear", rung: "fail", fallback_reason: "timeout", fallback_rung: "jev", created_at: "2026-10-12T10:06:00.000Z" });
    // named, non-budget fails: two on the Jev rung and one cascade failure; with the Jev rung paged elsewhere (ruling 9) only the cascade's
    expect(store.countDecisionFallbacks("turn.handler", "2026-10-12T09:59:00.000Z")).toBe(3);
    expect(store.countDecisionFallbacks("turn.handler", "2026-10-12T09:59:00.000Z", true)).toBe(1);
    // attempts: every non-rule row except a budget skip (state too large is not a Jev call); failed: the silent four, on the Jev rung only
    expect(store.countDecisionJevSkips("turn.handler", "2026-10-12T09:00:00.000Z", "2026-10-12T11:00:00.000Z")).toEqual({ attempts: 4, failed: 2 });
    expect(store.hasJevAnsweredDecisionSince("turn.handler", "2026-10-12T09:00:00.000Z")).toBe(false);
    store.insertDecision({ ...D, created_at: "2026-10-12T10:07:00.000Z" });
    expect(store.hasJevAnsweredDecisionSince("turn.handler", "2026-10-12T10:06:30.000Z")).toBe(true);
    expect(store.listDecisionsBetween("2026-10-12T10:03:30.000Z", "2026-10-12T10:05:00.000Z").map((r) => r.reason_code)).toEqual(["posture", "routed"]);
    store.close();
  });
});

describe("decision_outcomes", () => {
  it("a review label is one-shot per decision; a second (either label) is not inserted", () => {
    const store = RunStore.openInMemory();
    const id = store.insertDecision(D);
    expect(store.insertDecisionOutcome({ decision_id: id, signal: "review_bad", value: "turn.handler", source: "paco" }).inserted).toBe(true);
    expect(store.insertDecisionOutcome({ decision_id: id, signal: "review_ok", value: "turn.handler", source: "paco" })).toEqual({ inserted: false, outcome_id: null });
    expect(store.listDecisionOutcomes(id).map((o) => [o.signal, o.value, o.source])).toEqual([["review_bad", "turn.handler", "paco"]]);
    store.close();
  });
  it("the insert rejects a value outside the signal's closed set and an unknown decision", () => {
    const store = RunStore.openInMemory();
    const id = store.insertDecision(D);
    expect(() => store.insertDecisionOutcome({ decision_id: id, signal: "review_bad", value: "free text", source: "paco" })).toThrow(OutcomeRejected);
    expect(() => store.insertDecisionOutcome({ decision_id: "dec_missing", signal: "review_bad", value: "turn.handler", source: "paco" })).toThrow(/decision_not_found/);
    store.close();
  });
});

describe("ladder_moves (spec §4.3)", () => {
  it("approval.standing may insert an automatic move for tool.policy", () => {
    const store = RunStore.openInMemory();
    expect(store.insertLadderMove(MOVE)).toMatch(/^lm_/);
    store.close();
  });
  it("refuses an automatic move from any other code, for any other entry, a Paco move without a callback id, and every locked entry", () => {
    const store = RunStore.openInMemory();
    const refused = (m: LadderMoveInsert) => { try { store.insertLadderMove(m); return "inserted"; } catch (e) { return e instanceof LadderMoveRefused ? e.code : "other"; } };
    expect(refused({ ...MOVE, granted_via: "improve.route" })).toBe("auto_not_standing");
    expect(refused({ ...MOVE, entry_id: "tool.shell_class" })).toBe("auto_not_standing");
    expect(refused({ ...MOVE, granted_by: "paco", granted_via: null, paco_callback_id: null, entry_id: "tool.injection" })).toBe("paco_needs_callback");
    expect(refused({ ...MOVE, granted_by: "paco", granted_via: null, paco_callback_id: "cb_1", entry_id: "tool.path" })).toBe("locked_entry");
    expect(refused({ ...MOVE, granted_by: "paco", granted_via: null, paco_callback_id: "cb_1", entry_id: "tool.injection" })).toBe("inserted");
    store.close();
  });
  it("one Paco callback authorises one move only (spec §4.3 one-shot, in the schema)", () => {
    const store = RunStore.openInMemory();
    const m: LadderMoveInsert = { ...MOVE, granted_by: "paco", granted_via: null, paco_callback_id: "cb_7", entry_id: "tool.injection" };
    store.insertLadderMove(m);
    expect(() => store.insertLadderMove({ ...m, scope: "fp:other" })).toThrow(/UNIQUE constraint failed/);
    store.close();
  });
});

describe("the digest latch and offers", () => {
  it("one row per local date; offered ids are found within the window only", () => {
    const store = RunStore.openInMemory();
    expect(store.recordDecisionDigest({ local_date: "2026-10-12", sent: true, offered: ["dec_a", "dec_b"], created_at: "2026-10-12T10:00:00.000Z" })).toBe(true);
    expect(store.recordDecisionDigest({ local_date: "2026-10-12", sent: false, offered: [], created_at: "2026-10-12T11:00:00.000Z" })).toBe(false);
    expect(store.getDecisionDigest("2026-10-12")).toMatchObject({ local_date: "2026-10-12", sent: 1, offered: ["dec_a", "dec_b"] });
    expect(store.wasDecisionOffered("dec_b", "2026-10-11T00:00:00.000Z")).toBe(true);
    expect(store.wasDecisionOffered("dec_b", "2026-10-12T10:00:00.000Z")).toBe(false);
    expect(store.wasDecisionOffered("dec_z", "2026-10-11T00:00:00.000Z")).toBe(false);
    store.close();
  });
});

describe("the link columns and the migration", () => {
  it("jev_decisions.ladder_decision_id and jev_verdicts.decision_id are written and indexed", () => {
    const store = RunStore.openInMemory();
    const dec = store.insertDecision(D);
    store.insertJevDecision({ run_id: "run_1", point: "triage", question_id: null, criteria_hash: null, model_reported: null, state_hash: null, lang: "zh",
      answers_json: null, confidence: null, top_prob: null, margin: null, threshold_version: null, threshold_used: null, decision: null, latency_ms: null,
      input_tokens: null, status: "skipped", skip_reason: "transport", ladder_decision_id: dec });
    store.insertJevVerdict({ run_id: "run_1", category: null, breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "planner",
      role: "default", effort: null, cascade: null, save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: "transport",
      quoted_turn_id: null, decision_id: dec });
    expect(store.listJevDecisions("run_1")[0]?.ladder_decision_id).toBe(dec);
    expect(store.getJevVerdictForRun("run_1")?.decision_id).toBe(dec);
    const idx = raw(store).prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('jev_decisions_ladder_idx', 'jev_verdicts_decision_idx')").all();
    expect(idx).toHaveLength(2);
    store.close();
  });
  // The stage B rebuild (2026-10-10-jev-verdicts-lanes) recreates jev_verdicts without the new column when it runs late
  // (tests/run/jev-verdicts-store.test.ts:126 does exactly this): the ladder migration must put the column back on that open.
  it("re-adds the link column after the stage B rebuild recreated jev_verdicts, and one schema_migrations row survives reopen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hdec-")), "h.sqlite");
    RunStore.open(path).close();
    const db = new DatabaseSync(path);
    db.exec(`
      DROP INDEX jev_verdicts_decision_idx;
      DROP TABLE jev_verdicts;
      DELETE FROM schema_migrations WHERE version = '2026-10-10-jev-verdicts-lanes';
      CREATE TABLE jev_verdicts (
        verdict_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, category TEXT, breadth REAL, reasoning REAL, actions REAL, sets_rule REAL, rule_scope TEXT,
        lane TEXT NOT NULL, role TEXT NOT NULL, effort TEXT, model TEXT, cascade TEXT, save_outcome TEXT NOT NULL, route_outcome TEXT NOT NULL,
        handler_outcome TEXT NOT NULL, reason TEXT NOT NULL, skip_reason TEXT, fast_used_tool INTEGER NOT NULL DEFAULT 0, paco_correction TEXT,
        quoted_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );`);
    db.close();
    const store = RunStore.open(path);
    expect(raw(store).prepare("PRAGMA table_info(jev_verdicts)").all<{ name: string }>().some((c) => c.name === "decision_id")).toBe(true);
    expect(raw(store).prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '2026-10-12-decision-ladder'").get<{ n: number }>()?.n).toBe(1);
    store.close();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/decisions/outcomes.test.ts tests/run/decisions-store.test.ts`
Expected: FAIL (`Cannot find module '../../src/decisions/outcomes.js'`; then missing store methods).

- [ ] **Step 4: Write `src/decisions/outcomes.ts`**

```ts
import { ENTRY_IDS } from "./entry-ids.js";
import { DECISION_SIGNALS, type DecisionSignal } from "./types.js";

/**
 * Spec §5.2 / §7.4: each outcome signal's closed value set. The store calls `checkOutcomeValue` before every insert, so no
 * free text reaches `decision_outcomes`. Lists duplicated from other modules are pinned equal by tests/decisions/outcomes.test.ts.
 */
export const CORRECTION_VALUES = ["answer", "lookup", "research", "memory", "self_change", "machine_task", "schedule", "wiki", "mail_calendar",
  "status", "other"] as const;
export const DIG_DEEPER_VALUES = ["answer", "lookup", "memory", "status", "planner"] as const;

export class OutcomeRejected extends Error {}

type Check = (v: string | number) => boolean;
const ids: ReadonlySet<string> = new Set(ENTRY_IDS);
const oneOf = (xs: readonly string[]): Check => (v) => typeof v === "string" && xs.includes(v);
const intIn = (lo: number, hi: number): Check => (v) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const entryId: Check = (v) => typeof v === "string" && ids.has(v);

/** `null`: no producer yet. The stage that adds one defines the set here (a protected edit) and its tests. */
const VALUE_CHECKS: Readonly<Record<DecisionSignal, Check | null>> = {
  correction: oneOf(CORRECTION_VALUES), dig_deeper: oneOf(DIG_DEEPER_VALUES),
  review_ok: entryId, review_bad: entryId, review_unsure: entryId,
  rating: intIn(0, 3), recurrence: intIn(1, 10_000),
  approval_denied: null, approval_expired: null, settle_sent_back: null, planner_failed: null, abandoned: null, lesson_unfollowed: null
};

/** The stored text of a valid value; throws OutcomeRejected otherwise (the message names the signal, never the value). */
export function checkOutcomeValue(signal: string, value: string | number): string {
  if (!(DECISION_SIGNALS as readonly string[]).includes(signal)) throw new OutcomeRejected("unknown outcome signal");
  const check = VALUE_CHECKS[signal as DecisionSignal];
  if (!check || !check(value)) throw new OutcomeRejected(`value not allowed for ${signal}`);
  return String(value);
}
```

- [ ] **Step 5: Modify `src/run/run-store.ts`**

5a. Imports (beside the existing imports at the top):

```ts
import { DECISION_STAGES, FALLBACK_REASONS, RUNG_KINDS } from "../decisions/types.js";
import type { DecidedBy, DecisionSignal, DecisionStage, FallbackReason, RecordedArmedMode, RungKind } from "../decisions/types.js";
import { checkOutcomeValue } from "../decisions/outcomes.js";
import { LOCKED_ENTRY_IDS } from "../decisions/entry-ids.js";
```

5b. `JevDecisionRow` (`:933-940`): add `ladder_decision_id: string | null;` after `state_built_at`. `JevVerdictInsert`
(`:944-947`): add `decision_id?: string | null;` before `created_at?`. `JevVerdictRow` (`:951-958`): add
`decision_id: string | null;` after `quoted_turn_id`.

5c. After `VERDICT_PATCH_COLUMNS` (`:965`), add the decision-ladder types and DDL. Growing enums (`stage`,
`fallback_reason`, outcome `signal`) carry no CHECK and are validated in code (ruling 15); fixed ones keep a CHECK:

```ts
/** One recorded decision (ADR 0030, spec §5.2): ids, closed enums and numbers. No state column, never text. */
export interface DecisionInsert {
  entry_id: string; entry_version: number; run_id: string | null; tool_call_id: string | null; stage: DecisionStage; rung: DecidedBy; verdict: string;
  p: number | null; reason_code: string | null; fallback_reason: FallbackReason | null; fallback_rung: RungKind | null; armed_mode: RecordedArmedMode;
  latency_ms: number; created_at?: string;
}
export type DecisionRow = Omit<DecisionInsert, "created_at"> & { decision_id: string; created_at: string };
export interface DecisionOutcomeRow { outcome_id: string; decision_id: string; signal: DecisionSignal; value: string; source: "paco" | "code"; created_at: string }
/** Spec §4.3. `granted_via`: the code that grants an automatic move (only "approval.standing"); `paco_callback_id`: the tap behind a Paco move. */
export interface LadderMoveInsert {
  entry_id: string; scope: string; from_rung: RungKind; to_rung: RungKind; evidence: string[]; granted_by: "paco" | "auto";
  granted_via: string | null; paco_callback_id: string | null; revocable: boolean; created_at?: string;
}
export class LadderMoveRefused extends Error {
  constructor(readonly code: "locked_entry" | "auto_not_standing" | "paco_needs_callback") { super(`ladder move refused: ${code}`); }
}
export interface DecisionDigestRow { local_date: string; sent: number; offered: string[]; created_at: string }
/** A decision row value outside its code-owned set (ruling 15). The message names the column, never the value. */
export class DecisionRejected extends Error {
  constructor(readonly column: "stage" | "fallback_reason") { super(`decision rejected: ${column} not allowed`); }
}

const sqlList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(", ");
/** The only automatic ladder move the store accepts (spec §4.3): standing approvals, on tool.policy, granted by approval.standing. */
const AUTO_MOVE = { entry_id: "tool.policy", granted_via: "approval.standing" } as const;
const LOCKED: ReadonlySet<string> = new Set(LOCKED_ENTRY_IDS);

const DECISION_LADDER_DDL = `
  CREATE TABLE IF NOT EXISTS decisions (
    decision_id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    entry_version INTEGER NOT NULL,
    run_id TEXT,
    tool_call_id TEXT,
    stage TEXT NOT NULL,
    rung TEXT NOT NULL CHECK (rung IN (${sqlList([...RUNG_KINDS, "fail"])})),
    verdict TEXT NOT NULL,
    p REAL,
    reason_code TEXT,
    fallback_reason TEXT,
    fallback_rung TEXT CHECK (fallback_rung IS NULL OR fallback_rung IN (${sqlList(RUNG_KINDS)})),
    armed_mode TEXT NOT NULL CHECK (armed_mode IN ('on', 'shadow', 'late')),
    latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS decisions_entry_idx ON decisions(entry_id, created_at);
  CREATE INDEX IF NOT EXISTS decisions_run_idx ON decisions(run_id);
  CREATE INDEX IF NOT EXISTS decisions_created_idx ON decisions(created_at);
  CREATE TABLE IF NOT EXISTS decision_outcomes (
    outcome_id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decisions(decision_id),
    signal TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('paco', 'code')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS decision_outcomes_decision_idx ON decision_outcomes(decision_id);
  CREATE UNIQUE INDEX IF NOT EXISTS decision_outcomes_review_once ON decision_outcomes(decision_id)
    WHERE signal IN ('review_ok', 'review_bad', 'review_unsure') AND source = 'paco';
  CREATE TABLE IF NOT EXISTS ladder_moves (
    move_id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    from_rung TEXT NOT NULL CHECK (from_rung IN (${sqlList(RUNG_KINDS)})),
    to_rung TEXT NOT NULL CHECK (to_rung IN (${sqlList(RUNG_KINDS)})),
    evidence_json TEXT NOT NULL,
    granted_by TEXT NOT NULL CHECK (granted_by IN ('paco', 'auto')),
    granted_via TEXT,
    paco_callback_id TEXT,
    revocable INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'ended')),
    created_at TEXT NOT NULL,
    ended_at TEXT,
    CHECK (granted_by = 'auto' OR paco_callback_id IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS ladder_moves_entry_idx ON ladder_moves(entry_id, state);
  CREATE UNIQUE INDEX IF NOT EXISTS ladder_moves_callback_once ON ladder_moves(paco_callback_id) WHERE paco_callback_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS decision_digests (
    local_date TEXT PRIMARY KEY,
    sent INTEGER NOT NULL,
    offered_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`;
```

5d. `insertJevDecision` (`:4405-4416`): extend the row type's optional part with `ladder_decision_id?: string | null`, add
`"ladder_decision_id"` to its `Omit<…>` list, and write the column:

```ts
  insertJevDecision(row: Omit<JevDecisionRow, "decision_id" | "created_at" | "outcome_source" | "outcome_value" | "thread_cut_at" | "state_built_at" | "ladder_decision_id">
    & { created_at?: string; thread_cut_at?: string | null; state_built_at?: string | null; ladder_decision_id?: string | null }): string {
    const decision_id = `jd_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO jev_decisions (decision_id, run_id, point, question_id, criteria_hash, model_reported, state_hash, lang, answers_json, confidence,
        top_prob, margin, threshold_version, threshold_used, decision, latency_ms, input_tokens, status, skip_reason, created_at, thread_cut_at, state_built_at,
        ladder_decision_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(decision_id, row.run_id, row.point, row.question_id, row.criteria_hash, row.model_reported, row.state_hash, row.lang, row.answers_json,
      row.confidence, row.top_prob, row.margin, row.threshold_version, row.threshold_used, row.decision, row.latency_ms, row.input_tokens,
      row.status, row.skip_reason, row.created_at ?? new Date().toISOString(), row.thread_cut_at ?? null, row.state_built_at ?? null,
      row.ladder_decision_id ?? null);
    return decision_id;
  }
```

5e. `insertJevVerdict` (`:4433-4442`): add `decision_id` to the column list, one more `?`, and `i.decision_id ?? null`
after `i.quoted_turn_id`.

5f. After `latestJevVerdictForChat` (`:4487`), add the decision-ladder methods:

```ts
  // ── Decision ladder (ADR 0030, spec §4.3, §5.2) ───────────────────────────

  insertDecision(d: DecisionInsert): string {
    if (!(DECISION_STAGES as readonly string[]).includes(d.stage)) throw new DecisionRejected("stage");
    if (d.fallback_reason !== null && !(FALLBACK_REASONS as readonly string[]).includes(d.fallback_reason)) throw new DecisionRejected("fallback_reason");
    const decision_id = `dec_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO decisions (decision_id, entry_id, entry_version, run_id, tool_call_id, stage, rung, verdict, p, reason_code, fallback_reason,
        fallback_rung, armed_mode, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(decision_id, d.entry_id, d.entry_version, d.run_id, d.tool_call_id, d.stage, d.rung, d.verdict, d.p, d.reason_code, d.fallback_reason,
      d.fallback_rung, d.armed_mode, d.latency_ms, d.created_at ?? new Date().toISOString());
    return decision_id;
  }

  getDecision(decision_id: string): DecisionRow | undefined {
    return this.db.prepare(`SELECT * FROM decisions WHERE decision_id = ?`).get<DecisionRow>(decision_id);
  }

  listDecisionsForRun(run_id: string): DecisionRow[] {
    return this.db.prepare(`SELECT * FROM decisions WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`).all<DecisionRow>(run_id);
  }

  /** Rows created in (since, until], oldest first: the digest's day. */
  listDecisionsBetween(since: string, until: string): DecisionRow[] {
    return this.db.prepare(`SELECT * FROM decisions WHERE created_at > ? AND created_at <= ? ORDER BY created_at ASC, rowid ASC`).all<DecisionRow>(since, until);
  }

  /**
   * `decision_fallback` input (spec §8.2, plan ruling 9): `fail` rows of one entry with a named failure other than `budget`,
   * after `since`. `excludeJevRung`: an entry whose Jev failures already page elsewhere counts only its other rungs' failures.
   */
  countDecisionFallbacks(entry_id: string, since: string, excludeJevRung = false): number {
    return this.db.prepare(`
      SELECT COUNT(*) AS n FROM decisions
      WHERE entry_id = ? AND rung = 'fail' AND fallback_reason IS NOT NULL AND fallback_reason <> 'budget' AND created_at > ?
        AND (? = 0 OR fallback_rung IS NULL OR fallback_rung <> 'jev')
    `).get<{ n: number }>(entry_id, since, excludeJevRung ? 1 : 0)?.n ?? 0;
  }

  /**
   * Per-entry `jev_skip_rate` input (spec §5.2, from `fallback_reason`, not jev_decisions): attempts = rows past the rule
   * rungs except a budget skip (an oversized state is not a Jev call); failed = timeout, outage, parse or threw ON THE JEV
   * RUNG (`fallback_rung`, codex W6: a cascade failure is not a Jev skip).
   */
  countDecisionJevSkips(entry_id: string, since: string, until: string): { attempts: number; failed: number } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN rung <> 'rule' AND (fallback_reason IS NULL OR fallback_reason <> 'budget') THEN 1 ELSE 0 END), 0) AS attempts,
        COALESCE(SUM(CASE WHEN fallback_rung = 'jev' AND fallback_reason IN ('timeout', 'outage', 'parse', 'threw') THEN 1 ELSE 0 END), 0) AS failed
      FROM decisions WHERE entry_id = ? AND created_at > ? AND created_at <= ?
    `).get<{ attempts: number; failed: number }>(entry_id, since, until);
    return row ?? { attempts: 0, failed: 0 };
  }

  /** Whether a Jev or model rung of the entry answered after `since` (what clears a sticky per-entry skip rate). */
  hasJevAnsweredDecisionSince(entry_id: string, since: string): boolean {
    return this.db.prepare(`SELECT 1 AS hit FROM decisions WHERE entry_id = ? AND rung IN ('jev', 'model') AND created_at > ? LIMIT 1`)
      .get<{ hit: number }>(entry_id, since) !== undefined;
  }

  /** A closed outcome value (checkOutcomeValue throws otherwise); a second review label on one decision is not inserted. */
  insertDecisionOutcome(o: { decision_id: string; signal: DecisionSignal; value: string | number; source: "paco" | "code"; created_at?: string }): { inserted: boolean; outcome_id: string | null } {
    const value = checkOutcomeValue(o.signal, o.value);
    if (!this.getDecision(o.decision_id)) throw new Error("decision_not_found");
    const outcome_id = `do_${randomUUID()}`;
    try {
      this.db.prepare(`INSERT INTO decision_outcomes (outcome_id, decision_id, signal, value, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(outcome_id, o.decision_id, o.signal, value, o.source, o.created_at ?? new Date().toISOString());
      return { inserted: true, outcome_id };
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) return { inserted: false, outcome_id: null };
      throw e;
    }
  }

  listDecisionOutcomes(decision_id: string): DecisionOutcomeRow[] {
    return this.db.prepare(`SELECT * FROM decision_outcomes WHERE decision_id = ? ORDER BY created_at ASC, rowid ASC`).all<DecisionOutcomeRow>(decision_id);
  }

  /** Spec §4.3's store-level check, before any write: locked entries refuse; only approval.standing auto-moves tool.policy; Paco's rows carry a callback. */
  insertLadderMove(m: LadderMoveInsert): string {
    if (LOCKED.has(m.entry_id)) throw new LadderMoveRefused("locked_entry");
    if (m.granted_by === "auto" && (m.entry_id !== AUTO_MOVE.entry_id || m.granted_via !== AUTO_MOVE.granted_via)) throw new LadderMoveRefused("auto_not_standing");
    if (m.granted_by === "paco" && !m.paco_callback_id) throw new LadderMoveRefused("paco_needs_callback");
    const move_id = `lm_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO ladder_moves (move_id, entry_id, scope, from_rung, to_rung, evidence_json, granted_by, granted_via, paco_callback_id, revocable, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(move_id, m.entry_id, m.scope, m.from_rung, m.to_rung, JSON.stringify(m.evidence), m.granted_by, m.granted_via, m.paco_callback_id,
      m.revocable ? 1 : 0, m.created_at ?? new Date().toISOString());
    return move_id;
  }

  /** The digest latch (spec §8.1): one row per local date, whether or not a message went out. False when the date already has one. */
  recordDecisionDigest(d: { local_date: string; sent: boolean; offered: string[]; created_at?: string }): boolean {
    const r = this.db.prepare(`INSERT OR IGNORE INTO decision_digests (local_date, sent, offered_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(d.local_date, d.sent ? 1 : 0, JSON.stringify(d.offered), d.created_at ?? new Date().toISOString());
    return Number(r.changes) === 1;
  }

  getDecisionDigest(local_date: string): DecisionDigestRow | undefined {
    const r = this.db.prepare(`SELECT * FROM decision_digests WHERE local_date = ?`).get<Omit<DecisionDigestRow, "offered"> & { offered_json: string }>(local_date);
    return r ? { local_date: r.local_date, sent: r.sent, offered: JSON.parse(r.offered_json) as string[], created_at: r.created_at } : undefined;
  }

  /** A review tap counts only for a decision a digest offered after `sinceIso` (spec §8.1: unknown or stale ids write nothing). */
  wasDecisionOffered(decision_id: string, sinceIso: string): boolean {
    return this.db.prepare(`SELECT 1 AS hit FROM decision_digests d, json_each(d.offered_json) j WHERE j.value = ? AND d.created_at > ? LIMIT 1`)
      .get<{ hit: number }>(decision_id, sinceIso) !== undefined;
  }
```

5g. `migrate()` (`:6998`): append `this.applyDecisionLadderMigration();` after `this.applyLaneRepliesMigration();`.

5h. After `applyLaneRepliesMigration` (`:7166`), add:

```ts
  /**
   * Decision ladder (ADR 0030): the ledger, outcomes, ladder moves and the digest latch, plus the two link columns. The
   * columns are checked on every open, not only once: it runs after the jev_verdicts rebuild above, so a table rebuilt by an
   * older migration gets its column back. FKs are declared for readers; the store never enables PRAGMA foreign_keys.
   */
  private applyDecisionLadderMigration(): void {
    const version = "2026-10-12-decision-ladder";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(DECISION_LADDER_DDL);
      if (!this.tableColumns("jev_decisions").has("ladder_decision_id")) {
        this.db.exec(`ALTER TABLE jev_decisions ADD COLUMN ladder_decision_id TEXT REFERENCES decisions(decision_id)`);
      }
      if (!this.tableColumns("jev_verdicts").has("decision_id")) {
        this.db.exec(`ALTER TABLE jev_verdicts ADD COLUMN decision_id TEXT REFERENCES decisions(decision_id)`);
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS jev_decisions_ladder_idx ON jev_decisions(ladder_decision_id);
        CREATE INDEX IF NOT EXISTS jev_verdicts_decision_idx ON jev_verdicts(decision_id);
      `);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }
```

- [ ] **Step 6: Modify `src/jev/decide.ts:69-78`**

```ts
/** Writes one skipped row (no question, no numbers). Called by the caller after its cancellation check. */
export function recordSkip(store: RunStore, point: DecisionPoint, run_id: string | null, lang: Lang, reason: SkipReason, now?: string,
  ladder_decision_id: string | null = null): void {
  store.insertJevDecision({ run_id, point, question_id: null, criteria_hash: null, model_reported: null, state_hash: null, lang, answers_json: null,
    confidence: null, top_prob: null, margin: null, threshold_version: null, threshold_used: null, decision: null, latency_ms: null, input_tokens: null,
    status: "skipped", skip_reason: reason, ladder_decision_id, ...(now ? { created_at: now } : {}) });
}

/** Inside the caller's transaction: the rows land with their final decision (and the ladder decision they answered), next to the lane's own writes. */
export function persistDecisionRows(store: RunStore, rows: JevDecisionInsert[], decision: "act" | "fallback" | "shadow", threshold_used: string | null,
  ladder_decision_id: string | null = null): string[] {
  return rows.map((r) => store.insertJevDecision({ ...r, decision, threshold_used, ladder_decision_id }));
}
```

- [ ] **Step 7: Update the migration count `tests/run/run-store-approvals.test.ts:585-591`**

Change the comment's list to end `… + lane-replies + decision-ladder.` and both `toBe(33)` to `toBe(34)`.

- [ ] **Step 8: Run**

Run: `npx vitest run tests/decisions/outcomes.test.ts tests/run/decisions-store.test.ts tests/run/ tests/jev/ && npm run typecheck`
Expected: PASS; typecheck clean (the `persistDecisionRows` / `recordSkip` callers compile unchanged thanks to the defaults).

- [ ] **Step 9: Commit (protected: run-store.ts)**

```bash
git add src/decisions/outcomes.ts src/run/run-store.ts src/jev/decide.ts tests/decisions/outcomes.test.ts tests/run/decisions-store.test.ts tests/run/run-store-approvals.test.ts
git commit -m "feat(store): decisions, decision_outcomes, ladder_moves and the digest latch; link jev rows to decisions"
```

## Task 5: The recorder — when a row is written, `decision_record_failed`, `decision_fallback:<entry>`, urgent cards

**Files:**
- Create: `src/decisions/urgent.ts`
- Create: `src/decisions/record.ts`
- Test: `tests/decisions/record.test.ts`

**Interfaces:**
- Consumes: `AnyEntry`, `AnyDecideResult`, `DecisionRecorder`, `RUNNER_REASON_CODES` (Task 3); `RunStore.insertDecision`, `countDecisionFallbacks`, `findOpenIncident`, `findRecentlyResolvedIncident`, `incidentFingerprint`, `resolveIncident`, `enqueueNotification`, `DecisionInsert` (Task 4); `ALERT_REOPEN_QUIET_MS`, `openAlertedIncident`, `resolveOpenIncidents` (`src/run/incident-alert.ts:25, 28, 86`).
- Produces:
  - `urgent.ts`: `interface UrgentCard { chat_id: string; key: string; text: string; buttons?: NotificationButton[] }`, `enqueueUrgentCard(store: RunStore, c: UrgentCard): void`.
  - `record.ts`: `DECISION_FALLBACK_LIMIT = 3`, `DECISION_FALLBACK_WINDOW_MS = 3_600_000`, `JEV_PAGED_ELSEWHERE` (`turn.handler`, `turn.gear`), `shouldRecord(entry: AnyEntry, r: AnyDecideResult): boolean`, `interface RecorderOptions { env?: NodeJS.ProcessEnv; now?: () => string }`, `storeRecorder(store: RunStore, o?: RecorderOptions): DecisionRecorder`, `fallbackCardText(entry_id: string, n: number): string`.
- `storeRecorder(...).record` never throws and opens no transaction, so Task 8b can call it inside `settleTriage`'s transaction.

- [ ] **Step 1: Write the failing tests `tests/decisions/record.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { decide } from "../../src/decisions/decide.js";
import { fallbackCardText, shouldRecord, storeRecorder } from "../../src/decisions/record.js";
import type { AnyDecideResult, AnyEntry, Entry, RungResult } from "../../src/decisions/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec §5.2: a row only when it matters (non-default, beyond the first rule, shadow, Paco, or alwaysRecord), so the ledger
// stays at ~10–15 rows a turn. Spec §4.1: a failed write never changes the decision and opens decision_record_failed.
// Spec §8.2 + plan ruling 9: three named fallbacks of one entry in an hour page once (decision_fallback:<entry>); only a
// judge's answer clears it; a reopen inside the 10-minute quiet window sends no second card; a failure another incident
// already pages (the front door's Jev rung) never pages twice; `budget` is not a failure.
type V = "pass" | "ask";
type S = { v: V | "abstain" };
const FX = { kind: "reply", reversible: true, announced: "card" } as const;
const E: Entry<S, V> = {
  id: "test.judge", version: 3, stage: "pre_model", input: "paco", question: "q", verdicts: ["pass", "ask"],
  ladder: [{ kind: "rule", name: "r", decide: (s) => (s.v === "abstain" ? { abstain: true } : { verdict: s.v, reason: "routed" }) },
    { kind: "jev", name: "j", questions: [], bars: { kind: "calibrated", questionIds: [], p: 0.6 }, timeoutMs: 50 }],
  fail: "pass", defaultVerdict: "pass", outcomes: [], armed: { rule: "on", jev: "on" }, effects: { pass: FX, ask: FX }, reasonCodes: ["routed", "transport"]
};
const any = E as unknown as AnyEntry;
const HANDLER: Entry<S, V> = { ...E, id: "turn.handler",
  ladder: [...E.ladder, { kind: "model", name: "m", role: "tiny", prompt: { id: "p", version: 1 }, timeoutMs: 50 }], armed: { rule: "on", jev: "on", model: "on" } };
const result = (o: Partial<AnyDecideResult>): AnyDecideResult => ({ verdict: "pass", rung: "rule", reason: null, fallbackReason: null, fallbackRung: null,
  armedMode: "on", decisionId: null, walk: [{ kind: "rule", name: "r", mode: "on", result: { verdict: "pass" } }], latencyMs: 1, ...o });
const ENV = { HOUGE_TELEGRAM_CHAT_ID: "555" };
const jevDown = vi.fn(async (): Promise<RungResult<V>> => ({ failed: "outage", reason: "transport" }));
const jevAnswers = vi.fn(async (): Promise<RungResult<V>> => ({ verdict: "pass", reason: "routed" }));
const jevAbstains = vi.fn(async (): Promise<RungResult<V>> => ({ abstain: true }));
const modelDown = vi.fn(async (): Promise<RungResult<V>> => ({ failed: "outage", reason: "transport" }));
const open = (store: RunStore) => store.listOpenIncidents().map((i) => [i.kind, i.subject]);
const cards = (store: RunStore) => [...drainOutbox(store).values()].map((p) => p.text);

afterEach(() => { vi.restoreAllMocks(); });

describe("shouldRecord", () => {
  it("routine: the first rule gave the default verdict, nothing shadowed: no row", () => {
    expect(shouldRecord(any, result({}))).toBe(false);
  });
  it("a row for: a non-default verdict, a judge, a fail, a shadow run, a later rule, alwaysRecord", () => {
    expect(shouldRecord(any, result({ verdict: "ask" }))).toBe(true);
    expect(shouldRecord(any, result({ rung: "jev" }))).toBe(true);
    expect(shouldRecord(any, result({ rung: "fail" }))).toBe(true);
    expect(shouldRecord(any, result({ armedMode: "shadow" }))).toBe(true);
    expect(shouldRecord(any, result({ walk: [{ kind: "rule", name: "a", mode: "on", result: { abstain: true } }, { kind: "rule", name: "b", mode: "on", result: { verdict: "pass" } }] }))).toBe(true);
    expect(shouldRecord({ ...any, alwaysRecord: true }, result({}))).toBe(true);
  });
});

describe("storeRecorder: the row", () => {
  it("writes entry version and stage from the entry, a reason only if the entry or the runner lists it, the failing rung, never state", async () => {
    const store = RunStore.openInMemory();
    const r = await decide(E, { v: "ask" }, { run_id: "run_1", recorder: storeRecorder(store) });
    expect(store.getDecision(r.decisionId!)).toMatchObject({ entry_id: "test.judge", entry_version: 3, stage: "pre_model", rung: "rule", verdict: "ask",
      reason_code: "routed", run_id: "run_1", armed_mode: "on", fallback_rung: null });
    const odd = storeRecorder(store).record(any, result({ verdict: "ask", reason: "free text from somewhere" }), { run_id: null, tool_call_id: null });
    expect(store.getDecision(odd!)?.reason_code).toBeNull();
    const held = storeRecorder(store).record(any, result({ verdict: "ask", reason: "floor_held" }), { run_id: null, tool_call_id: null });
    expect(store.getDecision(held!)?.reason_code).toBe("floor_held");
    const failed = await decide(E, { v: "abstain" }, { run_id: null, recorder: storeRecorder(store), exec: { jev: jevDown } });
    expect(store.getDecision(failed.decisionId!)).toMatchObject({ rung: "fail", fallback_reason: "outage", fallback_rung: "jev" });
    store.close();
  });
  it("a failed write returns null, keeps the verdict, opens decision_record_failed once; the next good write resolves it", async () => {
    const store = RunStore.openInMemory();
    const spy = vi.spyOn(store, "insertDecision").mockImplementation(() => { throw new Error("SQLITE_FULL"); });
    const r = await decide(E, { v: "ask" }, { run_id: null, recorder: storeRecorder(store, { env: ENV }), log: () => {} });
    expect(r).toMatchObject({ verdict: "ask", decisionId: null });
    expect(open(store)).toEqual([["decision_record_failed", "test.judge"]]);
    spy.mockRestore();
    await decide(E, { v: "ask" }, { run_id: null, recorder: storeRecorder(store, { env: ENV }) });
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
});

describe("storeRecorder: decision_fallback (ruling 9)", () => {
  it("three named fallbacks in an hour open decision_fallback:<entry> and send ONE urgent card; a fourth sends nothing more", async () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV });
    for (let k = 0; k < 4; k += 1) await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev: jevDown } });
    expect(open(store)).toEqual([["decision_fallback", "test.judge"]]);
    expect(cards(store)).toEqual([fallbackCardText("test.judge", 3)]);
    store.close();
  });
  it("a rule answer (a photo, an ack) does not clear it; the next Jev or model answer does", async () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV });
    for (let k = 0; k < 3; k += 1) await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev: jevDown } });
    await decide(E, { v: "ask" }, { run_id: null, recorder: rec }); // a rule answered: proves nothing about the judge
    expect(open(store)).toEqual([["decision_fallback", "test.judge"]]);
    await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev: jevAnswers } });
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
  it("a reopen within 10 minutes of resolving records the incident but sends no second card (E12 damping)", async () => {
    const store = RunStore.openInMemory();
    let t = Date.parse("2026-10-12T10:00:00.000Z");
    const rec = storeRecorder(store, { env: ENV, now: () => new Date(t).toISOString() });
    const step = async (jev: () => Promise<RungResult<V>>) => { t += 60_000; await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev } }); };
    for (let k = 0; k < 3; k += 1) await step(jevDown); // pages at 10:03
    await step(jevAnswers);                            // resolved at 10:04
    await step(jevDown);                               // 10:05: four fails in the hour, reopened inside the quiet window
    expect(open(store)).toEqual([["decision_fallback", "test.judge"]]);
    expect(cards(store)).toHaveLength(1);
    store.close();
  });
  it("turn.handler: Jev-rung failures never page here (the Jev incidents do); three cascade failures do", async () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV });
    for (let k = 0; k < 4; k += 1) await decide(HANDLER, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev: jevDown, model: jevAbstains } });
    expect(store.listOpenIncidents()).toEqual([]);
    for (let k = 0; k < 3; k += 1) await decide(HANDLER, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev: jevAbstains, model: modelDown } });
    expect(open(store)).toEqual([["decision_fallback", "turn.handler"]]);
    store.close();
  });
  it("turn.handler: a confident Jev answer does not clear a cascade incident; the next cascade pick does", async () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV });
    const modelPicks = vi.fn(async (): Promise<RungResult<V>> => ({ verdict: "pass", reason: "routed" }));
    for (let k = 0; k < 3; k += 1) await decide(HANDLER, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev: jevAbstains, model: modelDown } });
    await decide(HANDLER, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev: jevAnswers } }); // routed by Jev: proves nothing about the cascade
    expect(open(store)).toEqual([["decision_fallback", "turn.handler"]]);
    await decide(HANDLER, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev: jevAbstains, model: modelPicks } });
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
  it("budget (an oversized state) and a fail with no named failure (shadowed or abstained) are not fallbacks and never page", async () => {
    const store = RunStore.openInMemory();
    const rec = storeRecorder(store, { env: ENV });
    const budget = vi.fn(async (): Promise<RungResult<V>> => ({ failed: "budget", reason: "state_too_large" }));
    for (let k = 0; k < 4; k += 1) await decide(E, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev: budget } });
    const shadow = { ...E, armed: { rule: "on" as const, jev: "shadow" as const } };
    for (let k = 0; k < 4; k += 1) await decide(shadow, { v: "abstain" }, { run_id: null, recorder: rec, exec: { jev: jevDown } });
    expect(store.listOpenIncidents()).toEqual([]);
    store.close();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/decisions/record.test.ts`
Expected: FAIL (`Cannot find module '../../src/decisions/record.js'`).

- [ ] **Step 3: Write `src/decisions/urgent.ts`**

```ts
import type { NotificationButton } from "../notifications/notification-types.js";
import type { RunStore } from "../run/run-store.js";

/**
 * Spec §8.2: an urgent card goes straight to the outbox (the telegram adapter renders it with the rich renderer). The key
 * makes it idempotent: a redelivered event never sends the card twice. Stage 1 sends `decision_fallback:<entry>`; later
 * stages add skill authoring, standing grants, hostile turns and unverified settles.
 */
export interface UrgentCard { chat_id: string; key: string; text: string; buttons?: NotificationButton[] }

export function enqueueUrgentCard(store: RunStore, c: UrgentCard): void {
  store.enqueueNotification({
    target: { kind: "telegram", chat_id: c.chat_id }, intent_type: "progress", idempotency_key: `urgent:${c.key}`, correlation_id: c.key,
    payload: { text: c.text, ...(c.buttons && c.buttons.length > 0 ? { buttons: c.buttons } : {}) }
  });
}
```

- [ ] **Step 4: Write `src/decisions/record.ts`**

```ts
import { ALERT_REOPEN_QUIET_MS, openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { DecisionInsert, RunStore } from "../run/run-store.js";
import { RUNNER_REASON_CODES, type AnyDecideResult, type AnyEntry, type DecisionRecorder } from "./types.js";
import { enqueueUrgentCard } from "./urgent.js";

/** Spec §8.2: an entry falling back to `fail` this many times in this window pages once. */
export const DECISION_FALLBACK_LIMIT = 3;
export const DECISION_FALLBACK_WINDOW_MS = 60 * 60 * 1000;
/**
 * Plan ruling 9: entries whose Jev-rung failures already page through the Jev incidents (openJevIncident and the triage
 * jev_skip_rate). Their Jev failures do not count toward decision_fallback: one call, one page.
 */
export const JEV_PAGED_ELSEWHERE: ReadonlySet<string> = new Set(["turn.handler", "turn.gear"]);
const RECORD_FAILED: ReadonlySet<string> = new Set(["decision_record_failed"]);
const RUNNER_CODES: ReadonlySet<string> = new Set(RUNNER_REASON_CODES);

/** Spec §5.2: a row when the verdict is not the default, a rung past the first rule decided or ran in shadow, Paco took part, or the entry always records. */
export function shouldRecord(entry: AnyEntry, r: AnyDecideResult): boolean {
  if (entry.alwaysRecord || r.verdict !== entry.defaultVerdict || r.armedMode !== "on") return true;
  if (r.rung !== "rule") return true;
  return r.walk.length > 1 || r.walk.some((o) => o.kind === "paco" && o.result !== null);
}

export interface RecorderOptions { env?: NodeJS.ProcessEnv; now?: () => string }

/**
 * The store-backed recorder. Never throws (every failure is logged and becomes an incident) and opens no transaction, so a
 * caller may run it inside its own (Task 8b writes the front door's rows inside settleTriage's).
 */
export function storeRecorder(store: RunStore, o: RecorderOptions = {}): DecisionRecorder {
  return {
    record: (entry, r, ctx) => {
      const now = (o.now ?? (() => new Date().toISOString()))();
      if (clears(entry.id, r)) clearFallback(store, entry.id, now); // only an answer from a rung that counts shows it is back
      if (!shouldRecord(entry, r)) return null;
      let id: string;
      try {
        id = store.insertDecision(rowOf(entry, r, ctx, now));
      } catch (e) {
        recordFailed(store, entry.id, e, o, now);
        return null;
      }
      afterRecord(store, entry.id, r, o, now);
      return id;
    }
  };
}

function rowOf(entry: AnyEntry, r: AnyDecideResult, ctx: { run_id: string | null; tool_call_id: string | null }, now: string): DecisionInsert {
  const known = r.reason !== null && (entry.reasonCodes.includes(r.reason) || RUNNER_CODES.has(r.reason));
  return {
    entry_id: entry.id, entry_version: entry.version, run_id: ctx.run_id, tool_call_id: ctx.tool_call_id, stage: entry.stage, rung: r.rung, verdict: r.verdict,
    p: r.p ?? null, reason_code: known ? r.reason : null, fallback_reason: r.fallbackReason, fallback_rung: r.fallbackRung,
    armed_mode: r.armedMode, latency_ms: r.latencyMs, created_at: now
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function recordFailed(store: RunStore, entry_id: string, e: unknown, o: RecorderOptions, now: string): void {
  console.error(`decisions: ${entry_id} record failed: ${message(e)}`);
  try {
    openAlertedIncident(store, { kind: "decision_record_failed", subject: entry_id, detail: { entry: entry_id }, now, ...(o.env ? { env: o.env } : {}) });
  } catch (e2) {
    console.error(`decisions: decision_record_failed could not open: ${message(e2)}`);
  }
}

/**
 * Senior re-review W1: an answer clears decision_fallback only from a rung whose failures count toward it — any judge for
 * most entries, but only the cascade (model) for an entry whose Jev failures page elsewhere.
 */
function clears(entry_id: string, r: AnyDecideResult): boolean {
  return r.rung === "model" || (r.rung === "jev" && !JEV_PAGED_ELSEWHERE.has(entry_id));
}

/** A named failure that counts toward decision_fallback (ruling 9): not budget, and not a Jev failure another incident pages. */
function countsAsFallback(entry_id: string, r: AnyDecideResult): boolean {
  if (r.rung !== "fail" || r.fallbackReason === null || r.fallbackReason === "budget") return false;
  return !(JEV_PAGED_ELSEWHERE.has(entry_id) && r.fallbackRung === "jev");
}

function afterRecord(store: RunStore, entry_id: string, r: AnyDecideResult, o: RecorderOptions, now: string): void {
  try {
    resolveOpenIncidents(store, RECORD_FAILED, entry_id, now);
    if (!countsAsFallback(entry_id, r)) return;
    const since = new Date(Date.parse(now) - DECISION_FALLBACK_WINDOW_MS).toISOString();
    const n = store.countDecisionFallbacks(entry_id, since, JEV_PAGED_ELSEWHERE.has(entry_id));
    if (n >= DECISION_FALLBACK_LIMIT) pageFallback(store, entry_id, n, o, now);
  } catch (e) {
    console.error(`decisions: ${entry_id} incident bookkeeping failed: ${message(e)}`);
  }
}

/**
 * Opens the row with no generic alert (env {}), then sends the code-built urgent card once per open incident. A reopen
 * within ALERT_REOPEN_QUIET_MS of the last resolve records its row and sends nothing (E12's flap damping, as
 * openAlertedIncident does for its own alert).
 */
function pageFallback(store: RunStore, entry_id: string, n: number, o: RecorderOptions, now: string): void {
  const fingerprint = store.incidentFingerprint("decision_fallback", entry_id);
  const flapping = store.findRecentlyResolvedIncident(fingerprint, new Date(Date.parse(now) - ALERT_REOPEN_QUIET_MS).toISOString()) !== undefined;
  const opened = openAlertedIncident(store, { kind: "decision_fallback", subject: entry_id, detail: { entry: entry_id, limit: DECISION_FALLBACK_LIMIT, window_min: 60 }, env: {}, now });
  if (!opened || flapping) return;
  const chat = (o.env ?? process.env).HOUGE_TELEGRAM_CHAT_ID?.trim();
  const incident = store.findOpenIncident(fingerprint);
  if (chat && incident) enqueueUrgentCard(store, { chat_id: chat, key: `decision_fallback:${incident.incident_id}`, text: fallbackCardText(entry_id, n) });
}

/** Resolves an open decision_fallback on a counting rung's answer, recorded or not (spec §8.2 "the next answered call"). */
function clearFallback(store: RunStore, entry_id: string, now: string): void {
  try {
    const open = store.findOpenIncident(store.incidentFingerprint("decision_fallback", entry_id));
    if (open) store.resolveIncident(open.incident_id, now);
  } catch (e) {
    console.error(`decisions: ${entry_id} fallback resolve failed: ${message(e)}`);
  }
}

export function fallbackCardText(entry_id: string, n: number): string {
  return `⚠️ *${entry_id}* fell back to its fail answer ${n} times in the last hour (no rung answered). Houge keeps working on the fail path; the next answer from the failing rung clears this.`;
}
```

- [ ] **Step 5: Run**

Run: `npx vitest run tests/decisions/ && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/decisions/urgent.ts src/decisions/record.ts tests/decisions/record.test.ts
git commit -m "feat(decisions): the store recorder, decision_record_failed and the decision_fallback card"
```

## Task 6: The registry and the `turn.handler` and `turn.gear` entries (R12 effect tables, R13 arming)

**Files:**
- Create: `src/decisions/entries/turn-handler.ts`
- Create: `src/decisions/entries/turn-gear.ts`
- Create: `src/decisions/registry.ts`
- Test: `tests/decisions/registry.test.ts`, `tests/decisions/turn-handler-entry.test.ts`

**Interfaces:**
- Consumes: Task 3 types (`Entry`, `AnyEntry`, `VerdictEffect`, `EffectKind`), `ENTRY_IDS`, `LOCKED_ENTRY_IDS`; `TREE_QUESTIONS`, `TREE_BREADTH`, `TREE_REASONING`, `TREE_ACTIONS` (`src/jev/questions/tree.ts`); `TREE_BAR_DEFAULTS`, `Lane`, `TurnRole`, `RouteReason` (`src/jev/tree-policy.ts`); `SkipReason` (`src/jev/decide.ts`); `JevTriageMode` (`src/jev/jev-flags.ts`); `TurnModality`.
- Produces:
  - `entries/turn-handler.ts`: `TURN_HANDLER_ID = "turn.handler"`, `type TurnHandlerVerdict = Lane`, `TURN_HANDLER_VERDICTS`, `TURN_HANDLER_EFFECTS`, `ROUTE_REASONS`, `SKIP_REASONS`, `isSkipReason(x: unknown): x is SkipReason`, `interface TurnHandlerState { mode: JevTriageMode; overridden: boolean; posture: string | null; modality: TurnModality; hasTurnState: boolean; isAck: () => boolean }`, `turnHandlerGate(s)`, `TURN_HANDLER: Entry<TurnHandlerState, TurnHandlerVerdict>`.
  - `entries/turn-gear.ts`: `TURN_GEAR_ID = "turn.gear"`, `type TurnGearVerdict = TurnRole`, `interface TurnGearState { role: TurnRole; reason: RouteReason; applied: boolean }`, `turnGearRule(s)`, `TURN_GEAR: Entry<TurnGearState, TurnGearVerdict>`.
  - `registry.ts`: `REGISTRY: readonly AnyEntry[]`, `entryById(id): AnyEntry | undefined`, `entryProblems(e: AnyEntry): string[]`.
- Deleted from Rev 1 by R13: `off-switch.ts`, `effectiveTriageMode`, the boot warning and their tests. No `src/telegram/telegram-daemon.ts` change in this task.

- [ ] **Step 1: Write the failing tests**

`tests/decisions/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ENTRY_IDS, LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { entryById, entryProblems, REGISTRY } from "../../src/decisions/registry.js";
import type { AnyEntry, EffectKind, VerdictEffect } from "../../src/decisions/types.js";

// Spec §4.1 (R12, R13) / §6.3: the registry is a gate. Every entry must be internally sound; what a Jev or model rung may
// cause depends on what it read (over Paco's message: reversible and announced; over tool input: only tighten or propose);
// no entry ships in shadow or off; locked entries carry rule rungs only; a provisional bar sits only on a monotone or
// fail-open entry. A misdeclared entry must FAIL here — that is the whole point of declaring effects as data.
const HANDLER = REGISTRY[0] as AnyEntry;
const base = (o: Partial<AnyEntry>): AnyEntry => ({ ...HANDLER, ...o });
const fx = (kind: EffectKind, reversible = true, announced: VerdictEffect["announced"] = "card"): VerdictEffect => ({ kind, reversible, announced });
const shape = (e: AnyEntry) => Object.fromEntries(Object.entries(e.effects).map(([v, f]) => [v, [f.kind, f.reversible, f.announced]]));

describe("the registry", () => {
  it("holds exactly ENTRY_IDS, once each, and every entry is sound", () => {
    expect(REGISTRY.map((e) => e.id)).toEqual([...ENTRY_IDS]);
    for (const e of REGISTRY) expect([e.id, entryProblems(e)]).toEqual([e.id, []]);
  });
  it("a registered locked entry is listed in LOCKED_ENTRY_IDS (so the store refuses its moves)", () => {
    for (const e of REGISTRY.filter((x) => x.locked)) expect(LOCKED_ENTRY_IDS as readonly string[]).toContain(e.id);
  });
  it("entryById finds turn.handler and turn.gear", () => {
    expect(entryById("turn.handler")?.stage).toBe("pre_model");
    expect(entryById("turn.gear")?.fail).toBe("default");
    expect(entryById("nope")).toBeUndefined();
  });
  it("every registered entry is armed on (R13: no designed shadow or off state)", () => {
    for (const e of REGISTRY) expect([e.id, Object.values(e.armed).every((m) => m === "on")]).toEqual([e.id, true]);
  });
  // R12: the front door's real effects, pinned, so relabelling one away is a visible, reviewed edit. A confident sets_rule
  // saves a lesson first on the answer, lookup and planner routes too (tree-policy.ts:226-237, core-worker.ts:2931-2934),
  // announced today only in the reply; Task 8c (Paco's Q1 ruling) moves them to the Undo card and updates this pin.
  it("turn.handler reads Paco's message and its effect table is exactly today's behaviour", () => {
    expect(HANDLER.input).toBe("paco");
    expect(shape(HANDLER)).toEqual({ answer: ["effect", true, "reply"], lookup: ["effect", true, "reply"], memory: ["effect", true, "card"],
      status: ["reply", true, "card"], planner: ["effect", true, "reply"] });
    expect(entryById("turn.gear")?.input).toBe("paco");
    expect(Object.values(shape(entryById("turn.gear")!)).map((f) => f[0])).toEqual(["none", "none", "none"]);
  });
});

describe("entryProblems (R12 and R13 as data)", () => {
  it("fails a judged entry over Paco's message whose verdict causes an irreversible or unannounced effect", () => {
    expect(entryProblems(base({ effects: { ...HANDLER.effects, memory: fx("effect", false) } })))
      .toContain("a jev/model rung can choose memory, an unannounced or irreversible effect");
    expect(entryProblems(base({ effects: { ...HANDLER.effects, planner: fx("effect", true, "none") } })))
      .toContain("a jev/model rung can choose planner, an unannounced or irreversible effect");
  });
  it("over tool or mixed input anything but none / tighten / proposal fails, even a reversible announced reply", () => {
    expect(entryProblems(base({ input: "tool" }))).toContain("a jev/model rung over tool input can choose answer, which is not tightening");
    expect(entryProblems(base({ input: "mixed" }))).toContain("a jev/model rung over mixed input can choose memory, which is not tightening");
    const kinds: EffectKind[] = ["none", "tighten", "proposal"];
    const passive = Object.fromEntries(HANDLER.verdicts.map((v, k) => [v, fx(kinds[k % 3]!)]));
    expect(entryProblems(base({ input: "tool", effects: passive }))).toEqual([]);
  });
  it("a code-only entry may cause an effect (R12 binds the judges, not code rules)", () => {
    const codeOnly = base({ ladder: [HANDLER.ladder[0]!], armed: { rule: "on" }, effects: { ...HANDLER.effects, memory: fx("effect", false, "none") } });
    expect(entryProblems(codeOnly)).toEqual([]);
  });
  it("fails a missing effect, a shadow or off arming (R13), a locked entry with a judge, and a fail or default outside the verdicts", () => {
    const noMemory = Object.fromEntries(Object.entries(HANDLER.effects).filter(([v]) => v !== "memory"));
    expect(entryProblems(base({ effects: noMemory }))).toContain("no effect declared for memory");
    expect(entryProblems(base({ armed: { rule: "on", jev: "shadow", model: "on" } }))).toContain("entry armed other than on (R13: no designed shadow or off state)");
    expect(entryProblems(base({ locked: true }))).toContain("locked entry with a non-rule rung");
    expect(entryProblems(base({ fail: "nope" }))).toContain("fail not in verdicts");
    expect(entryProblems(base({ defaultVerdict: "nope" }))).toContain("defaultVerdict not in verdicts");
  });
  it("fails a provisional bar on an entry that is neither monotone nor fail-open", () => {
    const ladder = HANDLER.ladder.map((r) => (r.kind === "jev" ? { ...r, bars: { kind: "provisional" as const, question: "q", criteriaHash: "h", model: "m", p: 0.5, source: "mu" } } : r));
    expect(entryProblems(base({ ladder, fail: "answer" }))).toContain("provisional bar on an entry that is neither monotone nor fail-open");
    expect(entryProblems(base({ ladder }))).toEqual([]); // turn.handler is fail-open: fail = default = planner
  });
});
```

`tests/decisions/turn-handler-entry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { decide } from "../../src/decisions/decide.js";
import { TURN_HANDLER, turnHandlerGate, type TurnHandlerState } from "../../src/decisions/entries/turn-handler.js";
import { TURN_GEAR, turnGearRule } from "../../src/decisions/entries/turn-gear.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";

// The gate rule IS today's order of code exits (core-worker.ts:2756-2769): flag off, override, posture, modality, no turn
// state, then the ack rule only when armed. A clean-looking text abstains, so it reaches the Jev rung (spec §4.1 codex B1).
const S: TurnHandlerState = { mode: "arm", overridden: false, posture: null, modality: "text", hasTurnState: true, isAck: () => false };
const recorder: DecisionRecorder = { record: () => null };

describe("turnHandlerGate", () => {
  it("answers each code exit in today's order, with today's skip reason", () => {
    expect(turnHandlerGate({ ...S, mode: "off", overridden: true })).toEqual({ verdict: "planner", reason: "disabled" });
    expect(turnHandlerGate({ ...S, overridden: true, posture: "killed" })).toEqual({ verdict: "planner", reason: "override" });
    expect(turnHandlerGate({ ...S, posture: "killed", modality: "photo" })).toEqual({ verdict: "planner", reason: "posture" });
    expect(turnHandlerGate({ ...S, modality: "photo", hasTurnState: false })).toEqual({ verdict: "planner", reason: "modality" });
    expect(turnHandlerGate({ ...S, hasTurnState: false })).toEqual({ verdict: "planner", reason: "error" });
    expect(turnHandlerGate({ ...S, isAck: () => true })).toEqual({ verdict: "planner", reason: "ack_rule" });
  });
  it("shadow never runs the ack rule (it changes the role), and the ack check runs only after the earlier exits", () => {
    const isAck = vi.fn(() => true);
    expect(turnHandlerGate({ ...S, mode: "shadow", isAck })).toEqual({ abstain: true });
    expect(isAck).not.toHaveBeenCalled();
    turnHandlerGate({ ...S, posture: "killed", isAck });
    expect(isAck).not.toHaveBeenCalled();
  });
  // Plan ruling 19: at 3bff437 a throw while computing the ack check settled skipped `error`; a thrown rule would
  // otherwise be an abstention and hand the turn to Jev — a behaviour change.
  it("a throwing ack check answers planner / error, never the Jev rung's turn", async () => {
    const jev = vi.fn(async () => ({ verdict: "planner" as const, reason: "routed" }));
    const boom = { ...S, isAck: () => { throw new Error("clock"); } };
    expect(turnHandlerGate(boom)).toEqual({ verdict: "planner", reason: "error" });
    const r = await decide(TURN_HANDLER, boom, { run_id: null, recorder, exec: { jev } });
    expect(r).toMatchObject({ rung: "rule", reason: "error" });
    expect(jev).not.toHaveBeenCalled();
  });
  it("an eligible, clean-looking text reaches the Jev rung", async () => {
    const jev = vi.fn(async () => ({ verdict: "planner" as const, reason: "routed" }));
    const r = await decide(TURN_HANDLER, S, { run_id: null, recorder, exec: { jev } });
    expect(jev).toHaveBeenCalledOnce();
    expect(r.rung).toBe("jev");
  });
});

describe("turn.gear", () => {
  it("the rule answers the route's role unless the gear questions were applied; then the Jev rung answers", async () => {
    expect(turnGearRule({ role: "thinking", reason: "routed", applied: false })).toEqual({ verdict: "thinking", reason: "gear_not_applied" });
    expect(turnGearRule({ role: "fast", reason: "routed", applied: true })).toEqual({ abstain: true });
    const r = await decide(TURN_GEAR, { role: "fast", reason: "routed", applied: true }, { run_id: null, recorder, exec: { jev: async () => ({ verdict: "fast" as const, reason: "routed" }) } });
    expect(r).toMatchObject({ verdict: "fast", rung: "jev" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/decisions/registry.test.ts tests/decisions/turn-handler-entry.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Write `src/decisions/entries/turn-handler.ts`**

```ts
import type { SkipReason } from "../../jev/decide.js";
import type { JevTriageMode } from "../../jev/jev-flags.js";
import { TREE_QUESTIONS } from "../../jev/questions/tree.js";
import { TREE_BAR_DEFAULTS, type Lane, type RouteReason } from "../../jev/tree-policy.js";
import type { TurnModality } from "../../media/media-config.js";
import type { Entry, RungAbstain, RungAnswer, VerdictEffect } from "../types.js";

/**
 * `turn.handler` (spec §4.4): which handler takes a Telegram text turn. Ladder: today's code exits and the ack rule →
 * the Jev tree (six questions, one call) → the Tiny cascade below the choice bar; the planner is `fail`. Its judges read
 * Paco's own message, so under R12 a verdict may cause an effect that is reversible and announced: the effect table below
 * declares today's behaviour exactly (move, don't improve). Task 8c (Paco's Q1 ruling) moves every automatic save to the Undo card.
 */
export const TURN_HANDLER_ID = "turn.handler";
export type TurnHandlerVerdict = Lane;
export const TURN_HANDLER_VERDICTS: readonly TurnHandlerVerdict[] = ["answer", "lookup", "memory", "status", "planner"];
export const ROUTE_REASONS = ["routed", "uncalibrated", "below_bar", "bare_ack_guard", "lane_limits", "correction", "cascade", "cascade_failed",
  "ack_rule", "jev_skipped", "two_request"] as const satisfies readonly RouteReason[];
export const SKIP_REASONS = ["no_key", "fused", "auth", "rate_limited", "overloaded", "malformed_question", "timeout", "parse", "transport",
  "state_too_large", "disabled", "posture", "modality", "override", "error", "ack_rule"] as const satisfies readonly SkipReason[];
// Compile-time: the lists above cover their unions exactly (a new reason must be added here, or the build fails).
const ROUTE_COMPLETE: [Exclude<RouteReason, (typeof ROUTE_REASONS)[number]>] extends [never] ? true : false = true;
const SKIP_COMPLETE: [Exclude<SkipReason, (typeof SKIP_REASONS)[number]>] extends [never] ? true : false = true;
void ROUTE_COMPLETE; void SKIP_COMPLETE;

/** Spec §4.1 (R12): what each verdict causes today. tests/decisions/registry.test.ts pins this table. */
export const TURN_HANDLER_EFFECTS: Readonly<Record<TurnHandlerVerdict, VerdictEffect>> = {
  answer: { kind: "effect", reversible: true, announced: "reply",
    what: "answer-lane reply (Dig deeper); on a confident sets_rule the lesson saves first and the card's 📒 line names it, no Undo (until Task 8c)" },
  lookup: { kind: "effect", reversible: true, announced: "reply",
    what: "lookup-lane reply (Dig deeper); on a confident sets_rule the lesson saves first and the card's 📒 line names it, no Undo (until Task 8c)" },
  status: { kind: "reply", reversible: true, announced: "card", what: "status card rendered by code; Dig deeper" },
  memory: { kind: "effect", reversible: true, announced: "card", what: "instant lesson save on a confident sets_rule; memory-lane card with Undo (ADR 0029 §5.5, R12)" },
  planner: { kind: "effect", reversible: true, announced: "reply",
    what: "the planner answers; on a confident sets_rule the lesson saves first and the [memory] note names it in the planner's prompt (planner-supervisor.ts:479; until Task 8c)" }
};

export function isSkipReason(x: unknown): x is SkipReason {
  return typeof x === "string" && (SKIP_REASONS as readonly string[]).includes(x);
}

/** A snapshot for the gate rule. `isAck` is lazy: the tree's clock runs only for a turn that passed the earlier exits (as today). */
export interface TurnHandlerState { mode: JevTriageMode; overridden: boolean; posture: string | null; modality: TurnModality; hasTurnState: boolean; isAck: () => boolean }

/** Today's code exits, in today's order (core-worker.ts:2756-2769 at 3bff437). */
export function turnHandlerGate(s: TurnHandlerState): RungAnswer<TurnHandlerVerdict> | RungAbstain<TurnHandlerVerdict> {
  if (s.mode === "off") return { verdict: "planner", reason: "disabled" };
  if (s.overridden) return { verdict: "planner", reason: "override" };
  if (s.posture !== null) return { verdict: "planner", reason: "posture" };
  if (s.modality !== "text") return { verdict: "planner", reason: "modality" };
  if (!s.hasTurnState) return { verdict: "planner", reason: "error" };
  // shadow never changes behaviour, so the ack rule (which changes the role) acts only when armed
  return s.mode === "arm" ? ackRule(s) : { abstain: true };
}

/** The ack rule. A throw settles skipped `error`, as a throw at that point did at 3bff437 (plan ruling 19), never a judge's turn. */
function ackRule(s: TurnHandlerState): RungAnswer<TurnHandlerVerdict> | RungAbstain<TurnHandlerVerdict> {
  try {
    return s.isAck() ? { verdict: "planner", reason: "ack_rule" } : { abstain: true };
  } catch {
    console.error("triage: ack check threw; settling skipped error");
    return { verdict: "planner", reason: "error" };
  }
}

export const TURN_HANDLER: Entry<TurnHandlerState, TurnHandlerVerdict> = {
  id: TURN_HANDLER_ID, version: 1, stage: "pre_model", input: "paco",
  question: "Which handler takes this Telegram text turn: a no-planner lane, or the planner?",
  verdicts: TURN_HANDLER_VERDICTS,
  ladder: [
    { kind: "rule", name: "gate", decide: turnHandlerGate },
    // The client's own bound is 1.5 s with no retry; this outer bound only stops a hung executor and never fires first.
    { kind: "jev", name: "tree", questions: TREE_QUESTIONS, bars: { kind: "calibrated", questionIds: TREE_QUESTIONS.map((q) => q.id), p: TREE_BAR_DEFAULTS.choice },
      timeoutMs: 10_000, recordedP: "category" },
    // CASCADE_TIMEOUT_MS (20 s) bounds the pick inside the executor; this outer bound sits above it and never fires first.
    { kind: "model", name: "cascade", role: "tiny", prompt: { id: "turn.handler.cascade", version: 1 }, timeoutMs: 25_000 }
  ],
  fail: "planner", defaultVerdict: "planner", alwaysRecord: true,
  outcomes: ["dig_deeper", "correction", "rating", "review_ok", "review_bad", "review_unsure"],
  armed: { rule: "on", jev: "on", model: "on" },
  effects: TURN_HANDLER_EFFECTS,
  reasonCodes: [...ROUTE_REASONS, ...SKIP_REASONS]
};
```

- [ ] **Step 4: Write `src/decisions/entries/turn-gear.ts`**

```ts
import { TREE_ACTIONS, TREE_BREADTH, TREE_REASONING } from "../../jev/questions/tree.js";
import type { RouteReason, TurnRole } from "../../jev/tree-policy.js";
import type { Entry, RungAbstain, RungAnswer, VerdictEffect } from "../types.js";
import { ROUTE_REASONS } from "./turn-handler.js";

/**
 * `turn.gear` (spec §4.4): the planner role this turn runs on, from the same Jev call as `turn.handler`. Stage 1 records it;
 * the planner still pins the route's role, and the two are equal by construction (tests/core/turn-handler-ladder.test.ts).
 * `applied` is true only when the gear questions were armed and the tree (or the cascade) decided the handler. A role
 * causes nothing beyond which model answers (R12 kind `none`).
 */
export const TURN_GEAR_ID = "turn.gear";
export type TurnGearVerdict = TurnRole;
export interface TurnGearState { role: TurnRole; reason: RouteReason; applied: boolean }
const NONE: VerdictEffect = { kind: "none", reversible: true, announced: "none", what: "which planner role answers" };

export function turnGearRule(s: TurnGearState): RungAnswer<TurnGearVerdict> | RungAbstain<TurnGearVerdict> {
  return s.applied ? { abstain: true } : { verdict: s.role, reason: "gear_not_applied" };
}

export const TURN_GEAR: Entry<TurnGearState, TurnGearVerdict> = {
  id: TURN_GEAR_ID, version: 1, stage: "pre_model", input: "paco",
  question: "Which planner role (Fast, Default, Thinking) does this turn run on?",
  verdicts: ["fast", "default", "thinking"],
  ladder: [
    { kind: "rule", name: "route_role", decide: turnGearRule },
    { kind: "jev", name: "tree_gear", questions: [TREE_BREADTH, TREE_REASONING, TREE_ACTIONS], bars: { kind: "calibrated", questionIds: ["breadth", "reasoning", "actions"] },
      timeoutMs: 1_000 }
  ],
  fail: "default", defaultVerdict: "default",
  outcomes: ["correction", "rating", "review_ok", "review_bad", "review_unsure"],
  armed: { rule: "on", jev: "on" },
  effects: { fast: NONE, default: NONE, thinking: NONE },
  reasonCodes: [...ROUTE_REASONS, "gear_not_applied"]
};
```

- [ ] **Step 5: Write `src/decisions/registry.ts`**

```ts
import { TURN_GEAR } from "./entries/turn-gear.js";
import { TURN_HANDLER } from "./entries/turn-handler.js";
import type { AnyEntry, EffectKind } from "./types.js";

/** Every decision on one list (spec §6). Stage 1 registers the front door; later stages add their families. Protected surface (spec §6.3). */
export const REGISTRY: readonly AnyEntry[] = [TURN_HANDLER as unknown as AnyEntry, TURN_GEAR as unknown as AnyEntry];
/** Effects a judge may choose over any input (R12): nothing, a tightening, or a proposal for Paco's tap. */
const PASSIVE: ReadonlySet<EffectKind> = new Set(["none", "tighten", "proposal"]);

export function entryById(id: string): AnyEntry | undefined {
  return REGISTRY.find((e) => e.id === id);
}

/** Spec §4.1 as data: what is wrong with an entry (empty = sound). tests/decisions/registry.test.ts asserts it for every entry. */
export function entryProblems(e: AnyEntry): string[] {
  return [...shapeProblems(e), ...effectProblems(e)];
}

function shapeProblems(e: AnyEntry): string[] {
  const p: string[] = [];
  const has = (v: string): boolean => e.verdicts.includes(v);
  if (!has(e.fail)) p.push("fail not in verdicts");
  if (!has(e.defaultVerdict)) p.push("defaultVerdict not in verdicts");
  if (e.ladder.length === 0) p.push("empty ladder");
  if (e.monotone && [...e.monotone.order].sort().join() !== [...e.verdicts].sort().join()) p.push("monotone order is not the verdict set");
  if (Object.values(e.armed).some((m) => m !== "on")) p.push("entry armed other than on (R13: no designed shadow or off state)");
  if (e.locked && e.ladder.some((r) => r.kind !== "rule")) p.push("locked entry with a non-rule rung");
  const provisional = e.ladder.some((r) => r.kind === "jev" && r.bars.kind === "provisional");
  if (provisional && !e.monotone && e.fail !== e.defaultVerdict) p.push("provisional bar on an entry that is neither monotone nor fail-open");
  return p;
}

/**
 * R12: a verdict a Jev or model rung can choose may, over tool (or mixed) input, only tighten or propose; over Paco's own
 * message it may cause a reply or an effect only when reversible and announced. Code-only entries are not bound.
 * `announced: "reply"` is accepted only until Task 8c, which removes it (Paco's Q1 ruling: announced means a card with Undo).
 */
function effectProblems(e: AnyEntry): string[] {
  const p: string[] = [];
  const judged = e.ladder.some((r) => r.kind === "jev" || r.kind === "model");
  for (const v of e.verdicts) {
    const fx = e.effects[v];
    if (fx === undefined) { p.push(`no effect declared for ${v}`); continue; }
    if (!judged || PASSIVE.has(fx.kind)) continue;
    if (e.input !== "paco") p.push(`a jev/model rung over ${e.input} input can choose ${v}, which is not tightening`);
    else if (!fx.reversible || fx.announced === "none") p.push(`a jev/model rung can choose ${v}, an unannounced or irreversible effect`);
  }
  return p;
}
```

- [ ] **Step 6: Run**

Run: `npx vitest run tests/decisions/ && npm run typecheck`
Expected: PASS; typecheck clean (the two `*_COMPLETE` constants compile only while the lists cover their unions).
Run: `grep -rn "HOUGE_DECISIONS_OFF\|off-switch" src/ tests/`
Expected: no output (R13).

- [ ] **Step 7: Commit**

```bash
git add src/decisions/entries/turn-handler.ts src/decisions/entries/turn-gear.ts src/decisions/registry.ts tests/decisions/registry.test.ts tests/decisions/turn-handler-entry.test.ts
git commit -m "feat(decisions): registry with turn.handler and turn.gear; R12 effect tables and R13 arming as data"
```

## Task 7: `src/decisions/` joins the protected surface

**Files:**
- Modify: `src/capabilities/self-write-guard.ts:67-73` (`PROTECTED_DIRS`)
- Test: `tests/capabilities/self-write-guard.test.ts:109-140` (the `protectedHits` table) and one new `it`

**Interfaces:**
- Consumes: `checkSelfWriteDiff`, `PROTECTED_DIRS`.
- Produces: `PROTECTED_DIRS` includes `"src/decisions"`. Protected: `self-write-guard.ts` (Paco's merge; the guard cannot edit itself).

- [ ] **Step 1: Write the failing test**

Add to the `protectedHits` array (after the `"src/omp"`-era entries, before `".github dir"`):

```ts
    ["decisions registry dir (spec §6.3: the registry decides the gates)", entry({ status: "M", path: "src/decisions/registry.ts" })],
```

and after the `"even ADDING into a protected dir is denied"` test (`:154-156`) add:

```ts
  // Spec §6.3: if the registry decides the gates, editing it can open a gate, so a self-write may not add an entry,
  // change a rung or move a bar — under any path spelling.
  it("denies adding a new decision entry and a disguised path into src/decisions", () => {
    expect(check(entry({ status: "A", path: "src/decisions/entries/tool-policy.ts", oldMode: "000000" })).allowed).toBe(false);
    expect(check(entry({ status: "M", path: "./src/decisions/decide.ts" })).allowed).toBe(false);
    expect(check(entry({ status: "M", path: "src/core/../decisions/record.ts" })).allowed).toBe(false);
    expect(check(entry({ status: "M", path: "src/decisionsmore.ts" }))).toEqual({ allowed: true }); // segment-precise
  });
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/capabilities/self-write-guard.test.ts`
Expected: FAIL (`denies decisions registry dir`, `denies adding a new decision entry…`).

- [ ] **Step 3: Add the directory**

In `PROTECTED_DIRS` (`src/capabilities/self-write-guard.ts:67-73`), after the `"src/omp"` line:

```ts
  "src/decisions", // decision ladder (ADR 0030, spec §6.3): the registry, runner and recorder decide the gates — Paco's hand only
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/capabilities/self-write-guard.test.ts tests/capabilities/self-write-guard-adversarial.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (protected)**

```bash
git add src/capabilities/self-write-guard.ts tests/capabilities/self-write-guard.test.ts
git commit -m "feat(guard): src/decisions joins the protected surface"
```

## Task 8a: The pure glue for `turn.handler`'s rungs (`src/core/turn-handler-ladder.ts`, no `core-worker.ts` edit)

The pure half of the move (spec §6.2 "wrap"): today's policy calls, unchanged, shaped as rung results. This task touches
no existing file except by adding the new module and its tests, so it can be reviewed on its own; 8b wires it in.

**Files:**
- Create: `src/core/turn-handler-ladder.ts`
- Test: `tests/core/turn-handler-ladder-glue.test.ts`

**Interfaces:**
- Consumes: `RungResult`, `DecideResult`, `RungOutcome`, `FallbackReason` (Task 3); `isSkipReason`, `TurnHandlerVerdict` (Task 6); `routeTree`, `treeArmed`, `TREE_BAR_DEFAULTS`, `Armed`, `LaneSwitch`, `Route`, `RoutePlan` (`src/jev/tree-policy.ts`); `topProbOf`, `Decision`, `SkipReason` (`src/jev/decide.ts`); `isBareAck`; `CalibrationRow`; `Lang`; `JevTriageMode`; the Task 2 harness's `cat` (tests only).
- Produces: `type AnsweredDecision = Extract<Decision, { status: "answered" }>`; `interface TreeDetail { d: AnsweredDecision; armed: Armed; plan?: RoutePlan; route?: Route; error?: string }`; `UNARMED: Armed`; `urlRule(route, text, unlaned): Route` (moved verbatim from `core-worker.ts:4055-4065`; 8b deletes the original); `fallbackOfSkip(reason: SkipReason): FallbackReason`; `interface PlanInput`; `planTree(d, i: PlanInput): RungResult<TurnHandlerVerdict, TreeDetail>`; `treeDetailOf(r): TreeDetail | undefined`; `jevSkipReason(r): SkipReason`.

- [ ] **Step 1: Write the failing tests `tests/core/turn-handler-ladder-glue.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { fallbackOfSkip, jevSkipReason, planTree, treeDetailOf, urlRule, type AnsweredDecision, type PlanInput } from "../../src/core/turn-handler-ladder.js";
import type { DecideResult } from "../../src/decisions/types.js";
import { fallbackRoute } from "../../src/jev/tree-policy.js";
import { cat } from "../helpers/triage-harness.js";

// Spec §6.2 "wrap": the pure half of turn.handler's rungs reproduces today's policy calls exactly, including where a
// failure lands. Plan ruling 19: a throw before today's held.answered (arming, routeTree) fails with NO detail, so the turn
// settles skipped `error` and Jev's rows are dropped, as at 3bff437; only a throw after it keeps the detail.
const answered = (category = cat({ other: 0.9 })) => ({ status: "answered", model: "jev-1.13.0", answers: { category }, rows: [] }) as unknown as AnsweredDecision;
const input = (o: Partial<PlanInput> = {}): PlanInput => ({ userText: "帮我整理一下这周的待办", mode: "shadow", lang: "zh", thinkHarder: false, rows: [], lanesOff: new Set(), ...o });

describe("the pure glue", () => {
  it("fallbackOfSkip maps every Jev skip to a closed fallback reason", () => {
    expect([fallbackOfSkip("timeout"), fallbackOfSkip("parse"), fallbackOfSkip("malformed_question"), fallbackOfSkip("state_too_large"), fallbackOfSkip("transport"),
      fallbackOfSkip("rate_limited"), fallbackOfSkip("no_key")]).toEqual(["timeout", "parse", "parse", "budget", "outage", "outage", "outage"]);
  });
  it("treeDetailOf prefers the cascade's detail; jevSkipReason reads the tree rung's reason, else error", () => {
    const d = { status: "answered" } as never;
    const r = { walk: [{ kind: "jev", name: "tree", mode: "on", result: { abstain: true, detail: { d, armed: {} } } },
      { kind: "model", name: "cascade", mode: "on", result: { verdict: "planner", detail: { d, armed: {}, route: fallbackRoute("cascade", false) } } }] } as unknown as DecideResult<"planner", never>;
    expect(treeDetailOf(r as never)?.route?.reason).toBe("cascade");
    const skip = { walk: [{ kind: "jev", name: "tree", mode: "on", result: { failed: "outage", reason: "transport" } }] } as unknown as DecideResult<"planner", never>;
    expect([jevSkipReason(skip as never), jevSkipReason({ walk: [] } as never)]).toEqual(["transport", "error"]);
  });
  it("urlRule moved verbatim: a lookup naming a URL becomes the planner (lane_limits)", () => {
    const lookup = { ...fallbackRoute("routed", false), lane: "lookup" as const, category: "lookup" as const };
    expect(urlRule(lookup, "see https://example.com", () => ({ kind: "final", route: fallbackRoute("routed", false) })).reason).toBe("lane_limits");
    expect(urlRule(lookup, "no link here", () => { throw new Error("not called"); })).toBe(lookup);
  });
  it("planTree in shadow arms nothing: the planner, uncalibrated, p = the category's top probability (today's shadow route)", () => {
    const r = planTree(answered(), input());
    expect(r).toMatchObject({ verdict: "planner", reason: "uncalibrated", p: 0.9 });
    expect("detail" in r && r.detail?.route?.reason).toBe("uncalibrated");
  });
  it("planTree: a throw while arming fails with no detail (skipped error, Jev's rows dropped, as at 3bff437)", () => {
    const r = planTree(answered(), input({ mode: "arm", rows: null as never })); // treeArmed reads rows.some → TypeError
    expect(r).toEqual({ failed: "threw", reason: "error" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/core/turn-handler-ladder-glue.test.ts`
Expected: FAIL (`Cannot find module '../../src/core/turn-handler-ladder.js'`).

- [ ] **Step 3: Write `src/core/turn-handler-ladder.ts`**

```ts
import type { CalibrationRow } from "../jev/calibration.js";
import { topProbOf, type Decision, type SkipReason } from "../jev/decide.js";
import type { JevTriageMode } from "../jev/jev-flags.js";
import type { Lang } from "../jev/intent-question.js";
import { routeTree, TREE_BAR_DEFAULTS, treeArmed, type Armed, type LaneSwitch, type Route, type RoutePlan } from "../jev/tree-policy.js";
import { isBareAck } from "../omp/bare-ack.js";
import { isSkipReason, type TurnHandlerVerdict } from "../decisions/entries/turn-handler.js";
import type { DecideResult, FallbackReason, RungOutcome, RungResult } from "../decisions/types.js";

/**
 * The pure half of `turn.handler`'s rungs (spec §4.4, §6.2 "wrap"): today's policy calls, unchanged, shaped as rung
 * results. `CoreWorker` owns the I/O half (the Jev call, the cascade call) and every handler after the decision. Not under
 * the protected src/decisions/ (ADR 0030 consequences): the entry is protected, this glue is as self-writable as tree-policy.ts.
 */
export type AnsweredDecision = Extract<Decision, { status: "answered" }>;
/** What the tree rung hands the cascade rung and the handlers: Jev's answer and rows, the arming, the plan, the route. */
export interface TreeDetail { d: AnsweredDecision; armed: Armed; plan?: RoutePlan; route?: Route; error?: string }
export const UNARMED: Armed = { category: false, status: false, memory: false, gear: false, rule: false, answer: false, lookup: false };
const URL_IN_TEXT = /https?:\/\//i;
type TreeOpts = Omit<Parameters<typeof routeTree>[1], "armed">;

/**
 * Stage B §2's one code rule: a lookup naming a URL is the planner's (its http_fetch path can read a named page; the lane
 * cannot from a one-line query). The route is the policy's own with the lookup lane unarmed (the gear's role), relabelled.
 */
export function urlRule(route: Route, text: string, unlaned: () => RoutePlan): Route {
  if (route.lane !== "lookup" || !URL_IN_TEXT.test(text)) return route;
  const p = unlaned();
  return p.kind === "final" ? { ...p.route, reason: "lane_limits" } : { ...route, lane: "planner", reason: "lane_limits" };
}

/** A Jev skip as the ledger's closed fallback reason; the skip reason itself stays the row's reason code. */
export function fallbackOfSkip(reason: SkipReason): FallbackReason {
  if (reason === "timeout") return "timeout";
  if (reason === "parse" || reason === "malformed_question") return "parse";
  if (reason === "state_too_large") return "budget";
  return "outage";
}

export interface PlanInput { userText: string; mode: JevTriageMode; lang: Lang; thinkHarder: boolean; rows: readonly CalibrationRow[]; lanesOff: ReadonlySet<LaneSwitch> }

/**
 * Jev answered: arming, routeTree, urlRule — today's routeAnswered head (core-worker.ts:2782-2792 at 3bff437). Below the bar
 * it abstains with the plan. Ruling 19: a throw in arming or routeTree happened BEFORE today's `held.answered`, so it fails
 * with no detail (skipped `error`); a throw in urlRule happened after it, so it keeps the detail (the answered fallback).
 */
export function planTree(d: AnsweredDecision, i: PlanInput): RungResult<TurnHandlerVerdict, TreeDetail> {
  let opts: TreeOpts;
  let armed: Armed;
  let plan: RoutePlan;
  try {
    opts = { bars: TREE_BAR_DEFAULTS, thinkHarder: i.thinkHarder, bareAck: isBareAck(i.userText) };
    armed = i.mode === "arm" ? treeArmed(i.lang, d.model, i.rows, i.lanesOff) : UNARMED; // d.model: the REPORTED id
    plan = routeTree(d.answers, { ...opts, armed });
  } catch {
    return { failed: "threw", reason: "error" };
  }
  if (plan.kind === "cascade") return { abstain: true, detail: { d, armed, plan } };
  return routed(d, i.userText, armed, plan, opts);
}

/** A final plan through urlRule (today: after held.answered, so a throw keeps Jev's answer for the answered fallback). */
function routed(d: AnsweredDecision, text: string, armed: Armed, plan: Extract<RoutePlan, { kind: "final" }>, opts: TreeOpts): RungResult<TurnHandlerVerdict, TreeDetail> {
  let route: Route;
  try {
    route = urlRule(plan.route, text, () => routeTree(d.answers, { ...opts, armed: { ...armed, lookup: false } }));
  } catch (e) {
    return { failed: "threw", reason: "error", detail: { d, armed, plan, error: e instanceof Error ? e.message : String(e) } };
  }
  const category = d.answers.category;
  return { verdict: route.lane, reason: route.reason, ...(category ? { p: topProbOf(category) } : {}), detail: { d, armed, plan, route } };
}

function detailOf(r: RungResult<TurnHandlerVerdict, TreeDetail> | null | undefined): TreeDetail | undefined {
  return r && "detail" in r ? r.detail : undefined;
}

/** The detail the handlers need: the cascade's (it carries the picked route) when it ran, else the tree's. */
export function treeDetailOf(r: DecideResult<TurnHandlerVerdict, TreeDetail>): TreeDetail | undefined {
  const walk: readonly RungOutcome<TurnHandlerVerdict, TreeDetail>[] = r.walk;
  return detailOf(walk.find((o) => o.kind === "model")?.result) ?? detailOf(walk.find((o) => o.kind === "jev")?.result);
}

/** Why the tree gave no answer, as today's skip reason (`error` when it threw or was never reached). */
export function jevSkipReason(r: DecideResult<TurnHandlerVerdict, TreeDetail>): SkipReason {
  const res = r.walk.find((o) => o.kind === "jev")?.result;
  return res && "failed" in res && isSkipReason(res.reason) ? res.reason : "error";
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/core/turn-handler-ladder-glue.test.ts && npm run typecheck`
Expected: PASS (5 tests); typecheck clean (`core-worker.ts` still has its own `urlRule`/`UNARMED` until 8b; nothing imports the new module yet).

- [ ] **Step 5: Commit**

```bash
git add src/core/turn-handler-ladder.ts tests/core/turn-handler-ladder-glue.test.ts
git commit -m "feat(core): turn.handler rung glue (policy calls as rung results)"
```

## Task 8b: Move `turn.handler` and `turn.gear` onto the registry (move, don't improve)

The decision moves behind the runner; every handler (status lane, save-first, memory card, answer/lookup lanes, settle,
`laneLost`, the catch's answered fallback) stays as it is. The front door's ledger rows are queued at decide time and
written inside `settleTriage`'s transaction (plan ruling 14). The Task 2 pin is the differential: it must pass with no
snapshot written and no change to the frozen set. Protected for Paco's merge (spec §13 row 1: core-worker).

**Exit-by-exit trace (the reviewer checks each row against the code):**

| Exit | 3bff437 settle | Ladder path in 8b |
|---|---|---|
| flag off | `triageOff` (skipped `disabled`, no route, no gear) | gate `disabled` → `gateExit` → `triageOff` |
| override / posture / modality / no state | `triageSkip(<reason>)` | gate answers the reason → `gateExit` → gear by rule → `triageSkip` |
| ack rule (arm) | `triageSkip("ack_rule", ACK_ROUTE)` | gate `ack_rule` → `gateExit` → `ACK_ROUTE` |
| ack check throws | catch → skipped `error` | gate `error` (ruling 19) → `triageSkip("error")` |
| state too large / any Jev skip | `triageSkip(<skip>)` | tree rung `failed` with the skip as reason → no detail → `triageSkip(jevSkipReason)` |
| `calibrationRows` / arming / `routeTree` throws | catch → skipped `error`, Jev's rows dropped | `planTree` (or the rung) fails with no detail → `triageSkip("error")` |
| `urlRule` throws | catch → answered `fallback` | `planTree` fails with detail → `routeAnswered` sets `held.answered`, rethrows → catch → answered `fallback` |
| shadow (configured) | `routeAnswered` with `UNARMED` → `uncalibrated`, decision `shadow` | `TREE_SHADOWED`: tree asked, not applied; cascade rung abstains (no cascade plan when unarmed) → rung `fail` with the tree's detail → `routeAnswered` |
| routed / status / answer / lookup / memory / save-first | `routeAnswered` handlers | `routeDecided` → `routeAnswered(det)` → the same handlers |
| cascade pick / no pick | `cascadeRoute` after `cascadePick` | model rung picks (or fails with the `cascade_failed` route in its detail) → `cascadeRoute(det.route)` |
| lost turn (abort, state replaced) | `settleTriage` returns null, nothing written | same; the queued ladder rows are never written (ruling 14) |

**Files:**
- Modify: `src/core/core-worker.ts` — imports (`:142-153`); `TriageHeld` (`:267`) unchanged, module-level declarations after it; delete `UNARMED` (`:270`, moved); new fields after `ompTurns` (`:496`); `settleTriage` (`:2681-2700`); replace `triageTurn` … `checkJevModel` (`:2728-2803`); `cascadeRoute` and `cascadePick` (`:2876-2908`); delete `URL_IN_TEXT` and `urlRule` (`:4055-4065`, moved in 8a)
- Test: `tests/core/turn-handler-ladder.test.ts`; re-run the frozen Task 2 set and every consumer suite

**Interfaces:**
- Consumes: `decide` as `decideLadder` (Task 3); `AnyEntry`, `AnyDecideResult`, `DecisionRecorder` (Task 3); `storeRecorder` (Task 5); `TURN_HANDLER`, `TurnHandlerState`, `TurnHandlerVerdict`, `isSkipReason`, `TURN_GEAR`, `TurnGearState`, `TurnGearVerdict` (Task 6); the 8a glue; `recordSkip` / `persistDecisionRows` with `ladder_decision_id`, `JevVerdictInsert.decision_id`, `listDecisionsForRun` (Task 4); the Task 2 harness.
- Produces: no new export. `CoreWorker` private: `pendingLadder`, `decisionRecorder`, `deferredRecorder(run_id)`, `flushLadder(run_id)`.

- [ ] **Step 1: Write the failing tests `tests/core/turn-handler-ladder.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunStore } from "../../src/run/run-store.js";
import { cat, HEAVY, jevDown, picks, scriptedLlm, SHADOW, treeSays, triageHarness, webOk, type Says } from "../helpers/triage-harness.js";

// ADR 0030 / spec §5.3: every turn.handler decision is one `decisions` row, and each jev_verdicts row and each jev_decisions
// row of the turn links to it — the outcome trail a digest tap or a later correction follows. Plan ruling 14 (codex B1):
// the row is written with the verdict, so a lost turn writes none and a rolled-back save takes its row with it. turn.gear
// records the role the route carries and must equal it on every path (the planner pins route.role in stage 1). A broken
// ledger must not change what Paco gets.
const RULE: Says = { category: cat({ memory: 0.9 }), sets_rule: 0.95 };
const handlerRow = (store: RunStore, run_id: string) => store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "turn.handler");
const gearRow = (store: RunStore, run_id: string) => store.listDecisionsForRun(run_id).find((d) => d.entry_id === "turn.gear");

function expectLinked(store: RunStore, run_id: string): string {
  const rows = handlerRow(store, run_id);
  expect(rows).toHaveLength(1);
  const id = rows[0]!.decision_id;
  expect(store.getJevVerdictForRun(run_id)?.decision_id).toBe(id);
  const jd = store.listJevDecisions(run_id);
  expect(jd.length).toBeGreaterThan(0);
  expect(jd.every((r) => r.ladder_decision_id === id)).toBe(true);
  return id;
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("turn.handler decisions link to what triage persisted", () => {
  it("a routed planner turn: rung jev, p = the category's top probability, reason routed; verdict and six rows linked", async () => {
    const h = triageHarness(treeSays({ category: cat({ research: 0.9 }), breadth: HEAVY, reasoning: HEAVY, actions: HEAVY }));
    const t = h.turn("帮我比较三款 NAS");
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "jev", verdict: "planner", p: 0.9, reason_code: "routed", armed_mode: "on", stage: "pre_model" });
    expect(gearRow(h.store, t.run_id)).toMatchObject({ rung: "jev", verdict: "thinking" });
    expect(h.store.getJevVerdictForRun(t.run_id)?.role).toBe("thinking");
    h.store.close();
  });
  it("the ack rule: rung rule, reason ack_rule; the skipped row and the verdict linked; gear fast by rule", async () => {
    const h = triageHarness(treeSays());
    h.store.recordChatTurn({ chat_id: "555", run_id: "run_seed_ack", role: "assistant", text: "明天悉尼晴，最高 22 度。", intent: "loop" });
    const t = h.turn("谢谢");
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "rule", reason_code: "ack_rule", verdict: "planner" });
    expect(gearRow(h.store, t.run_id)).toMatchObject({ rung: "rule", verdict: "fast", reason_code: "gear_not_applied" });
    h.store.close();
  });
  it("a Jev outage: rung fail, fallback_reason outage on the jev rung, reason transport", async () => {
    const h = triageHarness(jevDown());
    const t = h.turn("以后回复短一点");
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "fail", fallback_reason: "outage", fallback_rung: "jev", reason_code: "transport" });
    h.store.close();
  });
  it("a cascade pick: rung model, reason cascade", async () => {
    const h = triageHarness(treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }) }), { llm: scriptedLlm({ cascade: picks("lookup") }) });
    const t = h.turn("这个周末去哪玩");
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "model", reason_code: "cascade", verdict: "planner" });
    h.store.close();
  });
  it("a cascade with no pick: rung fail, reason cascade_failed, the model rung's outage (not a Jev skip)", async () => {
    const h = triageHarness(treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }) }));
    const t = h.turn("这个周末去哪玩");
    await h.worker.triageTurn(t.input);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "fail", reason_code: "cascade_failed", fallback_reason: "outage", fallback_rung: "model" });
    h.store.close();
  });
  it("configured shadow: armed_mode shadow, rung fail, the Jev rows say shadow", async () => {
    const h = triageHarness(treeSays(RULE), { env: SHADOW });
    const t = h.turn("以后回复短一点");
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "fail", armed_mode: "shadow", fallback_reason: null });
    expect(h.store.listJevDecisions(t.run_id).every((r) => r.decision === "shadow")).toBe(true);
    h.store.close();
  });
  it("a memory lane save links inside the save's transaction too", async () => {
    const h = triageHarness(treeSays(RULE));
    const t = h.turn("从现在起，回复请控制在三句话以内。");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expectLinked(h.store, t.run_id);
    h.store.close();
  });
});

describe("a lost turn writes no decisions row (ruling 14, codex B1)", () => {
  it("killed while Jev answers: no decisions row, no verdict, no Jev row", async () => {
    const ctl = new AbortController();
    const says = treeSays(RULE);
    const h = triageHarness(vi.fn(async (u: unknown, i: unknown) => { ctl.abort(); return says(u, i); }));
    const t = h.turn("从现在起，回复请控制在三句话以内。", { signal: ctl.signal });
    await h.worker.triageTurn(t.input);
    expect([h.store.listDecisionsForRun(t.run_id), h.store.getJevVerdictForRun(t.run_id), h.store.listJevDecisions(t.run_id)]).toEqual([[], undefined, []]);
    h.store.close();
  });
  it("killed while the cascade answers: no decisions row, no verdict", async () => {
    const ctl = new AbortController();
    const cascade = async () => { ctl.abort(); return { ok: true as const, output: { answer: "lookup" } }; };
    const h = triageHarness(treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }) }), { llm: scriptedLlm({ cascade }) });
    const t = h.turn("这个周末去哪玩", { signal: ctl.signal });
    await h.worker.triageTurn(t.input);
    expect([h.store.listDecisionsForRun(t.run_id), h.store.getJevVerdictForRun(t.run_id)]).toEqual([[], undefined]);
    h.store.close();
  });
  it("a lane save that rolls back takes its row with it; the fallback settle writes exactly one, linked", async () => {
    const h = triageHarness(treeSays(RULE));
    const t = h.turn("从现在起，回复请控制在三句话以内。");
    h.worker.breakLaneFinalizeOnceForTest();
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(h.store.listDecisionsForRun(t.run_id).filter((d) => d.entry_id === "turn.gear").length).toBeLessThanOrEqual(1);
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ route_outcome: "fallback" });
    h.store.close();
  });
});

describe("turn.gear equals the role on the verdict row (the route's role) on every path", () => {
  const cases: Array<[string, Says | "down", string]> = [
    ["research heavy", { category: cat({ research: 0.9 }), breadth: HEAVY, reasoning: HEAVY, actions: HEAVY }, "帮我比较三款 NAS"],
    ["other light", { category: cat({ other: 0.9 }) }, "帮我整理一下这周的待办"],
    ["answer lane", { category: cat({ answer: 0.9 }) }, "你觉得 NAS 放在客厅还是书房更好？"],
    ["think harder", { category: cat({ answer: 0.9 }) }, "认真想：你觉得呢？"],
    ["outage + think harder", "down", "认真想：这个怎么办"]
  ];
  for (const [name, says, text] of cases) {
    it(name, async () => {
      const h = triageHarness(says === "down" ? jevDown() : treeSays(says), { web: webOk() });
      const t = h.turn(text);
      await h.worker.triageTurn(t.input);
      const role = h.store.getJevVerdictForRun(t.run_id)!.role;
      expect(gearRow(h.store, t.run_id)?.verdict ?? "default").toBe(role); // no row = the default verdict "default"
      h.store.close();
    });
  }
});

describe("recording never changes a decision (spec §4.1)", () => {
  it("a failing decisions write: the same route and verdict row, decision_id null, decision_record_failed open", async () => {
    const h = triageHarness(treeSays({ category: cat({ research: 0.9 }) }));
    vi.spyOn(h.store, "insertDecision").mockImplementation(() => { throw new Error("SQLITE_FULL"); });
    const t = h.turn("帮我比较三款 NAS");
    const out = await h.worker.triageTurn(t.input);
    expect(out).toMatchObject({ kind: "fallthrough", route: { role: "thinking" } });
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ lane: "planner", role: "thinking", decision_id: null });
    expect(h.store.listOpenIncidents().map((i) => i.kind)).toContain("decision_record_failed");
    h.store.close();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/core/turn-handler-ladder.test.ts`
Expected: FAIL (no `decisions` rows are written yet; `listDecisionsForRun` returns `[]`, so the link and row assertions fail).

- [ ] **Step 3: Modify `src/core/core-worker.ts` — imports, module-level declarations and fields**

Imports (`:142-153`): add

```ts
import { decide as decideLadder } from "../decisions/decide.js";
import { isSkipReason, TURN_HANDLER, type TurnHandlerState, type TurnHandlerVerdict } from "../decisions/entries/turn-handler.js";
import { TURN_GEAR, type TurnGearState, type TurnGearVerdict } from "../decisions/entries/turn-gear.js";
import { storeRecorder } from "../decisions/record.js";
import type { AnyDecideResult, AnyEntry, DecideResult, DecisionRecorder, FallbackReason, RungOutcome, RungResult } from "../decisions/types.js";
import { fallbackOfSkip, jevSkipReason, planTree, treeDetailOf, type AnsweredDecision, type TreeDetail } from "./turn-handler-ladder.js";
```

and import `type LastHougeTurn, type QuotedTurn` from `../jev/questions/tree.js` (`:148`). After Step 6 compiles, remove the
imports the change orphaned (`routeTree`, `treeArmed`, `TREE_BAR_DEFAULTS`, `type Armed`, `type RoutePlan` only if unused,
`isBareAck`, `type Decision`) — check each with `grep -n "<name>" src/core/core-worker.ts` first; `preJudge`,
`calibrationRows`, `resolveJevLanesOff` stay used.

Delete `const UNARMED …` (`:270`; it now lives in `turn-handler-ladder.ts`, and `core-worker.ts` no longer uses it). Delete `URL_IN_TEXT` (`:4055`) and `urlRule`
with its doc comment (`:4057-4065`), both moved verbatim in 8a. Keep `LANE_PREVIOUS_TURNS` (`:4054`).

Add, next to the other module-level types (after `TriageHeld`, `:267`):

```ts
/** Configured triage shadow as the runner's arming (the one shadow R13 keeps): the Jev and cascade rungs are asked and recorded, never applied. */
const TREE_SHADOWED = { jev: "shadow", model: "shadow" } as const;
/** The tree's instants (spec §2.2), read once per turn. */
interface TreeContext { now: () => Date; builtAt: Date; lastHougeTurn: LastHougeTurn; quotedTurn: QuotedTurn | null }
type HandlerResult = DecideResult<TurnHandlerVerdict, TreeDetail>;
/** One queued front-door ladder row (plan ruling 14): written by settleTriage, inside its transaction. */
interface PendingLadderRow { entry: AnyEntry; r: AnyDecideResult; ctx: { run_id: string | null; tool_call_id: string | null } }
```

After `private readonly ompTurns = new Map<string, OmpTurnState>();` (`:496`) add:

```ts
  /** The front door's ladder rows, queued at decide time and written by settleTriage (ruling 14); cleared when triageTurn returns. */
  private readonly pendingLadder = new Map<string, PendingLadderRow[]>();
  private recorderCache?: DecisionRecorder;
  /** Lazy: a field initializer cannot read the runStore parameter property (it is assigned after class fields). */
  private get decisionRecorder(): DecisionRecorder { return (this.recorderCache ??= storeRecorder(this.runStore)); }
```

- [ ] **Step 4: Replace `settleTriage` (`:2675-2700`, doc comment included) so the ladder rows ride its transaction**

```ts
  /**
   * THE finaliser: every eligible, still-active exit of triageTurn passes through here exactly once and writes the
   * turn's ladder rows, the decision rows (or the skipped row), the verdict row and the triage event together. A lost turn
   * writes nothing — not even its `decisions` row (plan ruling 14). `inTx`: already inside the lane's save transaction, so
   * the caller flips `triageFinalized` after that commit; a rollback there takes the ladder rows with it, and the
   * fallback settle that follows writes them once.
   * Returns the verdict id, or null when nothing was written.
   */
  private settleTriage(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, f: TriageSettle, o: { inTx?: boolean } = {}): string | null {
    if (state?.triageFinalized || this.laneLost(i, state)) return null;
    const run_id = i.claim.run_id;
    let verdict_id: string | null = null;
    const write = (): void => {
      const ladder = this.flushLadder(run_id);
      if (f.kind === "skipped") recordSkip(this.runStore, "triage", run_id, lang, f.reason, undefined, ladder);
      else persistDecisionRows(this.runStore, f.rows, f.decision, `${TREE_THRESHOLD_VERSION}:${f.route.reason}`, ladder);
      if (o.inTx && this.laneFinalizeFault) { this.laneFinalizeFault = false; throw new Error("lane finalize fault (test)"); }
      if (f.route.thinkHarder) this.markThinkHarder(run_id);
      const id = this.runStore.insertJevVerdict({ ...this.verdictInsert(run_id, f, state), decision_id: ladder }, f.kind === "answered" ? f.verdict_id : undefined);
      this.runStore.updateJevVerdict(id, { ...(f.handler ? { handler_outcome: f.handler } : {}), ...(f.kind === "answered" && f.model ? { model: f.model } : {}) });
      this.triageEvent(run_id, lang, f, id);
      verdict_id = id;
    };
    if (o.inTx) { write(); return verdict_id; }
    this.runStore.inTransaction(write);
    if (state) state.triageFinalized = true;
    this.pendingLadder.delete(run_id); // committed: no later settle may write the rows again (senior re-review S5)
    return verdict_id;
  }

  /** The front door's recorder (ruling 14): the runner's record call only queues the row for flushLadder. Never writes, never throws. */
  private deferredRecorder(run_id: string): DecisionRecorder {
    return {
      record: (entry, r, ctx) => {
        const list = this.pendingLadder.get(run_id) ?? [];
        list.push({ entry, r, ctx });
        this.pendingLadder.set(run_id, list);
        return null;
      }
    };
  }

  /**
   * Writes the turn's queued ladder rows (turn.handler, then turn.gear) inside settleTriage's transaction. storeRecorder
   * never throws and opens no transaction; a failed insert leaves the link null and opens decision_record_failed, and the
   * verdict stands. Rows stay queued after an `inTx` write until its outer transaction is known (a rollback is redone by
   * the next settle); a committed non-`inTx` settle clears them.
   * Returns turn.handler's decision id.
   */
  private flushLadder(run_id: string): string | null {
    let handler: string | null = null;
    for (const p of this.pendingLadder.get(run_id) ?? []) {
      const id = this.decisionRecorder.record(p.entry, p.r, p.ctx);
      if (p.entry.id === TURN_HANDLER.id) handler = id;
    }
    return handler;
  }
```

- [ ] **Step 5: Replace `triageTurn` … `checkJevModel` (`:2728-2803`, doc comment included) with**

```ts
  /**
   * The decision point (spec §2; ADR 0030 §4.4): the `turn.handler` ladder decides — the gate rule (flag → override →
   * posture → modality → state → ack rule), the Jev tree, then below the bar the cascade's Tiny pick — and the handler runs
   * and settles once. Any throw still finalises once: answered `fallback` once Jev had answered, skipped `error` before that.
   */
  async triageTurn(i: TriageInput): Promise<TriageOutcome> {
    const lang = langOf(i.userText);
    const state = this.ompTurns.get(i.claim.run_id);
    const held: TriageHeld = { thinkHarder: thinkHarderIn(i.userText), quote: this.quoteRef(state) };
    try {
      return await this.triageTurnInner(i, state, lang, held);
    } catch (e) {
      console.error(`triage: threw: ${safeReason(e)}`);
      const route = fallbackRoute("jev_skipped", held.thinkHarder);
      const id = this.settleTriage(i, state, lang, held.answered ? { ...held.answered, route, decision: "fallback" } : { kind: "skipped", reason: "error", route });
      const saved = state?.lessonSavedThisTurn;
      const base = { route: turnRoute(route, id), ...quoteField(held.quote) };
      return saved ? { kind: "inform", note: memoryInformNote(saved.id, saved.theme), ...base } : { kind: "fallthrough", ...base };
    } finally {
      this.pendingLadder.delete(i.claim.run_id);
    }
  }

  private async triageTurnInner(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, held: TriageHeld): Promise<TriageOutcome> {
    this.resolveQuietOverrides();
    const mode = resolveJevTriageMode(process.env, this.ompDataDir());
    const tree = this.lazyTreeContext(state);
    const r = await decideLadder<TurnHandlerState, TurnHandlerVerdict, TreeDetail>(TURN_HANDLER, this.turnHandlerState(i, state, mode, tree), {
      // configured shadow is the one shadow left (R13): the Jev and cascade rungs are asked and recorded, never applied
      run_id: i.claim.run_id, recorder: this.deferredRecorder(i.claim.run_id), armed: mode === "shadow" ? TREE_SHADOWED : undefined,
      exec: { jev: () => this.treeRung(i, state, lang, mode, tree, held), model: (_rung, _s, prior) => this.cascadeRung(i, prior, held) }
    });
    return this.routeDecided(i, state, lang, mode, r, held);
  }

  /** Housekeeping before the ladder: a throw here never costs the turn its route. */
  private resolveQuietOverrides(): void {
    try {
      resolveQuietTriageOverrides(this.runStore);
    } catch (e) {
      console.error(`triage: triage_overrides resolve failed: ${safeReason(e)}`);
    }
  }

  /** Read on first use only, so the clock runs for a turn that passed the gate's earlier exits (as at 3bff437). */
  private lazyTreeContext(state: OmpTurnState | undefined): () => TreeContext | null {
    let ctx: TreeContext | null | undefined;
    return () => {
      if (ctx !== undefined) return ctx;
      if (!state) return (ctx = null);
      const now = this.ompOptions.jevNow ?? (() => new Date());
      const builtAt = now();
      ctx = { now, builtAt, lastHougeTurn: lastHougeTurnOf(state.turnCtx.recentTurns, builtAt.getTime()),
        quotedTurn: state.quote ? quotedTurnFromRow(state.quote.turn, builtAt.getTime()) : null };
      return ctx;
    };
  }

  private turnHandlerState(i: TriageInput, state: OmpTurnState | undefined, mode: JevTriageMode, tree: () => TreeContext | null): TurnHandlerState {
    return {
      mode, overridden: mode !== "off" && this.runStore.triageOverrideFor(i.claim.run_id), posture: i.posture, modality: i.modality,
      hasTurnState: state !== undefined,
      isAck: () => {
        const t = tree();
        return t !== null && preJudge({ text: i.userText, lastHougeTurn: t.lastHougeTurn, quoted: t.quotedTurn !== null }).kind === "ack_answer";
      }
    };
  }

  /** The Jev rung: the tree state, one Jev call, then the pure policy. Every failure is a rung failure naming today's skip reason. */
  private async treeRung(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, mode: JevTriageMode, tree: () => TreeContext | null,
    held: TriageHeld): Promise<RungResult<TurnHandlerVerdict, TreeDetail>> {
    const t = tree();
    if (!state || !t) return { failed: "threw", reason: "error" };
    const run_id = i.claim.run_id;
    const built = buildTreeState({ userText: i.userText, recentTurns: state.turnCtx.recentTurns, turnChars: state.turnCtx.turnChars, modality: i.modality,
      lastHougeTurn: t.lastHougeTurn, quotedTurn: t.quotedTurn }, this.broker ? (s) => this.broker!.redact(s) : undefined);
    if (!built.ok) return { failed: fallbackOfSkip(built.skip), reason: built.skip };
    const d = await decide({ point: "triage", run_id, state: built.state, questions: TREE_QUESTIONS, lang, client: this.jevClient(run_id),
      store: this.runStore, thresholdVersion: TREE_THRESHOLD_VERSION, now: t.now, instants: { thread_cut_at: state.threadCutAt, state_built_at: t.builtAt.toISOString() } });
    if (d.status === "skipped") return { failed: fallbackOfSkip(d.reason), reason: d.reason };
    return this.planAnswered(i, lang, mode, d, held);
  }

  /**
   * Jev answered: the pure policy, then (armed only, and only once the policy ran, as at 3bff437) the alias-move page.
   * A throw in calibrationRows is the rung's throw (runAsync catches it): skipped `error`, as today (ruling 19).
   */
  private planAnswered(i: TriageInput, lang: Lang, mode: JevTriageMode, d: AnsweredDecision, held: TriageHeld): RungResult<TurnHandlerVerdict, TreeDetail> {
    const rows = calibrationRows(process.env);
    const out = planTree(d, { userText: i.userText, mode, lang, thinkHarder: held.thinkHarder, rows, lanesOff: resolveJevLanesOff(process.env) });
    const reachedPolicy = !("failed" in out) || out.detail !== undefined;
    if (mode === "arm" && reachedPolicy) this.checkJevModel(d.model, rows); // shadow arms nothing, so an alias move loses nothing there
    return out;
  }

  /** The model rung (Decision 14): the Tiny pick between Jev's top two, only when the tree abstained below the choice bar. */
  private async cascadeRung(i: TriageInput, prior: readonly RungOutcome<TurnHandlerVerdict, TreeDetail>[], held: TriageHeld): Promise<RungResult<TurnHandlerVerdict, TreeDetail>> {
    const jev = prior.find((o) => o.kind === "jev")?.result;
    const det = jev && "abstain" in jev ? jev.detail : undefined;
    if (!det?.plan || det.plan.kind !== "cascade") return { abstain: true };
    const pick = await this.cascadePick(i, det.plan.between, held.quote);
    const route = applyCascade(det.plan, pick.pick);
    const detail: TreeDetail = { ...det, route };
    return pick.pick === null ? { failed: pick.why, reason: route.reason, detail } : { verdict: route.lane, reason: route.reason, detail };
  }

  /** The ladder's answer to a handler: a gate exit, a tree with no answer (today's skip), or Jev's plan through the handlers. */
  private async routeDecided(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, mode: JevTriageMode, r: HandlerResult, held: TriageHeld): Promise<TriageOutcome> {
    if (r.rung === "rule") return this.gateExit(i, state, lang, r, held);
    const det = treeDetailOf(r);
    if (!det || !state) {
      await this.recordGear(i, r, fallbackRoute("jev_skipped", held.thinkHarder), false);
      return this.triageSkip(i, state, lang, jevSkipReason(r), held);
    }
    await this.recordGear(i, r, det.route ?? fallbackRoute("jev_skipped", held.thinkHarder), det.armed.gear);
    return this.routeAnswered(i, state, lang, mode, det, held);
  }

  /** The gate rule answered: the flag-off rollback (no route, no gear), the ack route, or a skip with today's reason. */
  private async gateExit(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, r: HandlerResult, held: TriageHeld): Promise<TriageOutcome> {
    const reason = isSkipReason(r.reason) ? r.reason : "error";
    if (reason === "disabled") return this.triageOff(i, state, lang, held);
    const route = reason === "ack_rule" ? ACK_ROUTE : fallbackRoute("jev_skipped", held.thinkHarder);
    await this.recordGear(i, r, route, false);
    return this.triageSkip(i, state, lang, reason, held, route);
  }

  /** `turn.gear` (spec §4.4): the role this turn's route carries, recorded under its own entry from the same Jev call, queued with the handler's row. */
  private async recordGear(i: TriageInput, handler: HandlerResult, route: Route, gearArmed: boolean): Promise<void> {
    const applied = gearArmed && (handler.rung === "jev" || handler.rung === "model");
    await decideLadder<TurnGearState, TurnGearVerdict>(TURN_GEAR, { role: route.role, reason: route.reason, applied }, {
      run_id: i.claim.run_id, recorder: this.deferredRecorder(i.claim.run_id),
      exec: { jev: async () => ({ verdict: route.role, reason: route.reason }) }
    });
  }

  /** Jev answered: the settle helpers over its rows, then the plan's handler (the cascade's pick already in `det.route`). */
  private async routeAnswered(i: TriageInput, state: OmpTurnState, lang: Lang, mode: JevTriageMode, det: TreeDetail, held: TriageHeld): Promise<TriageOutcome> {
    const d = det.d;
    const settleFor: SettleFor = (route, save, handler, outcome) => ({ kind: "answered", rows: d.rows, decision: decisionFor(mode, route, save, outcome),
      numbers: numbersOf(d.answers.category!), scores: scoresOf(d.answers), route, save, ...(handler ? { handler } : {}), ...(outcome ? { outcome } : {}) });
    held.answered = settleFor(fallbackRoute("jev_skipped", held.thinkHarder), "none"); // from here a throw settles as answered fallback
    if (det.error !== undefined || !det.plan) throw new Error(det.error ?? "tree plan missing"); // the catch settles the answered fallback, as before
    if (det.plan.kind === "cascade") return this.cascadeRoute(i, state, lang, det.plan, det.route ?? applyCascade(det.plan, null), settleFor, held);
    const route = det.route ?? det.plan.route;
    if (route.lane === "status") return this.statusLane(i, state, lang, route, settleFor, held);
    if (route.lane === "answer" || route.lane === "lookup") return this.laneRoute(i, state, lang, route, settleFor, held);
    if (route.save) return this.saveThenRoute(i, state, lang, route, settleFor, held);
    const id = this.settleTriage(i, state, lang, settleFor(route, "none"));
    return { kind: "fallthrough", route: turnRoute(route, id), ...quoteField(held.quote) };
  }

  /** An alias move pages once (jev-incidents.ts), counting only the tree's live rows. Never fails the turn: the answer is held. */
  private checkJevModel(model: string, rows: readonly CalibrationRow[]): void {
    try { checkJevModelCalibrated(this.runStore, model, treeArmingRows(rows)); } catch (e) { console.error(`jev: model calibration check failed: ${safeReason(e)}`); }
  }
```

- [ ] **Step 6: Replace `cascadeRoute` and `cascadePick` (`:2876-2908`)**

```ts
  /**
   * Below the choice bar with two candidates (spec §2.4; plan Decision 14). The model rung already made the one Tiny pick;
   * `route` is the pick's route, or `applyCascade(plan, null)` (Default, nothing saved). A rule saves first
   * (`saveThenRoute`), else the planner on the pick's role. Every settle of this turn carries the pair for its triage event.
   */
  private async cascadeRoute(i: TriageInput, state: OmpTurnState, lang: Lang, plan: Extract<RoutePlan, { kind: "cascade" }>, route: Route, settleFor: SettleFor,
    held: TriageHeld): Promise<TriageOutcome> {
    const withPair: SettleFor = (r, save, handler, outcome) => ({ ...settleFor(r, save, handler, outcome), between: plan.between });
    held.answered = withPair(fallbackRoute("jev_skipped", held.thinkHarder), "none"); // a throw from here still names the pair
    if (route.save) return this.saveThenRoute(i, state, lang, route, withPair, held);
    const id = this.settleTriage(i, state, lang, withPair(route, "none"));
    return { kind: "fallthrough", route: turnRoute(route, id), ...quoteField(held.quote) };
  }

  /**
   * The cascade's one call (Decision 14): the Tiny chain under LlmCallRole "cascade", audited per leg on the turn's run,
   * bounded at CASCADE_TIMEOUT_MS and by the turn's own signal. No pick on any failure, timeout or answer outside the two;
   * `why` is the ladder's fallback reason (no answer in time or a failed call is `outage`: withinMs folds the two).
   */
  private async cascadePick(i: TriageInput, between: readonly [Category, Category], quote: QuoteRef | null): Promise<{ pick: Category | null; why: FallbackReason }> {
    const ctl = new AbortController();
    const signal = AbortSignal.any([i.signal, ctl.signal]);
    try {
      const answer = await withinMs(CASCADE_TIMEOUT_MS, () => this.cascadeCall(i.claim.run_id, cascadePrompt(between, i.userText, quote), signal), () => ctl.abort());
      if (answer === null) {
        console.warn(`triage: cascade gave no answer within ${CASCADE_TIMEOUT_MS} ms or failed`);
        return { pick: null, why: "outage" };
      }
      return { pick: parseCascadePick(answer, between), why: "parse" };
    } catch (e) {
      console.error(`triage: cascade call threw: ${safeReason(e)}`);
      return { pick: null, why: "threw" };
    }
  }
```

- [ ] **Step 7: Run the new tests, the frozen pin set and the typecheck**

Run: `npx vitest run tests/core/turn-handler-ladder.test.ts tests/core/turn-handler-ladder-glue.test.ts && CI=1 npx vitest run tests/core/turn-handler-pin.test.ts tests/core/turn-handler-pin-throws.test.ts tests/core/turn-handler-routed-by.test.ts && npm run typecheck`
Expected: PASS; the pin writes no snapshot (`CI=1`). If a pin case fails, the diff names the column: fix the code until
it passes. Never re-run the pin with `-u` in this task.
Run: `git diff --exit-code <task-2 sha> -- tests/helpers/triage-harness.ts tests/core/turn-handler-pin.test.ts tests/core/turn-handler-pin-throws.test.ts tests/core/turn-handler-routed-by.test.ts tests/core/__pins__`
Expected: exit 0, no output (the harness, the projection, the pin tests and the snapshots are exactly as Task 2 wrote them).

- [ ] **Step 8: Run every consumer's suite (the consumer table above), then the whole suite**

Run: `npx vitest run tests/core/core-worker-triage.test.ts tests/core/core-worker-lanes.test.ts tests/gateway/memlane-commands.test.ts tests/gateway/rating-capture.test.ts tests/run/ tests/omp/ tests/jev/`
Expected: PASS.
Run (in the feature worktree only, never the main checkout): `npm run typecheck && npm test && npm run build`
Expected: PASS with no skipped tests (`grep -c "skipped"` on the vitest summary shows 0), build succeeds.

- [ ] **Step 9: Commit (protected for Paco's merge per spec §13: core-worker)**

```bash
git add src/core/core-worker.ts tests/core/turn-handler-ladder.test.ts
git commit -m "refactor(core): turn.handler and turn.gear decide through the ladder (behaviour pinned)"
```

## Task 8c: Every automatic lesson save is announced on the memory card with Undo (Paco's Q1 ruling)

Paco, 2026-10-12 ("Add the card"): the memory card with Undo appears whenever a lesson is saved automatically, whatever
route the turn took. This is a deliberate behaviour change, so it comes after 8b: the pin has already proved the move
changed nothing, and this task updates the pin and the effect table on purpose, naming every changed file. End state:
every automatic save is a reversible effect announced on a card with Undo, and `entryProblems` no longer accepts
`announced: "reply"`.

Today's announcement per route (3bff437):

| Route | Save path | Announced today | After 8c |
|---|---|---|---|
| memory lane | `saveThenRoute` → `memoryLaneEnd` | the memory card with ↩️ Undo is the reply | unchanged |
| answer / lookup lane (`laneBranch` save) | `laneRoute` → `saveFirst` (`core-worker.ts:2931-2934`) | the lane card's 📒 line, no Undo | the lane card gains ↩️ Undo |
| answer / lookup lane that falls through | `laneRoute` → inform (`:2947`) | `[memory]` note to the planner | Undo-only memory card queued |
| planner (`two_request`, cascade pick with a rule, rule on a status/other route) | `saveThenRoute` → inform (`:2848`) | `[memory]` note to the planner (`planner-supervisor.ts:479`) | Undo-only memory card queued |
| memory lane lost after the save (/kill) or its card throws | `memoryLaneEnd` (`:2858-2869`) | inform note only | Undo-only memory card queued |
| a throw after a committed save | `triageTurn` catch (`:2743`) | inform note only | Undo-only memory card queued |

The queued card is keyed `memcard:<change_id>`, so two paths reaching it for one save send one card. It carries Undo
only (Dig deeper belongs to a lane reply, not to a planner turn). Undo works for every route: `saveFirst` writes the
lesson change through `runLessonWrite` (`:2604`), and `handleMemLaneUndo` undoes any change id of this chat
(`src/gateway/memlane-commands.ts:19-34`).

**Files:**
- Modify: `src/core/memory-lane-card.ts` — export `memlaneUndoButton(change_id)`; `memoryLaneCard` uses it
- Modify: `src/core/core-worker.ts` — new `announceSave`; call sites in `saveThenRoute` (`:2841-2851`), `memoryLaneEnd` (`:2858-2869`), `laneRoute`'s fall-through return (`:2947`), `laneCardFor` (`:2965-2975`), `triageTurn`'s catch (8b's version)
- Modify: `src/decisions/entries/turn-handler.ts` (`TURN_HANDLER_EFFECTS`), `src/decisions/registry.ts` (`effectProblems`), `tests/decisions/registry.test.ts`
- Modify (deliberate, named): `tests/core/__pins__/turn-handler/rule-on-lookup.json` (regenerated), `tests/core/core-worker-triage.test.ts` ("ompFail after a committed save…")
- Test: `tests/core/lesson-save-card.test.ts`

**Interfaces:**
- Consumes: `memoryLaneCard`, `MEMLANE_UNDO_PREFIX`; `OmpTurnState.lessonSavedThisTurn` (`{ id, theme, change_id }`, `core-worker.ts:241`); `RunStore.getLesson`, `enqueueNotification`; the Task 2 harness; `drainOutbox`.
- Produces: `memlaneUndoButton(change_id: string): NotificationButton`; `CoreWorker` private `announceSave(run_id, saved)`.

- [ ] **Step 1: Write the failing tests `tests/core/lesson-save-card.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";
import { cat, HEAVY, LIGHT, picks, scriptedLlm, treeSays, triageHarness, webOk, type Says } from "../helpers/triage-harness.js";

// Paco 2026-10-12 (Q1 → "Add the card"): every automatic lesson save is announced on a card with ↩️ Undo, whatever route
// the turn took, exactly once, and the Undo really retires the lesson. R12: an effect over Paco's message must be
// reversible and announced; a save the planner may or may not mention is not announced.
const RULE: Says = { category: cat({ memory: 0.9 }), sets_rule: 0.95 };
const UNDO = /^memlane:undo:(.+)$/;
const memcards = (store: RunStore) => [...drainOutbox(store).entries()].filter(([k]) => k.startsWith("memcard:")).map(([, p]) => p);
const undoOf = (buttons: unknown): string | undefined =>
  (buttons as Array<{ data: string }> | undefined)?.map((b) => UNDO.exec(b.data)?.[1]).find((x) => x !== undefined);

function tapUndo(store: RunStore, change_id: string) {
  return new Gateway(store).intake(buildTypedTaskEvent({ source: "telegram", type: "memlane_undo", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `undo:${change_id}`, source_reference: `undo:${change_id}`,
    metadata: { telegram_update_id: 1, telegram_callback_id: `cb_${change_id}`, change_id } }));
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("the planner path queues one Undo-only memory card", () => {
  it("two_request: inform to the planner, one memcard with ↩️ Undo only, and the Undo retires the lesson", async () => {
    const h = triageHarness(treeSays({ ...RULE, actions: HEAVY }));
    const t = h.turn("以后用摄氏度。顺便帮我订明天的会议室");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("inform");
    const cards = memcards(h.store);
    expect(cards).toHaveLength(1);
    expect(String(cards[0]?.text)).toMatch(/^📒 Saved lesson #\d+ · /);
    expect((cards[0]?.buttons as Array<{ data: string }>).map((b) => b.data)).toEqual([expect.stringMatching(UNDO)]);
    expect(tapUndo(h.store, undoOf(cards[0]?.buttons)!)).toMatchObject({ ok: true, status: "lesson_change_undone" });
    expect(h.store.getActiveLessons("ask")).toHaveLength(0);
    h.store.close();
  });
  it("a cascade pick with a rule: one memcard", async () => {
    const h = triageHarness(treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }), sets_rule: 0.95 }), { llm: scriptedLlm({ cascade: picks("answer") }) });
    const t = h.turn("以后都用摄氏度，这周末去哪");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("inform");
    expect(memcards(h.store)).toHaveLength(1);
    h.store.close();
  });
});

describe("the lanes", () => {
  it("a lookup lane that saved: the lane card itself carries ↩️ Undo (and Dig deeper); no separate card", async () => {
    const h = triageHarness(treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.95, actions: LIGHT }), { web: webOk() });
    const t = h.turn("以后温度都用摄氏度。明天悉尼天气怎么样？");
    const out = await h.worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    const change_id = undoOf(out.kind === "lane_reply" ? out.buttons : undefined);
    expect(change_id).toBeDefined();
    expect(memcards(h.store)).toEqual([]);
    expect(tapUndo(h.store, change_id!)).toMatchObject({ ok: true, status: "lesson_change_undone" });
    h.store.close();
  });
  it("an answer lane that saved and then fell through: inform plus one memcard", async () => {
    const h = triageHarness(treeSays({ category: cat({ answer: 0.9 }), sets_rule: 0.95 }),
      { llm: scriptedLlm({ compose: async () => ({ ok: false, error: "all lane legs failed" }) }) });
    const t = h.turn("以后回复短一点。你觉得呢？");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("inform");
    expect(memcards(h.store)).toHaveLength(1);
    h.store.close();
  });
  it("the memory lane: its reply is the card (Undo + Dig deeper); nothing extra is queued", async () => {
    const h = triageHarness(treeSays(RULE));
    const t = h.turn("从现在起，回复请控制在三句话以内。");
    const out = await h.worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    expect(undoOf(out.kind === "lane_reply" ? out.buttons : undefined)).toBeDefined();
    expect(memcards(h.store)).toEqual([]);
    h.store.close();
  });
  it("the memory card fails to render after the save: the save is still announced, once", async () => {
    const h = triageHarness(treeSays(RULE));
    h.worker.breakMemoryLaneCardForTest();
    const t = h.turn("从现在起，回复请控制在三句话以内。");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("inform");
    expect(memcards(h.store)).toHaveLength(1);
    h.store.close();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/core/lesson-save-card.test.ts`
Expected: FAIL (no `memcard:` rows; the lookup lane card has no Undo button).

- [ ] **Step 3: `src/core/memory-lane-card.ts`**

Add after `button`:

```ts
/** The ↩️ Undo button for a lesson change. Paco 2026-10-12: every automatic save carries it, whatever the turn's route. */
export function memlaneUndoButton(change_id: string): NotificationButton {
  return button("↩️ Undo", `${MEMLANE_UNDO_PREFIX}${change_id}`);
}
```

and in `memoryLaneCard` replace `button("↩️ Undo", \`${MEMLANE_UNDO_PREFIX}${i.change_id}\`)` with `memlaneUndoButton(i.change_id)` (same output).

- [ ] **Step 4: `src/core/core-worker.ts`**

Import `memlaneUndoButton` beside `memoryInformNote, memoryLaneCard` (`:154`). Add next to `memoryLaneCardFor`:

```ts
  /**
   * Paco 2026-10-12 (Q1, "add the card"): every automatic lesson save is announced on the memory card with Undo, whatever
   * route the turn took. The memory lane's reply IS that card and a lane reply carries Undo itself; every other path (the
   * planner's inform note, a lane that fell through, a lost turn, a card that failed, a throw after the save) queues an
   * Undo-only card here. Keyed by the change id, so two paths for one save send one card. Never throws: the save stands.
   */
  private announceSave(run_id: string, saved: { id: number; theme: string; change_id: string } | undefined): void {
    if (!saved) return;
    try {
      const row = this.runStore.getLesson(saved.id);
      const card = memoryLaneCard({ lesson_id: saved.id, theme: saved.theme, text: row?.text ?? "", ...(row?.avoid ? { avoid: row.avoid } : {}),
        verb: "add", change_id: saved.change_id, run_id });
      this.runStore.enqueueNotification({ target: { kind: "telegram", chat_id: this.chatOf(run_id) }, intent_type: "progress",
        idempotency_key: `memcard:${saved.change_id}`, correlation_id: run_id, payload: { text: card.text, buttons: [memlaneUndoButton(saved.change_id)] } });
    } catch (e) {
      console.error(`memory card: announce failed: ${safeReason(e)}`);
    }
  }
```

(It uses the module's `memoryLaneCard`, not the test-faultable `this.memoryLaneCard`, so a failed lane card is still announced.)

Call sites (each passes `state.lessonSavedThisTurn`, which `runLessonWrite` set for this save):
- `saveThenRoute`: replace `if (route.lane !== "memory") return { kind: "inform", note: s.note, route: turnRoute(route, s.verdict_id), ...q };` with
  `if (route.lane !== "memory") { this.announceSave(i.claim.run_id, state.lessonSavedThisTurn); return { kind: "inform", note: s.note, route: turnRoute(route, s.verdict_id), ...q }; }`
- `memoryLaneEnd`: first line of the `laneLost` branch and first line of the `catch` add `this.announceSave(i.claim.run_id, state.lessonSavedThisTurn);`.
- `laneRoute`: before its last line (`return save?.note ? …`) add `if (save?.settled) this.announceSave(i.claim.run_id, state.lessonSavedThisTurn);`.
- `triageTurn` catch (8b's version): after `const saved = state?.lessonSavedThisTurn;` add `this.announceSave(i.claim.run_id, saved);` (a no-op when nothing was saved; deduplicated when an inform path already queued it).
- `laneCardFor`: give a saved lane reply the Undo button:

```ts
  private laneCardFor(run_id: string, text: string, save: SaveStep | null):
    { card: { text: string; buttons: NotificationButton[] } } | { why: "empty_reply" | "render_failed" } {
    try {
      const card = this.laneCard({ text, run_id, ...(save?.settled ? { note: laneSavedNote(save.lesson_id, save.theme) } : {}) });
      if (!card) return { why: "empty_reply" };
      // Paco 2026-10-12: a saved lesson is announced with Undo on the card that names it
      const undo = save?.settled ? [memlaneUndoButton((save.w as Required<LessonWriteOutcome>).change_id)] : [];
      return { card: { ...card, buttons: [...undo, ...card.buttons] } };
    } catch (e) {
      console.error(`lane: card render failed: ${safeReason(e)}`);
      return { why: "render_failed" };
    }
  }
```

- [ ] **Step 5: The effect table's end state and `entryProblems` (`src/decisions/`, protected)**

In `src/decisions/entries/turn-handler.ts`, replace the `answer`, `lookup` and `planner` lines of `TURN_HANDLER_EFFECTS` with:

```ts
  answer: { kind: "effect", reversible: true, announced: "card",
    what: "answer-lane reply (Dig deeper); on a confident sets_rule the lesson saves first and the lane card carries 📒 and ↩️ Undo" },
  lookup: { kind: "effect", reversible: true, announced: "card",
    what: "lookup-lane reply (Dig deeper); on a confident sets_rule the lesson saves first and the lane card carries 📒 and ↩️ Undo" },
  planner: { kind: "effect", reversible: true, announced: "card",
    what: "the planner answers; on a confident sets_rule the lesson saves first and an Undo-only memory card is queued (announceSave)" }
```

and drop "(until Task 8c)" from the file's doc comment. In `src/decisions/registry.ts` `effectProblems`, replace
`else if (!fx.reversible || fx.announced === "none") p.push(...)` with:

```ts
    else if (!fx.reversible || fx.announced !== "card") p.push(`a jev/model rung can choose ${v}, an effect not reversible or not announced on a card`);
```

and replace the doc line about `"reply"` with: `Announced means a code-built card with Undo (Paco 2026-10-12): "reply" is not accepted.`

In `tests/decisions/registry.test.ts`:
- the pinned table becomes `{ answer: ["effect", true, "card"], lookup: ["effect", true, "card"], memory: ["effect", true, "card"], status: ["reply", true, "card"], planner: ["effect", true, "card"] }`, and its comment says the end state follows Paco's Q1 ruling;
- the two expected messages in "fails a judged entry over Paco's message…" become `"a jev/model rung can choose memory, an effect not reversible or not announced on a card"` and the same for `planner`;
- add to that test: `expect(entryProblems(base({ effects: { ...HANDLER.effects, answer: fx("effect", true, "reply") } }))).toContain("a jev/model rung can choose answer, an effect not reversible or not announced on a card");` (a save announced only in the reply no longer passes).

- [ ] **Step 6: Run, and update exactly the named tests and snapshot**

Run: `npx vitest run tests/core/lesson-save-card.test.ts tests/decisions/ && npm run typecheck`
Expected: PASS.
Run: `CI=1 npx vitest run tests/core/turn-handler-pin.test.ts tests/core/turn-handler-pin-throws.test.ts`
Expected: exactly one FAIL, `rule-on-lookup` (its lane card's `buttons` gain ↩️ Undo). Any other failing case is a
regression: stop and fix the code. Then regenerate only that case:
`npx vitest run tests/core/turn-handler-pin.test.ts -t "rule-on-lookup" -u`, and check `git diff --stat tests/core/__pins__`
shows only `rule-on-lookup.json`, with the only change the added `{ "text": "↩️ Undo", "data": "memlane:undo:<lc#1>" }` button.
Update `tests/core/core-worker-triage.test.ts` "ompFail after a committed save…" (`:816-830`): the outbox now also holds
the save's card, so replace its two `texts` lines with

```ts
    const sent = drainOutbox(store);
    expect([...sent.keys()].filter((k) => k.startsWith("memcard:"))).toHaveLength(1); // Paco's Q1 ruling: the save's Undo card
    const texts = [...sent.entries()].filter(([k]) => !k.startsWith("memcard:")).map(([, p]) => String(p.text));
```

Run: `npx vitest run tests/core/ tests/gateway/ tests/omp/ tests/run/ && npm run typecheck && npm test`
Expected: PASS. Any other existing test that breaks must be one that counts outbox rows or a saved lane card's buttons;
update it the same way, name it in the commit body, and change nothing else.

- [ ] **Step 7: Commit (protected: `src/decisions/` and core-worker — Paco's merge)**

```bash
git add src/core/memory-lane-card.ts src/core/core-worker.ts src/decisions/entries/turn-handler.ts src/decisions/registry.ts tests/decisions/registry.test.ts tests/core/lesson-save-card.test.ts tests/core/core-worker-triage.test.ts tests/core/__pins__/turn-handler/rule-on-lookup.json
git commit -m "feat(core): every automatic lesson save announced on the memory card with Undo"
```

Record this commit's sha in the task report as `<task-8c sha>`.

## Task 9: Per-entry health in the invariant sweep (`jev_skip_rate` from `decisions.fallback_reason`)

**Files:**
- Modify: `src/run/invariant-sweep.ts` — import `REGISTRY`; new block after `jevViolations` (`:233-236`); `detectViolations` (`:268-275`, add one spread)
- Test: `tests/run/invariant-sweep-decisions.test.ts`

**Interfaces:**
- Consumes: `REGISTRY`, `AnyEntry` (Task 6); `countDecisionJevSkips`, `hasJevAnsweredDecisionSince`, `insertDecision` (Task 4); `JEV_SKIP_RATE_WINDOW_MS`, `JEV_SKIP_RATE_MIN_ATTEMPTS`, `JEV_SKIP_RATE_MAX` (`invariant-sweep.ts:203-205`).
- Produces: `DECISION_SKIP_RATE_EXCLUDED: ReadonlySet<string>` (`turn.handler`, `turn.gear`), `checkDecisionSkipRates(store, now, entries?, windowMs?): Array<{ entry: string; open: boolean; attempts: number; failed: number }>`; violations of kind `jev_skip_rate` with subject `decision:<entry>`. The digest (Task 10) reads `countDecisionJevSkips` directly.

- [ ] **Step 1: Write the failing test `tests/run/invariant-sweep-decisions.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { AnyEntry } from "../../src/decisions/types.js";
import { REGISTRY } from "../../src/decisions/registry.js";
import { checkDecisionSkipRates, DECISION_SKIP_RATE_EXCLUDED, detectViolations } from "../../src/run/invariant-sweep.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";

// Spec §5.2: a silently dead judge on any entry must be loud. The rate comes from decisions rows whose first failure was on
// the Jev rung (fallback_rung, codex W6), per entry (not jev_decisions, which counts answers per run). turn.handler and turn.gear keep the pinned triage check for stage 1 (one
// Jev call, one page), so they are measured here but never paged twice.
const NOW = "2026-10-12T12:00:00.000Z";
const judged: AnyEntry = { ...(REGISTRY[0] as AnyEntry), id: "tool.injection" };
const row = (entry_id: string, o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id, entry_version: 1, run_id: null, tool_call_id: null, stage: "post_tool",
  rung: "jev", verdict: "planner", p: 0.7, reason_code: null, fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: "2026-10-12T11:00:00.000Z", ...o });

describe("per-entry jev_skip_rate", () => {
  it("opens for an entry whose Jev rung failed silently at least half the time (≥ 3 attempts)", () => {
    const store = RunStore.openInMemory();
    store.insertDecision(row("tool.injection", { rung: "fail", fallback_reason: "timeout", fallback_rung: "jev" }));
    store.insertDecision(row("tool.injection", { rung: "fail", fallback_reason: "outage", fallback_rung: "jev" }));
    store.insertDecision(row("tool.injection", {}));
    expect(checkDecisionSkipRates(store, NOW, [judged])).toEqual([{ entry: "tool.injection", open: true, attempts: 3, failed: 2 }]);
    store.close();
  });
  it("stays open until a Jev answer lands after it opened (ageing out proves nothing)", () => {
    const store = RunStore.openInMemory();
    store.openIncident({ kind: "jev_skip_rate", subject: "decision:tool.injection", detail: {}, now: "2026-10-10T00:00:00.000Z" });
    expect(checkDecisionSkipRates(store, NOW, [judged])[0]?.open).toBe(true);
    store.insertDecision(row("tool.injection", { created_at: "2026-10-12T11:30:00.000Z" }));
    expect(checkDecisionSkipRates(store, NOW, [judged])[0]?.open).toBe(false);
    store.close();
  });
  it("never pages turn.handler or turn.gear (the pinned triage check owns that page in stage 1)", () => {
    const store = RunStore.openInMemory();
    for (let k = 0; k < 4; k += 1) store.insertDecision(row("turn.handler", { rung: "fail", fallback_reason: "outage", fallback_rung: "jev", stage: "pre_model" }));
    expect(DECISION_SKIP_RATE_EXCLUDED.has("turn.handler")).toBe(true);
    expect(checkDecisionSkipRates(store, NOW).find((r) => r.entry === "turn.handler")?.open).toBe(true);
    expect(detectViolations(store, NOW).filter((v) => v.subject.startsWith("decision:"))).toEqual([]);
    store.close();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/run/invariant-sweep-decisions.test.ts`
Expected: FAIL (`checkDecisionSkipRates` is not exported).

- [ ] **Step 3: Implement in `src/run/invariant-sweep.ts`**

Add `import { REGISTRY } from "../decisions/registry.js";` and `import type { AnyEntry } from "../decisions/types.js";` to the
imports, then after `jevViolations` (`:236`):

```ts
/**
 * Spec §5.2: `jev_skip_rate` per entry, from `decisions` rows that failed on the Jev rung (every entry with a Jev rung). Sticky like the
 * triage check: open until that entry's Jev or model rung answers after the incident opened. turn.handler and turn.gear
 * are measured (the digest shows them) but keep the jev_decisions-based page above in stage 1: one call, one page.
 */
export const DECISION_SKIP_RATE_EXCLUDED: ReadonlySet<string> = new Set(["turn.handler", "turn.gear"]);

export function checkDecisionSkipRates(
  store: RunStore, now: string, entries: readonly AnyEntry[] = REGISTRY, windowMs = JEV_SKIP_RATE_WINDOW_MS
): Array<{ entry: string; open: boolean; attempts: number; failed: number }> {
  const since = new Date(Date.parse(now) - windowMs).toISOString();
  return entries.filter((e) => e.ladder.some((r) => r.kind === "jev")).map((e) => {
    const r = store.countDecisionJevSkips(e.id, since, now);
    if (r.attempts >= JEV_SKIP_RATE_MIN_ATTEMPTS && r.failed / r.attempts >= JEV_SKIP_RATE_MAX) return { entry: e.id, open: true, ...r };
    const opened = store.findOpenIncident(store.incidentFingerprint("jev_skip_rate", `decision:${e.id}`));
    return { entry: e.id, open: opened !== undefined && !store.hasJevAnsweredDecisionSince(e.id, opened.first_seen_at), ...r };
  });
}

function decisionSkipViolations(store: RunStore, now: string): InvariantViolation[] {
  return checkDecisionSkipRates(store, now).filter((r) => r.open && !DECISION_SKIP_RATE_EXCLUDED.has(r.entry))
    .map((r) => ({ kind: "jev_skip_rate" as const, subject: `decision:${r.entry}`, detail: { entry: r.entry, attempts: r.attempts, failed: r.failed } }));
}
```

In `detectViolations` (`:268-275`), add `...decisionSkipViolations(store, now),` after `...jevViolations(store, now),`.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/run/ && npm run typecheck`
Expected: PASS (the existing `invariant-sweep-jev.test.ts` and `invariant-sweep-lanes.test.ts` unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add src/run/invariant-sweep.ts tests/run/invariant-sweep-decisions.test.ts
git commit -m "feat(sweep): per-entry jev_skip_rate from decisions.fallback_reason"
```

## Task 10: The daily digest (counts, unsure list, per-entry health) and `button_rows`

**Files:**
- Create: `src/decisions/digest.ts`
- Modify: `src/notifications/notification-types.ts:14-18` (`NotificationPayload.button_rows?`)
- Modify: `src/notifications/telegram-notification-adapter.ts:115` (call site) and `:146-151` (`toReplyMarkup`) — **protected** (`PROTECTED_FILES`, `self-write-guard.ts:120`): Paco's merge
- Modify: `src/telegram/telegram-daemon.ts` — import; `runSignalPathTick` (`:506`, one call after `checkMeteredCeiling`); one new function after it
- Test: `tests/decisions/digest.test.ts`; add one case to `tests/notifications/telegram-notification-adapter.test.ts`

**Interfaces:**
- Consumes: `REGISTRY`, `AnyEntry` (Task 6); `listDecisionsBetween`, `recordDecisionDigest`, `getDecisionDigest`, `userTurnTextForRun`, `getJevVerdictForRun`, `enqueueNotification`, `inTransaction`, `DecisionRow` (Task 4); `formatInstantInZone`, `resolveDisplayZone` (`src/run/schedule-spec.ts:132-149`).
- Produces: `DEFAULT_DIGEST_AT = "21:00"`, `DIGEST_WINDOW_MS`, `UNSURE_BAND = 0.15`, `UNSURE_MAX = 8`, `REVIEW_PREFIX = "dec:rv:"`, `resolveDigestAt(env): string`, `barOf(entry): number | undefined`, `unsureOf(rows, registry?): DecisionRow[]`, `reviewButtons(decision_id, n): NotificationButton[]`, `interface Digest { text: string; button_rows: NotificationButton[][]; offered: string[] }`, `buildDecisionDigest(store, now, env?, registry?): Digest | null`, `runDecisionDigestTick(i: { store; chatId: string | null; now: string; env?: NodeJS.ProcessEnv }): { ran: false } | { ran: true; sent: boolean }`. `NotificationPayload.button_rows?: NotificationButton[][]`.

- [ ] **Step 1: Write the failing tests `tests/decisions/digest.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { buildDecisionDigest, resolveDigestAt, reviewButtons, runDecisionDigestTick, unsureOf, UNSURE_MAX } from "../../src/decisions/digest.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec §8.1: one message a day, rich-rendered, skipped when empty: up to 8 unsure verdicts (p within 0.15 of the entry's
// bar) with ✅/❌ taps, counts per entry by rung, per-entry health. The line shows Paco's own words for front-door entries
// and never tool text. The latch makes it one message per local date, whatever the poll cadence. Plan ruling 14: a
// front-door row whose verdict does not link it (a turn that never settled) is neither counted nor offered.
const ENV = { HOUGE_DISPLAY_TZ: "Australia/Sydney" };
const NOW = "2026-10-12T11:00:00.000Z"; // 22:00 in Sydney (AEDT, UTC+11)
const D = (o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id: "turn.handler", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_model",
  rung: "jev", verdict: "planner", p: 0.9, reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1,
  created_at: "2026-10-12T05:00:00.000Z", ...o });
/** A turn.handler decision as settleTriage writes it: its run's verdict links it. */
function settled(store: RunStore, o: Partial<DecisionInsert>, text = "x"): { id: string; run_id: string } {
  const run_id = createQueuedTurnRun(store, text);
  const id = store.insertDecision(D({ run_id, ...o }));
  store.insertJevVerdict({ run_id, category: null, breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "planner",
    role: "default", effort: null, cascade: null, save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null,
    quoted_turn_id: null, decision_id: id });
  return { id, run_id };
}

describe("unsureOf", () => {
  it("keeps applied Jev decisions within 0.15 of the entry's bar (turn.handler: 0.6), newest first, at most 8", () => {
    const store = RunStore.openInMemory();
    store.insertDecision(D({ p: 0.9 }));                           // sure
    store.insertDecision(D({ p: 0.5, armed_mode: "shadow" }));     // shadow: not applied, not offered
    store.insertDecision(D({ p: 0.5, rung: "rule" }));             // a rule decided
    store.insertDecision(D({ entry_id: "turn.gear", p: 0.5 }));    // turn.gear has no single bar
    for (let k = 0; k < 10; k += 1) store.insertDecision(D({ p: 0.46 + k * 0.01, created_at: `2026-10-12T06:0${k}:00.000Z` }));
    const rows = unsureOf(store.listDecisionsBetween("2026-10-11T11:00:00.000Z", NOW));
    expect(rows).toHaveLength(UNSURE_MAX);
    expect(rows[0]?.p).toBeCloseTo(0.55);
    expect(rows.every((r) => r.entry_id === "turn.handler" && r.rung === "jev" && r.armed_mode === "on")).toBe(true);
    store.close();
  });
});

describe("buildDecisionDigest", () => {
  it("null on a day with no decisions (skipped when empty)", () => {
    const store = RunStore.openInMemory();
    expect(buildDecisionDigest(store, NOW, ENV)).toBeNull();
    store.close();
  });
  it("renders unsure, counts and health; the line carries Paco's own words (markdown stripped, 40 code points), no tool text", () => {
    const store = RunStore.openInMemory();
    const { id, run_id } = settled(store, { p: 0.58 });
    store.recordChatTurn({ chat_id: "555", run_id, role: "user", text: "**明天** 悉尼 [天气] 怎么样？ 顺便 看看 后天 的 风 和 湿度 还有 紫外线 指数 多少" });
    settled(store, { rung: "fail", fallback_reason: "outage", fallback_rung: "jev", reason_code: "transport", p: null });
    settled(store, { rung: "rule", reason_code: "ack_rule", p: null });
    const g = buildDecisionDigest(store, NOW, ENV)!;
    expect(g.text).toContain("🪜 *Decisions — 2026-10-12*");
    expect(g.text).toContain("1. turn.handler → planner · p 0.58 · 16:00 · «明天 悉尼 天气 怎么样？ 顺便 看看 后天 的 风 和 湿度 还有 紫外线 指»");
    expect(g.text).toContain("· turn.handler 3 — rule 1 · jev 1 · fail 1");
    expect(g.text).toContain("· turn.handler: 1 Jev skip · 1 fallback");
    expect(g.offered).toEqual([id]);
    expect(g.button_rows).toEqual([reviewButtons(id, 1)]);
    store.close();
  });
  it("a front-door row no verdict links (a turn that never settled) is neither counted nor offered", () => {
    const store = RunStore.openInMemory();
    const orphan = store.insertDecision(D({ run_id: createQueuedTurnRun(store, "x"), p: 0.6 }));
    const { id } = settled(store, { p: 0.62 });
    const g = buildDecisionDigest(store, NOW, ENV)!;
    expect(g.offered).toEqual([id]);
    expect(g.offered).not.toContain(orphan);
    expect(g.text).toContain("· turn.handler 1 — jev 1");
    store.close();
  });
  it("a snippet never splits an emoji (code points, not UTF-16 units)", () => {
    const store = RunStore.openInMemory();
    const { run_id } = settled(store, { p: 0.6 });
    store.recordChatTurn({ chat_id: "555", run_id, role: "user", text: `${"a".repeat(39)}😀tail` });
    expect(buildDecisionDigest(store, NOW, ENV)!.text).toContain(`«${"a".repeat(39)}😀»`);
    store.close();
  });
  it("review buttons carry dec:rv:<id>:<ok|bad> within Telegram's 64-byte callback limit", () => {
    const id = "dec_00000000-0000-0000-0000-000000000000";
    expect(reviewButtons(id, 3)).toEqual([{ text: "✅ 3", data: `dec:rv:${id}:ok` }, { text: "❌ 3", data: `dec:rv:${id}:bad` }]);
    expect(Buffer.byteLength(`dec:rv:${id}:bad`)).toBeLessThanOrEqual(64);
  });
});

describe("runDecisionDigestTick", () => {
  it("before HOUGE_DECISION_DIGEST_AT nothing runs; after it, one message per local date with the offered ids latched", () => {
    const store = RunStore.openInMemory();
    const { id } = settled(store, { p: 0.6 });
    const env = { ...ENV, HOUGE_DECISION_DIGEST_AT: "22:30" };
    expect(runDecisionDigestTick({ store, chatId: "555", now: NOW, env })).toEqual({ ran: false });          // 22:00 < 22:30
    const later = "2026-10-12T11:40:00.000Z";                                                                 // 22:40
    expect(runDecisionDigestTick({ store, chatId: "555", now: later, env })).toEqual({ ran: true, sent: true });
    expect(runDecisionDigestTick({ store, chatId: "555", now: "2026-10-12T12:00:00.000Z", env })).toEqual({ ran: false });
    const sent = [...drainOutbox(store).values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]?.button_rows).toEqual([reviewButtons(id, 1)]);
    expect(store.getDecisionDigest("2026-10-12")).toMatchObject({ sent: 1, offered: [id] });
    store.close();
  });
  it("an empty day latches with sent 0 and sends nothing; no operator chat: nothing runs", () => {
    const store = RunStore.openInMemory();
    expect(runDecisionDigestTick({ store, chatId: null, now: NOW, env: ENV })).toEqual({ ran: false });
    expect(runDecisionDigestTick({ store, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: false });
    expect(drainOutbox(store).size).toBe(0);
    expect(store.getDecisionDigest("2026-10-12")).toMatchObject({ sent: 0, offered: [] });
    store.close();
  });
  it("an outbox conflict on today's key latches sent 0 with nothing offered (never a silent 'sent')", () => {
    const store = RunStore.openInMemory();
    settled(store, { p: 0.6 });
    store.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: "decision_digest:2026-10-12",
      correlation_id: "decision-digest", payload: { text: "an older digest" } });
    expect(runDecisionDigestTick({ store, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: false });
    expect(store.getDecisionDigest("2026-10-12")).toMatchObject({ sent: 0, offered: [] });
    store.close();
  });
  it("a malformed HOUGE_DECISION_DIGEST_AT falls back to 21:00", () => {
    expect([resolveDigestAt({}), resolveDigestAt({ HOUGE_DECISION_DIGEST_AT: "9pm" }), resolveDigestAt({ HOUGE_DECISION_DIGEST_AT: "07:05" })]).toEqual(["21:00", "21:00", "07:05"]);
  });
});
```

Add to `tests/notifications/telegram-notification-adapter.test.ts`, after the "renders an inline_keyboard…" test (`:105`):

```ts
  // Decision digest (spec §8.1): up to 8 ✅/❌ pairs; Telegram allows 8 buttons per row, so rows are kept as given.
  it("renders button_rows as one keyboard row each, and prefers them over buttons", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({ sendMessage: async (input) => { sent.push(input); return { message_id: 6 }; } });
    const d = dispatch("Digest");
    d.payload = { text: "Digest", buttons: [{ text: "x", data: "x" }], button_rows: [[{ text: "✅ 1", data: "dec:rv:a:ok" }, { text: "❌ 1", data: "dec:rv:a:bad" }],
      [{ text: "✅ 2", data: "dec:rv:b:ok" }, { text: "❌ 2", data: "dec:rv:b:bad" }]] };
    await adapter.send(d);
    expect(sent[0]?.reply_markup).toEqual({ inline_keyboard: [
      [{ text: "✅ 1", callback_data: "dec:rv:a:ok" }, { text: "❌ 1", callback_data: "dec:rv:a:bad" }],
      [{ text: "✅ 2", callback_data: "dec:rv:b:ok" }, { text: "❌ 2", callback_data: "dec:rv:b:bad" }]] });
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/decisions/digest.test.ts tests/notifications/telegram-notification-adapter.test.ts`
Expected: FAIL (digest module missing; the adapter renders a single row from `buttons`).

- [ ] **Step 3: `button_rows` in the payload and the adapter**

`src/notifications/notification-types.ts`, in `NotificationPayload` after `buttons?`:

```ts
  /** Several keyboard rows (the decision digest: one ✅/❌ pair per row); when present the adapter renders these instead of `buttons`. */
  button_rows?: NotificationButton[][];
```

`src/notifications/telegram-notification-adapter.ts` (protected): change the call at `:115` to `const reply_markup = toReplyMarkup(notification.payload);`
and replace `toReplyMarkup` (`:146-151`) with:

```ts
function toReplyMarkup(payload: NotificationPayload): TelegramInlineKeyboardMarkup | undefined {
  const rows = buttonRowsOf(payload.button_rows) ?? (payload.buttons && payload.buttons.length > 0 ? [payload.buttons] : null);
  if (!rows) return undefined;
  return { inline_keyboard: rows.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) };
}

/** Rows only when every row is a non-empty list of {text, data}; anything else falls back to `buttons` (the payload is stored JSON). */
function buttonRowsOf(v: unknown): NotificationButton[][] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const ok = v.every((row) => Array.isArray(row) && row.length > 0
    && row.every((b) => typeof (b as NotificationButton)?.text === "string" && typeof (b as NotificationButton)?.data === "string"));
  return ok ? (v as NotificationButton[][]) : null;
}
```

(import `type NotificationPayload` beside the adapter's existing `NotificationButton` import.)

- [ ] **Step 4: Write `src/decisions/digest.ts`**

```ts
import type { NotificationButton } from "../notifications/notification-types.js";
import type { DecisionRow, RunStore } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import { REGISTRY } from "./registry.js";
import type { AnyEntry } from "./types.js";

/**
 * The daily decision digest (spec §8.1), stage 1 content: unsure verdicts with ✅/❌ taps, counts per entry by rung, and
 * per-entry health. Improvements, proposals and the gaming watch join in stage 2b. One message per local date at
 * HOUGE_DECISION_DIGEST_AT, through the outbox and the rich renderer; skipped when the day has no decisions.
 */
export const DEFAULT_DIGEST_AT = "21:00";
export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
export const UNSURE_BAND = 0.15;
export const UNSURE_MAX = 8;
export const REVIEW_PREFIX = "dec:rv:";
const SNIPPET_CHARS = 40;
const RUNG_ORDER = ["rule", "jev", "model", "paco", "fail"] as const;
/** Entries decided over Paco's own message: their unsure line may quote his words (never tool text, plan ruling 10). */
const PACO_TEXT_STAGES: ReadonlySet<string> = new Set(["intake", "pre_model"]);
/** Entries whose rows settleTriage writes with the turn's verdict (plan ruling 14). */
const FRONT_DOOR: ReadonlySet<string> = new Set(["turn.handler", "turn.gear"]);

export function resolveDigestAt(env: NodeJS.ProcessEnv): string {
  const raw = env.HOUGE_DECISION_DIGEST_AT?.trim();
  return raw !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_DIGEST_AT;
}

/** The entry's single probability bar (its Jev rung's), when it has one. */
export function barOf(entry: AnyEntry): number | undefined {
  const jev = entry.ladder.find((r) => r.kind === "jev");
  return jev?.kind === "jev" ? jev.bars.p : undefined;
}

/** Applied Jev decisions within UNSURE_BAND of their entry's bar, newest first, at most UNSURE_MAX. */
export function unsureOf(rows: readonly DecisionRow[], registry: readonly AnyEntry[] = REGISTRY): DecisionRow[] {
  const bars = new Map(registry.map((e) => [e.id, barOf(e)] as const));
  return rows.filter((r) => {
    const bar = bars.get(r.entry_id);
    return r.rung === "jev" && r.armed_mode === "on" && r.p !== null && bar !== undefined && Math.abs(r.p - bar) <= UNSURE_BAND + 1e-9;
  }).slice(-UNSURE_MAX).reverse();
}

export function reviewButtons(decision_id: string, n: number): NotificationButton[] {
  const ok = `${REVIEW_PREFIX}${decision_id}:ok`;
  const bad = `${REVIEW_PREFIX}${decision_id}:bad`;
  if (Buffer.byteLength(bad, "utf8") > 64) throw new Error("review callback_data exceeds 64 bytes");
  return [{ text: `✅ ${n}`, data: ok }, { text: `❌ ${n}`, data: bad }];
}

/** Code points, not UTF-16 units: a split surrogate pair would make Telegram reject the HTML send. */
const snippetOf = (text: string): string => Array.from(text.replace(/[*_`[\]<>]/g, " ").replace(/\s+/g, " ").trim()).slice(0, SNIPPET_CHARS).join("");

/**
 * Plan ruling 14: a front-door row counts only when its run's verdict links it. Stage 1 writes the two atomically, so this
 * only guards a future path that leaves a row behind (a lost or killed turn must never be offered for review).
 */
function settledRows(store: RunStore, rows: readonly DecisionRow[]): DecisionRow[] {
  return rows.filter((r) => {
    if (!FRONT_DOOR.has(r.entry_id)) return true;
    const linked = r.run_id ? store.getJevVerdictForRun(r.run_id)?.decision_id ?? null : null;
    return linked !== null && (r.entry_id !== "turn.handler" || linked === r.decision_id);
  });
}

function unsureLine(store: RunStore, r: DecisionRow, n: number, tz: string, registry: readonly AnyEntry[]): string {
  const entry = registry.find((e) => e.id === r.entry_id);
  const words = entry && PACO_TEXT_STAGES.has(entry.stage) && r.run_id ? store.userTurnTextForRun(r.run_id) : undefined;
  const at = formatInstantInZone(r.created_at, tz).slice(11);
  return `${n}. ${r.entry_id} → ${r.verdict} · p ${r.p!.toFixed(2)} · ${at}${words ? ` · «${snippetOf(words)}»` : ""}`;
}

function countLines(rows: readonly DecisionRow[]): string[] {
  const by = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = by.get(r.entry_id) ?? new Map<string, number>();
    m.set(r.rung, (m.get(r.rung) ?? 0) + 1);
    by.set(r.entry_id, m);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, m]) => {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return `· ${id} ${total} — ${RUNG_ORDER.filter((k) => m.has(k)).map((k) => `${k} ${m.get(k)}`).join(" · ")}`;
  });
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Per entry (spec §5.2): Jev skips (a failure on the Jev rung, budget excluded: codex W6), named fallbacks (budget
 * excluded), and rows run in the configured triage shadow when there are any; entries with nothing to report are left out.
 */
function healthLines(rows: readonly DecisionRow[]): string[] {
  const ids = [...new Set(rows.map((r) => r.entry_id))].sort();
  return ids.flatMap((id) => {
    const mine = rows.filter((r) => r.entry_id === id);
    const skips = mine.filter((r) => r.fallback_rung === "jev" && r.fallback_reason !== null && r.fallback_reason !== "budget").length;
    const fallbacks = mine.filter((r) => r.rung === "fail" && r.fallback_reason !== null && r.fallback_reason !== "budget").length;
    const shadowed = mine.filter((r) => r.armed_mode === "shadow").length;
    if (skips + fallbacks + shadowed === 0) return [];
    return [`· ${id}: ${plural(skips, "Jev skip")} · ${plural(fallbacks, "fallback")}${shadowed > 0 ? ` · ${shadowed} in configured shadow` : ""}`];
  });
}

export interface Digest { text: string; button_rows: NotificationButton[][]; offered: string[] }

export function buildDecisionDigest(store: RunStore, now: string, env: NodeJS.ProcessEnv = process.env, registry: readonly AnyEntry[] = REGISTRY): Digest | null {
  const rows = settledRows(store, store.listDecisionsBetween(new Date(Date.parse(now) - DIGEST_WINDOW_MS).toISOString(), now));
  if (rows.length === 0) return null;
  const tz = resolveDisplayZone(env);
  const unsure = unsureOf(rows, registry);
  const sections = [`🪜 *Decisions — ${formatInstantInZone(now, tz).slice(0, 10)}*`];
  if (unsure.length > 0) sections.push(["*Unsure* (✅ right · ❌ wrong)", ...unsure.map((r, k) => unsureLine(store, r, k + 1, tz, registry))].join("\n"));
  sections.push(["*Counts (24 h)*", ...countLines(rows)].join("\n"));
  const health = healthLines(rows);
  if (health.length > 0) sections.push(["*Health*", ...health].join("\n"));
  return { text: sections.join("\n\n"), button_rows: unsure.map((r, k) => reviewButtons(r.decision_id, k + 1)), offered: unsure.map((r) => r.decision_id) };
}

export interface DigestTickInput { store: RunStore; chatId: string | null; now: string; env?: NodeJS.ProcessEnv }
export type DigestTickResult = { ran: false } | { ran: true; sent: boolean };

/** Due once per local date at or after HOUGE_DECISION_DIGEST_AT; the latch row and the message commit together. */
export function runDecisionDigestTick(i: DigestTickInput): DigestTickResult {
  const env = i.env ?? process.env;
  if (!i.chatId) return { ran: false };
  const chatId = i.chatId;
  const [date, time] = formatInstantInZone(i.now, resolveDisplayZone(env)).split(" ") as [string, string];
  if (time < resolveDigestAt(env) || i.store.getDecisionDigest(date)) return { ran: false };
  const digest = buildDecisionDigest(i.store, i.now, env);
  return i.store.inTransaction((): DigestTickResult => {
    if (i.store.getDecisionDigest(date)) return { ran: false };
    const sent = digest !== null && enqueueDigest(i.store, chatId, date, digest);
    i.store.recordDecisionDigest({ local_date: date, sent, offered: digest && sent ? digest.offered : [], created_at: i.now });
    return { ran: true, sent };
  });
}

/** False on an idempotency conflict (another payload already holds today's key): the day latches sent 0, logged, never a silent "sent". */
function enqueueDigest(store: RunStore, chatId: string, date: string, digest: Digest): boolean {
  const r = store.enqueueNotification({ target: { kind: "telegram", chat_id: chatId }, intent_type: "progress", idempotency_key: `decision_digest:${date}`,
    correlation_id: "decision-digest", payload: { text: digest.text, ...(digest.button_rows.length > 0 ? { button_rows: digest.button_rows } : {}) } });
  if (r.status !== "conflict") return true;
  console.error(`decisions: digest for ${date} not queued (${r.error})`);
  return false;
}
```

Check against the test before running: the unsure line for `p 0.58` created at `05:00Z` renders `16:00` in Sydney (UTC+11
on 2026-10-12); the snippet strips `*`, `[`, `]`, collapses spaces and keeps 40 code points.

- [ ] **Step 5: Wire the tick (`src/telegram/telegram-daemon.ts`)**

Add `import { runDecisionDigestTick } from "../decisions/digest.js";` with the other imports. In `runSignalPathTick`, after
`checkMeteredCeiling({ … });` (`:506`) add `runDigestTick(options.store, chatId, now);`, and after `runSignalPathTick` add:

```ts
/** Spec §8.1: the daily decision digest. Its own catch: a failed digest never skips the sweep after it. */
function runDigestTick(store: RunTelegramDaemonOptions["store"], chatId: string | null, now: string): void {
  try {
    runDecisionDigestTick({ store, chatId, now });
  } catch (error) {
    console.error(`[telegram-daemon] decision digest tick failed: ${errorCode(error)}`);
  }
}
```

- [ ] **Step 6: Run**

Run: `npx vitest run tests/decisions/ tests/notifications/ tests/telegram/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit (protected: `telegram-notification-adapter.ts` and `src/decisions/` — Paco's merge)**

```bash
git add src/decisions/digest.ts src/notifications/notification-types.ts src/notifications/telegram-notification-adapter.ts src/telegram/telegram-daemon.ts tests/decisions/digest.test.ts tests/notifications/telegram-notification-adapter.test.ts
git commit -m "feat(decisions): the daily digest with unsure verdicts, counts and health; keyboard rows"
```

## Task 11: The ✅/❌ review tap — `dec:rv:<decision_id>:<ok|bad>` → a `decision_outcomes` label

**Files:**
- Modify: `src/triggers/telegram-command-parser.ts` (after `parseMemLaneCallback`, `:331`)
- Modify: `src/triggers/telegram-trigger-adapter.ts:6` (import), `:272-273` (one parser after `memlane`), new builder after `buildMemLaneTapEvent` (`:346`)
- Modify: `src/domain/types.ts:4` (`TaskEventType` gains `"decision_review"`), `tests/domain/types.test.ts:31` (the union)
- Create: `src/gateway/decision-commands.ts`
- Modify: `src/gateway/gateway.ts` — import; the rate-limit exemption (`:154`); `GatewayIntakeResult` (`:72`, one variant); dispatch beside `memlane_undo` (`:187`)
- Modify: `src/run/run-store.ts` — `checkTelegramRateLimit`'s window query (`:2239-2246`): review taps do not count — **protected** (Paco's merge)
- Test: `tests/triggers/decision-review-callback.test.ts`, `tests/gateway/decision-commands.test.ts`

**Interfaces:**
- Consumes: `LC_UUID` (`telegram-command-parser.ts:317`); `authorizeTelegramUpdate` inside `normalizeCallbackQuery`; `oncePerTrigger`, `replyTo` (`src/gateway/memory-commands.ts:19-36`); `getDecision`, `wasDecisionOffered`, `insertDecisionOutcome`, `recordDecisionDigest` (Task 4); `OutcomeRejected` (Task 4); `checkTelegramRateLimit`, `recordTelegramCommandAudit` (`run-store.ts:2237`).
- Produces: `parseDecisionReviewCallback(data: unknown): { decision_id: string; label: "ok" | "bad" } | null`; event type `decision_review` with `metadata.decision_id`, `metadata.label`; `handleDecisionReview(store, event, now?): GatewayIntakeResult`; `REVIEW_STALE_MS`, `REVIEW_OK_TEXT`, `REVIEW_BAD_TEXT`, `REVIEW_HANDLED_TEXT`; `GatewayIntakeResult` variant `{ ok: true; status: "decision_reviewed"; run_id: string }`. Every review outcome is `ok: true`, so `HANDLED_INTAKE_DENIAL_CODES` needs no new code.

- [ ] **Step 1: Write the failing tests**

`tests/triggers/decision-review-callback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseDecisionReviewCallback } from "../../src/triggers/telegram-command-parser.js";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";

// Spec §8.1: a digest tap is a label Paco gives; only exact shapes parse, and the tapping user passes the same allowlist as a
// message sender before anything is read, so a stranger's tap never writes a label.
const ID = "dec_0f8fad5b-d9cb-469f-a165-70867728950e";
const allowlist = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] };
const tap = (from: number, data: string) => normalizeTelegramUpdate({ update_id: 3000, callback_query: { id: "cbq_9", from: { id: from }, message: { message_id: 5, chat: { id: 222 } }, data } }, allowlist);

describe("parseDecisionReviewCallback", () => {
  it("parses ok and bad, and refuses every other shape", () => {
    expect(parseDecisionReviewCallback(`dec:rv:${ID}:ok`)).toEqual({ decision_id: ID, label: "ok" });
    expect(parseDecisionReviewCallback(`dec:rv:${ID}:bad`)).toEqual({ decision_id: ID, label: "bad" });
    for (const bad of [`dec:rv:${ID}:unsure`, `dec:rv:${ID}`, `dec:rv:dec_x:ok`, `dec:rv:${ID}:ok:x`, `xdec:rv:${ID}:ok`, 42, null]) {
      expect(parseDecisionReviewCallback(bad)).toBeNull();
    }
  });
});

describe("the review tap through the adapter", () => {
  it("an allowlisted tap becomes a decision_review event carrying the id and label", () => {
    const r = tap(111, `dec:rv:${ID}:bad`);
    expect(r).toMatchObject({ ok: true, event: { type: "decision_review", requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:3000:callback:cbq_9", metadata: { decision_id: ID, label: "bad", telegram_callback_id: "cbq_9" } } });
  });
  it("a tap from a user outside the allowlist is refused before parsing", () => {
    expect(tap(999, `dec:rv:${ID}:bad`)).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });
});
```

`tests/gateway/decision-commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { REVIEW_BAD_TEXT, REVIEW_HANDLED_TEXT, REVIEW_OK_TEXT } from "../../src/gateway/decision-commands.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec §8.1: a tap writes one decision_outcomes label and replies; it is one-shot (a second tap, an unknown id or one no
// digest offered in the last 7 days answers "Already handled." and writes nothing); a redelivered update replies once.
// Plan ruling 16: the 5-a-minute command limit neither drops a tap nor counts taps against Paco's next real command.
const NOW = "2026-10-12T11:00:00.000Z";
let seq = 0;
const tap = (decision_id: string, label: string, key = `k${++seq}`) => buildTypedTaskEvent({ source: "telegram", type: "decision_review",
  requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" }, idempotency_key: key, source_reference: key,
  metadata: { telegram_update_id: seq, telegram_callback_id: key, decision_id, label } });
const decision = (store: RunStore): string => store.insertDecision({ entry_id: "turn.handler", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_model",
  rung: "jev", verdict: "planner", p: 0.6, reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1 });
/** `n` decisions offered by one digest dated by `created_at` (one latch row per local date). */
function offeredMany(store: RunStore, n: number, created_at = "2026-10-12T10:00:00.000Z"): string[] {
  const ids = Array.from({ length: n }, () => decision(store));
  store.recordDecisionDigest({ local_date: created_at.slice(0, 10), sent: true, offered: ids, created_at });
  return ids;
}
const offered = (store: RunStore, created_at?: string): string => offeredMany(store, 1, created_at)[0]!;
const replies = (store: RunStore) => [...drainOutbox(store).values()].map((p) => p.text);

describe("decision_review taps", () => {
  it("❌ writes review_bad (value: the entry id, source paco) and replies once", () => {
    const store = RunStore.openInMemory();
    const id = offered(store);
    expect(new Gateway(store).intake(tap(id, "bad"), NOW)).toMatchObject({ ok: true, status: "decision_reviewed" });
    expect(store.listDecisionOutcomes(id).map((o) => [o.signal, o.value, o.source])).toEqual([["review_bad", "turn.handler", "paco"]]);
    expect(replies(store)).toEqual([REVIEW_BAD_TEXT]);
    store.close();
  });
  it("a second tap (either button) answers Already handled and writes nothing", () => {
    const store = RunStore.openInMemory();
    const id = offered(store);
    new Gateway(store).intake(tap(id, "ok"), NOW);
    new Gateway(store).intake(tap(id, "bad"), NOW);
    expect(store.listDecisionOutcomes(id)).toHaveLength(1);
    expect(replies(store)).toEqual([REVIEW_OK_TEXT, REVIEW_HANDLED_TEXT]);
    store.close();
  });
  it("an unknown id, a decision no digest offered, and one offered 8 days ago: Already handled, nothing written", () => {
    const store = RunStore.openInMemory();
    const stale = offered(store, "2026-10-04T10:00:00.000Z");
    const never = decision(store);
    for (const id of ["dec_00000000-0000-0000-0000-000000000000", never, stale]) new Gateway(store).intake(tap(id, "bad"), NOW);
    expect([store.listDecisionOutcomes(never), store.listDecisionOutcomes(stale)]).toEqual([[], []]);
    expect(replies(store)).toEqual([REVIEW_HANDLED_TEXT, REVIEW_HANDLED_TEXT, REVIEW_HANDLED_TEXT]);
    store.close();
  });
  it("a redelivered update (same idempotency key) is replayed, not re-applied: one reply", () => {
    const store = RunStore.openInMemory();
    const id = offered(store);
    new Gateway(store).intake(tap(id, "bad", "same"), NOW);
    new Gateway(store).intake(tap(id, "bad", "same"), NOW);
    expect(replies(store)).toEqual([REVIEW_BAD_TEXT]);
    store.close();
  });
  it("8 taps in one minute all write labels and do not use up the command window; the limit still holds for other commands", () => {
    const store = RunStore.openInMemory();
    const ids = offeredMany(store, 8);
    for (const id of ids) expect(new Gateway(store).intake(tap(id, "bad"), NOW)).toMatchObject({ ok: true, status: "decision_reviewed" });
    expect(ids.every((id) => store.listDecisionOutcomes(id).length === 1)).toBe(true);
    const limit = () => store.checkTelegramRateLimit({ actor_id: "paco", chat_id: "555", command: "turn", now: NOW }).ok;
    expect(limit()).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      store.recordTelegramCommandAudit({ actor_id: "paco", chat_id: "555", command: "turn", source_reference: `s${i}`, decision: "accepted", occurred_at: NOW });
    }
    expect(limit()).toBe(false);
    store.close();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/triggers/decision-review-callback.test.ts tests/gateway/decision-commands.test.ts`
Expected: FAIL (`parseDecisionReviewCallback` missing; `decision_review` is not a `TaskEventType`).

- [ ] **Step 3: Parser (`src/triggers/telegram-command-parser.ts`, after `parseMemLaneCallback`)**

```ts
const DEC_REVIEW = new RegExp(`^dec:rv:(dec_${LC_UUID}):(ok|bad)$`);

/** Decision digest taps (decision ladder spec §8.1): `dec:rv:<decision_id>:<ok|bad>`, ≤ 51 bytes; anything else returns null. */
export function parseDecisionReviewCallback(data: unknown): { decision_id: string; label: "ok" | "bad" } | null {
  if (typeof data !== "string") return null;
  const m = DEC_REVIEW.exec(data);
  return m ? { decision_id: m[1]!, label: m[2] as "ok" | "bad" } : null;
}
```

- [ ] **Step 4: Event type and adapter**

`src/domain/types.ts:4`: append `| "decision_review"` to `TaskEventType`; `tests/domain/types.test.ts:31`: append `| "decision_review"` to the expected union.

`src/triggers/telegram-trigger-adapter.ts`: add `parseDecisionReviewCallback` to the parser import (`:6`); in
`normalizeCallbackQuery`, after the `memlane` line (`:273`):

```ts
  const review = parseDecisionReviewCallback(callback.data);
  if (review) return { ok: true, event: buildDecisionReviewTapEvent(update, callback, message.chat.id, auth.identity, review) };
```

and after `buildMemLaneTapEvent` (`:346`):

```ts
/** A decision digest tap (decision ladder §8.1): the approval tap's shape, with the decision id and label in metadata. */
function buildDecisionReviewTapEvent(
  update: TelegramUpdate, callback: TelegramCallbackQuery, chat_id: number, identity: Identity, review: { decision_id: string; label: "ok" | "bad" }
): TypedTaskEvent {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "decision_review",
    requested_by: identity,
    notify: { kind: "telegram", chat_id: String(chat_id) },
    idempotency_key: `telegram:${update.update_id}:callback:${callback.id}`,
    source_reference: `telegram:update:${update.update_id}:callback:${callback.id}`,
    metadata: { telegram_update_id: update.update_id, telegram_callback_id: callback.id, decision_id: review.decision_id, label: review.label }
  });
}
```

- [ ] **Step 5: Write `src/gateway/decision-commands.ts`**

```ts
import { OutcomeRejected } from "../decisions/outcomes.js";
import type { TypedTaskEvent } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/**
 * Decision digest taps (decision ladder spec §8.1). The adapter already passed the sender allowlist. A tap writes one
 * `decision_outcomes` label for a decision a digest offered in the last REVIEW_STALE_MS, once; anything else replies
 * REVIEW_HANDLED_TEXT and writes nothing. Labels feed `improve.route` from stage 2b.
 */
export const REVIEW_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_OK_TEXT = "✅ Noted: right.";
export const REVIEW_BAD_TEXT = "❌ Noted: wrong. It goes into the next review.";
export const REVIEW_HANDLED_TEXT = "Already handled.";
const reviewed = (): GatewayIntakeResult => ({ ok: true, status: "decision_reviewed", run_id: "" });

export function handleDecisionReview(store: RunStore, event: TypedTaskEvent, now: string = new Date().toISOString()): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const id = typeof event.metadata?.decision_id === "string" ? event.metadata.decision_id : "";
    const raw = event.metadata?.label;
    const label = raw === "ok" || raw === "bad" ? raw : null;
    const decision = id ? store.getDecision(id) : undefined;
    const since = new Date(Date.parse(now) - REVIEW_STALE_MS).toISOString();
    if (!decision || !label || !store.wasDecisionOffered(id, since)) {
      replyTo(store, event, "decision_review", REVIEW_HANDLED_TEXT);
      return reviewed();
    }
    replyTo(store, event, "decision_review", labelOnce(store, decision.decision_id, decision.entry_id, label, now));
    return reviewed();
  });
}

/** One label per decision (the store's unique index); an entry id the registry no longer has is answered as handled. */
function labelOnce(store: RunStore, decision_id: string, entry_id: string, label: "ok" | "bad", now: string): string {
  try {
    const r = store.insertDecisionOutcome({ decision_id, signal: label === "ok" ? "review_ok" : "review_bad", value: entry_id, source: "paco", created_at: now });
    if (!r.inserted) return REVIEW_HANDLED_TEXT;
    return label === "ok" ? REVIEW_OK_TEXT : REVIEW_BAD_TEXT;
  } catch (e) {
    if (e instanceof OutcomeRejected) return REVIEW_HANDLED_TEXT;
    throw e;
  }
}
```

- [ ] **Step 6: Gateway dispatch and the rate-limit exemption (`src/gateway/gateway.ts`, `src/run/run-store.ts`)**

In `src/gateway/gateway.ts`, add at module level (beside the other constants):

```ts
/** ADR 0018 + decision ladder plan ruling 16: commands the per-chat rate limit never delays (kill; digest review taps). */
const RATE_LIMIT_EXEMPT: ReadonlySet<string> = new Set(["kill", "decision_review"]);
```

and change the condition at `:154` from `event.source === "telegram" && event.type !== "kill"` to
`event.source === "telegram" && !RATE_LIMIT_EXEMPT.has(event.type)` (extend the comment above it: "…and a digest review
tap: allowlisted, one-shot, one closed-enum label; a dropped tap would look labelled").

In `src/run/run-store.ts` `checkTelegramRateLimit` (`:2239-2246`), add `AND command <> 'decision_review'` after
`AND decision = 'accepted'` in the window query, with the comment `-- review taps are exempt and never count (ruling 16)`.

Add `import { handleDecisionReview } from "./decision-commands.js";` beside the memlane import (`:46`); add
`| { ok: true; status: "decision_reviewed"; run_id: string }` to `GatewayIntakeResult` after `lesson_change_undone`
(`:72`); after the `memlane_undo` line (`:187`):

```ts
    if (event.type === "decision_review") return this.accepted(event, now, handleDecisionReview(this.runStore, event, now));
```

- [ ] **Step 7: Run**

Run: `npx vitest run tests/triggers/ tests/gateway/ tests/domain/ tests/run/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit (protected: `run-store.ts` — Paco's merge)**

```bash
git add src/triggers/telegram-command-parser.ts src/triggers/telegram-trigger-adapter.ts src/domain/types.ts tests/domain/types.test.ts src/gateway/decision-commands.ts src/gateway/gateway.ts src/run/run-store.ts tests/triggers/decision-review-callback.test.ts tests/gateway/decision-commands.test.ts
git commit -m "feat(gateway): digest review taps write one decision_outcomes label"
```

## Task 12: Live gate `scripts/live-gate-decisions-parity.mjs` — the P6 dual run, the digest, the ❌ tap

Spec §6.2 P6 and §13 row 1's PASS. Runs real Jev (about 400–460 calls with retries), no planner, no lanes, no Telegram,
no outbox delivery, against two `VACUUM INTO` copies of one frozen snapshot of the live DB. Gates import `dist/`, so both
builds are built first — each in its own worktree. **Nothing in this task runs `npm run build` in the main checkout**:
the daemon executes `/Users/xiaochuan/Projects/adventure/dist`, and a relaunch would run unmerged code and migrate the
live DB. The script refuses to run unless its own `dist/` is under `.worktrees/`.

**Files:**
- Create: `scripts/live-gate-decisions-parity.mjs`

**Interfaces:**
- Consumes (from each build's `dist/`): `CoreWorker` (`triageTurn`, `buildOmpTools`, 13-arg constructor, `ompOptions.jevNow`), `Gateway`, `RunStore` (`open`, `claimRun`, `recordChatTurn`, `listJevDecisions`, `getJevVerdictForRun`, `getLedgerEvents`), `buildTypedTaskEvent`, `loadHougeEnv`, `DISARM_FLAGS`, `resolveChatContextTurns`, `chatContextSince`; new build only: `listDecisionsForRun`, `listDecisionOutcomes`, `getDecisionDigest`, `claimNextNotification`, `buildDecisionDigest`, `runDecisionDigestTick`, `normalizeTelegramUpdate`, `CALIBRATED_ROWS`, `TelegramNotificationAdapter`.
- Produces: exit 0 PASS · 1 FAIL · 2 setup error · 3 INCONCLUSIVE (a required check could not run; never a PASS).

- [ ] **Step 1: Build both dists, each in its own worktree (once)**

```bash
cd /Users/xiaochuan/Projects/adventure
git worktree add .worktrees/p6-base 3bff437
(cd .worktrees/p6-base && npm ci && npm run build)
(cd .worktrees/decision-ladder-stage-1 && npm run build)
```

3bff437 is the pre-stage-1 code (3bff437..1b65de4 is docs only). Task 13's rollback check reuses `.worktrees/p6-base/dist`.

- [ ] **Step 2: Write `scripts/live-gate-decisions-parity.mjs`**

```js
#!/usr/bin/env node
// Live gate — decision ladder stage 1 (spec 2026-10-12 §6.2 P6, §13 row 1).
//
//   Run from the feature worktree, after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-decisions-parity.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/p6-base/dist [--db <path>] [--limit 200] [--keep]
//
// P6 dual run: for each of the last Telegram user texts in chat_turns, the same triage input — the text, its stored
// previous turns (within the context window, minus a 10-minute margin) seeded into a fresh chat at the same offsets, one
// fixed clock for both builds — goes through CoreWorker.triageTurn in the pre-stage-1 dist (copy A) and in this build's
// dist (copy B). Real Jev, one call per text per build, paced. Lanes, planner, Telegram and the outbox are stubbed: the
// cascade stub picks the first candidate, every other seat fails, search and fetch fail. Later jev_verdicts mutations are
// covered by the Task 2 pin and Task 8b tests, not here.
// Compared projection: every jev_decisions and jev_verdicts column the OLD schema has and the triage event payload, except
// ids, timestamps and latency_ms; the triage event's verdict_id is compared as a link.
// Classification (codex B2, re-review #2): structure first — the outcome kind, question order, statuses, skip reasons,
// verdict presence and the triage link. A structural difference where a side shows a retryable Jev failure (timeout,
// transport, 429, overloaded, auth, parse) or the two sides' Jev answers differ is retried once with a fresh chat and
// clock; a structural difference that persists after that retry is a MISMATCH, never inconclusive (spec: any structural
// difference is a mismatch). Only a structurally identical pair whose Jev probabilities (or reported model) differ is
// "Jev nondeterminism", and only a structurally identical pair whose sides failed Jev the same way is inconclusive.
// Neither ever passes.
// PASS: ≥ 190 deterministic pairs before 200 decided (candidates over-fetched by 30), 0 mismatches; the coverage floor
// (every answered row reports a calibrated model; ≥ 100 armed turn.handler verdicts; the cascade rung ran); every stage-1
// verdict and Jev row links its turn.handler decision; the digest builds on copy B and renders through the Telegram adapter
// with exactly `dec:rv:<offered id>:ok` / `:bad` per row, the tick sends once, the RENDERED ❌ button's callback writes one
// review_bad outcome, the rendered ✅ then writes nothing, a stranger's tap is refused. Exit: 0 PASS · 1 FAIL · 2 setup error · 3 INCONCLUSIVE. Never opens the live DB
// for writing.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const failures = [];
const inconclusive = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
/** A required check that could not run: never a PASS (exit 3 unless something failed). */
const cannotRun = (name, why) => { console.log(`INCONCLUSIVE ${name} — ${why}`); inconclusive.push(`${name}: ${why}`); };
const SILENT = new Set(["timeout", "transport", "parse", "error", "rate_limited", "overloaded", "auth", "no_key", "fused", "malformed_question"]);
const RETRYABLE = new Set(["timeout", "transport", "rate_limited", "overloaded", "auth", "parse"]);
const ID_COLS = new Set(["decision_id", "run_id", "verdict_id", "ladder_decision_id", "created_at", "updated_at", "latency_ms", "thread_cut_at", "state_built_at"]);
const MARGIN_MS = 10 * 60_000;
const PACE_MS = 250;
const OVERFETCH = 30;
const MIN_DETERMINISTIC = 190;
const MIN_ARMED = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const a = { oldDist: null, db: null, limit: 200, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist") a.oldDist = resolve(argv[++i]);
    else if (argv[i] === "--db") a.db = resolve(argv[++i]);
    else if (argv[i] === "--limit") a.limit = Number(argv[++i]);
    else if (argv[i] === "--keep") a.keep = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!NEW_DIST.includes("/.worktrees/")) throw new Error(`run from the feature worktree (this dist is ${NEW_DIST}); never build in the main checkout`);
  if (!a.oldDist || !existsSync(join(a.oldDist, "core/core-worker.js"))) throw new Error("--old-dist <pre-stage-1 dist> is required (see the header)");
  return a;
}

async function loadBuild(dist, extra = []) {
  const paths = ["core/core-worker.js", "gateway/gateway.js", "run/run-store.js", "domain/types.js", "capabilities/intent.js", ...extra];
  const m = Object.assign({}, ...(await Promise.all(paths.map((p) => import(join(dist, p))))));
  for (const n of ["CoreWorker", "Gateway", "RunStore", "buildTypedTaskEvent", "resolveChatContextTurns", "chatContextSince"]) {
    if (m[n] === undefined) throw new Error(`${dist} lacks ${n}`);
  }
  return m;
}

/** A consistent snapshot through a read-only connection (WAL-safe; the daemon keeps running). */
function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

function guardCopy(path, root, live) {
  if (resolve(path) === live || !resolve(path).startsWith(`${resolve(root)}/`)) throw new Error(`refusing to write outside the gate's temp copy: ${path}`);
}

/**
 * No Telegram, every disarm flag off, markers in the temp root, the tree armed on the committed rows (no calibration
 * file), the answer and lookup lanes on for coverage (both builds see the same env; the live .env is untouched).
 */
function gateEnv(m, root) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID", "HOUGE_JEV_CALIBRATION_FILE", "HOUGE_JEV_GATE", "HOUGE_JEV_LANES_OFF"]) delete process.env[k];
  for (const f of m.DISARM_FLAGS) process.env[f] = "false";
  Object.assign(process.env, {
    HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", HOUGE_JEV_DISARM_PATH: join(root, "houge.jev-disarmed")
  });
}

/** The last N (+ over-fetch) Telegram user texts, oldest first, each with its stored previous turns inside the context window (gaps kept). */
function pickTexts(m, basePath, n) {
  const db = new DatabaseSync(basePath, { readOnly: true });
  try {
    const texts = db.prepare(`SELECT t.chat_id, t.text, t.created_at FROM chat_turns t JOIN runs r ON r.run_id = t.run_id
      WHERE t.role = 'user' AND r.source = 'telegram' ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`).all(n).reverse();
    const ctx = m.resolveChatContextTurns(process.env);
    const prior = db.prepare(`SELECT role, text, intent, created_at FROM chat_turns WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?`);
    return texts.map((t, k) => {
      const at = Date.parse(t.created_at);
      const windowMs = at - Date.parse(m.chatContextSince(process.env, new Date(at)));
      const turns = prior.all(t.chat_id, t.created_at, ctx).reverse().map((p) => ({ role: p.role, text: p.text, intent: p.intent, gapMs: at - Date.parse(p.created_at) }))
        .filter((p) => p.gapMs < windowMs - MARGIN_MS);
      return { k, text: t.text, prior: turns };
    });
  } finally { db.close(); }
}

const firstCandidate = (system) => /nothing else: ([a-z_]+), ([a-z_]+)\./.exec(String(system ?? ""))?.[1] ?? "";
/** The cascade picks the first candidate (deterministic, so the model rung runs); every other seat fails the same way on both sides. */
const stubLlm = async (input) => (/exactly one of these two words/.test(String(input.system ?? ""))
  ? { ok: true, output: { answer: firstCandidate(input.system) } } : { ok: false, error: "stubbed in the parity gate" });
const stubTool = async () => ({ ok: false, error: "stubbed in the parity gate" });

function makeSide(m, dbPath, dist, root, name, clock) {
  const store = m.RunStore.open(dbPath);
  const dir = join(root, name); mkdirSync(join(dir, "project"), { recursive: true });
  const worker = new m.CoreWorker(store, join(dir, "project"), stubLlm, stubTool, undefined, undefined, stubTool, undefined, undefined, async () => null,
    undefined, undefined, { dataDir: dir, distDir: dist, jevNow: () => new Date(clock.t) });
  return { m, store, worker, name, dir };
}

/** Seeds the previous turns into a fresh chat (per attempt) at the same offsets from the shared clock, then admits and claims the turn. */
function admit(side, item, clock, attempt) {
  const chat = `p6c${item.k}a${attempt}`;
  for (const p of item.prior) {
    side.store.recordChatTurn({ chat_id: chat, run_id: `run_p6seed_${item.k}_${attempt}`, role: p.role, text: p.text, ...(p.intent ? { intent: p.intent } : {}),
      created_at: new Date(clock.t - p.gapMs).toISOString() });
  }
  const upd = 900_000 + item.k * 10 + attempt;
  const r = new side.m.Gateway(side.store, undefined, undefined, undefined, undefined, { dataDir: side.dir }).intake(side.m.buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: item.text, requested_by: { kind: "user", id: "p6" }, notify: { kind: "telegram", chat_id: chat },
    idempotency_key: `telegram:${upd}:${item.k}`, source_reference: `telegram:update:${upd}:message:${item.k}`, metadata: { telegram_update_id: upd, telegram_message_id: item.k } }));
  if (!r.ok || r.status !== "created") return null;
  const claim = side.store.claimRun(r.run_id, "p6", 120);
  side.worker.buildOmpTools(claim, chat);
  return { run_id: r.run_id, input: { claim, text: item.text, userText: item.text, modality: "text", posture: null, signal: new AbortController().signal } };
}

const pick = (cols) => (row) => Object.fromEntries(cols.filter((c) => !ID_COLS.has(c)).map((c) => [c, row[c]]));

/** One side's projection over the OLD schema's columns; the triage event's verdict_id becomes a link check. */
function project(side, run_id, cols) {
  const v = side.store.getJevVerdictForRun(run_id);
  const triage = side.store.getLedgerEvents(run_id).filter((e) => e.event_type === "triage")
    .map((e) => ({ ...e.payload, verdict_id: v && e.payload.verdict_id === v.verdict_id ? "<own verdict>" : "<other>" }));
  return { jd: side.store.listJevDecisions(run_id).map(pick(cols.jd)), v: v ? pick(cols.jv)(v) : null, triage };
}

function columnsOf(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const of = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    return { jd: of("jev_decisions"), jv: of("jev_verdicts") };
  } finally { db.close(); }
}

const shape = (p) => JSON.stringify({ out: p.out, jd: p.jd.map((r) => [r.question_id, r.status, r.skip_reason]), v: p.v !== null, triage: p.triage.map((t) => [t.status, t.verdict_id]) });
const failedJev = (p) => p.jd.some((r) => r.status === "skipped" && SILENT.has(r.skip_reason));
const retryable = (p) => p.jd.some((r) => r.status === "skipped" && RETRYABLE.has(r.skip_reason));
function jevDiffers(a, b) {
  return a.jd.some((r, i) => {
    const o = b.jd[i];
    if (!o || r.model_reported !== o.model_reported) return true;
    const x = r.answers_json ? JSON.parse(r.answers_json) : {}; const y = o.answers_json ? JSON.parse(o.answers_json) : {};
    return Object.keys({ ...x, ...y }).some((k) => Math.abs((x[k] ?? -1) - (y[k] ?? -1)) > 1e-6);
  });
}

/** match · mismatch · nondeterministic · inconclusive · retry — structure first (spec §6.2, codex B2). */
function classify(a, b) {
  if (shape(a) !== shape(b)) return retryable(a) || retryable(b) || jevDiffers(a, b) ? "retry" : "mismatch";
  if (failedJev(a)) return "inconclusive"; // structures equal, so both sides failed the same way
  if (jevDiffers(a, b)) return "nondeterministic";
  return JSON.stringify(a) === JSON.stringify(b) ? "match" : "mismatch";
}

/** Stage 1 only: one turn.handler decision per turn, and the verdict and every Jev row link to it. */
function linkOk(side, run_id) {
  const d = side.store.listDecisionsForRun(run_id).filter((x) => x.entry_id === "turn.handler");
  if (d.length !== 1) return false;
  const v = side.store.getJevVerdictForRun(run_id);
  const jd = side.store.listJevDecisions(run_id);
  return v?.decision_id === d[0].decision_id && jd.length > 0 && jd.every((r) => r.ladder_decision_id === d[0].decision_id);
}

/** One attempt: the same input through both builds, paced. Null when either side would not admit the turn. */
async function triagePair(g, item, attempt) {
  g.clock.t = Date.now();
  const a = admit(g.oldSide, item, g.clock, attempt); const b = admit(g.newSide, item, g.clock, attempt);
  if (!a || !b) return null;
  const outA = await g.oldSide.worker.triageTurn(a.input);
  await sleep(PACE_MS);
  const outB = await g.newSide.worker.triageTurn(b.input);
  await sleep(PACE_MS);
  return { a: { ...project(g.oldSide, a.run_id, g.cols), out: outA.kind }, b: { ...project(g.newSide, b.run_id, g.cols), out: outB.kind }, runB: b.run_id };
}

/**
 * A retryable or both-failed pair is retried once (senior W10). After the retry a structural difference is a mismatch
 * (codex re-review #2); only a structurally identical, both-failed pair stays inconclusive.
 */
async function runPair(g, item) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pair = await triagePair(g, item, attempt);
    if (pair === null) return { c: "skipped" };
    const c = classify(pair.a, pair.b);
    if ((c === "retry" || c === "inconclusive") && attempt === 0) { g.retries += 1; continue; }
    return { c: c === "retry" ? "mismatch" : c, ...pair };
  }
  return { c: "skipped" };
}

async function dualRun(g, items, limit) {
  const t = { match: 0, mismatch: [], nondeterministic: 0, inconclusive: 0, skipped: 0, links: 0, completed: 0, newRuns: [] };
  const decided = () => t.match + t.mismatch.length + t.nondeterministic;
  for (const item of items) {
    if (decided() >= limit) break;
    const r = await runPair(g, item);
    if (r.c === "skipped") { t.skipped += 1; continue; }
    t.completed += 1;
    if (r.c === "mismatch") t.mismatch.push({ k: item.k, old: r.a, new: r.b }); else t[r.c] += 1;
    t.newRuns.push(r.runB);
    if (!linkOk(g.newSide, r.runB)) t.links += 1;
  }
  return t;
}

function reportDualRun(t, retries) {
  const det = t.match + t.mismatch.length;
  console.log(`  pairs ${t.completed}: match ${t.match} · mismatch ${t.mismatch.length} · Jev nondeterminism ${t.nondeterministic} · inconclusive ${t.inconclusive} · retried ${retries} · not admitted ${t.skipped}`);
  for (const m of t.mismatch.slice(0, 5)) console.log(`  mismatch #${m.k}:\n    old ${JSON.stringify(m.old)}\n    new ${JSON.stringify(m.new)}`);
  // senior re-review S3: a shortfall that the inconclusive (both-failed) pairs explain is infrastructure, not code
  if (det < MIN_DETERMINISTIC && MIN_DETERMINISTIC - det <= t.inconclusive) cannotRun(`P6: at least ${MIN_DETERMINISTIC} deterministic pairs`, `${det}; ${t.inconclusive} pair(s) lost to Jev failures`);
  else check(`P6: at least ${MIN_DETERMINISTIC} deterministic pairs`, det >= MIN_DETERMINISTIC, `${det}`);
  check("P6: 0 mismatches among them", t.mismatch.length === 0, `${t.mismatch.length}`);
  check("links: every stage-1 verdict and Jev row links its turn.handler decision", t.links === 0, `${t.links} unlinked`);
}

/** The new side's turn.handler rows, tallied (senior W9): a silently narrowed corpus (all uncalibrated, no cascade) must not pass. */
function coverage(g, runs) {
  const rows = runs.flatMap((r) => g.newSide.store.listDecisionsForRun(r).filter((d) => d.entry_id === "turn.handler"));
  const tally = {};
  for (const d of rows) tally[`${d.rung}:${d.reason_code}`] = (tally[`${d.rung}:${d.reason_code}`] ?? 0) + 1;
  const calibrated = new Set(g.newMods.CALIBRATED_ROWS.map((r) => r.model));
  const reported = [...new Set(runs.flatMap((r) => g.newSide.store.listJevDecisions(r).filter((x) => x.status === "answered").map((x) => x.model_reported)))];
  return {
    tally, reported, uncalibrated: reported.filter((m) => !calibrated.has(m)),
    armed: rows.filter((d) => (d.rung === "jev" || d.rung === "model") && d.reason_code !== "uncalibrated").length,
    model: rows.filter((d) => d.rung === "model" || d.fallback_rung === "model").length
  };
}

function reportCoverage(c) {
  console.log(`  turn.handler rows by rung:reason — ${Object.entries(c.tally).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  check("coverage: every answered Jev row reports a model the committed rows arm", c.reported.length > 0 && c.uncalibrated.length === 0, `reported ${c.reported.join(", ") || "none"}`);
  check(`coverage: at least ${MIN_ARMED} turn.handler verdicts from an armed tree`, c.armed >= MIN_ARMED, `${c.armed}`);
  if (c.model === 0) cannotRun("coverage: the cascade (model) rung ran", "no text fell below the choice bar");
  else check("coverage: the cascade (model) rung ran", true, `${c.model}`);
}

/** Copy B only, before it is opened: the digest latch and the day's digest outbox row ride along once the daemon runs stage 1. */
function clearDigestLatch(pathB, root, live) {
  guardCopy(pathB, root, live);
  const db = new DatabaseSync(pathB);
  try {
    const has = db.prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'decision_digests'`).get();
    if (has) console.log(`  cleared ${db.prepare(`DELETE FROM decision_digests`).run().changes} digest latch row(s) from copy B`);
    console.log(`  cleared ${db.prepare(`DELETE FROM notification_outbox WHERE idempotency_key LIKE 'decision_digest:%'`).run().changes} digest outbox row(s) from copy B`);
  } finally { db.close(); }
}

/**
 * The ❌ tap is under test, not Jev's p distribution (senior B2, codex B3): when the dual run left no unsure verdict, the
 * newest applied jev-rung turn.handler decision of this run is set to p 0.6 on copy B only, and the output says so.
 */
function ensureUnsure(g, runs) {
  const digest = g.newMods.buildDecisionDigest(g.newSide.store, new Date().toISOString(), process.env);
  if (digest && digest.offered.length > 0) return;
  const target = runs.flatMap((r) => g.newSide.store.listDecisionsForRun(r))
    .filter((d) => d.entry_id === "turn.handler" && d.rung === "jev" && d.armed_mode === "on").at(-1);
  if (!target) return;
  guardCopy(g.pathB, g.root, g.live);
  const db = new DatabaseSync(g.pathB);
  try { db.prepare(`UPDATE decisions SET p = 0.6 WHERE decision_id = ?`).run(target.decision_id); } finally { db.close(); }
  console.log(`  seeded: ${target.decision_id} set to p 0.6 on copy B so the digest offers one decision`);
}

function claimDigest(store) {
  let note = null;
  for (let n = store.claimNextNotification("p6", 30); n; n = store.claimNextNotification("p6", 30)) if (n.idempotency_key.startsWith("decision_digest:")) note = n;
  return note;
}

/**
 * Spec §13 row 1 "the digest renders": the queued payload through TelegramNotificationAdapter with a stub transport (codex
 * S7). Each rendered row must be exactly ✅ `dec:rv:<offered id>:ok`, ❌ `dec:rv:<offered id>:bad`, in offer order (codex
 * re-review #8). Returns the rendered keyboard, which the tap check uses.
 */
async function checkRender(g, note, digest) {
  if (!note || !digest) { cannotRun("digest render", "no digest message was queued"); return []; }
  const sent = [];
  const adapter = new g.newMods.TelegramNotificationAdapter({ sendMessage: async (input) => { sent.push(input); return { message_id: 1 }; } });
  await adapter.send(note);
  const rows = sent[0]?.reply_markup?.inline_keyboard ?? [];
  check("digest render: HTML through the rich renderer", sent.length === 1 && sent[0].parse_mode === "HTML" && sent[0].text.includes("Decisions"), sent[0]?.text.split("\n")[0] ?? "nothing sent");
  const want = digest.offered.map((id) => [`dec:rv:${id}:ok`, `dec:rv:${id}:bad`]);
  const got = rows.map((r) => r.map((b) => b.callback_data));
  check("digest render: each row is exactly ✅ dec:rv:<offered id>:ok and ❌ dec:rv:<offered id>:bad", JSON.stringify(got) === JSON.stringify(want),
    `${rows.length} row(s), ${digest.offered.length} offered`);
  return rows;
}

async function checkDigest(g) {
  const now = new Date().toISOString();
  const digest = g.newMods.buildDecisionDigest(g.newSide.store, now, process.env);
  check("digest: builds on copy B with turn.handler counts", digest !== null && digest.text.includes("· turn.handler "), digest ? digest.text.split("\n")[0] : "null");
  const env = { ...process.env, HOUGE_DECISION_DIGEST_AT: "00:00" };
  const first = g.newMods.runDecisionDigestTick({ store: g.newSide.store, chatId: "p6op", now, env });
  const again = g.newMods.runDecisionDigestTick({ store: g.newSide.store, chatId: "p6op", now, env });
  check("digest tick: sends once per local date", first.ran === true && first.sent === true && again.ran === false, JSON.stringify({ first, again }));
  const note = claimDigest(g.newSide.store);
  check("digest tick: one outbox message to the operator chat", note !== null && note.payload.text === digest?.text, note ? note.idempotency_key : "none");
  return { digest, rows: await checkRender(g, note, digest) };
}

function tapUpdate(m, from, data, id) {
  const allowlist = { users: [{ telegram_user_id: 111, identity_id: "p6" }], chats: [{ telegram_chat_id: 222, label: "p6", allowed_identity_ids: ["p6"] }] };
  return m.normalizeTelegramUpdate({ update_id: 7_000_000 + id, callback_query: { id: `p6cb${id}`, from: { id: from }, message: { message_id: 1, chat: { id: 222 } }, data } }, allowlist);
}

/** The RENDERED buttons go into the gateway (codex re-review #8): a keyboard whose ❌ submits :ok or another id fails here. */
function checkTap(g, { digest, rows }) {
  const offered = digest?.offered ?? [];
  if (offered.length === 0) { cannotRun("❌ tap", "nothing was offered even after seeding (copy B has no applied jev-rung turn.handler row)"); return; }
  const [ok, bad] = (rows[0] ?? []).map((b) => b.callback_data);
  if (!ok || !bad) { cannotRun("❌ tap", "the digest rendered no keyboard to tap"); return; }
  const id = offered[0];
  const gw = new g.newMods.Gateway(g.newSide.store);
  const first = tapUpdate(g.newMods, 111, bad, 1);
  if (first.ok) gw.intake(first.event);
  const second = tapUpdate(g.newMods, 111, ok, 2);
  if (second.ok) gw.intake(second.event);
  const outcomes = g.newSide.store.listDecisionOutcomes(id).map((o) => `${o.signal}:${o.value}:${o.source}`);
  check("❌ tap: writes exactly one review_bad outcome; the second tap writes nothing", outcomes.length === 1 && outcomes[0] === "review_bad:turn.handler:paco", outcomes.join(",") || "none");
  check("❌ tap: a stranger's tap is refused by the allowlist", tapUpdate(g.newMods, 999, bad, 3).ok === false);
}

async function setup(args) {
  const newMods = await loadBuild(NEW_DIST, ["config/load-env.js", "config/disarm-posture.js", "decisions/digest.js", "triggers/telegram-trigger-adapter.js",
    "jev/calibration.js", "notifications/telegram-notification-adapter.js"]);
  newMods.loadHougeEnv();
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set (HOUGE_ENV_FILE?)");
  const repo = dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env")));
  const live = resolve(args.db ?? join(repo, "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  const root = mkdtempSync("/tmp/hg-p6-");
  gateEnv(newMods, root);
  const base = join(root, "base.sqlite"); const pathA = join(root, "a.sqlite"); const pathB = join(root, "b.sqlite");
  copyDb(live, base); copyDb(base, pathA); copyDb(base, pathB); // one frozen snapshot, two copies
  for (const p of [base, pathA, pathB]) guardCopy(p, root, live);
  clearDigestLatch(pathB, root, live);
  const oldMods = await loadBuild(args.oldDist);
  const clock = { t: Date.now() };
  const cols = columnsOf(pathA); // the OLD schema: stage 1's new columns are checked as links, not compared
  const g = { root, live, pathB, clock, cols, newMods, retries: 0,
    oldSide: makeSide(oldMods, pathA, args.oldDist, root, "old", clock), newSide: makeSide(newMods, pathB, NEW_DIST, root, "new", clock) };
  return { g, items: pickTexts(newMods, base, args.limit + OVERFETCH) };
}

function verdict(args, g) {
  if (inconclusive.length > 0) console.log(`\nINCONCLUSIVE:\n  - ${inconclusive.join("\n  - ")}`);
  const status = failures.length > 0 ? "FAIL" : inconclusive.length > 0 ? "INCONCLUSIVE" : "PASS";
  console.log(status === "FAIL" ? `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}` : `\nLIVE GATE: ${status}`);
  if (args.keep || status !== "PASS") console.log(`temp dir kept: ${g.root}`); else rmSync(g.root, { recursive: true, force: true });
  return status === "PASS" ? 0 : status === "FAIL" ? 1 : 3;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { g, items } = await setup(args);
  console.log(`decision ladder parity gate — ${items.length} candidate texts for ${args.limit} decided pairs, copies under ${g.root}\n`);
  try {
    const t = await dualRun(g, items, args.limit);
    reportDualRun(t, g.retries);
    reportCoverage(coverage(g, t.newRuns));
    ensureUnsure(g, t.newRuns);
    checkTap(g, await checkDigest(g));
  } finally { g.oldSide.store.close(); g.newSide.store.close(); }
  return verdict(args, g);
}

main().then((c) => process.exit(c), (e) => { console.error(`live gate setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(2); });
```

- [ ] **Step 3: Syntax check**

Run: `node --check scripts/live-gate-decisions-parity.mjs`
Expected: no output.

- [ ] **Step 4: Run the gate (the live run that counts as "done")**

Run, from the feature worktree only:

```bash
cd /Users/xiaochuan/Projects/adventure/.worktrees/decision-ladder-stage-1
HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-decisions-parity.mjs --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/p6-base/dist
```

First the determinism probe (senior re-review W3): run the same command with `--limit 10 --keep`. Expected: at most one
`Jev nondeterminism` pair in ten. If more, stop: Jev does not return identical probabilities for the same input, the
190-pair floor cannot be met, and the comparison rule needs Paco (tolerance compare, or replaying side A's Jev answers
into side B). Report the probe's counts either way. Then the full run:

Expected: `LIVE GATE: PASS` (exit 0) with `P6: at least 190 deterministic pairs`, `P6: 0 mismatches`, the three coverage
checks, the two render checks and both tap checks PASS. Paste the full output into the task report. A mismatch is a code
fault: read the printed pair, fix the code, rebuild in the worktree, rerun. `LIVE GATE: INCONCLUSIVE` (exit 3) is never a
PASS: report which required check could not run and rerun (or ask Paco). Record
`stat -f %m /Users/xiaochuan/Projects/adventure/dist/core/core-worker.js` before and after the run and show it unchanged
(the main checkout's `dist/` was not rebuilt).

Egress (senior S8): the gate builds `CoreWorker` without a broker, so the last 200 Telegram texts and their stored context
reach TypeSafe redacted by shape only (`sanitizeJevText`), not by known secret values — the same class as the jev-tree gate
and the replay. **Approved by Paco 2026-10-12 ("Yes, 200 messages"): keep shape-only redaction in this gate.**

- [ ] **Step 5: Commit**

```bash
git add scripts/live-gate-decisions-parity.mjs
git commit -m "test(gate): decision ladder parity gate (P6 dual run, coverage floor, digest render, review tap)"
```

## Task 13 (final): Docs sync and the R13 rollback check

The ADR, its index row and AGENTS.md are Task 1. `sessions.md`, `tasks/todo.md` and `tasks/lessons.md` are written by the
controller at ship. `README.md` needs no change: it lists no env vars (`README.md:59` links configuration.md). This task
also proves R13's remedy on real data (spec §5.4: "every stage plan's final task verifies that by booting the previous
`dist/` against a migrated DB copy").

**Files:**
- Modify: `docs/reference/configuration.md` — a new section after "Jev System One (ADR 0029)" (before `## Kill switch + disarm posture`, `:1041`); the sweep paragraph (`:736`). The `HOUGE_JEV_LANES_OFF` row (`:957`) is not touched (R13).
- Modify: `docs/reference/jev-decision-layer.md` — header paragraph (`:3-7`), a new section after "Decision flow" (before `## State and questions`, `:48`), "Rolling back" (`:195`), "Failure and the sweep" (`:216`)
- Modify: `CONTEXT.md` — five terms after **Quoted Turn** (`:65`)
- Create: `scripts/check-decisions-rollback.mjs`

**Interfaces:** none (docs and a check script). The script consumes, from the new `dist/`: `RunStore`, `loadHougeEnv`,
`DISARM_FLAGS`; from the previous `dist/` (`.worktrees/p6-base/dist`, built in Task 12): `CoreWorker`, `Gateway`,
`RunStore`, `buildTypedTaskEvent`, `detectViolations` (`src/run/invariant-sweep.ts:268` at 3bff437).

- [ ] **Step 1: `docs/reference/configuration.md` — new section**

```markdown
## Decision ladder (ADR 0030)

Every decision that changes a turn's path is an entry in the code-owned registry (`src/decisions/`, protected surface),
decided by a ladder of deciders (code rule → Jev → model → Paco) and recorded after it decides. Stage 1 registers the
front door: `turn.handler` (the gate rule and ack rule → the Jev tree → the Tiny cascade; the planner is its fail value)
and `turn.gear` (the role on the route, recorded from the same Jev call). Reference: [jev-decision-layer.md](jev-decision-layer.md#the-decision-ladder).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOUGE_DECISION_DIGEST_AT` | `21:00` | Local time (`HH:MM`, in `HOUGE_DISPLAY_TZ`) of the daily decision digest to the operator chat. Malformed → the default. Sent once per local date on the first poll at or after the time; a day with no decisions sends nothing (the latch row still records the date). |

**No off switch (ruling R13).** There is no variable that turns the decision system off or into shadow. The only shadow
left is the front door's existing `HOUGE_JEV_TRIAGE_ENABLED=shadow`, unchanged. If a build is fundamentally wrong, revert
its commit, rebuild `dist/`, kickstart: every stage's migrations are additive, and `scripts/check-decisions-rollback.mjs`
proves the previous build runs on a migrated DB (run by each stage's final task). After such a revert, a digest still in
the outbox is sent without its buttons (the old adapter ignores `button_rows`), and a tap on an earlier digest is answered
as unrecognised callback data; neither writes anything.

**The digest** (one Telegram message, rich-rendered): up to 8 **unsure** verdicts (an applied Jev decision whose
probability is within 0.15 of its entry's bar; `turn.handler`'s bar is the choice bar 0.6), each with ✅ / ❌ buttons
(`dec:rv:<decision_id>:<ok|bad>`); **counts** per entry by deciding rung in the last 24 h; **health** per entry (Jev skips —
failures on the Jev rung, budget excluded — fallbacks, and rows in the configured triage shadow when there are any;
health counts applied rungs only, so in configured shadow a Jev failure shows in the triage `jev_skip_rate`, not here). A
front-door row counts only when its turn's verdict links it. For front-door entries a line quotes the first 40
characters of Paco's own message; no tool text ever. A tap passes the sender allowlist, writes one `decision_outcomes`
row (`review_ok` / `review_bad`, value = the entry id) and replies; a second tap, an unknown id, or one no digest offered in
the last 7 days answers "Already handled." and writes nothing. Review taps are exempt from the 5-commands-a-minute limit
and do not count toward it.

**Tables** (migration `2026-10-12-decision-ladder`, additive): `decisions` (one row per decision that matters:
`decision_id`, `entry_id`, `entry_version`, `run_id`, `tool_call_id`, `stage`, `rung` (`rule` \| `jev` \| `model` \|
`paco` \| `fail`), `verdict`, `p`, `reason_code` (a code-owned enum per entry), `fallback_reason` (`timeout` \| `outage` \|
`parse` \| `threw` \| `stale_bar` \| `budget`), `fallback_rung` (which rung failed first), `armed_mode`, `latency_ms`,
`created_at`; no state column; `stage` and `fallback_reason` are validated in code so a later stage can extend them),
`decision_outcomes` (closed signal and value per row, validated in code; one review label per decision), `ladder_moves`
(who decides, moved; only `approval.standing` may write an automatic row, for `tool.policy`; every Paco row carries its
callback id, used once; locked entries refuse every move), `decision_digests` (the daily latch and the ids each digest
offered). `jev_decisions.ladder_decision_id` and `jev_verdicts.decision_id` link the Jev rows and the verdict to their
`turn.handler` decision; the front door writes its decision row in the same transaction as the verdict, so a lost turn
writes none.

**Incidents:** `decision_record_failed` (subject = the entry; a decisions write failed, the verdict stood; the next good
write resolves it), `decision_fallback` (subject = the entry; three named fallbacks to the entry's fail answer in one hour,
`budget` excluded; for `turn.handler` and `turn.gear` only cascade failures count, because the Jev incidents already page a
Jev outage, and only a cascade answer resolves it; one urgent card per open incident, none for a reopen within 10 minutes
of the last resolve; for other entries the next Jev or model answer resolves it; a rule answer never does), and `jev_skip_rate` with subject `decision:<entry>` (the sweep's
per-entry rate from Jev-rung failures; `turn.handler` and `turn.gear` keep the triage-wide `jev_skip_rate` above in stage 1).

**Live gate:** from the feature worktree, `HOUGE_ENV_FILE=/abs/.env node scripts/live-gate-decisions-parity.mjs --old-dist <pre-stage-1 dist>`
(P6: the last 200 Telegram texts through the old and new triage on two copies of the DB; coverage floor; the digest
rendered through the Telegram adapter; a ❌ tap). Exit 3 = INCONCLUSIVE, never a pass.
```

In the sweep paragraph (`:736`), change `(plus the Jev rate kinds `jev_skip_rate` and `lane_fallthrough_rate`, below)` to
`(plus the Jev rate kinds `jev_skip_rate`, also per decision entry, and `lane_fallthrough_rate`, below)`.

- [ ] **Step 2: `docs/reference/jev-decision-layer.md`**

Header (`:3`): change `as of the stage B lanes` to `as of the stage B lanes and the decision ladder's stage 1`, and add
`[ADR 0030](../decisions/0030-decision-ladder.md)` beside the ADR 0029 link.

New section before `## State and questions`:

```markdown
## The decision ladder

Since ADR 0030 this decision point is the registry entry `turn.handler` (`src/decisions/entries/turn-handler.ts`),
walked by the ladder runner (`src/decisions/decide.ts`):

| Rung | What it is | When it decides | Recorded as |
|---|---|---|---|
| rule `gate` | flag off, override, posture, non-text, no turn state, then the ack rule (arm mode only) | one of those holds | `rung rule`, `reason_code` = the skip reason (`disabled`, `override`, …, `ack_rule`) |
| jev `tree` | the six-question call and the pure policy above | the policy routes (any lane or the planner) | `rung jev`, `p` = the category's top probability, `reason_code` = the route reason |
| model `cascade` | the Tiny pick between Jev's top two | the tree went below the choice bar and the pick is one of the two | `rung model`, `reason_code` `cascade` |
| fail | the planner | nothing answered (Jev skipped, cascade failed) | `rung fail`, `fallback_reason` = `timeout` / `outage` / `parse` / `threw` / `budget`, `fallback_rung` = the rung that failed |

Every `turn.handler` decision is recorded (`decisions` row) in the same transaction as the turn's `jev_verdicts` row
(`decision_id`) and its `jev_decisions` rows (`ladder_decision_id`), all linked; a turn lost before it settles writes none.
`turn.gear` records the route's role from the same call (rung `jev` when the gear questions were armed and applied, else
`rule`). The entry declares what each verdict causes (ADR 0030 decision 4, R12): the status card is a reversible reply;
`answer`, `lookup`, `memory` and `planner` may save a lesson first on a confident `sets_rule`, and every such automatic save
is announced on the memory card with ↩️ Undo — on the lane card itself, as the memory lane's reply, or as a separate
Undo-only card on the planner path (Paco, 2026-10-12). `HOUGE_JEV_TRIAGE_ENABLED=shadow` runs the Jev and cascade
rungs in shadow: asked and recorded (`armed_mode shadow`), never applied. Stage 1 changed no routing: the pinned
characterisation tests (`tests/core/turn-handler-pin.test.ts`) and the P6 dual run (`scripts/live-gate-decisions-parity.mjs`)
compare every persisted column with the pre-ladder build.
```

"Rolling back" (`:195`): add before item 0:

```markdown
00. **The decision ladder itself has no off switch** (ruling R13, ADR 0030 decision 10). If a ladder build is
    fundamentally wrong: revert its commit, rebuild `dist/`, kickstart. Its migrations are additive, so the previous build
    runs on the migrated DB (`scripts/check-decisions-rollback.mjs`). The items below still roll back the tree's behaviour.
```

"Failure and the sweep" (`:216`): add two bullets:

```markdown
- `decision_fallback` (subject `turn.handler`): three cascade failures in one hour (a Jev outage pages through the Jev
  incidents instead); one urgent card, none for a reopen within 10 minutes; the next cascade answer clears it.
- `decision_record_failed`: a `decisions` write failed; the routing stood (the verdict row then has `decision_id` null).
```

- [ ] **Step 3: `CONTEXT.md` — after **Quoted Turn** (`:65`)**

```markdown
**Decision**: A choice that changes a turn's path and whose answer an outcome could show wrong (ADR 0030). Mechanics — validation, timeouts, retries — are not decisions and stay plain code.

**Entry**: One decision in the code-owned registry (`src/decisions/`, protected): its id, version, stage, the input its judges read (`paco`, `tool`, `mixed`), closed verdicts, ladder, `fail` and default verdicts, what each verdict causes (and whether that is reversible and announced), and the outcome signals that can show it wrong. `turn.handler` and `turn.gear` are the first two.

**Rung**: One decider on an entry's ladder: a code `rule`, `jev`, a `model` one-shot, or `paco`. A rung answers, abstains (optionally with a monotone floor) or fails (`timeout`, `outage`, `parse`, `threw`, `stale_bar`, `budget`). Every entry ships armed; the only shadow is the front door's configured triage shadow (asked and recorded, never applied).

**Ladder**: An entry's rungs in order, code first; the first rung that answers decides, and the entry's `fail` verdict stands when none does. On a monotone entry a later rung can only tighten. What a Jev or model verdict may cause depends on what it read: over tool output only a tightening or a proposal, over Paco's own message a reversible, announced effect. The runner decides, then records (`decisions`); recording never changes a decision.

**Ladder move**: A recorded change of who decides an entry (`ladder_moves`), such as a standing approval moving a fingerprint from Paco's tap to a code rule. Only code may make one on its own (standing approvals, skill authoring after recurrence, stated-rule lessons); every loosening is a proposal for Paco's tap; locked entries never move.
```

- [ ] **Step 4: Write `scripts/check-decisions-rollback.mjs`**

```js
#!/usr/bin/env node
// R13 rollback check — decision ladder stage 1 (spec 2026-10-12 §5.4; plan Task 13).
//
//   From the feature worktree, after `npm run build` there (never in the main checkout):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-decisions-rollback.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/p6-base/dist [--db <path>] [--keep]
//
// Rollback is "revert, rebuild, kickstart" only while every migration is additive. This proves it on real data: a VACUUM
// copy of the live DB is migrated by the new build; then the previous build (3bff437) opens it — its migrations run, a
// triage turn settles (Jev unreachable: a skipped row and a verdict, no network, no egress), its invariant sweep runs —
// and the new build reopens it afterwards. Exit: 0 PASS · 1 FAIL · 2 setup error. Never opens the live DB for writing.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const load = async (dist, paths) => Object.assign({}, ...(await Promise.all(paths.map((p) => import(join(dist, p))))));
const LADDER_TABLES = ["decisions", "decision_outcomes", "ladder_moves", "decision_digests"];

function parseArgs(argv) {
  const a = { oldDist: null, db: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist") a.oldDist = resolve(argv[++i]);
    else if (argv[i] === "--db") a.db = resolve(argv[++i]);
    else if (argv[i] === "--keep") a.keep = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!NEW_DIST.includes("/.worktrees/")) throw new Error(`run from the feature worktree (this dist is ${NEW_DIST}); never build in the main checkout`);
  if (!a.oldDist || !existsSync(join(a.oldDist, "core/core-worker.js"))) throw new Error("--old-dist <previous build's dist> is required");
  return a;
}

function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

/** The ladder's additive schema: its four tables and both link columns. */
function hasLadder(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name);
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    return LADDER_TABLES.every((t) => tables.includes(t)) && cols("jev_verdicts").includes("decision_id") && cols("jev_decisions").includes("ladder_decision_id");
  } finally { db.close(); }
}

/** No Telegram, disarm flags off, markers in the temp root, Jev armed but unreachable (a dummy key; jevFetch throws). */
function isolate(root, disarmFlags) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID", "HOUGE_JEV_CALIBRATION_FILE", "HOUGE_JEV_GATE"]) delete process.env[k];
  for (const f of disarmFlags) process.env[f] = "false";
  Object.assign(process.env, {
    HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"), HOUGE_DISARM_PATH: join(root, "houge.disarm"),
    HOUGE_JEV_DISARM_PATH: join(root, "houge.jev-disarmed"), HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false",
    HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", TYPESAFE_API_KEY: "rollback-check"
  });
}

/** The previous build on the migrated copy: its migrations (on open), one triage turn through its CoreWorker, its sweep. */
async function bootOld(m, path, dist, root) {
  const store = m.RunStore.open(path);
  try {
    const dir = join(root, "old"); mkdirSync(join(dir, "project"), { recursive: true });
    const stub = async () => ({ ok: false, error: "rollback check" });
    const worker = new m.CoreWorker(store, join(dir, "project"), stub, stub, undefined, undefined, stub, undefined, undefined, async () => null, undefined, undefined,
      { dataDir: dir, distDir: dist, jevFetch: async () => { throw new TypeError("rollback check: no network"); } });
    const r = new m.Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir }).intake(m.buildTypedTaskEvent({
      source: "telegram", type: "turn", program: "turn", goal: "rollback check", requested_by: { kind: "user", id: "rb" }, notify: { kind: "telegram", chat_id: "rb" },
      idempotency_key: "telegram:rollback-check:1", source_reference: "telegram:update:rollback-check:message:1", metadata: { telegram_update_id: 1, telegram_message_id: 1 } }));
    if (!r.ok || r.status !== "created") throw new Error(`the previous build refused the turn: ${JSON.stringify(r)}`);
    const claim = store.claimRun(r.run_id, "rb", 120);
    worker.buildOmpTools(claim, "rb");
    await worker.triageTurn({ claim, text: "rollback check", userText: "rollback check", modality: "text", posture: null, signal: new AbortController().signal });
    return { verdict: store.getJevVerdictForRun(r.run_id), violations: m.detectViolations(store, new Date().toISOString()).length };
  } finally { store.close(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const newMods = await load(NEW_DIST, ["run/run-store.js", "config/load-env.js", "config/disarm-posture.js"]);
  newMods.loadHougeEnv();
  const live = resolve(args.db ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  const root = mkdtempSync("/tmp/hg-rb-");
  isolate(root, newMods.DISARM_FLAGS);
  const path = join(root, "copy.sqlite");
  copyDb(live, path);
  newMods.RunStore.open(path).close();
  check("the new build migrated the copy (four ladder tables, two link columns)", hasLadder(path));
  const oldMods = await load(args.oldDist, ["core/core-worker.js", "gateway/gateway.js", "run/run-store.js", "domain/types.js", "run/invariant-sweep.js"]);
  try {
    const old = await bootOld(oldMods, path, args.oldDist, root);
    check("the previous build boots on the migrated copy and settles a triage turn", old.verdict !== undefined,
      `verdict ${old.verdict ? `${old.verdict.lane}/${old.verdict.skip_reason ?? old.verdict.reason}` : "none"}; sweep ran (${old.violations} violation(s))`);
  } catch (e) {
    check("the previous build boots on the migrated copy and settles a triage turn", false, e instanceof Error ? e.message : String(e));
  }
  check("the previous build left the ladder's tables and link columns in place", hasLadder(path));
  try { newMods.RunStore.open(path).close(); check("the new build reopens the copy afterwards", true); }
  catch (e) { check("the new build reopens the copy afterwards", false, e instanceof Error ? e.message : String(e)); }
  console.log(failures.length === 0 ? "\nROLLBACK CHECK: PASS" : `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}`);
  if (args.keep || failures.length > 0) console.log(`temp dir kept: ${root}`); else rmSync(root, { recursive: true, force: true });
  return failures.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(`rollback check setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(2); });
```

- [ ] **Step 5: Run the rollback check (R13's proof)**

```bash
cd /Users/xiaochuan/Projects/adventure/.worktrees/decision-ladder-stage-1
node --check scripts/check-decisions-rollback.mjs
HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-decisions-rollback.mjs --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/p6-base/dist
```

Expected: `ROLLBACK CHECK: PASS` (exit 0) with all four checks PASS; paste the output into the task report. A FAIL means a
migration is not additive: stop and report to Paco before anything merges (R13's remedy would not hold).

- [ ] **Step 6: Final checks**

Run: `grep -rn "HOUGE_DECISIONS_OFF" src/ tests/ scripts/ docs/reference/ CONTEXT.md AGENTS.md`
Expected: no output (R13).
Run: `grep -n "HOUGE_DECISION_DIGEST_AT" docs/reference/configuration.md && ! grep -rn "HOUGE_TRUST_ASK_TTL_MS" docs/reference/`
Expected: the digest variable documented; no `HOUGE_TRUST_ASK_TTL_MS` (stage 2a).
Run: `git diff --name-only <task-2 sha> -- tests/helpers/triage-harness.ts tests/core/turn-handler-pin.test.ts tests/core/turn-handler-pin-throws.test.ts tests/core/turn-handler-routed-by.test.ts tests/core/__pins__`
Expected: exactly the snapshot(s) Task 8c named (`tests/core/__pins__/turn-handler/rule-on-lookup.json`); nothing else in
the frozen set changed during the stage.
Run (worktree): `npm run typecheck && npm test && npm run build`
Expected: PASS, no skipped tests.

- [ ] **Step 7: Commit (two concerns, two commits)**

```bash
git add scripts/check-decisions-rollback.mjs
git commit -m "test(gate): R13 rollback check — the previous build on a DB the ladder migrated"
git add docs/reference/configuration.md docs/reference/jev-decision-layer.md CONTEXT.md
git commit -m "docs: decision ladder stage 1 — configuration, the Jev reference, CONTEXT terms"
```

---


## Self-review (run by the plan author against spec §13 row 1, Rev 8)

**Spec coverage.**
- ADR 0030 with Assumptions and Revisit-when, amendments to 0029 / 0028 / 0014 / 0011 clause by clause, the one named
  deny-path exception, R11, R12 (effects by input source), R13 (no off switch, no designed shadow, rollback by revert),
  provisional bars that page instead of disarming, index row, AGENTS.md sentence → Task 1 (no code depends on it).
- Registry types with `{abstain, floor}`, `input`, effect declarations; runner `decideSync` / `decide`, code first,
  monotone floor (with `floor_held`), configured shadow only, locked, record after decide with `decision_record_failed`,
  bar types → Tasks 3, 5, 6.
- R12 registry test (unannounced or irreversible judge effect fails; any non-tightening effect over tool input fails;
  `turn.handler`'s real effect table pinned) and R13 (every registered entry armed `on`) → Task 6 `entryProblems` +
  `registry.test.ts`; eligible input reaches the Jev rung → Task 6 `turn-handler-entry.test.ts`.
- `decisions` (with `fallback_rung`), `decision_outcomes`, `ladder_moves` (store-level auto check; one-shot callback),
  `jev_decisions.ladder_decision_id` (FK, indexed), `jev_verdicts.decision_id`, growing enums validated in code, no state
  column, migration count → Task 4.
- `turn.handler` + `turn.gear` migrated, move-don't-improve, differential on behaviour incl. persisted rows (`state_hash`
  kept), triage event, `routed_by` (pinned projection plus the real-supervisor end-to-end test), catch-up, corrections,
  terminal transitions, the throw paths → Tasks 2, 8a, 8b; rows written atomically with the verdict (no orphan for a lost
  turn) → Task 8b; the consumer table lists every `jev_verdicts` consumer and the suite that keeps it green.
- `src/decisions/` protected with its test → Task 7.
- No `HOUGE_DECISIONS_OFF` anywhere; `HOUGE_JEV_LANES_OFF` untouched; `HOUGE_DECISION_DIGEST_AT` documented;
  `HOUGE_TRUST_ASK_TTL_MS` not added → Tasks 6, 13.
- Digest (counts, unsure list with ✅/❌ `dec:rv:` callbacks, sender allowlist, one-shot, exempt from the command limit,
  per-entry health with Jev-rung skips, settled front-door rows only, rich renderer, skipped when empty, scheduled,
  conflict-safe latch), `decision_fallback:<entry>` urgent card (judge answers clear it, damped, no double page), per-entry
  `jev_skip_rate` in the sweep → Tasks 5, 9, 10, 11.
- P6 dual run (200 decided pairs from 230 candidates, two VACUUM copies of one snapshot, stubs, projection, id mapping as
  links, structure before Jev failures, one retry, pacing, coverage floor, ≥ 190 deterministic and 0 mismatches), the
  digest rendered through the adapter, a ❌ tap that can fail (seeded offer), INCONCLUSIVE never PASS, worktree-only
  builds → Task 12.
- Every automatic lesson save announced on a card with Undo (Paco's Q1 ruling), effect table at its end state,
  `"reply"` rejected → Task 8c.
- Docs sync and the R13 rollback check (the 3bff437 build boots on a DB the new build migrated) → Task 13.

**Placeholder scan.** Every code step carries the code. Deliberate edges, named: outcome signals with no stage 1
producer reject every value until their stage defines the set (ruling 7); a required gate check that cannot run is
INCONCLUSIVE (exit 3), never PASS; `CLOCK_CASES` starts empty and may only ever hold a prior-turn case; Task 6 accepts
`announced: "reply"` only until Task 8c removes it in the same stage.

**Type consistency.** `RungResult` / `RungAnswer` / `RungAbstain` / `RungFailed`, `DecideResult` (with `fallbackRung`),
`DecideCtx`, `DecisionRecorder`, `AnyEntry`, `VerdictEffect`, `InputSource`, `RUNNER_REASON_CODES` (Task 3) are used with
the same names in Tasks 5, 6, 8a, 8b, 9, 10. Store names (`insertDecision`, `listDecisionsForRun`, `listDecisionsBetween`,
`countDecisionFallbacks(…, excludeJevRung)`, `countDecisionJevSkips`, `hasJevAnsweredDecisionSince`,
`insertDecisionOutcome`, `listDecisionOutcomes`, `insertLadderMove`, `recordDecisionDigest`, `getDecisionDigest`,
`wasDecisionOffered`, `DecisionRejected`) match between Task 4 and their callers; every `DecisionInsert` literal carries
`fallback_rung`. `recordSkip(…, now?, ladder_decision_id)` and `persistDecisionRows(…, threshold_used, ladder_decision_id)`
match Task 8b's calls. Entry ids `turn.handler` / `turn.gear` match `ENTRY_IDS`, `JEV_PAGED_ELSEWHERE` and the digest's
`FRONT_DOOR`. The callback prefix `dec:rv:` matches between Tasks 10, 11 and 12.

## Appendix: Review dispositions (Rev 1 reviews)

Senior review: `scratchpad/review-ladder/plan1-senior-review.md`. Codex review: `…/plan1-codex-review.md`. Each line: the
finding, then what Rev 2 did.

### BLOCKERs (all fixed)

- **Senior B1 — the "pin bites" mutation could not fail.** Fixed: mutate `choice` to 0.4; `cascade-pick`,
  `cascade-failed` and `cascade-pick-with-rule` are named as the cases that must flip (Task 2 Step 7).
- **Senior B2 — INCONCLUSIVE ❌ tap printed PASS / exit 0.** Fixed: required checks that cannot run go through
  `cannotRun`, and `verdict()` prints `LIVE GATE: INCONCLUSIVE` with exit 3; `ensureUnsure` seeds an offered decision on
  copy B so the tap check runs (Task 12).
- **Codex B1 — an aborted turn could leave an orphan `decisions` row.** Fixed: the front door's rows are queued at decide
  time and written inside `settleTriage`'s transaction after its lost-turn check (ruling 14); tests for Jev-time and
  cascade-time aborts and for a rolled-back save (Task 8b).
- **Codex B2 — P6 classified a structural regression as inconclusive.** Fixed: `classify` compares structure (outcome kind,
  question order, statuses, skip reasons, verdict presence, links) first; a structural difference is a mismatch unless a
  side shows a transient Jev failure, which is retried once and otherwise inconclusive (Task 12).
- **Codex B3 — the gate could PASS without exercising the ❌ tap.** Fixed with Senior B2 (seeded offer; exit 3 when it
  still cannot run).
- **Codex B4 — the `routed_by` differential could not fail.** Fixed: the projection carries every `llm_attempt`'s role and
  `routed_by` plus `route_links_verdict`; `turn-handler-routed-by.test.ts` drives a routed turn through the real
  supervisor (fake omp) and asserts the first compose attempt's `routed_by` is the verdict id, before and after the move
  (Tasks 2, 8b).
- **Codex B5 — the registry certified a false "reply only" effect.** Fixed by Paco's R12: `memory` and `planner` are
  declared `effect` (reversible, announced), the grandfather ruling and ADR paragraph are gone, and `entryProblems` fails a
  misdeclared entry (tests for each failure mode); the effect table is pinned (Task 6). The planner route's in-reply
  announcement is raised as Q1 (Rev 3: Paco ruled "Add the card"; Task 8c).

### WARNINGs (14: 14 applied, 0 rejected)

- Senior W1 (pin harness not frozen; `state_hash` dropped) — applied: `state_hash` kept, `CI=1`, `git diff --exit-code <task-2 sha>` over the frozen set in Tasks 8b and 13, `CLOCK_CASES` guard.
- Senior W2 (throw in `treeArmed`/`routeTree` would settle answered fallback) — applied: `planTree` fails without detail for those, keeps detail only for `urlRule`; pin case `routeTree-throws-after-answer`; the ack-check throw also keeps skipped `error` (ruling 19).
- Senior W3 (`decision_fallback` cleared by rule answers, no damping, double page) — applied: only Jev/model answers clear; `ALERT_REOPEN_QUIET_MS` damping; `budget` excluded; Jev-rung failures of `turn.handler`/`turn.gear` excluded (`JEV_PAGED_ELSEWHERE`); tests rewritten (Task 5).
- Senior W4 (rows for lost/killed turns and rolled-back saves) — applied: atomic write (ruling 14) plus the digest's `settledRows` guard and an orphan test (Tasks 8b, 10).
- Senior W5 (the carve-out was a label) — applied via R12: effects are data with `reversible`/`announced`, checked by `entryProblems`, table pinned.
- Senior W6 (adapter missing from the protected table) — applied: row added for Task 10, commit marked protected; Task 11's `run-store.ts` edit added too.
- Senior W7 (CHECK lists frozen at creation) — applied in the form the brief prefers: growing enums validated in code (`DecisionRejected`, `OutcomeRejected`), CHECKs kept only for fixed sets, with a test that no CHECK freezes a growing set (ruling 15). The senior's literal-list-plus-test variant is not used: it still needs a rebuild migration per extension.
- Senior W8 (5/min limit drops digest taps) — applied: `decision_review` exempt and excluded from the window; test with 8 taps (Task 11).
- Senior W9 (no P6 coverage floor) — applied: calibrated-model check, ≥ 100 armed verdicts, cascade rung ran (INCONCLUSIVE if not), tally printed (Task 12).
- Senior W10 (≥ 190 floor without retries) — applied: one retry, 250 ms pacing, 30 over-fetched candidates, retries reported.
- Senior W11 (build in the main checkout) — applied: Global Constraints worktree rule; Task 12 builds only in worktrees; both scripts refuse to run outside `.worktrees/`; main `dist/` mtime shown unchanged.
- Senior W12 (off-switch semantics decided in the plan) — applied by removal: R13 deletes the off switch; nothing left to rule.
- Senior W13 (Task 8 too large) — applied: split into 8a (glue + pure tests) and 8b (core-worker + pin + consumers), with the exit-by-exit trace table for the 8b reviewer.
- Codex W6 (digest "Jev skips" counted non-Jev failures) — applied: `decisions.fallback_rung`; skips and the sweep count Jev-rung failures only (Tasks 3, 4, 9, 10).

### SUGGESTIONs (12: 10 applied, 2 rejected)

- Senior S1 (locked id classified "unknown" by the off-switch warning) — rejected: moot, R13 removed the off switch and its warning.
- Senior S2 (skip count includes cascade failures and `budget`) — applied with Codex W6 (`fallback_rung`; budget excluded).
- Senior S3 (`snippetOf` splits surrogate pairs) — applied: `Array.from`; emoji test (Task 10).
- Senior S4 (digest ignores enqueue conflict; gate leaves outbox row) — applied: conflict latches `sent: 0`, test; gate clears copy B's `decision_digest:%` outbox rows.
- Senior S5 (`paco_callback_id` not unique) — applied: partial unique index and test (Task 4).
- Senior S6 (floor-held verdict attributed to Jev) — applied: `rung: "rule"`, `reason: "floor_held"`, no judge p (ruling 17, Task 3).
- Senior S7 (pin lacks restructured paths) — applied: `no-turn-state`, `jev-parse`, `memory-lane-finalize-rolled-back`, `routeTree-throws-after-answer`; a quoted-turn case is not added because its fixture helpers are local to `core-worker-triage.test.ts`, whose quote tests (`quoted_turn_id`) run in Task 8b Step 8.
- Senior S8 (gate builds `CoreWorker` without a broker) — rejected as code (constructing the broker needs the firewall env and is a gate-precedent change); applied as the explicit egress note for Paco in Task 12 Step 4.
- Senior S9 (`planTree` glue in an unprotected file) — applied: ADR 0030 consequences note (Task 1) and the module comment (Task 8a).
- Senior S10 (inventory re-walk only A12–A18) — applied as ruling 18: the full re-walk is deferred to the stage 3/4 plans, for Paco to accept.
- Senior S11 (plan hygiene) — applied: pre-flight header (code at 3bff437, docs-only to 1b65de4), adapter `:115`, `copyDb` `:148-151`, Task 4 placement fixed to after `VERDICT_PATCH_COLUMNS` (`:965`), `checkMeteredCeiling` `:506`, `CONTEXT.md` `:65`, sweep paragraph `:736`.
- Codex S7 (render the digest in the gate) — applied: `checkRender` sends the queued notification through `TelegramNotificationAdapter` with a stub transport and checks HTML and one ✅/❌ row per offered decision.

## Appendix: Review dispositions (Rev 2 re-reviews)

Codex re-review: `scratchpad/review-ladder/plan2-codex-review.md`. Senior re-review: `…/plan2-senior-review.md`.

### BLOCKERs (all fixed)

- **Codex #2 (Rev 1 B2 partial) — a persistent structural difference could end inconclusive.** Fixed: after the one retry a
  structural difference is a mismatch; only a structurally identical pair whose sides both failed Jev may be inconclusive
  (`runPair`, Task 12).
- **Codex #5 (Rev 1 B5 partial) / senior W5 — the registry certified `announced: "reply"` without an Undo card.** Fixed by
  Paco's Q1 ruling: Task 8c adds the Undo card to every automatic save and `entryProblems` rejects `"reply"`.
- **Codex #8 — a broken visible ❌ button could pass.** Fixed: `checkRender` asserts each row is exactly
  `dec:rv:<offered id>:ok` / `:bad` in offer order, and `checkTap` feeds the rendered ❌ (then ✅) `callback_data` into the
  gateway.
- **Senior N-B1 — `answer` and `lookup` declared `reply` though they save lessons.** Fixed: Task 6 declares them `effect`
  (`announced: "reply"`, today's truth) and Task 8c moves them to the Undo card; the pinned table changes in both, on purpose.

### WARNINGs (3 senior: 3 applied, 0 rejected)

- Senior W1 (a Jev answer cleared a cascade-only incident) — applied: for `JEV_PAGED_ELSEWHERE` entries only a cascade answer clears `decision_fallback`; new Task 5 test; docs updated.
- Senior W2 (noise could FAIL the gate) — applied in part: `parse` is retryable and a structural difference with differing Jev answers gets the retry; a difference that persists after the retry is still a mismatch, as codex #2 and the spec require (the senior's "reproduced flip counts as nondeterministic" is not adopted).
- Senior W3 (Jev determinism never probed) — applied: a `--limit 10` probe before the full run; more than one nondeterministic pair in ten stops the run for Paco.

### SUGGESTIONs (6 senior: 6 applied, 0 rejected)

- S1 (`npm ci` in the feature worktree) — applied in Global Constraints.
- S2 (`floor_held` always names `rule`) — applied: `Walk.floorRung` names the rung that set the floor; carrying its `detail` is left out (no stage 1 consumer; revisit with stage 2a's first monotone entry).
- S3 (a shortfall caused by inconclusive pairs prints FAIL) — applied: reported INCONCLUSIVE (exit 3) when the inconclusive count explains it.
- S4 (configured shadow hides Jev failures from health) — applied as a configuration.md note (health counts applied rungs; the triage `jev_skip_rate` still pages).
- S5 (queue not cleared after a committed settle) — applied: `settleTriage` clears the queue after a committed non-`inTx` write.
- S6 (what a reverted build does with digests and taps) — applied as a configuration.md note in the R13 paragraph.

### Paco's rulings applied

- Q1 → "Add the card": Task 8c; the open question is removed and the ruling recorded at the top.
- Gate egress → "Yes, 200 messages": recorded in Task 12's egress note; shape-only redaction kept.
