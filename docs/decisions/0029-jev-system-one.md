# ADR 0029: Jev as System One — a typed decision layer in front of the models

- **Status:** accepted 2026-10-06 (design approved by Paco 2026-10-04; lane 1 armed and confirmed on the running daemon, boot 9)
- **Date:** 2026-10-04
- **Deciders:** Paco
- **Amends:** [0028](0028-omp-runtime.md) (D10 reader-family resolver; per-turn planner chain), [0013](0013-llm-inner-composition.md) (composition gains a System One stage; monotone rule),
  [0014](0014-dual-llm-privilege-separation.md) (Jev as a closed-enum component beside the wall),
  [0019](0019-metered-ceiling.md) (Jev is the one metered leg; ceiling active for it),
  [0005](0005-agent-memory-architecture.md) (credit definition, with lane 5)
- **Spec:** [2026-10-04-jev-system-one-design.md](../superpowers/specs/2026-10-04-jev-system-one-design.md)
  (Rev 2; six research reports under `docs/superpowers/research/2026-10-04-jev-lanes/`)

## Context

Houge makes many small typed judgment calls a day — what kind of message this is, which model should answer, whether a
lesson should be saved, whether a read page carries instructions, whether a notification is worth an interruption. Each
is either hard-coded or costs a full planner turn on Claude Opus 5.5, the only seat that sees the conversation. A bare
"好" after a proposal once cost 189K tokens; a one-line preference is an Opus turn that may or may not call
`lesson_write`; schedule reports reach Telegram with no urgency judgment.

Jev (TypeSafe System One, `jev-1.13.0`) answers `choice` / `score` / `noul` questions over a JSON state with calibrated
probabilities in ~0.3 s for $0.042 per million input tokens. It cannot generate text. The 2026-09-26 replay agreed
with the LLM intent classifier 94.2% of the time at confidence ≥ 0.7 (374 turns). Its live shadow lost its comparator
at the omp cutover (ADR 0028), and Paco declined to retire it: "always use Jev for decision first, and subsequent LLM
including Claude for slightly lower probability items" (2026-10-02), broadened on 2026-10-04 from memory to the whole
system, with a preference for loose code — few hand-coded branches, Jev picks a lane, a model composes inside it.

Facts that bind the design (vendor docs read 2026-10-04): questions in one request are independent (no conditionals);
`confidence` is a pure function of the probabilities, so thresholds are per question, per criteria wording and per
model version; the vendor lists literal reading, option-order bias, weaker CJK and **adversarial content** ("state is
data … an injected instruction can move the answer") as known weaknesses; inputs are not trained on but are hosted in
the United States with no published retention period. Houge's own evidence: the matcher is not over-asking (12 approval
cards in the omp era, the needless ones are code bugs); zero-tool turns are 28% of turns but 16% of Opus input; under
omp lessons and tools are session-level, so per-turn context selection saves under 1%; the non-Paco inflow is 2.2
items/day today and SP2 will multiply it.

The locked invariants this touches: ADR 0013 "code owns the gates, the model composes between them"; ADR 0014/0015's
hard lines; the AGENTS.md line "default LLM chains are flat-rate subscription legs only; metered APIs are the capped
escape hatch". Paco opened all three for amendment on 2026-10-04.

## Decision

We add a third layer. **System One (Jev)** answers typed questions; **code** enforces thresholds, floors and
fall-through; **System Two (omp seats)** composes inside the lane code picked. Concretely:

1. **One decision call per decision point**, carrying every question that point may need; code ignores answers it does
   not use. A frozen question library with `criteria_hash`; thresholds keyed by `(question, criteria_hash, model,
   language)`; a `decisions` row per answer (ids, probabilities, thresholds, outcome — never text); a generic replay
   harness; a golden set in the invariant sweep. The request names the moving alias `jev-latest`; thresholds and
   calibration rows key on the versioned model Jev reports (amended 2026-10-07; was pinned to `jev-1.13.0`).
