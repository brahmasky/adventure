# Decisions inside the planner loop: Houge against mu — synthesis (2026-10-12)

Paco's question: Jev today is one judge at the front door (ADR 0029 stage A tree + stage B lanes); mu runs a judge at
dozens of checkpoints inside one agent loop. Houge already makes many decisions inside the planner turn — where are
they, which ones are rules, and where would an in-loop judge add something? Two reports answer it:
[`10-mu-decision-points.md`](10-mu-decision-points.md) (mu's own docs and source at `qybaihe/mu@faed8c3`, committed
2026-10-10) and [`11-houge-inloop-inventory.md`](11-houge-inloop-inventory.md) (Houge code at `main@1585105`, 85
decisions with file:line). This file maps one onto the other and names the gaps. It is the input to the next spec,
"Jev judges inside the loop".

## The answer in five lines

1. **Houge's middle is not empty; it is all rules.** 85 decision points between a Telegram message and the delivered
   reply: 28 before the model, 25 at the bridge before a tool runs, 8 after a tool, 12 in supervision, 12 at turn end.
   Once the planner runs, the only model judgment on the loop itself is the quarantined reader (summarise untrusted
   bytes into a fixed schema) with its `contains_instructions` flag; the other LLM steps sit inside single tools
   (lesson distill and reconcile, self-write review) and judge only that tool's input. Jev decides only at the door.
2. **mu is the same floor plus judges.** mu's own rule is "rules are the floor: a dangerous-looking command is caught
   by rules first, and the judge only vouches that you asked for it" (README). Its 38 points sit on top of plain-code
   checks much like Houge's B-stage gates. So the build is *adding judges beside existing checkpoints*, not new
   checkpoints and not a new loop.
3. **Five gaps, all verified in code**: tool output is screened for injection only on four read tools and the flag
   blocks nothing (G1); "done" is never verified (G2); no loop or drift detection beyond the 40-call cap and the clocks
   (G3); tool output is trimmed by size, never by relevance (G4); notify-now-vs-later is never decided (G5).
4. **Several mu points map onto things Houge decided against on purpose** (approval by judge, prompt hints, judge
   rewinds). Those stay rejected unless Paco reopens them; they are listed so the next spec does not rediscover them.
5. **mu's own retrospective is the warning label**: "local positive effect, no basis to claim net benefit"; its
   output-admission judge spent ~54% of all judge input and dropped nothing. Every in-loop judge here ships shadow,
   with a verdict → action → outcome link, before it acts — the stage A discipline, unchanged.

## Correction to what was said in chat

On 2026-10-10 I told Paco mu "says plainly: no fast path bypass". mu's docs do not say that (checked README and
`docs/` at `faed8c3`). What mu does say is the rules-floor sentence above, and its loop diagram has no path around the
model. "mu has no shortcut lanes" is a reading of the diagram, not a mu claim.

## The map

Status: **rule** = Houge decides it in code today; **none** = nothing decides it; **rejected** = Houge decided
against it (source named). Houge ids are rows in `11-`.

### Input (before the model)

| mu point | What it judges | Houge today | Status | Read |
|---|---|---|---|---|
| `input.preflight` | task kind + thinking level, one-line hint | A12–A18: Jev tree picks the **handler and role**, never hints | rule + Jev (stronger) | hint rejected (stage A spec App. B) |
| `task.frame` | new task / correction / new subgoal / no change | none; steered messages skip triage (A9, G6) | **none** | candidate, pairs with steering |
| `input.interjection` | mid-run message: interrupt now or after this step | A9: every live Telegram message is steered; A10 bare-ack nudge | rule | candidate: "stop/no" while a card waits does not deny it today (G6) |

### Context

| mu point | Houge today | Status | Read |
|---|---|---|---|
| `skills.disclosure`, `capability.disclosure` | A23 renders all skills; B2 manifest by arming flag | rule | low value at Houge's skill count; parked |
| `tool.admission`, `.test-log` | C5 head-cut at 32 KiB; 8000 chars to reader | rule (size only) | **G4**; mu measured 0 drops in 2,412 live blocks — do not lead with it |
| `context.forget`, `context.compact` | omp's own compaction, not Houge's | none (omp-owned) | out of reach without owning omp context; parked |
| `memory.recall` | A25 cosine/FTS relevance gate; lessons all rendered (A23) | rule | candidate later (lesson count is small) |
| `memory.capture`, `memory.worth`, `memory.merge` | A19 rule save-first: LLM distill + reconcile + backstop | rule + LLM | `merge` rejected by ADR 0029 (no Jev reconcile verdicts); mu's own capture: 6/6 skip |
| `memory.outcome`, `memory.applied` | none | **none** | parked in stage A App. A for stage C (credit) |
| `cache.warming` | n/a (omp subscription seats) | n/a | — |

### Tools and safety

| mu point | Houge today | Status | Read |
|---|---|---|---|
| `tool.risk` | B11 bash matcher (best effort, D12), B10 policy, B13 Paco's tap | rule + Paco | candidate *only as monotone* (a judge may add a tap on a matcher miss, never remove one) |
| `tool.approval` (judge approves) | B12–B14 Paco taps, fingerprint-bound | Paco | **rejected**: ADR 0029, Jev never gates an action; approval stays Paco's |
| `tool.constraint` | A7 contract (actions, gates); no per-turn stated constraints | none | candidate after `task.frame` (needs constraints captured first) |
| `tool.injection` | C1 wall on 4 read tools; C2 flag = note only; C4 bash/fs output raw | rule + LLM flag, **no teeth** | **G1 — first candidate.** mu wording measured 70/79 planted attacks vs 11 for a pattern scan, 0/1,520 clean passages withheld (stage A App. A) |
| `files.locate`, `judge.items`, `browser.step`, `review.triage`, `diagnostics.delivery` | no equivalent tools | n/a | coding-agent / browser tools; out of scope |

