# Jev version check — no version literal in behaviour code; a version move is checked by code

**Status:** Rev 3.4, 2026-10-22 (Rev 3.3 + codex r5: 1 blocker; senior r4: 0 blockers). Paco's ask (2026-10-22):
"build the automatic check". His intent (2026-10-07, restated today): no hard-coded version decides behaviour, and a Jev
version move must not stop him. This is Paco's decision, so ADR 0029 decision 5 and its 2026-10-07 amendment ("falls
through until Paco approves rows") are replaced by §2 (ADR text in §6).

## 1. Facts (live system 2026-10-22, read-only probes; senior r1 P1–P8)

- Version literals that decide behaviour: 18 triage calibration rows (`src/jev/calibration.ts:28-45`: the six tree
  questions plus the status, answer and lookup pseudo-rows, zh and en), `NoiseBand.model`, and the `model` field of the
  four ladder bars (`INJECTION_BAR`, `MEMORY_KIND_BAR`, `SETTLE_BAR`, `IMPROVE_BAR`). Comments naming `jev-1.13` stay.
- Only the triage tree is gated by the model today: `calibratedLang` (`calibration.ts:72`) matches the exact reported model,
  and `treeArmed` (`tree-policy.ts:61`) arms each lane from it. The four ladder bars apply whatever the model reports; a
  model change opens `decision_bar_stale` from the golden ticks and never disarms (ADR 0030 R13: drift pages).
- Reference evidence: the live `jev_decisions` holds only 26 zh, 1 en, 1 mixed tree turns on 1.13.0 with today's hashes.
  The evidence Paco approved on, `.houge/jev-tree/replay.jsonl`, holds 301 turns on 1.13.0 (zh 258, en 30, mixed 13); all
  six criteria hashes equal today's and all 301 states rebuild byte-identical; `labels.jsonl` beside it holds Paco's 111
  labels. That replay is the reference.
- Jev's own noise (1.13.0 against its permuted self, 301 turns): per-question top agreement 0.914 (category) to 0.96–0.99;
  full route-effect agreement 0.731 (the measure §2.5 uses). Absolute bars of 0.9 would fail a model against itself.
- Every Jev call path writes an `llm_attempt` ledger row carrying the reported `model` (golden ticks included).
- The alias served 1.13.0 and 1.14.0 within the same minute (02:33–02:34Z): two ids behind one alias is real.
- The signal-path tick is awaited inside the Telegram poll loop; a multi-minute check must not run there.

## 2. Design