2. **Monotone safety.** Jev enters a security-bearing decision only as `ask := code_ask ∨ (jev_flag ∧ conf ≥ τ)`. It
   never produces `allow` or `deny`, never shortens an approval, never clears a taint, and never touches self-write,
   the reader wall's existence, the invariant sweep, the kill switch or `/approve` consumption. Cards show
   `⚑ flagged: <class>` only — no score, no "safe". Added taps are budgeted per day (default 3); excess is an incident.
3. **Fail toward today.** `none`, low confidence, a missing language calibration, or any Jev failure (no key, fuse,
   401/403, 422, 429, 529, timeout, parse, oversized state) yields today's behaviour exactly, with a ledger row. Every
   Jev outage class is an alerted incident; none is a silent retry.
4. **State is code-observed fact**, redacted by the broker and stripped of credential-shaped tokens; OTP codes and links
   from `trusted_extract` never enter a state; never a model-authored justification. Approved egress today is Paco's
   Telegram text under the 2026-09-25 caps; web excerpts and mail/calendar fields are a new class that each needs
   Paco's explicit approval before its lane leaves shadow.
5. **Shadow before arm, per question and per language**, with bars sized against the measured volume and reported with
   Wilson lower bounds; a criteria or model change re-enters shadow; golden-set drift auto-disarms every Jev-added
   behaviour.
6. **Jev is a free, non-generative leg outside the flat-rate chains**, metered under the ADR 0019 ceiling and fuse,
   treated as free by Paco until he says otherwise.
7. **Lane order**, each its own spec → review → plan → build → live gate: (1) pre-planner triage with the memory lane —
   a pure memory instruction is saved on the ticks seat and answered with an undoable code-owned card, no planner turn;
   (2) model routing by judged task complexity — trivial and routine turns on Kimi → Gemini, hard turns on Opus, Codex
   untouched as the self-write writer — swapping the planner chain for that turn through the existing `set_model` path
   and resolving the reader cross-family at read time (amends ADR 0028 D10); (3) `injection_suspected`
   on reader-wall output, then a `risk` score on plain shell commands, both monotone; (4) inbound triage envelope,
   digest tick and `wrong urgency` label, before SP2; (5) context relevance in shadow, driving lesson credit.

## Consequences

- Easier: adding a judgment call is a question plus a threshold row, not a branch; every decision is replayable from
  its row; Opus quota is spent on turns that need it; SP2's inflow lands in an existing triage lane.
- Harder: thresholds are a maintained artefact (per question, hash, model, language); a criteria edit is a calibration
  event; CJK needs its own evidence per question; one more provider in the audit, one more secret in the broker's use.
- Constrained: no Jev-decided reconcile verdicts; no per-turn prompt assembly by Jev in v1; no `exfil_shape` through Jev;
  no Jev in any deny path, ever; nothing Jev does may be invisible to the ledger.
- Accepted risks: Jev is steerable by injected text (labels stay advisory or monotone, so steering degrades quality,
  never safety); US retention of chat text under a self-serve account (already accepted for the same envelope); a
  `pure` false positive swallows a question for one turn (strict bar, override tap, auto-disable, catch-up line); the
  memory lane is not faster than the planner, only cheaper and deterministic.
- Revisit when: TypeSafe ships adversarial hardening or a retention commitment; Jev volume makes the metered ceiling
  bind; omp exposes per-turn tool toggling or native skills (lane 5 may move from shadow to selection); SP3's quota
  invariant lands (lane 2 v2 reads 7-day utilisation).

## Alternatives considered

- **Jev for memory only (the original A2).** Rejected by Paco: the same layer serves every lane, and building it
  memory-shaped would be rebuilt twice.
- **Jev as a security gate.** Rejected: the vendor disclaims adversarial robustness, Jev read a credential-exfil request
  as benign in the replay, and Houge's hard lines are code-owned. Kept as a monotone pre-gate only.
