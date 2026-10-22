# Jev version check — no version literal in behaviour code; a version move is checked by code

**Status:** Rev 1, 2026-10-22. Paco's ask (2026-10-22): "build the automatic check". Intent he set 2026-10-07 and
restated today: no hard-coded version (omp, model, Jev) decides behaviour. ADR 0029's 2026-10-07 amendment kept
calibration keyed on the reported Jev version and accepted "every lane falls through to the planner until Paco approves
rows" on an alias move; TypeSafe moved `jev-latest` from `jev-1.13.0` to `jev-1.14.0` at 2026-10-22T02:33Z and that
fallback is now live. This spec removes the version from every behaviour key and replaces Paco's manual re-approval with
a measured check.

## 1. Facts (live system, 2026-10-22, read-only probes)

- Version literals that decide behaviour: 14 triage calibration rows (`src/jev/calibration.ts:28-45`, `model:
  "jev-1.13.0"`), four ladder bars (`INJECTION_BAR`, `MEMORY_KIND_BAR`, `SETTLE_BAR`, `IMPROVE_BAR`, field `model`).
  Comments naming `jev-1.13` (option-order bias notes) are history, not behaviour; they stay.
- Arming today: `calibratedLang(question, hash, model, lang)` matches a row on the exact reported model
  (`calibration.ts:72`); `treeArmed` (`tree-policy.ts:61`) arms each lane from those rows. The four bars apply whatever
  the model; their golden ticks (`golden.ts`) open `decision_bar_stale` when the reported model differs from `bar.model`.
- Alias-move page: `checkJevModelCalibrated` (`jev-incidents.ts:84`) opens `jev_model_uncalibrated` once per new model.
- Reference evidence on the old version (`jev_decisions`, answers stored): triage zh 180, en 6, mixed 9; injection 541.
  `jev_decisions` keeps `state_hash`, not the state; the tree replay (`triage-replay.ts:126`) rebuilds a turn's state from
  the DB and re-asks the tree questions (cost ≈ $0.066 per 293 turns, ADR 0029 evidence).
- Golden sets exist for `tool.injection`, `memory.kind`, `turn.settle` (`golden.ts`); none for `improve.route`.
- Since the move: 3 injection and 1 improve call on 1.14.0; no triage call yet (the next Telegram turn falls back).

## 2. Design

### 2.1 Data
New table `jev_models(model TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN
('trusted','checking','drifted','accepted')), checked_at TEXT, detail_json TEXT)`. Additive migration. Seed: one row
`state='trusted'` for the model the current rows were approved on — a data row in the migration (history, not
behaviour), derived from the existing `CALIBRATED_ROWS` model values before the field is removed, so the literal leaves
`src/` with this change.
- `trusted`: the reference version (calibration approved on it, or a check passed against a trusted one).
- `checking`: seen, check pending or running. `drifted`: check failed (per question/entry detail). `accepted`: Paco
  accepted a drifted version by command.

### 2.2 Keys without a version
- `CalibrationRow` drops `model`; arming matches `(question_id, criteria_hash, lang)`. `HOUGE_JEV_CALIBRATION_FILE`
  rows follow (a `model` field in the file is ignored, logged once).
- `ProvisionalBar` drops `model`.
- A question/entry is armed on the reported model when the model's state is `trusted` or `accepted`, or `checking`
  (§2.4 grace), or `drifted` for a question the check did not flag. A `drifted` question/entry falls back as today.
- The alias row rule stays: a reported model equal to the request alias never arms.

### 2.3 Trigger
Every answered Jev call (any point) passes `r.model` to `noteJevModel(store, model, now)`: unknown → insert `checking`,
`first_seen_at`. One indexed read per call; no network. The check runs on the daemon's signal-path tick (never in a
turn), at most one model at a time, retried next cycle on an outage (Jev error / 429 / timeout), budget 120 s per cycle.

### 2.4 Grace while checking
A `checking` model arms as if trusted for up to `JEV_CHECK_GRACE_MS = 24 h` from `first_seen_at`. Jev never gates an
action (ADR 0029 monotone rule), so the worst case is lanes routing for a few hours on an unmeasured model. After 24 h
without a finished check (persistent outage), the model is treated as `drifted` for everything and one alerted
incident says so.

### 2.5 The check
Against the newest `trusted` (or `accepted`) model, the reference:
1. **Triage.** Replay the last `JEV_CHECK_TURNS = 60` telegram turns that have reference answers on the reference model,
   through the tree questions on the new model (the existing tree replay core, store copy semantics unchanged, no
   writes to live verdict tables; results to a check table or the detail). Per question and language with ≥ 20
   reference turns: top-option agreement ≥ `JEV_CHECK_TOP_AGREE = 0.9` and mean |Δp(top option of the reference)| ≤
   `JEV_CHECK_MEAN_DP = 0.1`; and the routed lane (`routeTree` on both answer sets, same bars) agrees on ≥ 0.9 of turns.
   A language with < 20 reference turns inherits the zh result (as `mixed` does today, spec 2026-10-06 §3.4).
2. **Ladder bars.** Run each existing golden set on the new model: no `drift` outcome → pass for that entry.
   `improve.route` has no golden set: it passes when triage passes (its bar is new and tunes on its own revisit).
3. **Outcome.** All pass → `trusted`, one notice card "Jev moved to <model>; the check passed (n turns, agreement x)".
   Some fail → `drifted` with the failing questions/entries in `detail_json`; those fall back; one alerted incident
   with the numbers. The old `jev_model_uncalibrated` and `decision_bar_stale` kinds retire (their open rows resolve).

### 2.6 Paco's controls
`houge jev models` lists the table; `houge jev check <model>` re-runs a check; `houge jev accept <model>` marks a
drifted model `accepted` (everything armed). Telegram: the incident card carries an Accept button (`dec:jv:<model>:acc`,
chat-bound, once).

## 3. Failure modes
- Jev outage during the check → retry next cycle; grace bounds it; incident after 24 h.
- Two ids behind the alias (canary) → each gets its own row and check; no alternation page.
- Reference too thin (fresh DB) → no `trusted` row → nothing armed (today's behaviour with no rows).
- Cost: ~60 turns × tree questions ≈ $0.02 per version move; golden sets as today.

## 4. Tests and gate
Unit: keys without version; `noteJevModel` idempotent; grace window; check pass/fail per question and per entry; a thin
language inherits zh; incidents open/resolve; CLI/tap accept. Live gate on a VACUUM INTO copy with the real Jev: the
reported model today is `jev-1.14.0` against the seeded `jev-1.13.0` reference — the gate runs the real check and prints
the agreement numbers; PASS = the check completes and the arming result matches its verdict. Grep gate: no `jev-1.`
literal in `src/` outside comments and the migration seed.

## 5. Out of scope
Recalibrating bar values on the new model (the 14-day revisits do that); omp and Claude model versions (already
version-free: role lists resolved against the live catalog).