### 2.1 Scope
The check gates the triage tree only (the only model-gated decision). The four ladder bars and the noise band lose their
`model` field and are never disarmed by a version move; their golden sets run against a new model and a drift pages
(R13). No grace: an unchecked model leaves the tree unarmed (today's safe fallback) for the minutes the check takes.

### 2.2 Data (additive migration) — an immutable anchor
- `jev_anchor(turn_id, lang, question_id, criteria_hash, run, answer_json, model, PRIMARY KEY(turn_id, question_id, run))`
  with `run IN ('A','B')` (A = the canonical replay, B = the permuted replay), `jev_anchor_states(turn_id PRIMARY KEY,
  lang, state_json, state_hash)` and `jev_anchor_labels(turn_id PRIMARY KEY, category, by, at)`. Filled once by
  `importJevAnchor(store, dir)` from `.houge/jev-tree/replay.jsonl` (A), the permuted replay file (B) and `labels.jsonl`:
  latest line per key wins, `ok` lines only; A rows are validated against the live questions' hashes and B rows against
  the permuted questions' hashes (`treeQuestions(true)`); each turn's state is rebuilt from the DB at import with the
  live path's redaction: `store.redactSecretValues`, which is the broker's redactor when the secrets firewall is armed
  (`cli.ts:34`, the live daemon's configuration) and the same no-op the live path applies when it is off, so a stored
  state is byte-for-byte what the live path would send in either configuration, and a turn whose rebuilt `state_hash`
  differs from the anchor's is dropped; the stored state is what checks send, so they never depend on chat turns. Counts are logged. Runs at daemon boot when the tables are empty and the files
  exist, and as `houge jev anchor import`. The anchor is never replaced by a later model's answers: every check compares
  with Paco's approved set (no chain drift).
- Anchor baseline per check (§2.5): agreement(anchor A, anchor B) and the label error/recall counts, computed once at
  import and stored in `jev_anchor_meta`.
- `jev_models(model PRIMARY KEY, first_seen_at, state CHECK(state IN ('trusted','checking','deferred','drifted',
  'insufficient','accepted')), checked_at, attempts, detail_json)`. Seed: the anchor's own `model` value → `trusted`, but
  only when the zh anchor holds ≥ 100 rebuilt turns with both an A and a B answer set, and every imported A and B row
  reports one and the same versioned model. **As built:** rows reporting more than one model seed nothing and import
  nothing (status `mixed_models`, one incident), as the replay report already rejects mixed models; fewer than 100 zh
  turns is `insufficient`. Data from the file, no literal in `src/`.
  Fresh DB, no anchor → no `trusted` row → nothing armed.
- Discovery cursor: `ledger_events.rowid` (sequence is per run).

### 2.3 Keys without a version
- `CalibrationRow` drops `model`: a row arms `(question_id, criteria_hash, lang)`. `NoiseBand` and `ProvisionalBar` drop
  `model`. A `model` field in `HOUGE_JEV_CALIBRATION_FILE` is ignored, logged once.
- Arming is read through one protected function, `treeArmingFor(store, decision, lang)` in
  `src/decisions/jev-version-check.ts`, which reads the reported model from the decision itself and the model's
  per-question state; `treeArmed` takes its result. Residual (named): the caller in `src/core/turn-handler-ladder.ts`
  is not protected and could skip the call; the grep test and the live gate cover that path.
- Dependencies: `category` failing disarms category, memory, status, answer, lookup; `sets_rule`/`rule_scope` failing
  disarms rule, status, answer, lookup; a gear question failing disarms gear, answer, lookup (routeTree already requires
  rule and gear for the answer and lookup lanes). **Behaviour change, named and tested:** the status lane now also needs
  `category` (today it arms on its own pseudo-row plus rule).
- Language: zh's verdict covers zh and mixed (as today); en has 30 anchor turns, below the 100 a separate verdict needs
  (senior r2: a separate en verdict false-drifts 66% of moves), so en inherits zh. Ruling recorded in §7.

### 2.4 Discovery and the job
- The signal-path tick reads `llm_attempt` rows (provider jev) after its `rowid` cursor and inserts any unseen model as
  `checking`. No hook in `decide.ts`.
- The check is a background job on its own promise (like the evolution lane), started by the tick, never awaited by it;
  one model at a time; resumable (progress in `detail_json`); an outage retries on the next start; the stop signal is
  honoured. A batch whose answers report another model (the alias served the old id) is retried at most 3 times, then
  the model goes `deferred` (retried on a later day) and the job moves on.

### 2.5 The check
Send each anchor turn's stored state through the tree questions on the candidate, twice: run A canonical and run A2
canonical again (the self control), plus run B permuted. Only answers whose reported model equals the candidate count.
Agreement per check: same top option (choice), same zone across the bar (noul), same level bucket (score); the route
check compares the full route effect from `routeTree` with today's bars (category, lane, role, effort, save, scope; a
cascade by its pair). Seven checks: six questions + route. `slack(n, p) = max(0.05, 2.7 · sqrt(p(1−p)/n))` (z for 1 %
per check over seven checks).
a. **Close to the anchor:** agreement(cand A, anchor A) ≥ agreement(cand A, cand A2) − slack.
b. **Not noisier than the anchor:** agreement(cand A, cand B) ≥ agreement(anchor A, anchor B) − slack.
c. **Paco's labels, as allowed counts** (anchor values stored at import): per lane (memory, status, answer, lookup) the
   candidate's wrong routes into that lane ≤ the anchor's + 1 — this disarms that lane on failure. A recall drop (fewer
   labelled turns routed to their lane than the anchor's − max(2, the anchor's own A-vs-B recall gap + 1)) never
   disarms and never pages on its own: its numbers go into the one check-outcome notice (§2.5 d), so a routine move
   stays one message:
   losing recall is the safe direction (those turns fall back to the planner), and the anchor's recall is inside Jev's
   noise (senior r3: memory 11 → 9 between the anchor's own runs). The anchor's own B run must pass check c (a test).
d. **Outcome.** All pass → `trusted`, one notice with the margins and any recall drop. Any failure of the route check disarms the whole tree for that model, whether or not a
   question also failed (fail closed: a route drift cannot be tied to one question's dependents). A failure → `drifted`, the failing questions and lanes in `detail_json` (dependents
   per §2.3), the rest armed; one alerted incident with the numbers and an Accept button. Anchor < 100 zh turns →
   `insufficient`, nothing armed for that model, one incident naming the import.
e. **Ladder bars.** Each golden set runs on the candidate in check-specific runs keyed by model; every item's reported
   model must equal the candidate (else retried as above). `improve.route` gets a golden set of states that the rule rung
   abstains on, so each item reaches the Jev rung, with intended targets. Drift → one incident per entry; never disarms.
   `decision_bar_stale` retires.
Cost: 3 × ~300 turns ≈ $0.20 per version move. **As built:** asks are paced at 1.5 s per call (`JEV_CHECK_PACE_MS`, so the
check cannot trip a 429 on Paco's live triage key), so a check takes about 45 minutes after a version move and the lanes
fall back to the planner that long. The live gate ran about 2 h because it runs the check twice plus three golden repeats.

### 2.6 Paco's controls
`houge jev models` (states and numbers), `houge jev check <model>` (re-run), `houge jev accept <model>` (everything armed);
the incident card's Accept button (`dec:jv:<model hash>:acc`, chat-bound, once). `jev_model_uncalibrated` is replaced by
these incidents.

### 2.7 Protected surface
The check's thresholds, state machine and arming read live in `src/decisions/jev-version-check.ts` (under the protected
`src/decisions/`); `src/jev/calibration.ts` joins `PROTECTED_FILES` (it holds the arming rows the gate reads). **As built (Paco's middle path,
2026-10-22):** `src/jev/tree-policy.ts` is NOT protected; the arming application (`treeArmed`: the check state and the
lane dependencies) lives in the protected `src/decisions/jev-version-check.ts`, and the routing policy only consumes its
result. Residual: a self-write could change how `routeTree` honours the result, and the caller
`src/core/turn-handler-ladder.ts` is unprotected too (open question to Paco in `tasks/todo.md`).

## 3. Failure modes
Reference files missing → no reference → nothing armed + one incident naming the import command. Two ids behind the alias →
each has its own row; a `trusted` id arms its calls, the other's calls fall back until checked. Outage mid-check → resume.
A model that never passes → stays `drifted`; Paco accepts or waits for the next move.

## 4. Tests and gate
Unit: no version in any key, plus a test that greps `src/` for `jev-\d+\.\d+` outside comments and fails; import (latest
line per key, ok only, hash filter, state rebuilt, counts, ≥ 100 zh to seed); discovery by rowid; arming via
`treeArmingFor` with dependencies (incl. the status-lane change); slack maths; checks a–c including zero-denominator and
the ratchet-free anchor; mixed-model retry bound → deferred; insufficient; incidents and Accept. Live gate on a VACUUM
INTO copy with real Jev, the anchor imported, candidate = whatever `jev-latest` reports: PASS requires ≥ 200 zh anchor
turns compared, the check completes, arming matches its verdict, a shuffled-anchor negative control FAILS, and a self
control PASSES: the full check re-run with the candidate's own run A as the anchor and fresh runs as the candidate
(≈ $0.10 more). The per-check margins are printed.

## 5. Out of scope
Re-tuning bar values on a new model (their revisits do that); omp and Claude versions (already version-free).

## 6. ADR 0029 text (decisions 1 and 5 and the 2026-10-07 amendment, replaced)
"Calibration approves questions and bars, not a model version. A Jev version move is checked by code against Paco's
approved reference turns and labels; a version that agrees within Jev's own noise arms; a drift disarms only the drifting
triage questions and pages him. Safety judges never disarm on a version move."

## 7. Rulings (cost if wrong)
- en inherits zh's verdict (30 anchor turns; a separate verdict false-drifts 66 % of moves) — an en-only drift goes
  unseen; en traffic is ~2 % of turns.
- The anchor never rolls forward — after several version moves the model may legitimately diverge from 2026-10 answers
  and page; Paco then accepts or re-labels.
- Status lane needs `category` — one more way the status lane falls back.
- A category drift under ~5 % of turns may pass (caught about 2 times in 3) — such a small drift on routing is within
  what Jev's own noise already does day to day.
- Measured (senior r4): a same-model move disarms something on ~3–10 % of moves (one Accept tap); a 10 % routing
  drift is caught essentially always, 5 % about 2 times in 3.
- A recall drop is reported in the notice and does not disarm — a model that quietly stops routing to a lane keeps the lane armed (the
  planner takes those turns) until Paco looks.
