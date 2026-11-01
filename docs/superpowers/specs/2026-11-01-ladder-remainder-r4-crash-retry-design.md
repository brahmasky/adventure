# Decision ladder, remainder slice R4 — `planner.crash_guard` and `turn.retry` on the ladder (Rev 1.2)

**Status:** **APPROVED by Paco 2026-11-01: Decisions 1-A, 2-A.** Rev 1.2 — codex scoped re-review of Rev 1.1: all prior findings closed; one new blocker and two warnings applied (§Rev 1.2 changes). Rev 1.1 — after the senior review (Fable 5.1: 1 blocker, 3 warnings, 7 suggestions) and the codex design pass (1 blocker, 1 warning, 1 suggestion), every finding verified first-hand and applied (§Rev 1.1 changes).
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

**Crash guard.** `ensureSession(fresh)` (`omp/planner-supervisor.ts:954–968`) returns early when a ready child exists or after joining a start in flight; otherwise `if (this.crashLooping()) return "crash_loop";` (`:963`) before the preflight and spawn. `crashLooping()` (`:1041–1049`): latched → true; else drops exit times older than `CRASH_WINDOW_MS` (10 min, `:150`); fewer than `CRASH_LIMIT` (3, `:151`) → false; else latches, opens one `planner_crash_loop` incident, true. Exit times are pushed on a failed start that is not `model_missing` (`spawnFailed`, `:1222`) and on an unrequested exit of a ready child (`onExit`, `:1278`). `resetCrashGuard()` (`:373`) clears both; callers: `/rearm` and an invariant sweep that actually ran — not throttled, not disarmed (`src/telegram/telegram-daemon.ts:493`, `:764–771`).
- **Callers of `ensureSession`**, all inside a turn whose run is already claimed (`runTurn` claims at `:502`, sets `this.turn` at `:508`, then `startTurn`): the slot-B warm start (`startTurn`, `:600`, started before triage, for every Telegram and scheduled turn); `startSession` (`:988`, via `ensureReady`) when no warm start was passed; `afterWarm` (defined `:1004`, its call `:1007`) when the warm child exited or went stale; and `startSession`'s loop calls `ensureSession(false)` again once per candidate omp refused at spawn (`:987–996`). None of them takes the turn, and the consult at `:963` sits after two awaits (`:957` joining a start in flight, `:961` `stopSession`): by then `this.turn` can be the next turn or undefined (a lane turn completes after a bounded 5 s wait on its warm start, `:650`; `/kill`). A planner turn whose start returns `crash_loop` fails `planner_exit` / `crash_loop` (`ensureReady`, `:664`) and Paco gets `PLANNER_CRASH_LOOP_TEXT` (`core/omp-turn-wiring.ts:53`, `:77`). **A lane turn** (triage `lane_reply`) never awaits the warm start's result for its own outcome (`finishLane`, `:645–657`): a halt there refuses the spawn, but the lane reply is delivered and the run completes.
- One turn consults the guard once in the common case (the warm call; `afterWarm` returns the warm result unless the child came up and then went away). A second consult in the same turn is possible (`startTurn` re-runs `ensureReady` when the child went stale during the prompt build, `:612`).

**Retry.** `settle` (`:831–842`) loops on the turn's end: after an end with `turn.lastError` set and no `turn.failure`, it calls `retryNextLeg(turn, turn.lastError)` (`:841`). `retryNextLeg` (`:908–921`): `kind = classifyOmpError(error)` (`omp-frames.ts:68`); a non-`other` kind marks the current selector failed for the turn; `mayRetry(turn, kind)` (`:923–926`) is the decision: `RETRYABLE_ERROR_KINDS` (`quota`, `auth`, `transport`, `timeout`, `model_missing`, `omp-frames.ts:65`) → retry; `other` → retry only once, only on a routed turn (`turn.route !== null`), only while no non-`todo` tool has started (`usedTool`, set on `tool_execution_start`, `:1306`); else the turn fails `model_error` / `<kind>`. After a retry verdict: no live child → `planner_exit` / `planner not running`; `promptRetry` (`:929–945`) walks the chain (`pinWalk`), exhausted → `no_planner_leg` + `planner_no_leg` incident; else prompts `RETRY_NOTE`.
- `classifyOmpError` can return only `quota`, `auth`, `model_missing`, `model_refusal`, `aborted`, `timeout`, `transport`, `spawn`, `other` (`omp-frames.ts:68–78`).
- **Not consulted** (stay mechanics, stated so the row set is exact): an abort end (`:834` sets the failure, `:838` breaks); any end with `turn.failure` already set (`failTurn`, `onExit`, the deadline); a model error at an async-work-only end (`:840`: fails `model_error` without `retryNextLeg`, so no Houge retry overlaps the child's own work); a model error in a settle continuation pass after pass 0 answered (`:837`: the turn completes with pass 0's text). **Consulted:** an `error` frame or a `message_end` error, and a failed `prompt_result` (`onPromptRejected`, `:1366`, which sets `lastError`).
- `aborted` and `spawn` reach `retryNextLeg` only when the error text matches `/aborted|cancelled/` or `/enoent|spawn/` on a non-abort end; no code produces them on purpose. They stay in the rule (it must cover every kind), and a zero count for them is expected.
- One turn can consult the rule several times (one per failed leg); each consult is its own row.