- **Kimi one-shot as the decider.** Kept as the fallback below the Jev floor (the vendor's own pattern) and as the
  composer inside lanes; rejected as System One: 1–5 s, no probability distribution, verbalised confidence is poorly
  calibrated, equally injectable.
- **Local classifier (embeddinggemma centroids).** Right for near-duplicate and novelty checks and already the cosine
  gate; cannot read boundary rules; needs ≥ 20 labelled examples per class that Houge does not have.
- **omp's native `--thinking auto` (Jev as judge).** Prior art for lane 2, thinking-level only, coding-shaped criteria,
  and it would place `TYPESAFE_API_KEY` in the sandboxed child's environment (ADR 0015). Not used.
- **Route-and-inform instead of route-and-skip for the memory lane.** Paco chose skip; `mixed` messages take the inform
  path, and the next turn carries a catch-up line to close the transcript gap.

---

## Amendments to prior ADRs (appended 2026-10-06 to 0013, 0014, 0019 and AGENTS.md)

**ADR 0013 §Decision — System One stage (2026-10-06).** "Code owns the gates, the model composes between them" becomes:
code owns the gates and the thresholds; Jev (a non-generative typed decider) answers typed judgment calls under those
thresholds; the model composes between them. Jev may make Houge more cautious, never less (ADR 0029 §2).

**ADR 0014 — Jev beside the wall (2026-10-06).** `contains_instructions` on reader-wall output becomes
`reader_flag ∨ jev_flag` and is ledgered; a flag taints later external-write cards in the run with one line. Jev is a
closed-enum component from a third model family; it never decides whether the wall applies.

**ADR 0019 — the metered leg is Jev (2026-10-06).** The ceiling is no longer dormant: Jev is its one leg, checked before
every attempt, treated as free by Paco. 401/403, 422, 429 and 529 are alerted incidents.

**AGENTS.md invariant (Paco's instruction, applied 2026-10-06).** Appended to the flat-rate line: "Jev (TypeSafe System One), a non-generative typed
decider, sits in front of the chains under ADR 0029; it never gates an action and every outage reaches Paco."

## Build notes (2026-10-06, lane 1 built on `feat/jev-lane1`, not merged)

**§3.5 calibration wording.** `CALIBRATED_ROWS` in `src/jev/calibration.ts` ships empty, so lane 1 cannot act until
Paco commits rows after the replay report prints them. The memory lane arms on the three rows `lane`, `complete` and
`scope`. The status lane arms independently on a distinct pseudo-row `question_id: "lane:status"` whose criteria hash
is the `lane` question's: a `lane` row alone never arms status, and a `lane:status` row alone never arms memory.
`HOUGE_JEV_CALIBRATION_FILE` is for the live gate only; outside `HOUGE_JEV_GATE=1` a set file caps `arm` at `shadow`.
An auto-disable marker (`HOUGE_JEV_DISARM_PATH`, written when `triage_overrides` fires) also caps `arm` at `shadow`
until Paco deletes it.

**Deviations from the spec, both accepted.** (1) The daemon builds the Jev client per call rather than once at boot
(cheap; the broker key is read each time). (2) `jev_no_key` therefore opens on the first armed turn, not at boot.

**Before any calibration row is committed (both landed 2026-10-06).** `jev_skip_rate` (spec §3.7): timeout, parse,
transport and `error` skips open no incident per call, so the sweep opens one when they are at least half of 3 or more
triage calls in 24 h, and holds it until an answered call lands (failed rows ageing out prove nothing). State parity:
answered rows record `thread_cut_at` (the claim, when live read the thread) and `state_built_at` (when it computed
`last_houge_turn.age_s`); the replay rebuilds from both, reading the thread through the cut's own millisecond, so the
report's block on any mismatch no longer trips on timing. Rows written before the migration fall back to their write
time. Live gate cases 7 (parity on real decisions) and 8 (skip rate) cover both.

**Transactions.** `RunStore.inTransaction` is not re-entrant. Only `insertRun` joins an outer transaction (the "Ask
Houge anyway" admission); a nested `inTransaction` still issues `BEGIN` and throws.

**Planner-only turns.** The already-saved guard caps a planner-only turn at one saved lesson (a second `lesson_write`
gets `already_saved_this_turn`); see [jev-decision-layer.md](../reference/jev-decision-layer.md).

**Evidence.** 14 tasks by subagent TDD with per-task review (fix rounds on tasks 2, 8, 10 and 11); full suite 253
files / 3438 tests green; live gate `scripts/live-gate-jev-triage.mjs` PASS on its first run (27 checks, real Jev and
Kimi, four planner turns, on a copy of the live DB). Replay universe on a live-DB copy: 293 Telegram turns since
2026-07-02 (the spec estimated 288), estimated cost $0.033.

## Amendment (2026-10-06): lane 1 armed on Paco's instruction

Decision 5 ("shadow before arm") is amended for lane 1: Paco arms on his word, and evidence accrues while armed. The
per-turn bars still send every low-confidence or failed call to the planner (decision 3), and Undo, "Ask Houge anyway",
the `triage_overrides` auto-disable and the Jev incidents stay as built. Before arming, a replay sanity check ran over
the 293 Telegram turns since 2026-07-02 ($0.066 with the permuted run): 10 confident `pure` verdicts, 9 real memory
instructions and 1 miss (a correction that also needed a schedule edit, which the lane cannot do; "Ask Houge anyway"
covers it); 1 `status` verdict, correct; 12 `mixed` (save, then the planner answers); everything else fell through.
Option-order bias: verdicts agree on 291 of 293 turns with the options reversed. `CALIBRATED_ROWS` now names `lane`,
`complete`, `scope` and `lane:status` for zh and en on `jev-1.13.0`; a criteria or model change still disarms. The
§5.9 report and labelling stay available for tuning the bars, not as an arming gate.

**Accepted 2026-10-06.** On the running daemon (boot 9, `372f2ed`) Paco's first real memory instruction was triaged
`memory/pure/act` (confidence 0.91), saved by the lane as an UPDATE of lesson #47 with no planner turn, and the card
with Undo was delivered; no incident open. Operator reference: [jev-decision-layer.md](../reference/jev-decision-layer.md).

## Amendment (2026-10-07): Jev model alias, calibration keyed by the reported model

- **Amendment 2026-10-07 — Jev model alias** (approved by Paco: no hard-coded model versions). Jev requests name
  TypeSafe's moving alias `jev-latest` instead of a pinned version. The response's `model` field reports the versioned
  id behind the alias. It is validated by `JEV_MODEL_ID` and recorded as `jev_decisions.model_reported`. That reported id
  is the key for calibration rows (§3.5), the replay reports and the live-shadow evidence. The safety argument is
  unchanged: a row arms a question only for an exact `(question_id, criteria_hash, model, lang)`. When TypeSafe moves the
  alias, the new reported id has no row, so every lane falls through to the planner until Paco approves rows for it. Jev
  still never gates an action. A row naming the alias itself never arms (`calibratedLang`), because it would stay armed
  across a move.
- **The move pages Paco.** Losing the armed lanes would otherwise be silent. So, in `arm` mode only, an answered triage
  call on a model that no row names, while rows exist for another model, opens an alerted incident
  `jev_model_uncalibrated`: subject = the reported model, detail `{model, calibrated_models, note}`. The note reads
  "Jev moved to <model>; the lanes fall back to the planner until new calibration rows are approved for it." The open
  incident throttles it to one page per model. Shadow mode never opens it, since nothing is armed there.
- **Which rows count.** Only rows that can arm a lane today: a current triage question (or the `lane:status` pseudo-row)
  at its current criteria hash (`armingRows`). A stale-hash or unrelated row neither clears nor raises the page.
- **Resolving it.** A model's incident resolves only once arming rows name that model, never because another calibrated id
  answered in between: a canary serving two ids behind the alias must not re-page on every flip. When the calibrated set
  is empty (no rows, or only alias rows), every open `jev_model_uncalibrated` resolves and nothing opens: nothing armed,
  nothing lost. The invariant sweep never touches this kind.
- **The check cannot cost the answer.** It runs after the answered decision is held, inside a try/catch, so a failing
  check never loses the decision rows.
- **Replay tools stop comparing against a pin.** A run's evidence is its own reported model, and a model change mid-run
  warns, including across a resume. The intent replay's reference is the first model Jev reported, whatever the LLM leg
  did; off-model rows are recorded but excluded from the verdict. The triage report refuses a file (canonical or
  permuted) with more than one reported model. It suggests rows only with the model the rows reported. It reads the live
  shadow filtered to that same model, and refuses shadow stats for another model, so an old model's 14 days never stand
  as a new model's evidence.

## Amendment (2026-10-07): one decision tree (draft for Paco's approval)

Spec: [2026-10-06-jev-decision-tree-design.md](../superpowers/specs/2026-10-06-jev-decision-tree-design.md) (Rev 9).
This amendment is a draft: `docs/decisions/` is Paco's hand, and it lands with the stage A merge only once he approves it.

- **The front of Houge is one decision point.** Every Telegram text turn passes one Jev request of six questions in three
  answer types (`choice`, `score`, `noul`): `category` (11 values), `sets_rule`, `rule_scope`, and the three gear scores
  `breadth`, `reasoning` and `actions`. Lane 1's three questions (`lane`, `complete`, `scope`) leave the live path. Jev
  still only answers; code owns every bar and the fall-through (ADR 0013).
- **Lanes are the leaf type.** A lane is a handler whose control flow is code, with one one-shot compose, and it falls
  through to the planner on any doubt. Memory and status are re-attached as categories (lane 1's behaviour, behind the
  tree's `category` plus `rule` rows for memory and `category:status` plus `rule` for status). Every other category runs
  the planner on its routed model role (Fast, Default or Thinking). The planner is the floor.
- **`jev_verdicts` is the per-turn row.** One row per turn (category, the three scores, rule answers, lane, role, effort,
  the cascade value, save / route / handler outcomes, reason, skip reason, quoted turn), written in the same transaction as
  the `triage` event, joined to the turn's first model call through `routed_by`, and closed at the run's terminal so
  none stays `pending`.
- **A Telegram quote anchors the turn.** `chat_turns.quoted_turn_id` resolves a reply to its stored turn; the quoted turn is
  in Jev's state and the planner prompt; an unresolved quote is a ledger note (`quote_unresolved`), never a failure.
- **Arming follows new rows.** The six tree questions have new criteria hashes, so lane 1's `CALIBRATED_ROWS` no longer
  arm anything. The tree arms per decision (`category`, `category:status`, `rule`, `gear`) on rows Paco commits after
  `houge jev replay triage` on a DB copy, keyed on the reported model as before. Until then every turn routes
  `uncalibrated` to the planner on Default, and the memory and status lanes do not act. The merge is gated on that
  commit and on the armed live gate passing with both lanes acting.
- **The routing policy stays under `src/jev/`** (`tree-policy.ts`), not `src/policy/`: it produces no allow or deny, so it
  is not gate machinery and not on the protected surface.
- **Below the choice bar, one cascade call, bounded at 20 s** (Paco, 2026-10-07). When `category` is under its bar, one
  one-shot on the Tiny role picks between Jev's top two categories after `memory` and `status` are removed, so a model
  guess can never route into a no-planner lane. Failure, timeout or an answer outside the two means planner on Default and
  nothing saved. The verdict's `cascade` value is `tiny`. Flat-rate legs only (invariant unchanged).
- **A lane that fails pages.** The sweep adds `lane_fallthrough_rate` (per lane, at least 3 settled turns in 24 h with half
  or more falling through to the planner); `jev_skip_rate` is unchanged. Every Jev outage class still reaches Paco.
- **Failure is Default as resolved.** Any Jev failure, skip, unarmed question or thrown stage runs the planner on the Default
  role as resolved (a `/models` override included), with one verdict row.

