# Jev version check — no version literal in behaviour code; a version move is checked by code

**Status:** Rev 2, 2026-10-22 (Rev 1 + senior review r1, 4 blockers, and codex r1, 7 blockers). Paco's ask (2026-10-22):
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
  routed-lane agreement 0.78 (0.87 counting any cascade as equal). Absolute bars of 0.9 would fail a model against itself.
- Every Jev call path writes an `llm_attempt` ledger row carrying the reported `model` (golden ticks included).
- The alias served 1.13.0 and 1.14.0 within the same minute (02:33–02:34Z): two ids behind one alias is real.
- The signal-path tick is awaited inside the Telegram poll loop; a multi-minute check must not run there.

## 2. Design

### 2.1 Scope
The check gates the triage tree only (the only model-gated decision). The four ladder bars and the noise band lose their
`model` field and are never disarmed by a version move; their golden sets run against a new model and a drift pages
(R13). No grace: an unchecked model leaves the tree unarmed (today's safe fallback) for the minutes the check takes.

### 2.2 Data (additive migration)
- `jev_reference(turn_id, lang, question_id, criteria_hash, answer_json, model, imported_at, PRIMARY KEY(turn_id,
  question_id))` and `jev_reference_labels(turn_id, category, by, at)`. Filled by `importJevReference(store, dir)` from
  `.houge/jev-tree/replay.jsonl` + `labels.jsonl`: at daemon boot when the table is empty and the files exist, and by
  `houge jev reference import`. Only rows whose criteria hash equals the live question's hash are imported.
- `jev_models(model PRIMARY KEY, first_seen_at, state CHECK(state IN ('trusted','checking','drifted','insufficient',
  'accepted')), checked_at, detail_json)`. Seed: the import marks the reference rows' own `model` value `trusted` — data
  from the file, no literal in `src/`. Fresh DB with no reference → no `trusted` row → nothing armed (today's behaviour).

### 2.3 Keys without a version
- `CalibrationRow` drops `model`: a row arms `(question_id, criteria_hash, lang)` (Paco's approval of the questions and
  bars). `NoiseBand` and `ProvisionalBar` drop `model`. A `model` field in `HOUGE_JEV_CALIBRATION_FILE` is ignored, logged
  once.
- A tree question arms on a call when its row matches AND the call's reported model is `trusted` or `accepted` for that
  question and language (per-question state in `detail_json`). The alias string itself never arms.
- Dependencies: `category` failing disarms category, memory, status, answer, lookup; `sets_rule`/`rule_scope` failing
  disarms rule (and status, which needs it); a gear question failing disarms gear. The pseudo-rows have no question of
  their own: they ride on `category` plus their lane's absolute label check (§2.5 b).

### 2.4 Discovery and the job
- Discovery: the signal-path tick reads `llm_attempt` rows (provider jev) since its cursor and inserts any unseen model as
  `checking`. No hook in `decide.ts` (protected, documented never to write).
- The check is a background job on its own promise (like the evolution lane), started by the tick, never awaited by it;
  one model at a time; resumable (progress in `detail_json`); Jev outage → retried next start; stop signal honoured.

### 2.5 The check (per language with ≥ 20 reference turns; zh and en today; `mixed` inherits zh as now)
Run the reference turns' rebuilt states through the tree questions on the candidate model, twice (run A canonical, run B
the existing permuted order). Only answers whose reported model equals the candidate count; a mixed-model batch is
retried (the alias may serve the old id).
a. **Relative to its own noise.** For each question: agreement(A, reference) ≥ agreement(A, B) − `JEV_CHECK_SLACK = 0.05`,
   where agreement is: same top option (choice), same zone across the bar (noul), same level bucket (score). Same for the
   full route effect (`routeTree` on both answer sets with today's bars: category, lane, role, effort, save, scope; a
   cascade compares by its pair).
b. **Absolute, on Paco's labels.** Against `jev_reference_labels`: no new turn routed to the memory or status lane that the
   reference did not route there and Paco did not label so; answer-lane and lookup-lane precision against labels ≥ the
   reference's precision − 0.05.
c. **Outcome.** Pass → `trusted`; the candidate's run A answers become the next reference answers (labels stay the
   anchor, so drift cannot accumulate silently). Fail → `drifted`, failing questions and lanes in `detail_json`, the rest
   armed; one alerted incident with the numbers and an Accept button. A language with < 20 reference turns →
   `insufficient` for that language (unarmed), one incident.
d. **Ladder bars.** The candidate also runs each golden set (check-specific runs keyed by model, not the daily latch);
   `improve.route` gets a golden set from the sanity script's planted groups. Drift → one incident per entry; never
   disarms. `decision_bar_stale` retires.
Cost: 2 × ~300 turns ≈ $0.15 per version move; time ≈ a few minutes on the background job.

### 2.6 Paco's controls
`houge jev models` (states and numbers), `houge jev check <model>` (re-run), `houge jev accept <model>` (everything armed);
the incident card's Accept button (`dec:jv:<model hash>:acc`, chat-bound, once). `jev_model_uncalibrated` is replaced by
these incidents.

### 2.7 Protected surface
The check's thresholds, state machine and arming read live in `src/decisions/jev-version-check.ts` (under the protected
`src/decisions/`); `src/jev/calibration.ts` and `src/jev/tree-policy.ts` join `PROTECTED_FILES` (they now read the gate).

## 3. Failure modes
Reference files missing → no reference → nothing armed + one incident naming the import command. Two ids behind the alias →
each has its own row; a `trusted` id arms its calls, the other's calls fall back until checked. Outage mid-check → resume.
A model that never passes → stays `drifted`; Paco accepts or waits for the next move.

## 4. Tests and gate
Unit: no version in any key (and a test that greps `src/` for `jev-\d+\.\d+` outside comments and fails); import idempotent
and hash-filtered; discovery from ledger rows; per-question/per-language arming and dependencies; self-baseline maths;
label check; mixed-model retry; insufficient; incidents and Accept. Live gate on a VACUUM INTO copy with real Jev, the
reference imported, candidate `jev-1.14.0`: PASS requires ≥ 200 zh reference turns compared, the check completes, arming
matches its verdict, a shuffled-reference negative control FAILS the check, and the reference model against itself (if the
alias still serves it; else run B against run A) PASSES.

## 5. Out of scope
Re-tuning bar values on a new model (their revisits do that); omp and Claude versions (already version-free).

## 6. ADR 0029 text (decision 5 and the 2026-10-07 amendment, replaced)
"Calibration approves questions and bars, not a model version. A Jev version move is checked by code against Paco's
approved reference turns and labels; a version that agrees within Jev's own noise arms; a drift disarms only the drifting
triage questions and pages him. Safety judges never disarm on a version move."