**No recorder change.** R3 gave `SupervisorDeps` a `recorder` (passed by `CoreWorker.supervisorDeps`) and a private `record(entry, input, run_id)` helper; this slice reuses both. `src/omp/` is protected (`self-write-guard.ts:71`).

**Live traffic** (live DB, read-only, last 30 days): 374 compose `llm_attempt` rows, 5 compose errors (`quota` 4, `other` 1); 1 run failed `model_error`; `planner_crash_loop` and `planner_start_failed` incidents: **0** in the DB's history. Both entries are rare paths: their rows are an outage record, not a traffic record.

**Test seam.** `scripts/stage4-supervisor-fixture.mjs` (R3) has `fakeSession` (scripted `onPrompt(text, emit)`, `holdStart`), `heldSession`, `sink`, `mkSupervisor` (`opts.extra` overrides `SupervisorDeps`), `intakeRun`, `req`. It lacks a crash exit (the TS harness has `exit(code)`, `tests/helpers/supervisor-harness.ts:143`) and a no-manifest start; `onPrompt` already lets an item emit an error frame or `tool_execution_start`; `opts.extra.triage` gives a routed turn. Existing unit tests pin the crash latch (`tests/omp/planner-supervisor.test.ts:470–488`, `:541–548`, `:681–682`) and the retry paths (`:133`, `:438`, `:751–775`, `:1578–1665`, `:1828–1852`, `:1895`).

## 4. The entries

### 4.0 The recording rule (ADR 0030 §5)
Both decisions are made inside a turn whose run is already claimed (§3), so the row is written at the decision, with the consulting turn's run id, and `tool_call_id` null. **The turn is passed in, never read from `this.turn`:** `ensureSession(fresh, turn)`, `afterWarm(warm, turn)`, `startSession`'s loop and `startTurn`'s warm call (`:600`) pass their own `turn`; `retryNextLeg` already has it. The crash-guard row is written only when `!turn.finished` at the consult; **a consult reached after the consulting turn ended writes no row** (§5) — even when that consult is the one that latches; the guard still latches and opens its incident (raw behaviour), and the next turn's consult records `halt` / `latched`. `laneEnded` alone does not suppress it (`finishLane` sets it after the warm await), so a lane turn's halt still records (Decision 2-A). Neither decision is ever made for a run that is not claimed; a duplicate submit never reaches either. No message or error text is stored (`rowOf` has no input column; the error text never leaves `retryNextLeg`).

