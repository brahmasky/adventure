# Decision ladder, remainder slice R4 — `planner.crash_guard` and `turn.retry` on the ladder (Rev 1.0)

**Status:** draft, for the senior review (non-orchestrator model) and the codex design pass.
**Date:** 2026-11-01
**Amends:** `docs/ROADMAP.md` (the remainder line); ADR 0030 gets an amendment row (drafted under the approved spec, awaiting Paco's signature).
**Depends on:** ADR 0030 §4.1, §5 (a turn's row is written with the turn's own records), §6.1 (rows D2, D9, stage `supervision`), §6.2; remainder R1 spec §2 (seam order: R4 reuses R3's supervisor fixture); R3 (`2026-11-01-ladder-remainder-r3-ack-steer-design.md`, shipped `c02a96c`) for the pattern: `SupervisorDeps.recorder`, the private `record()` helper, the stamped merge-base differential with `scripts/stage4-supervisor-fixture.mjs`, production-wiring tests, exact-row assertions.

## 1. Goal

Put the planner supervisor's two supervision decisions on the registry as rule-only entries that **record and never steer**:

- `planner.crash_guard` (D2): before spawning an omp child, is the planner crash-looping (3 crash exits in 10 minutes, latched until `/rearm` or a sweep)? If so, refuse the spawn.
- `turn.retry` (D9): a model error ended the turn's current leg — move to the next model, or fail the turn?

Each wraps today's code unchanged; the raw answer drives. Proof: the stamped merge-base differential on the R3 supervisor fixture, zero behaviour differences.

## 2. Scope

In: the two entries; recording calls in `omp/planner-supervisor.ts` through R3's `record()` helper and recorder; fixture additions (a crash exit, an error frame, a routed turn, a tool frame); a new `supervision` corpus; a live gate; a rollback check.

Out: R5–R7; `CRASH_LIMIT`, `CRASH_WINDOW_MS`, `RETRYABLE_ERROR_KINDS`, `classifyOmpError`'s patterns, `RETRY_NOTE`, the chain walk and step-up (`pinWalk`, `stepUp`, `routed_escalation`); the start-time walk over models omp refuses at spawn or pin (`startSession`, `pinFirst`: a `model_missing` refusal is not a retry decision, it never reaches `retryNextLeg`); the two settle branches that end a turn on a model error without consulting the retry rule (§3, "Not consulted"); `resetCrashGuard` and its callers; any change to when the planner spawns, retries or fails.

## 3. Live facts (`main@8a24818`, read first-hand)

**Crash guard.** `ensureSession(fresh)` (`omp/planner-supervisor.ts:954–968`) returns early when a ready child exists or after joining a start in flight; otherwise `if (this.crashLooping()) return "crash_loop";` (`:963`) before the preflight and spawn. `crashLooping()` (`:1041–1049`): latched → true; else drops exit times older than `CRASH_WINDOW_MS` (10 min, `:150`); fewer than `CRASH_LIMIT` (3, `:151`) → false; else latches, opens one `planner_crash_loop` incident, true. Exit times are pushed on a failed start that is not `model_missing` (`spawnFailed`, `:1222`) and on an unrequested exit of a ready child (`onExit`, `:1278`). `resetCrashGuard()` (`:373`) clears both; callers: `/rearm` and every invariant sweep (`telegram-daemon.ts:493`, `:768–770`).
- **Callers of `ensureSession`**, all inside a turn whose run is already claimed (`runTurn` claims at `:502`, sets `this.turn` at `:508`, then `startTurn`): the slot-B warm start (`startTurn`, `:600`, started before triage, for every Telegram and scheduled turn); `startSession` (`:988`, via `ensureReady`) when no warm start was passed; `afterWarm` (`:1007`) when the warm child exited or went stale. A planner turn whose start returns `crash_loop` fails `planner_exit` / `crash_loop` (`ensureReady`, `:663`) and Paco gets `PLANNER_CRASH_LOOP_TEXT` (`core/omp-turn-wiring.ts:53`, `:77`). **A lane turn** (triage `lane_reply`) never awaits the warm start's result for its own outcome (`finishLane`, `:645–657`): a halt there refuses the spawn, but the lane reply is delivered and the run completes.
- One turn consults the guard once in the common case (the warm call; `afterWarm` returns the warm result unless the child came up and then went away). A second consult in the same turn is possible (`startTurn` re-runs `ensureReady` when the child went stale during the prompt build, `:612`).

**Retry.** `settle` (`:831–842`) loops on the turn's end: after an end with `turn.lastError` set and no `turn.failure`, it calls `retryNextLeg(turn, turn.lastError)` (`:841`). `retryNextLeg` (`:908–921`): `kind = classifyOmpError(error)` (`omp-frames.ts:68`); a non-`other` kind marks the current selector failed for the turn; `mayRetry(turn, kind)` (`:923–926`) is the decision: `RETRYABLE_ERROR_KINDS` (`quota`, `auth`, `transport`, `timeout`, `model_missing`, `omp-frames.ts:65`) → retry; `other` → retry only once, only on a routed turn (`turn.route !== null`), only while no non-`todo` tool has started (`usedTool`, set on `tool_execution_start`, `:1306`); else the turn fails `model_error` / `<kind>`. After a retry verdict: no live child → `planner_exit` / `planner not running`; `promptRetry` (`:929–945`) walks the chain (`pinWalk`), exhausted → `no_planner_leg` + `planner_no_leg` incident; else prompts `RETRY_NOTE`.
- `classifyOmpError` can return only `quota`, `auth`, `model_missing`, `model_refusal`, `aborted`, `timeout`, `transport`, `spawn`, `other` (`omp-frames.ts:68–78`).
- **Not consulted** (stay mechanics, stated so the row set is exact): a model error at an async-work-only end (`:840`: fails `model_error` without `retryNextLeg`, so no Houge retry overlaps the child's own work) and a model error in a settle continuation pass after pass 0 answered (`:837`: the turn completes with pass 0's text).
- One turn can consult the rule several times (one per failed leg); each consult is its own row.

**No recorder change.** R3 gave `SupervisorDeps` a `recorder` (passed by `CoreWorker.supervisorDeps`) and a private `record(entry, input, run_id)` helper; this slice reuses both. `src/omp/` is protected (`self-write-guard.ts:71`).

**Live traffic** (live DB, read-only, last 30 days): 374 compose `llm_attempt` rows, 5 compose errors (`quota` 4, `other` 1); 1 run failed `model_error`; `planner_crash_loop` and `planner_start_failed` incidents: **0** in the DB's history. Both entries are rare paths: their rows are an outage record, not a traffic record.

**Test seam.** `scripts/stage4-supervisor-fixture.mjs` (R3) has `fakeSession` (scripted `onPrompt(text, emit)`, `holdStart`), `heldSession`, `sink`, `mkSupervisor` (`opts.extra` overrides `SupervisorDeps`), `intakeRun`, `req`. It lacks a crash exit (the TS harness has `exit(code)`, `tests/helpers/supervisor-harness.ts:143`) and a no-manifest start; `onPrompt` already lets an item emit an error frame or `tool_execution_start`; `opts.extra.triage` gives a routed turn. Existing unit tests pin the crash latch (`tests/omp/planner-supervisor.test.ts:470–488`, `:541–548`, `:681–682`) and the retry paths (`:133`, `:438`, `:751–775`, `:1578–1665`, `:1828–1852`, `:1895`).

## 4. The entries

### 4.0 The recording rule (ADR 0030 §5)
Both decisions are made inside a turn whose run is already claimed (§3), so the row is written at the decision, with the consulting turn's run id, and `tool_call_id` null. Neither decision is ever made for a run that is not claimed; a duplicate submit never reaches either. No message or error text is stored (`rowOf` has no input column; the error text never leaves `retryNextLeg`).

Both: `version: 1`, `stage: "supervision"`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`, `input: "tool"` (supervisor state and the provider's error text, never Paco's words), **unlocked** (§6.1 carries no L for D2, D9).

### 4.1 `planner.crash_guard`
- Verdicts `spawn | halt`; `defaultVerdict: "spawn"`; `fail: "halt"` (recorded, never acted on).
- **Consulted** where `ensureSession` reaches `crashLooping()` (`:963`); not when a ready child exists or a joined start produced one.
- Input `{ latched: boolean; recent: number }` captured immediately before the raw call: `latched` = the latch as it stood, `recent` = exit times inside the window by the same cutoff the raw call uses. Rule (first match): `latched` → `halt` / `latched`; `recent >= CRASH_LIMIT` → `halt` / `limit_reached` (this consult latches and opens the incident); else `spawn`. The raw `crashLooping()` result drives; a test pins that the captured verdict equals it on every corpus item (`halt` ⇔ `true`). `reasonCodes`: `limit_reached`, `latched`.
- Effects: `halt` `tighten`, reversible true (`/rearm`, the next sweep), announced none (the incident and `PLANNER_CRASH_LOOP_TEXT` are today's announcements, unchanged); `spawn` `none`.
- Rows: only `halt` (the default writes none). The run id is the consulting turn's (**Decision 2**).

### 4.2 `turn.retry`
- Verdicts `retry | final`; `defaultVerdict: "final"`; `fail: "final"` (recorded, never acted on).
- **Consulted** once per `retryNextLeg` call, at `mayRetry` (`:911`), after the kind is classified and before the live-child check.
- Input `{ kind: LlmErrorKind; routed: boolean; usedTool: boolean; retriedOther: boolean }` from the values `mayRetry` reads. Rule (first match):
  - `kind` in `RETRYABLE_ERROR_KINDS` → `retry` / `<kind>` (`quota`, `auth`, `transport`, `timeout`, `model_missing`);
  - `kind === "other"`: `!routed` → `final` / `other_unrouted`; `retriedOther` → `final` / `other_retried`; `usedTool` → `final` / `other_after_tool`; else `retry` / `other_once`;
  - any other kind → `final` / `<kind>` (`model_refusal`, `aborted`, `spawn`).
  The rule reads `RETRYABLE_ERROR_KINDS` itself (no second list), and a test pins `rule(x).verdict === "retry"` ⇔ `mayRetry` over every combination of the four inputs and all nine reachable kinds. `reasonCodes` (12): `quota`, `auth`, `transport`, `timeout`, `model_missing`, `other_once`, `other_unrouted`, `other_retried`, `other_after_tool`, `model_refusal`, `aborted`, `spawn`.
- Effects: `retry` `effect`, reversible false, announced none (another model continues the turn with `RETRY_NOTE`; a step-up is ledgered as today); `final` `tighten`, reversible true, announced none (the turn fails with today's error text).
- Rows (**Decision 1**): every consult. A retry verdict's row stands whatever follows (no live child, an exhausted chain): those are the turn's outcome, already in its ledger.
- R12: `input: "tool"` with an `effect` verdict is allowed for a rule-only entry (`effectProblems` returns early, `registry.ts:84–100`). As with `intake.steer_or_queue` (R3 Decision 2-A), the amendment states the consequence: adding a Jev or model rung later needs a compliant effect contract, and `entryProblems` fails the suite until it has one.

### 4.3 Recorder seam
Unchanged from R3: `this.d.recorder` through the private `record()` helper; absent → no `decideSync` call. A production-wiring test drives `CoreWorker.submitTurn` with a fake session that errors once with `quota` and requires the `turn.retry` row (R2 lesson: a fixture that injects its own recorder cannot see a constructor that forgets one); `planner.crash_guard`'s wiring rides the same recorder and gets the same test with three failed starts.

### 4.4 Failure behaviour (R2/R3 carried over)
(a) The insert fails → `decision_record_failed` and one operator alert; (b) a recorder that throws past itself → logged. `decideSync` never throws for a rule-only entry. Neither fault changes the spawn, the latch, the incident, the retry, the prompt, the failure or its order. A recorder fault inside `retryNextLeg` must not throw into `settle` (the helper already catches).

## 5. What does not change
- When the planner spawns, latches, re-arms, retries, steps up or fails; the `planner_crash_loop`, `planner_no_leg`, `planner_start_failed` incidents; `llm_attempt` rows, `routed_escalation` events, run failures and their order; `RETRY_NOTE`; `PLANNER_CRASH_LOOP_TEXT`.
- `/status` gains a count line per new id once rows exist. The digest is unchanged (it lists only System One rows with a `p`).

## 6. The differential
**Harness (a plan task):** a stamped pair `--old-dist-r4` at this branch's merge base, provenance file `omp/planner-supervisor.js`; `R4_IDS = ["planner.crash_guard", "turn.retry"]` added to every pair's `NEW_ROW_IDS` and a new `r4` set; the first task greps every corpus, live gate and rollback check that drives a model error or a crash through the supervisor (the unit tests above; live gates `live-gate-omp`, `live-gate-jev-tree`, `live-gate-decisions-2a`, `live-gate-ladder-2b-hooks`, and R3's `supervisor` corpus) for unfiltered `decisions` counts and updates them to expect the new rows exactly (R2 P10).

**Fixture additions** (`scripts/stage4-supervisor-fixture.mjs`): `exit(code)` on `fakeSession` (as the TS harness: drop the sockets, call the exit callbacks with `stopped: false`); a no-manifest start option (start fails, counted as a crash exit). Both ported from `tests/helpers/supervisor-harness.ts`, narrow.

**Corpus `supervision`**, each item on a fresh store and supervisor:
- crash guard: three failed starts then a fourth turn [`halt/limit_reached` on the fourth run, one `planner_crash_loop`]; a fifth turn [`halt/latched`]; `resetCrashGuard` then a sixth [no row, a spawn]; a ready child's crash exit ×3 across turns then a turn [`halt/limit_reached`]; a lane turn (triage `lane_reply`) while latched [`halt/latched` on the lane run, the lane reply delivered]; two failed starts then a good turn [no row].
- retry: `quota` error then success [`retry/quota`]; `timeout` on every leg until exhausted [one `retry/timeout` per leg, then `no_planner_leg`]; `other` on an unrouted turn [`final/other_unrouted`]; `other` on a routed turn, no tool [`retry/other_once`], then `other` again [`final/other_retried`]; `other` after a `tool_execution_start` [`final/other_after_tool`]; `other` after only a `todo` tool [`retry/other_once`]; `model_refusal` [`final/model_refusal`]; an async-work-only end with an error [no row]; a quota error on a routed Fast turn that steps up [`retry/quota` + `routed_escalation`].
Compared: the session's call log (prompts, steers, set_model calls, in order), the outcome sink's calls (incl. incidents), and the whole-DB dump (new rows dropped before `relabelClocks`; ids scrubbed). Required: per item, the exact new rows (`[entry, verdict, reason, run_id label]`) and exact per-entry recorder call counts; a planted fault (the rule's `limit_reached` and `latched` branches swapped; `other_retried` and `other_after_tool` swapped) shown failing once.

## 7. Live gate — `scripts/live-gate-ladder-remainder-r4.mjs` (dist, VACUUM copy, refuses outside `.worktrees/`, copy deleted on every exit path, `HOUGE_TELEGRAM_CHAT_ID` stub, tombstone pinned, fake session — no real omp child, no real Telegram)
1. A turn whose first leg errors `quota` then succeeds → completed once, `RETRY_NOTE` sent once, exactly one row `turn.retry` `retry/quota` on the run.
2. A non-retryable `model_refusal` → failed `model_error` / `model_refusal`, no `RETRY_NOTE`, exactly one row `final/model_refusal`.
3. A routed turn: `other` twice → one `retry/other_once` then one `final/other_retried`, failed `model_error` / `other`.
4. Three failed starts, then a turn → failed `planner_exit` / `crash_loop`, exactly one `planner_crash_loop` incident, exactly one row `planner.crash_guard` `halt/limit_reached` on that run; the next turn → one `halt/latched`; `resetCrashGuard` → the next turn spawns, zero rows.
5. A clean turn → zero rows for both ids.
6. Through `CoreWorker.submitTurn` (production deps) → line 1's row is written (wiring).
7. Faults: the insert faulted → `decision_record_failed`, exactly one alert to the stub chat, line 1's and line 4's effects unchanged; a throwing recorder → no incident, effects unchanged.
8. `/status` count lines for both ids exact.
The slice updates the registry-count literals (30 → 32) and reruns the R3, R2, R1, 4C and 4B gates (4B on a baselined copy until its follow-up lands).

## 8. Rollback check — `scripts/check-ladder-remainder-r4-rollback.mjs`
The previous build opens a copy carrying the new rows (both ids, with run ids), renders `/status` and the digest (digest identical to an untouched copy's; `/status` differs only in the two count lines, asserted exactly), reads every row unchanged (`rung`, `entry_version`, `verdict`, `reason_code`), and refuses `review_ok` naming the new ids. No migration.

## 9. Protected files touched (Tier A under the approved spec)
`src/omp/planner-supervisor.ts`, `src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `src/decisions/entries/planner-crash-guard.ts`, `src/decisions/entries/turn-retry.ts`. `docs/decisions/0030-decision-ladder.md` (amendment drafted, awaiting Paco's signature).

## 10. Risks
- **A recorder on the failure path.** Both decisions run while something is already failing (a crashing child, a provider error). `record()` catches; `decideSync` is synchronous and never throws for rule-only entries; the raw `crashLooping()` / `mayRetry()` drive. A recorder fault is one more incident at worst (insert fault), as R1–R3.
- **Capture before a mutating call.** `crashLooping()` filters `this.exits` and latches; the input must be captured before it runs, by the same cutoff, or a row could say `spawn` for a halt. The equivalence test in §4.1 and corpus items pin it.
- **Rows during an outage.** A latched guard writes one row per turn until `/rearm` or the next sweep (each sweep re-arms, so a latch lasts at most one sweep interval); a provider outage writes one `turn.retry` row per failed leg (bounded by the chain length per turn). Both bounded by turns.
- **The lane-turn row** (Decision 2) is on a run that completed: the row records that its warm spawn was refused, not that the turn failed.

## Decisions needed (Paco, at the spec tap)

**Decision 1 — which `turn.retry` outcomes write a row.**
- **1-A (recommended):** every consult (`alwaysRecord`): both `retry` and `final`. A model error is rare (5 in 30 days), and the `final` side is the one an outcome judges most often (was `other_after_tool` right to give up?).
- **1-B:** `retry` only (`final` is the default and stays invisible; the failure is in the run's own error).

**Decision 2 — the run a `planner.crash_guard` row names.**
- **2-A (recommended):** the consulting turn's run, at the decision, for every halt — including a lane turn's warm start, where the halt refused the spawn but the lane reply still completed the run. The `limit_reached` row is always written on the consult that latched.
- **2-B:** only when the halt fails a planner turn (`ensureReady` → `crash_loop`). A halt on a lane turn writes nothing; if the latch happens on a lane turn, its `limit_reached` row is lost and the next planner turn records `latched`.
