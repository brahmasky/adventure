# Jev version check — implementation plan (Rev 2.1: codex plan r1 and r2 closed)

> For agentic workers: REQUIRED SUB-SKILL: subagent-driven-development. Steps use `- [ ]`.

**Goal:** no Jev version literal decides behaviour; a Jev version move is checked by code against Paco's approved
anchor and only drifting triage questions disarm.
**Architecture:** an immutable anchor (Paco's 2026-10-09 replay A/B + labels, states rebuilt with the live redactor) in
new tables; a `jev_models` state machine fed by `llm_attempt` ledger rows; a background check job (runs A, A2, B on the
candidate; checks a/b/c from the spec; golden runs keyed by model); arming read through one protected function.
**Spec:** `docs/superpowers/specs/2026-10-22-jev-version-check-design.md` Rev 3.4 (binding; §2.5 maths and §7 rulings).

## Global constraints
- `dependencies: {}` stays empty. Node stdlib + devDeps. Functions < 50 lines. Logs carry `errorCode(e)`, never
  `e.message`, never state or turn text. Telegram output through the outbox and the rich renderer.
- Never open `/Users/xiaochuan/Projects/adventure/houge.sqlite` for writing in tests or gates; gates use `VACUUM INTO`.
- Protected files touched under Paco's go (2026-10-22): `src/decisions/`, `src/run/run-store.ts`, `src/run/run-ledger.ts`,
  `src/capabilities/self-write-guard.ts`, `src/jev/jev-client.ts` (only if needed), `docs/decisions/0029`.
- After this change `grep -rEn "jev-[0-9]+\.[0-9]+" src` matches comments only (a test enforces it).
- Constants (spec): `JEV_ANCHOR_MIN_ZH = 100`, `JEV_CHECK_SLACK_MIN = 0.05`, `JEV_CHECK_Z = 2.7`,
  `JEV_CHECK_MIXED_RETRIES = 3`, wrong-route allowance `+1`, recall allowance `max(2, gap + 1)`.
- Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. One concern per commit. Tests first, seen red.

## Task 1 — Store: anchor and model tables
Files: `src/run/run-store.ts` (migration `2026-10-22-jev-version-check` + methods), `tests/run/jev-version-store.test.ts`.
- Tables per spec §2.2: `jev_anchor(turn_id, lang, question_id, criteria_hash, run CHECK(run IN ('A','B')),
  answer_json, model, PRIMARY KEY(turn_id, question_id, run))`, `jev_anchor_states(turn_id PK, lang, state_json,
  state_hash)`, `jev_anchor_labels(turn_id PK, category, by, at)`, `jev_anchor_meta(key PK, value_json)`,
  `jev_models(model PK, first_seen_at, state CHECK(state IN ('trusted','checking','deferred','drifted','insufficient',
  'accepted')), checked_at, attempts INTEGER NOT NULL DEFAULT 0, detail_json)`, `jev_model_cursor(id PK CHECK(id=1),
  ledger_rowid)`.
- Methods: `anchorEmpty()`, `insertAnchorRows(rows)` (one transaction), `listAnchorTurns(lang?)`,
  `anchorAnswers(run)`, `anchorStates()`, `anchorLabels()`, `getAnchorMeta(key)` / `setAnchorMeta`,
  `noteJevModel(model, now)` (INSERT OR IGNORE as `checking`), `getJevModel(model)`, `listJevModels()`,
  `setJevModelState(model, state, detail, now)` (fenced on the previous state), `bumpJevModelAttempts`,
  `jevAttemptModelsSince(rowid)` → `{ model, rowid }[]` from `ledger_events` `llm_attempt` provider `jev`, and the cursor.
- Model-keyed check runs (the daily golden latch is `(local_date, entry_id)`, `run-store.ts:1072`, and cannot hold one
  run per model): `jev_check_runs(model, generation, entry_id, run, outcome, detail_json, created_at, PRIMARY KEY(model,
  generation, entry_id, run))` with `recordJevCheckRun` / `getJevCheckRun`; `jev_models.generation INTEGER NOT NULL
  DEFAULT 0` is bumped when a check starts, and only rows of the model's current generation are credited (a re-run or a
  stopped partial run never reuses an older generation's results); the daily golden tables are untouched.
- Tests: additive migration on a DB with the 2b-ii tables; fenced state change; discovery reads models after the cursor
  only.

## Task 2 — Keys without a version
Files: `src/jev/calibration.ts`, `src/jev/tree-policy.ts`, `src/decisions/types.ts`, `src/decisions/noise-band.ts`,
`src/core/turn-handler-ladder.ts` (`treeNear`, :64-70: `bandFor` loses the model), `src/decisions/injection-judge.ts`
(`nearInjection`, :128), `src/jev/triage-report.ts` (`candidateRows`, :242: rows without `model`), `src/jev/noise-measure.ts`
(:36: generated band rows without `model`),
the four entries (`tool-injection`, `memory-kind`, `turn-settle`, `improve-route`), `src/decisions/golden.ts`,
`src/jev/jev-incidents.ts`, tests; new `tests/jev/no-version-literal.test.ts`.
- `CalibrationRow`, `ProvisionalBar`, `NoiseBand` drop `model`; `calibratedLang(questionId, hash, lang, rows)`;
  `bandFor(question, hash, bands)`; `HOUGE_JEV_CALIBRATION_FILE` rows with a `model` field: field ignored, one log line.
- Golden ticks: remove the `stale` / `decision_bar_stale` branch (spec §2.5 e retires it; drift incidents stay).
- `checkJevModelCalibrated` and `jev_model_uncalibrated` retire (resolve any open rows in the migration of Task 1 or at
  boot); the call at `core-worker.ts:3214` goes.
- Test: the literal grep; a match is allowed only on a comment line (after trimming it starts with `//`, `*` or `/*`,
  which covers `/**`), so `src/jev/questions/tree.ts:86` and the other notes pass and any code use fails.
- Until Task 3 lands, `treeArmed` keeps a model parameter but ignores it (keeps the build green between tasks).

## Task 3 — Arming through the check state (protected)
Files: create `src/decisions/jev-version-check.ts` (arming part), modify `src/jev/tree-policy.ts`,
`src/core/turn-handler-ladder.ts` (`PlanInput` gains the arming result; :97), `src/core/core-worker.ts` (`planAnswered`,
:3147-3151: computes `treeArmingFor(this.runStore, d, lang)` and passes it in; the `checkJevModel` call goes), `src/capabilities/self-write-guard.ts` (add `src/jev/calibration.ts`,
`src/jev/tree-policy.ts`), tests `tests/decisions/jev-version-arming.test.ts`.
- `treeArmingFor(store, decision, lang): ModelArming` (spec §2.3: reads the reported model from the answered decision) → per tree question `armed` from `jev_models` state: `trusted` /
  `accepted` → all; `drifted` → all but `detail.failed_questions` and, when `detail.route_failed`, none; `checking`,
  `deferred`, `insufficient`, unknown → none; the request alias → none. `mixed` → zh; `en` → zh (spec §2.3).
- `treeArmed(lang, rows, lanesOff, arming)` applies dependencies: category → memory, status, answer, lookup;
  sets_rule/rule_scope → rule, status, answer, lookup; any gear question → gear, answer, lookup; status additionally needs
  category (named behaviour change, its own test).
- `planAnswered` passes the decision itself; on any store error → `UNARMED` (logged with errorCode).

## Task 4 — Anchor import
Files: create `src/jev/anchor-import.ts`, modify `src/cli.ts` (`houge jev anchor import`), `src/telegram/telegram-daemon.ts`
(boot import when `anchorEmpty()` and the files exist; failure logged, boot continues), tests
`tests/jev/anchor-import.test.ts`.
- Read `.houge/jev-tree/replay.jsonl` (A), `replay-permuted.jsonl` (B), `labels.jsonl`: latest line per key, `ok` only;
  A hashes vs `treeQuestions(false)`, B vs `treeQuestions(true)`; rebuild each turn's state exactly as
  `triage-replay.ts` does, through `store.redactSecretValues`; drop a turn whose rebuilt `state_hash` differs or that
  lacks either run; all rows one model (else nothing seeded).
- Meta at import: per question and route, agreement(anchor A, anchor B); per lane wrong-route and recall counts on the
  labels for A and B (spec §2.5 c inputs).
- Seed `jev_models` `trusted` for the anchor model when zh paired turns alone ≥ 100 (mixed not counted); else
  `insufficient` and one incident naming the command. Missing files at boot (and an empty anchor) → one incident naming
  `houge jev anchor import` and the expected paths (spec §3), not a silent skip. Idempotent: a second import with a non-empty anchor is a no-op with a message.

## Task 5 — The check maths (pure)
Files: `src/decisions/jev-version-check.ts` (maths part), tests `tests/decisions/jev-version-maths.test.ts`.
- `agreementByCheck(a, b): Record<CheckId, { agree: number; n: number }>` over the six questions (choice: top option;
  noul: zone across that question's bar from `TREE_BAR_DEFAULTS`; score: level bucket) and `route` (the full
  `routeTree` effect with today's bars: category, lane, role, effort, save, scope; a cascade by its pair).
- `slack(n, p) = max(0.05, 2.7 * sqrt(p(1-p)/n))`.
- `judge(input) → { pass, failed_questions, route_failed, lanes_disarmed, recall_drops, margins }` implementing a, b, c
  exactly as spec §2.5. Fixtures: the anchor's own B run passes c; a 10 % category flip fails a; a noisier candidate
  fails b; a route-only failure → `route_failed`; zero routes into a lane the anchor used → that lane disarmed.

## Task 6 — The check job, incidents, controls
Files: `src/decisions/jev-version-check.ts` (job part) or `src/decisions/jev-version-job.ts`, `src/decisions/golden.ts`
(model-keyed check runs; an `improve.route` golden set whose items the rule rung abstains on), `src/telegram/telegram-daemon.ts`
(start the job from the signal-path tick without awaiting it; boot), `src/cli.ts` (`houge jev models | check <model> |
accept <model>`), the tap (`dec:jv:<hash>:acc`, parser + gateway, chat-bound, once), tests.
- Discovery each tick: `jevAttemptModelsSince(cursor)` → `noteJevModel`; advance the cursor.
- Which model: requests always name the alias `jev-latest` (`jev-client.ts:76,140`), so a check can only test the model
  the alias serves now; answers reporting another id are filtered (retried ≤ 3, then `deferred`). `houge jev check` re-runs
  the check for the model the alias currently serves; `houge jev check <model>` refuses with a message when `<model>` is
  not what the alias serves.
- Job: one model at a time; send the anchor's stored states through the tree questions for runs A, A2 (canonical) and B
  (permuted) with `createJevClient` as the daemon builds it; only answers reporting the candidate count; a mixed batch
  retried ≤ 3 then `deferred`; resumable progress in `detail_json`; stop signal honoured; outage → retry next start.
- Then the golden sets on the candidate via model-keyed runners (`runGoldenForModel(entry, model, client)` for
  tool.injection, memory.kind, turn.settle, and a new `IMPROVE_GOLDEN` + runner for improve.route whose items the rule
  rung abstains on — a test asserts `improveRule(item).abstain` for each) recorded in `jev_check_runs`; each item must
  report the candidate → per-entry drift incident, never disarm.
- Outcome → `setJevModelState`; one notice (pass: margins, recall drops) or one alerted incident (drift/insufficient:
  numbers + Accept button). The Accept card is its own notification (not the generic `alertOpened` text): payload
  `{ text, button_rows: [[{ text: "Accept <model>", callback_data: "dec:jv:<sha8 of model>:acc" }]] }`, through the
  outbox and the rich renderer, to the operator chat; the tap is parsed by `parseJevAcceptCallback` (`src/triggers/telegram-command-parser.ts`), becomes a
  `TaskEventType` `jev_accept_tap` (`src/domain/types.ts`, the type pin test follows), is built in
  `src/triggers/telegram-trigger-adapter.ts` after the improvement tap (:275 area), dispatched in `src/gateway/gateway.ts`
  beside `improvement_tap` (:199 area), rate-limit exempt, handled in `src/gateway/jev-accept-commands.ts`, chat-bound, `oncePerTrigger`, fenced on `drifted|insufficient` → `accepted`. Accept → `accepted`.
- Tests (spec §4): import latest-line/ok/hash/state/count/one-model/paired; zero-denominator lane; recall drop in the
  notice (not a page); resume after stop; mixed batch → deferred after 3; Accept replay refused; golden item reporting
  another model → retried, never credited.

## Task 7 — Live gate
File: `scripts/live-gate-jev-version.mjs` (model: `scripts/live-gate-improve-route.mjs` for copy/refusal/redaction).
- On a VACUUM INTO copy: import the anchor; candidate = whatever `jev-latest` reports; run the full check. PASS: ≥ 200 zh
  anchor turns compared; the check completes; arming matches the verdict; a shuffled-anchor negative control FAILS; the
  self control (candidate's own run A as anchor, fresh runs as candidate) PASSES; margins printed. Outage →
  INCONCLUSIVE.

## Task 8 — Docs (Paco's decision, no compromise amendments)
`docs/decisions/0029-jev-system-one.md`: replace decisions 1 and 5 and the 2026-10-07 amendment's arming sentence with
spec §6's text (a decision, so it belongs in the ADR); `docs/reference/configuration.md` (CLI commands, no new env var),
`docs/reference/jev-decision-layer.md`, `CONTEXT.md` (Anchor), `README.md`, `docs/ROADMAP.md`, `tasks/todo.md`,
`tasks/lessons.md` (the lesson: an ADR amendment is not done), `sessions.md`.