Both: `version: 1`, `stage: "supervision"`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`, `input: "tool"` (supervisor state and the provider's error text, never Paco's words), **unlocked** (§6.1 carries no L for D2, D9).

### 4.1 `planner.crash_guard`
- Verdicts `spawn | halt`; `defaultVerdict: "spawn"`; `fail: "halt"` (recorded, never acted on).
- **Consulted** where `ensureSession` reaches `crashLooping()` (`:963`); not when a ready child exists or a joined start produced one.
- **One clock read.** `ensureSession` reads `now = Date.now()` once and passes it to `crashLooping(now)` (today it reads its own, `:1043`; the only change to that function is the parameter) and to the capture, so the input and the raw guard use one cutoff (`t > now - CRASH_WINDOW_MS`, strict, as today).
- Input `{ latched: boolean; recent: number }` captured immediately before the raw call with that `now`: `latched` = the latch as it stood, `recent` = exit times with `t > now - CRASH_WINDOW_MS`. Rule (first match): `latched` → `halt` / `latched`; `recent >= CRASH_LIMIT` → `halt` / `limit_reached` (this consult latches and opens the incident); else `spawn`. The raw `crashLooping(now)` result drives; tests pin that the captured verdict equals it on every corpus item (`halt` ⇔ `true`) and at the boundary (an exit at exactly `now - CRASH_WINDOW_MS` is outside for both). `reasonCodes`: `limit_reached`, `latched`.
- Effects: `halt` `tighten`, reversible true (`/rearm`, the next sweep), announced none (the incident and `PLANNER_CRASH_LOOP_TEXT` are today's announcements, unchanged); `spawn` `none`.
- Rows: only `halt` (the default writes none). The run id is the consulting turn's (**Decision 2**).

### 4.2 `turn.retry`
- Verdicts `retry | final`; `defaultVerdict: "final"`; `fail: "final"` (recorded, never acted on).
- **Consulted** once per `retryNextLeg` call, at `mayRetry` (`:911`), after the kind is classified and before the live-child check.
- **One predicate.** `omp-frames.ts` (beside `RETRYABLE_ERROR_KINDS`) exports a pure `mayRetryOf({ kind, routed, usedTool, retriedOther })`; the private `mayRetry` becomes a call to it (same expression, behaviour unchanged) and the entry's rule uses it for the verdict, so there is no second copy of the rule.
- Input `{ kind: LlmErrorKind; routed: boolean; usedTool: boolean; retriedOther: boolean }` from the values `mayRetry` reads (`retriedOther` is set after `mayRetry`, `:914`, so the captured value is the pre-decision one). Reasons (first match; the verdict is `mayRetryOf`'s):
  - `kind` in `RETRYABLE_ERROR_KINDS` → `retry` / `<kind>` (`quota`, `auth`, `transport`, `timeout`, `model_missing`);
  - `kind === "other"`: `!routed` → `final` / `other_unrouted`; `retriedOther` → `final` / `other_retried`; `usedTool` → `final` / `other_after_tool`; else `retry` / `other_once`;
  - any other kind → `final` / `<kind>` (`model_refusal`, `aborted`, `spawn`).
  A test pins `rule(x).verdict === "retry"` ⇔ `mayRetryOf(x)` over every combination of the four inputs and all nine reachable kinds, and that each reason agrees with its verdict. `reasonCodes` (12): `quota`, `auth`, `transport`, `timeout`, `model_missing`, `other_once`, `other_unrouted`, `other_retried`, `other_after_tool`, `model_refusal`, `aborted`, `spawn`.
- Effects: `retry` `effect`, reversible false, announced none (another model continues the turn with `RETRY_NOTE`; a step-up is ledgered as today); `final` `tighten`, reversible true, announced none (the turn fails with today's error text).
- Rows (**Decision 1**): every consult. A retry verdict's row stands whatever follows (no live child, an exhausted chain): those are the turn's outcome, already in its ledger.
- R12: `input: "tool"` with an `effect` verdict is allowed for a rule-only entry: `effectProblems` (`registry.ts:97–108`) still requires an effect declared for every verdict, but skips the R12 check when the entry has no Jev or model rung. As with `intake.steer_or_queue` (R3 Decision 2-A), the amendment states the consequence: adding a Jev or model rung later needs a compliant effect contract, and `entryProblems` fails the suite until it has one.

### 4.3 Recorder seam
Unchanged from R3: `this.d.recorder` through the private `record()` helper; absent → no `decideSync` call. A production-wiring test drives `CoreWorker.submitTurn` with a fake session that errors once with `quota` and requires the `turn.retry` row (R2 lesson: a fixture that injects its own recorder cannot see a constructor that forgets one); `planner.crash_guard`'s wiring rides the same recorder and gets the same test with three failed starts.

### 4.4 Failure behaviour (R2/R3 carried over)
(a) The insert fails → `decision_record_failed` and one operator alert; (b) a recorder that throws past itself → logged. `decideSync` never throws for a rule-only entry. A rule that throws records its `fail` verdict at the `fail` rung (`halt` / `final`) while the raw code did what it did: a reader of a `halt` or `final` row checks `rung` first (as for `intake.bare_ack`). Neither fault changes the spawn, the latch, the incident, the retry, the prompt, the failure or its order. A recorder fault inside `retryNextLeg` must not throw into `settle` (the helper already catches).

## 5. What does not change
- When the planner spawns, latches, re-arms, retries, steps up or fails; the `planner_crash_loop`, `planner_no_leg`, `planner_start_failed` incidents; `llm_attempt` rows, `routed_escalation` events, run failures and their order; `RETRY_NOTE`; `PLANNER_CRASH_LOOP_TEXT`.
- `/status` gains a count line per new id once rows exist. The digest is unchanged (it lists only System One rows with a `p`).

## 6. The differential
**Harness (a plan task):** a stamped pair `--old-dist-r4` at this branch's merge base, provenance file `omp/planner-supervisor.js`; `R4_IDS = ["planner.crash_guard", "turn.retry"]` added to every pair's `NEW_ROW_IDS` and a new `r4` set; the first task greps for **every exact recorder-call tally or unfiltered `decisions` count on a path that spawns or tries to spawn a planner child** — every first spawn consults the crash guard, so not only model-error or crash paths are hit. Known: all 17 items of R3's `supervisor` corpus (`scripts/stage4-corpora/supervisor.mjs`, exact `calls` compared at `:233`) and the `counts` arrays of `tests/omp/supervisor-decisions.test.ts`; also check `live-gate-omp`, `live-gate-jev-tree`, `live-gate-decisions-2a`, `live-gate-ladder-2b-hooks`, `live-gate-ladder-remainder-r3`. New tallies follow one rule: `planner.crash_guard` +1 per `ensureSession` call that reaches the guard — one per turn that spawns or is refused, +1 for a stale re-check (`:612`), +1 per candidate omp refused at spawn. Updated to expect the new calls and rows exactly (R2 P10).

**Fixture additions** (`scripts/stage4-supervisor-fixture.mjs`): `exit(code)` on `fakeSession` (as the TS harness: drop the sockets, call the exit callbacks with `stopped: false`); `script.failStart` (`start()` rejects with a plain `Error` → `spawnFailed` counts a crash exit, `:1222`, at once — not a no-manifest start, which costs `manifestWaitMs` per failed start); `setModel` logs its calls; a role-list override (`opts.roles` or `opts.extra.roles`) so Default has two or more candidates and a retry has a next leg. Ported from `tests/helpers/supervisor-harness.ts`, narrow.

**Corpus `supervision`**, each item on a fresh store and supervisor:
- crash guard: three failed starts then a fourth turn [`halt/limit_reached` on the fourth run, one `planner_crash_loop`]; a fifth turn [`halt/latched`]; `resetCrashGuard` then a sixth [no row, a spawn]; a ready child's crash exit ×3 across turns then a turn [`halt/limit_reached`]; a lane turn (triage `lane_reply`) while latched [`halt/latched` on the lane run, the lane reply delivered]; two failed starts then a good turn [no row]; a run claimed by another worker before `submit`, guard latched [zero R4 calls and rows]; turn A's start held in flight, lane turn B completes, A's start settles [no `planner.crash_guard` row on B written after B finished]; the same with A's late consult being the one that latches (two prior crash exits, A's start a third) [no `limit_reached` row, one `planner_crash_loop` incident, the next turn `halt/latched`].
- retry: `quota` error then success [`retry/quota`]; `timeout` on every leg until exhausted [one `retry/timeout` per leg, then `no_planner_leg`]; `other` on an unrouted turn [`final/other_unrouted`]; `other` on a routed turn, no tool [`retry/other_once`], then `other` again [`final/other_retried`]; `other` after a `tool_execution_start` [`final/other_after_tool`]; `other` after only a `todo` tool [`retry/other_once`]; `model_refusal` [`final/model_refusal`]; an async-work-only end with an error [no row]; a quota error on a routed Fast turn that steps up [`retry/quota` + `routed_escalation`].
Compared: the session's call log (prompts, steers and `setModel` calls, in one ordered log — the `supervision` corpus projection includes it; R3's projection compares only prompts and steers), the outcome sink's calls (incl. incidents), and the whole-DB dump (new rows dropped before `relabelClocks`; ids scrubbed). Required: per item, the exact new rows (`[entry, verdict, reason, run_id label]`) and exact per-entry recorder call counts; a planted fault (the rule's `limit_reached` and `latched` branches swapped; `other_retried` and `other_after_tool` swapped) shown failing once.

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
`src/omp/planner-supervisor.ts`, `src/omp/omp-frames.ts` (`mayRetryOf`), `src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `src/decisions/entries/planner-crash-guard.ts`, `src/decisions/entries/turn-retry.ts`. `docs/decisions/0030-decision-ladder.md` (amendment drafted, awaiting Paco's signature).

## 10. Risks
- **A recorder on the failure path.** Both decisions run while something is already failing (a crashing child, a provider error). `record()` catches; `decideSync` is synchronous and never throws for rule-only entries; the raw `crashLooping()` / `mayRetry()` drive. A recorder fault is one more incident at worst (insert fault), as R1–R3.
- **Capture before a mutating call.** `crashLooping()` filters `this.exits` and latches; the input must be captured before it runs, by the same cutoff, or a row could say `spawn` for a halt. The equivalence test in §4.1 and corpus items pin it.
- **Rows during an outage.** A latched guard writes one row per turn until `/rearm` or the next sweep (a latch lasts until `/rearm` or the next sweep that actually runs — not throttled, not disarmed); a provider outage writes one `turn.retry` row per failed leg (bounded by the chain length per turn). Both bounded by turns.
- **The lane-turn row** (Decision 2) is on a run that completed: the row records that its warm spawn was refused, not that the turn failed.

## Decisions needed (Paco, at the spec tap)

**Decision 1 — which `turn.retry` outcomes write a row.**
- **1-A (recommended):** every consult (`alwaysRecord`): both `retry` and `final`. A model error is rare (5 in 30 days), and the `final` side is the one an outcome judges most often (was `other_after_tool` right to give up?).
- **1-B:** `retry` only (`final` is the default and stays invisible; the failure is in the run's own error).

**Decision 2 — the run a `planner.crash_guard` row names.**
- **2-A (recommended):** the consulting turn's run, at the decision, for every halt — including a lane turn's warm start, where the halt refused the spawn but the lane reply still completed the run. The `limit_reached` row is written on the consult that latched, unless that consult came after its turn ended (§4.0: the late consult writes no row and the next turn records `latched`).
- **2-B:** only when the halt fails a planner turn (`ensureReady` → `crash_loop`). A halt on a lane turn writes nothing; if the latch happens on a lane turn, its `limit_reached` row is lost and the next planner turn records `latched`.

## Rev 1.1 changes (senior Fable 5.1 + codex; each verified first-hand)
- Senior B / no in-scope run id for the crash guard: `ensureSession`, `afterWarm` take no turn and the consult follows two awaits (`:957`, `:961`), so `this.turn` can be the next turn → the turn is threaded through every caller; the row is written only when `!turn.finished`; a late consult writes no row (§4.0); corpus item added.
- Codex B / two clock reads: `crashLooping()` reads its own `Date.now()` (`:1043`) → one `now` passed to both; boundary test (§4.1). Supersedes senior S1.
- Senior W1 / the grep misses what breaks: every spawn consults the guard → criterion rewritten, the R3 corpus and `supervisor-decisions.test.ts` named, tally rule stated (§6).
- Senior W2 / sweep bound: re-arm only on a sweep that ran (`telegram-daemon.ts:764–771`) → §3, §10 reworded.
- Senior W3 / `effectProblems` cite: `:97–108`, R12 check skipped, per-verdict effect still required (§4.2).
- Codex W / fixture: a one-model Default role cannot retry to a second leg; `setModel` logs nothing → role override and call log (§6). Senior S2: `failStart` instead of a no-manifest start.
- Codex S / lost-run guarantee: pre-claimed run under a latched guard → zero R4 calls (§6).
- Senior S3 / not-consulted list completed; `prompt_result` errors consulted (§3). S4: `aborted`/`spawn` text-reachable only (§3). S5: one exported `mayRetryOf` predicate (§4.2). S6: `fail`-rung rows (§4.4). S7: line refs (`:664`, `:1004`, daemon path).

## Rev 1.2 changes (codex scoped re-review)
- Codex B / a late consult can latch with no row, against 2-A's "always": §4.0 wins (a lost turn writes no row); the guard still latches and pages; the next turn records `latched`; Decision 2-A reworded; corpus item added.
- Codex W / `setModel` order compared only if projected: the `supervision` projection includes the ordered call log (§6).
- Codex W / predicate location: `mayRetryOf` lives in `omp-frames.ts`, listed in §9.