### Turn

| mu point | Houge today | Status | Read |
|---|---|---|---|
| `turn.completion` | E1: done = omp `agent_end` without error; `stop_condition`/`eval_hooks` are contract data with no consumer | **none** | **G2 — second candidate** |
| `turn.continue` | none ("next I'll…" ends the turn) | **none** | with completion; never pushes a hard-to-undo step |
| `turn.drift` | D4 10-min deadline, D5 3-min idle, D12 40 calls; `loop_step` rows written, never read live; budget zone computed, never read | rule (clocks only) | **G3 — third candidate**; mu: rules catch loops (same call+result ×3), judge only every 6 calls |
| `turn.rewind` | none | none | rejected for now: Houge cannot undo tool side effects; omp has `checkpoint`/`rewind` (lifecycle-gap research) |
| `goal.met`, `board.read` | none (no goal record) | none | SP4 goal record first (lifecycle-gap synthesis) |
| `output.drift` | none | none | mu ships it off; skip |
| `notify.routing` | E9 FIFO outbox, E12 incident page-once + 10-min flap damper | rule (incidents only) | **G5**; parked for lane 4 (inbound triage, digest) |

### Teamwork

`swarm.*`, `hive.*`: Houge has no sub-agents. Out of scope until SP4.

## Plain-code gaps found on the way (no judge needed)

These came out of the inventory and are cheaper than any judge. Each is a code rule mu also uses as its floor.

1. **Repeated-call detector.** Same tool + same input + same result three times in one turn → stop or steer. mu
   catches loops this way, by rule, before any judge (`turn.drift` row in `10-`). Houge writes `loop_step` rows and
   never reads them (G3).
2. **Budget zone is computed and dropped.** `budget/budget-ledger.ts:26` returns green/yellow/red; nothing reads it.
   At exhaustion the planner gets "budget exhausted" per call and may keep generating until the 10-min deadline. A
   code "wrap up now" note at red would close the gap.
3. **A steered "stop"/"no" during an approval wait resolves nothing.** Only a tap, `/deny` or the 30-min timeout ends
   the card (`planner-supervisor.ts:288-293`). A code rule (or `input.interjection` later) could deny on an explicit
   stop word, the mirror of the bare-ack rule.
4. **"Do not retry" after a denial is advice.** A re-request makes a new card. A code rule could refuse a call whose
   fingerprint matches one Paco denied this turn.
5. **Supervisor queue has no cap in code** (`planner-supervisor.ts:294`); only the gateway rate limit bounds it.

## What the evidence supports building next

Order, each its own shadow → calibrate → arm cycle under ADR 0029 (one Jev call per decision point, thresholds per
question/model/language, monotone, fail toward today, every outage reaches Paco):

1. **`tool.injection` at the wall, monotone.** Judge passages of the four read tools' raw output before the reader;
   a confident "instructions aimed at the AI" withholds the passage with a note in place. Then ask whether the wall
   should widen to `bash` output that came from the network (D12 is Paco's call). Adds caution only, so it is the
   safest first in-loop judge, and it is the biggest safety gain.
2. **`turn.completion` + `turn.continue` at turn end.** One nudge back when the reply claims done with nothing
   verified, or ends on "next I'll…"; never toward an approval-gated or external step. First real use of the
   contract's `stop_condition`.
3. **Loop rule, then `turn.drift`.** The repeated-call rule and the budget-red note first (code, no judge); a drift
   judge only if the ledger shows loops the rule misses.

Parked, with the reason: `notify.routing` (lane 4), `memory.applied`/`outcome` (stage C), `goal.met` (SP4 goal
record), `tool.admission` (mu's own numbers show no drops; revisit when long tool outputs show up in Houge's ledger).
Rejected: judge approval (ADR 0029), prompt hints (stage A App. B), judge-driven rewind (side effects).

## Where a judge can stand without owning the loop

- **The bridge** (`omp/bridge-handler.ts`): every Houge tool call and every built-in read/edit/write gate crosses it.
  Injection (post-tool, before the result returns) and risk (pre-tool) judges belong here.
- **The supervisor's settle step** (`planner-supervisor.ts` `settle`/`finishSuccess`): sees `agent_end` and the final
  text before the reply is sent. Completion and continue judges belong here; "send back" is a `session.steer` the
  supervisor already knows how to do.
- **Not reachable from Houge today**: omp's context compaction and its in-child built-ins beyond the gate. omp ships
  `judgment`, `checkpoint`/`rewind`, `goal` and `advisor`
  ([lifecycle-gap synthesis](../2026-10-04-lifecycle-gap/00-synthesis.md)); whether any of them can
  host a Houge judge over RPC is unprobed and is a question for the spec's live-system review.

## Limits of this research

- mu was read from its docs and the decision-file type declarations, not run. Per-point accuracy exists only for the
  test-log admission study, `hive.relate` and the injection wording; the rest is mu's description.
- The Houge inventory read the code at `main@1585105`; it did not read the self-write test gate, diff reviewer, merge
  executor or sweep internals, and its "ledgered" column is from the code, not from rows in the DB.
- The five gaps were re-checked by hand in code (budget zone unread; `stop_condition`/`eval_hooks` unconsumed;
  `contains_instructions` renders a note only, `quarantine.ts:97`; budget exhaustion denies per call without ending
  the turn, `budget-ledger.ts:20-23`; steer during an approval wait, `planner-supervisor.ts:288-293`).
