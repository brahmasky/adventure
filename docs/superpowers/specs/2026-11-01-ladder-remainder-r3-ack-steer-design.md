# Decision ladder, remainder slice R3 — `intake.bare_ack` and `intake.steer_or_queue` on the ladder (Rev 1.2)

**Status:** Rev 1.2 — codex scoped re-review of Rev 1.1: all five prior findings closed, one wording fix (`failQueued`) applied. Rev 1.1 — after the senior review (Sonnet 5.5, read the supervisor lifecycle: 1 blocker, 3 warnings, 2 suggestions) and the codex design pass (1 blocker, 2 warnings, 1 suggestion), every finding verified first-hand and applied (§Rev 1.1 changes). Not yet approved.
**Date:** 2026-11-01
**Amends:** `docs/ROADMAP.md` (the remainder line); ADR 0030 gets an amendment row (drafted under the approved spec, awaiting Paco's signature).
**Depends on:** ADR 0030 §4.1, §6.1 (rows A9, A10), §6.2; ADR 0029 §5.1 (slot A: a bare ack while an approval card waits is consent to nothing); remainder R1 spec §2 (seam order, Decision 1-A: R3 is the first slice on the planner supervisor) and R2 (`2026-11-01-ladder-remainder-r2-sender-contract-design.md`, shipped `d231a4e`) for the pattern: stamped merge-base differential, production-wiring tests, exact-row assertions (R2 plan ruling P10).

## 1. Goal

Put the two decisions `PlannerSupervisor.submit` makes about an incoming turn on the registry as rule-only entries that **record and never steer**:

- `intake.bare_ack` (A10, **locked**, ADR 0029 §5.1): a bare acknowledgement (`好`, `ok`, `👍`, …) while an approval card waits is nudged — never steered in, never queued, never consent;
- `intake.steer_or_queue` (A9): a Telegram message during a live Telegram turn is steered into it; otherwise it queues — idle, or behind a live turn it may not join.

Each wraps today's code unchanged; the raw answer drives. Proof: the stamped merge-base differential with a new supervisor fixture, zero behaviour differences.

## 2. Scope

In: the two entries; a recorder on `SupervisorDeps` passed by `CoreWorker`; a `PlannerSupervisor` fixture for the differential (the new seam R1 §2 named; R4 reuses it); a live gate; a rollback check.

Out: R4–R7; `isBareAck`'s word list; the turn-router's own `bare_ack_guard` (already recorded on every routed turn as `turn.handler`'s reason, `tree-policy.ts:167`, `:185`, `:205`); any change to when a message steers, queues or is nudged.

## 3. Live facts (`main@e5922ca`, read first-hand)

**One entry point, three outcomes** — `PlannerSupervisor.submit(req)` (`omp/planner-supervisor.ts:358–372`), called once per turn run from `CoreWorker.dispatchTurn` (`core-worker.ts:2288`) via `submitTurn` (poll runner `:221`, daemon `:315`, schedule tick `:174`):
```
live = t?.live && t.req.source === "telegram" && req.source === "telegram" && !req.needsIngest
if (live && (st === "AWAITING_APPROVAL" || t.approvals > 0) && isBareAck(req.text)) → nudgeAck   (:364)
if (live && (st === "RUNNING" || st === "AWAITING_APPROVAL"))                       → steer      (:365–368)
else                                                                                 → queue      (:369–370)
```
- **nudge** (`nudgeAck`, `:374–382`): claims the incoming run under a `nudge` worker; on a failed claim returns with no effect; otherwise records the user turn, a `ack_nudged` ledger event naming the waiting run, the code-owned `ACK_NUDGE_TEXT` reply, and completes the run (0 tool calls). The waiting turn is untouched.
- **steer** (`steer`, `:453–466`, async, not awaited): claims the run under the live turn's worker, records the user turn, sends `session.steer(text)`; on a failure fails the run `planner_exit` / `steer_failed`. The merged run finishes with its parent (`merged_into`, `:1474`), one reply.
- **queue**: pushed; `drain` runs it as its own turn.
- `isBareAck` (`omp/bare-ack.ts:11`): trimmed, trailing `。！!.~～` and spaces stripped, lowercased, ≤ 4 chars, in a 21-entry code-owned set.

**Resubmission.** Boot fails stranded queued turns `planner_exit` (`failStrandedTurns`, `core-worker.ts:2297`) and nothing in the code resubmits a run, but neither `submitTurn` nor `submit` dedupes: a second submit of one run is stopped only by the claim (`claimRun` refuses a run already claimed). The recording rule below therefore keys on the claim (§4.0).

**When a turn is live.** `this.turn` is set when `runTurn` starts (`:475`) but `turn.live` becomes true only after the pin, `get_state` and the prompt claim (`:667`; a retry at `:906`), and false again at turn end or abort (`:553`, `:621`, `:1280`, `:1335`, `:1450`) while `this.turn` is still set until `:485`. Between turns of one drain, `this.busy` is true with no `this.turn`. So "no live turn" is three states: truly idle (`!busy`, no turn), a turn that is not yet or no longer live, and a drain between turns.

**No recorder today.** `SupervisorDeps` (`:84–104`) has none; `CoreWorker` holds a lazy `decisionRecorder` (`core-worker.ts:558–560`, `storeRecorder(this.runStore)`). `src/omp/` is a protected dir (`self-write-guard.ts:71`).

**Live traffic** (live DB, read-only): `ack_nudged` ledger events: **0** in the DB's history. Steers leave no ledger event of their own (only the merged run's `merged_into` completion), so today a steer is not separately visible; this slice is the first record of it. Turns: ~6 a day (121 Telegram + 58 scheduled in 30 days).

**Test seam.** `tests/helpers/supervisor-harness.ts` builds a `PlannerSupervisor` with a fake session (`fakeSession`, `harness`, `untilState`, `until`, `heldSession`, `:109–234`) — the TypeScript model for the differential's new `.mjs` fixture.

## 4. The entries

### 4.0 The recording rule: with the turn's own records (ADR 0030 §5)
ADR 0030 §5: "a row whose decision belongs to a turn is written with that turn's own records, so a turn that is lost writes no row." Each verdict is **decided** in `submit` (its input captured there, from the same values the branch reads) but **recorded** where the incoming run is claimed and its own records begin:
- `nudge`: inside `nudgeAck`, immediately after `claimRun` succeeds (`:377`), beside its chat turn and `ack_nudged` event; a failed claim (run already taken) writes nothing.
- `steer`: inside `steer`, immediately after `claimRun` succeeds (`:455`); a failed claim writes nothing; a later `session.steer` failure keeps the row (the run was claimed and is failed `steer_failed` with its own records).
- `wait` / `queue`: the decision rides on the queued request (a new optional `TurnRequest` field holding the captured input) and is recorded when `runTurn` claims the run (`:470`, after `if (!claim) return;`); a queued run failed before `runTurn` claims it to execute (`/kill`, shutdown: `failQueued` claims it under its own worker only to fail it, `:410`) writes nothing.
A duplicate submit is stopped by the claim, so it writes no second row.

Both: `version: 1`, `stage: "intake"`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`, no `alwaysRecord`, `input: "paco"` for `intake.bare_ack` (the rule reads Paco's words: the ack set over his text) and `"tool"` for `intake.steer_or_queue` (it reads supervisor state and provenance, never the words). Rows carry the **incoming** run's id (`req.run_id`; the run exists, created at intake) and `tool_call_id` null. No message text is stored (`rowOf`, `record.ts:63–69`).

### 4.1 `intake.bare_ack` (locked)
- Verdicts `nudge | pass`; `defaultVerdict: "pass"`; `fail: "nudge"` (fail-safe: a broken rule must never let an ack through as a steer that could read as consent; and the entry is consulted only when a card waits, below). `locked: true` (in `LOCKED_ENTRY_IDS` since stage 1).
- **Consulted** only when `live && (st === "AWAITING_APPROVAL" || t.approvals > 0)` — an approval card waits on the live Telegram turn. Not consulted otherwise (no card, no question of consent).
- Input `{ acked: boolean }` = `isBareAck(req.text)` (the raw answer); rule: `acked` → `nudge` / `ack_while_card_waits`; else `pass`. `reasonCodes`: `ack_while_card_waits`.
- Effects: `nudge` `reply`, reversible true, announced none (the code-owned nudge is the reply; nothing is approved); `pass` none. R12: a rule rung only, so `effectProblems` returns early (`registry.ts:84–100`).
- Only `nudge` writes a row (`pass` is the default, consulted in `submit` only for a counting recorder). Call sites: the branch in `submit` is unchanged (`live && cardWaits && isBareAck(req.text)` → `nudgeAck`); `nudgeAck` records `nudge` after its claim (§4.0). A `pass` (a card waits, the text is not an ack) is consulted in `submit` with the raw answer and writes no row. (TypeScript: keep `t` narrowed by the inline `live &&` — a separate boolean loses the narrowing.)

### 4.2 `intake.steer_or_queue`
- Verdicts `steer | wait | queue`; `defaultVerdict: "queue"`; `fail: "wait"` (recorded, never acted on).
- **Consulted** for every `submit` that the nudge did not take.
- Input `{ outcome: "steer" | "wait" | "queue"; reason: SteerReason }`, computed from the same values the code branches on, in this order:
  - no turn and not draining (`t === undefined && !this.busy`) → `queue` / `idle`;
  - no turn but draining (`t === undefined && this.busy`) → `wait` / `queued_behind`;
  - a turn that is not live (`t !== undefined && !t.live`: starting, pinning, ending, aborting) → `wait` / `turn_not_live`;
  - a live turn, but it is schedule-born (`t.req.source !== "telegram"`) → `wait` / `turn_schedule_born` (provenance B2: a message never steers into a schedule-born turn);
  - the message is schedule-born (`req.source !== "telegram"`) → `wait` / `message_scheduled`;
  - the message needs media ingest (`req.needsIngest`) → `wait` / `needs_ingest`;
  - the supervisor is not `RUNNING` or `AWAITING_APPROVAL` (e.g. `STARTING`) → `wait` / `not_running`;
  - else → `steer` / `live_turn`.
  First match wins when several apply (a media message during a schedule-born turn records `turn_schedule_born`). `not_running` covers a live turn whose state is `STARTING` (a mid-turn respawn, `:1056`), `IDLE`, `ABORTING` or `STOPPED`. The rule is a 1:1 map. `reasonCodes`: `live_turn`, `turn_schedule_born`, `message_scheduled`, `needs_ingest`, `not_running`, `turn_not_live`, `queued_behind`, `idle`.
- Effects: `steer` `effect`, reversible false, announced none (the message joins the running turn; one reply); `wait` `none`; `queue` `none`. Input `"tool"` + an `effect` verdict: R12 allows it for a rule-only entry (`effectProblems` early return); Decision 2 records why that is acceptable.
- Rows (**Decision 1**): `steer` and `wait` write rows; the idle `queue` (the default) does not. Volume: bounded by turns (~6 a day); idle submits — most turns — write nothing.
- Call sites: the input is computed in `submit`, after the nudge block, from `t`, `this.st`, `this.busy`, `req` exactly as the branch reads them; the existing `if (live && (RUNNING || AWAITING)) steer … else queue` stays and drives. The row is written per §4.0.

### 4.3 Recorder seam
`SupervisorDeps` gains `recorder?: DecisionRecorder`. `CoreWorker.supervisorDeps` passes `this.decisionRecorder` (its existing lazy recorder: a fault alert pages `HOUGE_TELEGRAM_CHAT_ID`, as R1/R2). Absent (tests that build a supervisor without one) → no `decideSync` call, behaviour unchanged. A production-wiring test drives `CoreWorker.submitTurn` with a fake session (the `useFakeOmp` helpers) and **requires** the row (R2 lesson: a fixture that injects its own recorder cannot see a constructor that forgets one).

### 4.4 Failure behaviour (R2 §4.3 carried over)
(a) the insert fails → `decision_record_failed` and one operator alert; (b) a recorder that throws past itself → logged. `decideSync` never throws for a rule-only entry (it refuses a non-rule ladder, `decide.ts:34`), and `submit` stays synchronous: neither fault changes which branch runs, the claim, the reply, the steer or the queue.

## 5. What does not change
- Which messages are nudged, steered or queued; `ACK_NUDGE_TEXT`; the `ack_nudged` event; claims, chat turns, outbox rows, merged completions, failures (`steer_failed`), and their order.
- `isBareAck`, its set, and the router's `bare_ack_guard`.
- `/status` gains a count line per new id once rows exist. The digest is unchanged (its Unsure section lists only System One rows with a `p`). These rows carry a `run_id`, but the digest's chat-bound review lists only System One rows, so they are never offered for review.

## 6. The differential
**Harness (a plan task):** a stamped pair `--old-dist-r3` at this branch's merge base, provenance file `omp/planner-supervisor.js` (this slice changes it); `R3_IDS = ["intake.bare_ack", "intake.steer_or_queue"]` added to every pair's `NEW_ROW_IDS` and a new `r3` set; any existing corpus that drives `submit` and asserts whole `decisions` tables updated to expect the new rows exactly (R2 P10) — the plan's first task greps for them; export-map entries for `PlannerSupervisor` and the fake-session pieces.

**Fixture `scripts/stage4-supervisor-fixture.mjs`** (its own plan task, sized as such — senior W2): a `.mjs` port of the narrow path of `tests/helpers/supervisor-harness.ts` over a dist module object — `SupervisorDeps` built from dist (`resolveOmpConfig`, fake roles, the outcome sink, a stub `buildTools`/`turnContext`, `skipPreflightForTest`), a fake session that records `prompt`/`steer` calls and can hold a turn live or hold its start, and `untilState`/`until` on real timers (no vitest). `EXPORTS` gains `PlannerSupervisor` and the pieces it needs (`omp/planner-supervisor.js` is new to the map). Worker ids are `randomUUID`: the dump goes through `scrubIds` as well as `relabelClocks`.

**Corpus `supervisor`**, each item on a fresh store, a held live turn where the item needs one, then one `submit`: idle message [`idle`]; message while a turn is starting (start held, not yet live) [`turn_not_live`]; message between two queued turns of one drain [`queued_behind`]; the same run submitted twice while a turn is live [one `steer` row]; a bare ack on a media message during a card [`needs_ingest`, no nudge]; message during `RUNNING` [`steer`]; during `AWAITING_APPROVAL` [`steer`]; bare ack during `AWAITING_APPROVAL` [`nudge`]; bare ack during `RUNNING` with an open trust card (`approvals > 0`) [`nudge`]; bare ack during `RUNNING` with no card [`steer`]; a non-ack while a card waits [`pass` + `steer`]; schedule-born live turn + Telegram message [`turn_schedule_born`]; scheduled message during a live Telegram turn [`message_scheduled`]; media message during a live turn [`needs_ingest`]; message while `STARTING` [`not_running`]; a nudge whose claim fails (run pre-claimed) [no row, no effect — both builds]; a steer whose claim fails [no row]. Compared: the session's call log (prompts, steers, in order), the outcome sink's calls, and the whole-DB dump (R2's `dumpDb`, new rows dropped before `relabelClocks`). Required: per item, the exact new rows (`[entry, verdict, reason, run_id = the submitted run]`) and exact per-entry recorder call counts; a planted early return (no `decideSync` in `submit`) shown failing once.

## 7. Live gate — `scripts/live-gate-ladder-remainder-r3.mjs` (dist, VACUUM copy, refuses outside `.worktrees/`, copy deleted on every exit path, `HOUGE_TELEGRAM_CHAT_ID` stub, tombstone pinned, fake session — no real omp child, no real Telegram)
1. A message while a held Telegram turn is `RUNNING` → the fake session receives exactly one `steer`; one row `intake.steer_or_queue` `steer/live_turn` on the incoming run.
2. Bare `好` while the turn is `AWAITING_APPROVAL` → no steer, one nudge reply, one `ack_nudged` event, exactly one row `intake.bare_ack` `nudge/ack_while_card_waits`; zero `intake.steer_or_queue` rows for that run.
3. A non-ack while a card waits → steered; zero `intake.bare_ack` rows (pass is the default); one `steer` row.
4. A Telegram message during a schedule-born live turn → queued (no steer) and, once that turn ends, run and completed exactly once; one row `wait/turn_schedule_born`, written at its claim.
5. An idle message → queued, run and completed exactly once; zero rows. A message while a turn's start is held → one row `wait/turn_not_live`, then run and completed once.
6. Through `CoreWorker.submitTurn` (the production deps) → the row from line 1's scenario is written (wiring).
7. Faults: the insert faulted → `decision_record_failed`, exactly one alert to the stub chat, line 1's and line 2's effects unchanged; a throwing recorder → no incident, effects unchanged.
8. `/status` count lines for both ids exact; `insertLadderMove` naming `intake.bare_ack` → refused (locked).
The slice updates the registry-count literals (28 → 30) and reruns the R2, R1, 4C and 4B gates (4B on a baselined copy until its follow-up lands).

## 8. Rollback check — `scripts/check-ladder-remainder-r3-rollback.mjs`
The previous build opens a copy carrying the new rows (both ids, with run ids), renders `/status` and the digest (digest identical to an untouched copy's; `/status` differs only in the two count lines, asserted exactly), reads every row unchanged, and refuses `review_ok` naming the new ids. No migration.

## 9. Protected files touched (Tier A under the approved spec)
`src/omp/planner-supervisor.ts` (protected dir `src/omp`), `src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `src/decisions/entries/intake-bare-ack.ts`, `src/decisions/entries/intake-steer-or-queue.ts`. Not protected: `src/core/core-worker.ts`. `docs/decisions/0030-decision-ladder.md` (amendment drafted, awaiting Paco's signature).

## 10. Risks
- **Recording on the consent floor.** `intake.bare_ack` records only after the code decided; the raw `isBareAck` drives. `fail: "nudge"` means a broken rule records `nudge`, never `pass` — the row can be wrong, the behaviour cannot.
- **`submit` is synchronous and on the poll path.** `decideSync` is synchronous and never throws; one insert per steer/wait/nudge.
- **A row with no effect.** None by construction for a lost claim (§4.0). A steer whose claim succeeded but whose `session.steer` send failed keeps its row: the run is failed `steer_failed` with its own records.
- **`ack_nudged` is not a cross-check.** 0 in the live DB; the new rows are the first count.
- **The router also guards bare acks** (`bare_ack_guard`). Two different decisions: the router's is about routing a turn that runs; this one is about a message arriving while another turn waits. Both stay.

## Decisions needed (Paco, at the spec tap)

**Decision 1 — which `intake.steer_or_queue` outcomes write a row.**
- **1-A (recommended):** `steer` and `wait` only. A steer changes a running turn's input and today leaves no trace of its own; a `wait` is a message held back from a live turn (provenance, media, start-up) — both path decisions an outcome can judge. An idle queue is the ordinary case and stays a default.
- **1-B:** every submit (`alwaysRecord`) — one row per turn (~6 a day), mostly `queue/idle`.
- **1-C:** `steer` only — `wait` (incl. the B2 provenance hold) stays invisible.

**Decision 2 — `intake.steer_or_queue` reads tool input but its `steer` verdict is an irreversible `effect`.** ADR 0030 R12 lets tool-input judges cause only `none` / `tighten` / `proposal`; a rule-only entry is exempt (`effectProblems` returns early) because code, not a judge, decides.
- **2-A (recommended):** register as specified, and the ADR amendment states the consequence: a later change adding a Jev or model rung to this entry needs a compliant effect contract (changing the input to `paco` alone is not enough: an irreversible, unannounced `steer` is refused for a judge over Paco's words too) — `entryProblems` (`registry.ts:94–104`, run over every registered entry by `tests/decisions/registry.test.ts`) reports "a jev/model rung over tool input can choose steer, which is not tightening" and the suite fails. No lock needed.
- **2-B:** lock `intake.steer_or_queue` too (§6.1 lists it unlocked), so no rung can ever be added.

## Rev 1.1 changes (senior Sonnet 5.5 + codex; each verified first-hand)
- Senior B1 / "no live turn" is not idle: `this.turn` exists before it is live (`:475` vs `:667`) and after (`:553`…`:1450`), and a drain is busy between turns → reasons `turn_not_live`, `queued_behind`; first-match order stated; `not_running` scope stated; corpus and gate items added (§3, §4.2, §6, §7).
- Codex B / ADR 0030 §5 "a turn that is lost writes no row": recording moved to the claim — `nudge` in `nudgeAck`, `steer` in `steer`, `wait`/`queue` when `runTurn` claims the queued run (§4.0); a pre-claimed nudge or steer now writes no row.
- Codex W / no dedupe on submit: closed by §4.0 (a duplicate's claim fails); corpus item added.
- Codex W / Decision 2-A overstated: a judge rung needs a compliant effect contract; input alone is not enough.
- Codex S / gate positive evidence: queued runs must complete exactly once (lines 4, 5).
- Senior W2 / fixture size: its own task; narrow path; `EXPORTS` additions; `scrubIds` for worker ids.
- Senior W3 / existing gates driving `submit`: the plan's first task greps the live gates and rollbacks that call `submitTurn`/`submit` (`live-gate-decisions-2a`, `live-gate-ladder-2b-hooks` — `:511` steers a media turn and will now write a `wait/needs_ingest` row — `live-gate-jev-tree`, `live-gate-omp`, `live-gate-media`, `live-gate-memory-write`, `check-ladder-stage4b-rollback`, `check-standing-rollback`) for unfiltered `decisions` counts. No corpus or unit test asserts whole tables after `submit` (senior grep).
- Senior S5 / `decideSync` throws for a non-rule ladder: "for rule-only entries" (§4.4); the 28 → 30 count literals are grepped first.
