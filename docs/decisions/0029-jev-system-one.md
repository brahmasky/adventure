# ADR 0029: Jev as System One — a typed decision layer in front of the models

- **Status:** proposed (design approved by Paco 2026-10-04; accepted when lane 1 ships its live gate)
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
   harness; a golden set in the invariant sweep. Model pinned to `jev-1.13.0`.
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

## Amendments to prior ADRs (appended 2026-10-06 to 0013, 0014 and 0019; the AGENTS.md line awaits Paco)

**ADR 0013 §Decision — System One stage (2026-10-06).** "Code owns the gates, the model composes between them" becomes:
code owns the gates and the thresholds; Jev (a non-generative typed decider) answers typed judgment calls under those
thresholds; the model composes between them. Jev may make Houge more cautious, never less (ADR 0029 §2).

**ADR 0014 — Jev beside the wall (2026-10-06).** `contains_instructions` on reader-wall output becomes
`reader_flag ∨ jev_flag` and is ledgered; a flag taints later external-write cards in the run with one line. Jev is a
closed-enum component from a third model family; it never decides whether the wall applies.

**ADR 0019 — the metered leg is Jev (2026-10-06).** The ceiling is no longer dormant: Jev is its one leg, checked before
every attempt, treated as free by Paco. 401/403, 422, 429 and 529 are alerted incidents.

**AGENTS.md invariant (Paco's hand).** Append to the flat-rate line: "Jev (TypeSafe System One), a non-generative typed
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

**Before any calibration row is committed.** `jev_skip_rate` (spec §3.7) must land first: timeout, parse and
transport failures open no incident, so without it a silently dead layer looks like a quiet one.

**Transactions.** `RunStore.inTransaction` is not re-entrant. Only `insertRun` joins an outer transaction (the "Ask
Houge anyway" admission); a nested `inTransaction` still issues `BEGIN` and throws.

**Planner-only turns.** The already-saved guard caps a planner-only turn at one saved lesson (a second `lesson_write`
gets `already_saved_this_turn`); see [jev-decision-layer.md](../reference/jev-decision-layer.md).

**Evidence.** 14 tasks by subagent TDD with per-task review (fix rounds on tasks 2, 8, 10 and 11); full suite 253
files / 3438 tests green; live gate `scripts/live-gate-jev-triage.mjs` PASS on its first run (27 checks, real Jev and
Kimi, four planner turns, on a copy of the live DB). Replay universe on a live-DB copy: 293 Telegram turns since
2026-07-02 (the spec estimated 288), estimated cost $0.033.

**Status stays `proposed`.** It becomes accepted only after Paco's merge, kickstart and the live gate on the running
build. Operator reference: [jev-decision-layer.md](../reference/jev-decision-layer.md).
