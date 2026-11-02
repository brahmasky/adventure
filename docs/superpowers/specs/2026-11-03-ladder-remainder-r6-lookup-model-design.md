# Decision ladder, remainder slice R6 — `lookup.rewrite`, `lookup.thin` and `turn.model` on the ladder (Rev 1.0)

**Status:** DRAFT — awaiting the senior review, the codex design pass, then Paco's Decisions 1 and 2. Its ADR 0030 amendment stacks on R4's, R5's and the loud-degradation slice's, all still awaiting his signature.
**Date:** 2026-11-03
**Amends:** `docs/ROADMAP.md` (the remainder line); ADR 0030 gets an amendment row (drafted under the approved spec, awaiting Paco's signature); the ladder design spec §6.1 gets a dated note.
**Depends on:** ADR 0030 §4.1, §5 (a turn's row is written with the turn's own records; a lost turn writes no row), §6.1 (rows A21, A22, stage `pre_model`), §6.2; remainder R1 spec §2 (the R6 rows of the re-walk table: `lookup.rewrite` "Tiny model between two code rungs", `lookup.thin` "code trigger on the reader's field", `turn.model` "at the supervisor's pin/step-up point only"); R3–R5 for the pattern: a recorder on the deps, a private record helper, the stamped merge-base differential, production-wiring tests, exact-row assertions, one exported predicate shared by code and rule; R5 §4.0 for the liveness rule (`turn.endSignalled`).

## 1. Goal

Put the last three pre-model decisions before R7 on the registry as rule-only entries that **record and never steer**:

- `lookup.rewrite` (A21): does the lookup lane search a rewritten query or Paco's bare message?
- `lookup.thin` (A21): did the strict reader's first read leave the objective unanswered, so the lane fetches the top listed result and reads again?
- `turn.model` (A22): which leg of the turn's role does the planner child get pinned to — the role's head, a later leg or the next role up, the model the child already holds, or none?

Each wraps today's code unchanged; the raw answer drives. Proof: a stamped merge-base differential (a new lane harness for the lookup entries, the R3–R5 supervisor fixture for `turn.model`), zero behaviour differences.

## 2. Scope

In: the three entries; a private record helper in `core/lanes/lookup-lane.ts` (the lane already holds `d.recorder`); two pure classifiers in `core/lanes/lane-compose.ts` that `needsRewrite` and `validateQuery` become thin wrappers of (one predicate each, byte-identical results); `turn.model` recorded by the supervisor's existing `record()` helper after each pin walk; a new lane differential harness and `lookup` corpus; a `model` corpus on the supervisor fixture; a live gate; a rollback check.

Out (stated so the review cannot creep):
- R7 (`attach.path`). Nothing here touches the outbox or its `run_id` propagation.
- **A model rung for `lookup.rewrite`.** The R1 table's "Tiny model between two code rungs" describes today's code, not a prescription; the remainder is rule-only record-never-steer (R1 Decision 1-A). Moving the Tiny call into `decide()` would make the lane's rewrite go through `runAsync`/`withTimeout` (`decisions/decide.ts:76–93`), which has no abort signal and no `within(bound…)`/`LATE` semantics, and would count a Tiny outage toward `decision_fallback` paging. That is a behaviour change and breaks the zero-difference proof. A ladder-owned Tiny call is a later slice with its own ADR line. Until then the row's `rung` is `rule` and its reason names which step answered (§4.1).
- **The lane's compose model** (`composeReply`'s walk of `d.fastChain`), the answer lane, the spawn model (`spawnChain`, `planner-supervisor.ts:480`: the turn re-pins its own first candidate before the prompt, spec §5 of the omp runtime), every other seat's `candidates()` call (reader, judges, ticks, tiny), effort clamping (`clampEffort`; the routed effort is `turn.gear`'s), the `/models` override and resolution itself (`resolveRole`). `turn.model` records the planner pin only.
- The execution after a `fetch` verdict: `thinFetch`'s own `bound <= 0` skip, a failed or late fetch, a failed second read. They are how the decision ran, not the decision (as R5 left `loop_started` to the turn and recorded only the prompt's decisions).
- The lane's existing `tool.wall` / `reader.family` consults (`lookup-lane.ts:90–99`, `:114–124`). The second-read pair records without a liveness check; aligning it would move rows (a follow-up, like R4's guard). Its four duplicated `decideSync` blocks are left as they are.
- `REWRITE_MAX_CHARS`, `REWRITE_RECENT_MS`, `QUERY_MAX_CHARS`, `FINAL_QUERY_CHARS`, `REWRITE_MS`, `FETCH_MS`, `COMPOSE_RESERVE_MS`, the rewrite prompt, `STEP_UP`, `recordPinMissing`'s `model_missing` rows, `routed_escalation`, `planner_model_reset_failed`, `planner_no_leg`; any change to which query is searched, which URL is fetched, which model is pinned, or in what order.

## 3. Live facts (`main@fe788f2`, read first-hand)

**The lookup lane** (`core/lanes/lookup-lane.ts`) runs inside triage (`PlannerSupervisor.startTurn`, `planner-supervisor.ts:631`, `signal: turn.abort.signal`), before `finishLane`. `lookupSteps` (`:34`): an empty Fast chain falls through `no_fast_leg` before any query step; then `lookupQuery`, an abort check, `searchStep`, `readStep`, `composeLookup`.

**Rewrite (A21).** `lookupQuery` (`:50–58`): `needsRewrite(i.userText, i.quoted !== null, age)` (`lane-compose.ts:63–66`: Paco's previous Telegram line at most 30 minutes old, AND quoting or at most 40 chars); false → `finalQuery(userText)`. Else `bound = min(REWRITE_MS, beforeReserve)`; `bound <= 0` → the bare message. Else one Tiny one-shot raced by `within(bound, …)`; a late answer is `LATE`, a throw is `null`; `validateQuery(ok ? answer : "SAME", userText)` (`:78–82`) returns the model's query only when it is non-empty, not `SAME` (any case, optional `.`/`!`/`。`), one line, at most 120 chars and has no URL — anything else returns the bare message. `finalQuery` folds whitespace and cuts at 200 chars. The production `rewrite` is `laneSeat(run_id, "lane", { chain: tiny })` (`core-worker.ts:3519`).

**Thin (A21).** `readStep` (`:86–103`): the first strict read; `!first.ok` falls through after recording `tool.wall` and `reader.family`; on success, after an abort check and the same two consults, `answer_to_objective === null && urls[0] !== undefined` → `thinFetch` (`:101`), where `urls` are the results' listable URLs (`sourceUrl`). `thinFetch` (`:106–130`) fetches once within `min(FETCH_MS, beforeReserve)`, writes `http_fetch_performed`, reads again, and on any failure composes from the first digest.

**Lane liveness.** The lane's signal is the turn's `abort` signal. Every path that ends a turn during triage aborts that signal before or with `done`: `abortTurn` calls `t.abort.abort()` before `t.done("abort")` (`:1583–1585`); shutdown (`:465`) likewise. A lane turn's own `done("end")` comes only in `finishLane`, after the lane returned. So `!i.signal.aborted` is the end signal in the lane window — the lane's equivalent of R5's `!turn.endSignalled`.

**The planner pin (A22).** `promptTop` (`:716–737`) sets `turn.chain = turnChain(turn.role, turn.effort)` (the routed role's candidates, minus what the child refused, `:482–484`) and calls `pinFirst` (`:743–751`) → `pinWalk(turn, s, "model_missing")` (`:758–768`). `pinWalk` loops: `currentCandidate` (`:771–777`; a spent chain steps a routed, un-pin-failed turn up `STEP_UP`, `fast → default → thinking → none`, ledgered `routed_escalation`, `:780–789`); `turn.legsTried++`; a child already on the target is `ok` with no RPC; else `pin` (`:792–806`) — a `Model not found` refusal adds the selector to `this.refused`, writes one `model_missing` attempt row, and the walk moves on; any other failure returns `{ error }`. `pinFirst`: `exhausted` → `no_planner_leg`; `{ error }` → `turn.pinFailed`, `planner_model_reset_failed` incident, the turn answers on the model the child already holds. A retry leg (`retryNextLeg` → `turn.retry` → `legIndex++` → `promptRetry`, `:951–990`) walks the same way with the error's kind; there `exhausted` → `no_planner_leg` and `{ error }` → `retry_failed` (the turn fails). An `ENDED` walk is a turn that ended mid-pin.

**Live traffic** (live DB, read-only, at `fe788f2`):
- Lookup lane: **one run ever** (2026-10-18; `lane_replies.lane = 'lookup'`), with one `web_search_performed` and one `http_fetch_performed` (the thin trigger fired), and two `llm_attempt` rows of role `lane` (one `timeout`, one `ok`). The `lane` role covers both the rewrite and the compose, so `llm_attempt` cannot count rewrites. `jev_verdicts`: lookup 1, answer 8, memory 1, planner 35; no `fallthrough:*` row.
- Planner pin: 112 `loop_started` rows in 30 days; `routed_escalation` **0 ever**; `:pin:` `model_missing` rows **0 ever**; `route_outcome = 'pin_failed'` **0**; compose errors in 30 days: `quota` 4, `other` 1 (each a candidate for a retry leg's pin). Every first pin so far landed on its role's head.

**Test seams.** `tests/core/lanes/lookup-lane.test.ts` drives `runLookupLane` with scripted `rewrite`/`search`/`read`/`fetch` (no recorder assertions today). The supervisor fixture `scripts/stage4-supervisor-fixture.mjs` (R3–R5) and the TS harness `tests/helpers/supervisor-harness.ts` drive pins through a fake session; `opts.extra` overrides any `SupervisorDeps` field, so a scripted `roles` and a session whose `setModel` refuses or throws are reachable. No stage-4 corpus drives a lane today (15 corpora: binding, command, context, contract, intake, memadmit, memcorrect, path, policy, redaction, schedule, sender, stub, supervision, supervisor).

`src/omp/` and `src/decisions/` are protected (`self-write-guard.ts`); `src/core/lanes/` and `src/core/core-worker.ts` are not.

## 4. The entries

### 4.0 The recording rule (ADR 0030 §5, as R5 §4.0)
All three decisions are made inside a turn whose run is claimed: each row carries that run's id and `tool_call_id` null, and is written **only while the turn is live** at the consult. The lane entries read `!i.signal.aborted` (§3); `turn.model` reads `!turn.endSignalled` (R5's flag, re-armed per retried leg by `armEnd`). A consult on an ended turn writes no row; the raw code is unchanged either way. No message, query, prompt, URL, digest or model id is stored (`rowOf` has no input column).

All three: `version: 1`, `stage: "pre_model"`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`, **unlocked** (§6.1 carries no L for A21, A22). `input`: `lookup.rewrite` `mixed` (Paco's message and recent chat lines go into the Tiny prompt); `lookup.thin` `tool` (the reader's field over search output); `turn.model` `tool` (supervisor state). R12 as in R5: an `effect` verdict over `mixed` input is allowed for a rule-only entry; adding a Jev or model rung later needs a compliant effect contract, and `entryProblems` fails the suite until it has one.

**One read, one predicate.** Each capture uses values the raw code already computed. Where the raw code branches on a predicate, the rule calls the same exported function (§4.1, §4.2); `turn.model`'s rule classifies the walk the code already finished and drives nothing.

### 4.1 `lookup.rewrite`
- **One predicate each, pure refactors in `lane-compose.ts`:**
  - `rewriteFilterOf(message, quoted, ageMs): "no_recent_line" | "long_message" | "needed"` — `ageMs === null || ageMs > REWRITE_RECENT_MS` → `no_recent_line`; else `quoted || chars <= REWRITE_MAX_CHARS` → `needed`; else `long_message`. `needsRewrite(...)` becomes `rewriteFilterOf(...) === "needed"`.
  - `queryCheckOf(raw, message): { kind: "same" } | { kind: "invalid" } | { kind: "query"; q: string }` — the strip as today; `/^same[.!。]?$/i` → `same`; empty, newline, over 120 chars or a URL → `invalid`; else `query`. `validateQuery(raw, message)` becomes `kind === "query" ? q : message`. (The empty-string check runs before the `SAME` test today and both return the bare message; the classifier calls an empty answer `invalid`.)
  Both wrappers return byte-identical results for every input; unit tests pin the equivalence over the existing cases plus the boundaries (40/41 chars, 30 min ± 1 ms, 120/121 chars, `same.`, `SAME!`, `same。`, empty, a URL, a newline).
- **Consulted** once per lookup run that reaches the end of `lookupQuery`, on a live turn. `no_fast_leg` (before the query step) is not a consult.
- Input `{ step: RewriteStep }`, `RewriteStep = "no_recent_line" | "long_message" | "no_time" | "late" | "failed" | "same" | "invalid" | "rewritten"`, set where `lookupQuery` branches: the filter's answer; `bound <= 0`; `r === LATE`; `r === null` (the call threw) or `!r.ok`; else `queryCheckOf(r.answer, userText).kind` (`query` → `rewritten`). A `LATE` or failed call still passes `"SAME"` to `validateQuery` exactly as today.
- Rule: `rewritten` → `rewrite` / `rewritten`; else `bare` / the step. `reasonCodes`: `rewritten`, `no_recent_line`, `long_message`, `no_time`, `late`, `failed`, `same`, `invalid`. Which reasons are code and which the model: `no_recent_line`, `long_message`, `no_time` (code before the call); `late`, `failed` (the call's outage); `same`, `rewritten` (the model's answer); `invalid` (code over the model's answer).
- Verdicts `rewrite | bare`; `defaultVerdict: "bare"`; `fail: "bare"`.
- Effects: `rewrite` `effect`, reversible true (the next lookup asks afresh), announced none (the query is not shown; the source line shows what was read), what "the validated rewrite is the search query and the reader's objective"; `bare` `none`.
- Rows: **Decision 2.**

### 4.2 `lookup.thin`
- **One predicate.** `lookup-lane.ts` exports `thinOf({ answered, url }): "thin" | "answered" | "no_url"` (`answered` = `answer_to_objective !== null`; `url` = `urls[0] !== undefined`): `answered` → `answered`; `!url` → `no_url`; else `thin`. The trigger at `:101` becomes `thinOf(...) === "thin"`, so code and rule share it.
- **Consulted** once per lookup run whose first read succeeded, at the trigger, on a live turn (after the existing abort check). A failed first read is not a consult (it falls through; `tool.wall`/`reader.family` already record it).
- Input `{ answered: boolean; url: boolean }`. Rule: `thinOf` → `thin` → `fetch` / `thin`; `answered` → `none` / `answered`; `no_url` → `none` / `no_url`. `reasonCodes`: `thin`, `answered`, `no_url`.
- Verdicts `fetch | none`; `defaultVerdict: "none"`; `fail: "none"`.
- Effects: `fetch` `effect`, reversible true (a GET of a URL the search listed; nothing Houge owns changes), announced none, what "one fetch of the top listed result through the SSRF floor and a second strict read; `http_fetch_performed` as today"; `none` `none`.
- Rows: **Decision 2.**

### 4.3 `turn.model`
- **Consulted** once per completed pin walk on a live turn: in `pinFirst` after `pinWalk` returns (`leg: "first"`), and in `promptRetry` after `pinWalk` returns (`leg: "retry"`). An `ENDED` walk is not a consult; `promptTop` with no session (`failTurn` before any pin) is not a consult. Never at `candidates()`, `turnChain`, `spawnChain` or `currentCandidate` (each runs several times a turn).
- Input `{ leg: "first" | "retry"; outcome: "ok" | "pin_failed" | "exhausted"; stepped: boolean; refused: number }`, captured around the walk from values the supervisor already holds: `stepped` = `turn.role` after the walk differs from before it; `refused` = the walk's pins omp refused (each walk iteration increments `turn.legsTried` once, so `refused` = the iterations minus one for `ok`/`pin_failed`, all of them for `exhausted`; R4's `legsTried` semantics are not changed).
- Rule (first match): `exhausted` → `none` / `no_leg`; `pin_failed` → first leg `held` / `pin_failed` (the turn answers on the model the child holds), retry leg `none` / `pin_failed` (the retry fails the turn); `stepped` → `fallback` / `stepped_up`; `refused > 0` → `fallback` / `refused`; `leg === "retry"` → `fallback` / `next_leg`; else `head`. `reasonCodes`: `stepped_up`, `refused`, `next_leg`, `pin_failed`, `no_leg`. No model id or role is a reason code.
- Verdicts `head | fallback | held | none`; `defaultVerdict: "head"`; `fail: "head"`.
- Effects: `head` `none`; `fallback` `effect`, reversible true (the next turn starts from its role's head again), announced none, what "a later leg of the role, or the next role up, answers; a step-up is ledgered `routed_escalation` as today"; `held` `effect`, reversible true, announced none, what "the turn answers on the model the child already holds; `planner_model_reset_failed` as today"; `none` `tighten`, reversible true, announced none, what "the turn fails `no_planner_leg` or `retry_failed` with today's text and incident".
- Rows: **Decision 1.**

### 4.4 Recorder seams
- **Lane.** A private `record(i, d, entry, input)` in `lookup-lane.ts`: no `d.recorder` → nothing; `i.signal.aborted` → nothing; `decideSync` wrapped so a throw past the recorder is logged and never reaches the lane (the lane's own `lane_threw` catch must not see it). Production already passes `storeRecorder(this.runStore, …)` in `lookupLaneDeps` (`core-worker.ts:3524`).
- **Supervisor.** `turn.model` through the existing `record()` helper (`planner-supervisor.ts:418–421`) guarded by `!turn.endSignalled`. The `.mjs` fixture and the TS harness already pass the supervisor recorder (R3–R5).
- **Production wiring tests** (R2 lesson: a fixture that injects its own recorder cannot see a constructor that forgets one): (a) `CoreWorker`'s own `lookupLaneDeps` (network deps `search`/`fetch`/`read`/`rewrite` replaced, recorder kept) driven through `runLookupLane` writes the `lookup.rewrite` and `lookup.thin` rows to the store; (b) `CoreWorker.submitTurn` with a fake session whose `setModel` refuses the head writes `turn.model` `fallback/refused` (added to `tests/core/supervisor-decision-wiring.test.ts`).

### 4.5 Failure behaviour (R1–R5 carried over)
(a) The insert fails → `decision_record_failed` and one operator alert; (b) a recorder that throws past itself → logged. A rule that throws records its `fail` verdict at the `fail` rung (`record.ts:29`); for `turn.model` and both lane entries the `fail` verdict equals the default, so the `fail`-rung row is the only trace; three in an hour page `decision_fallback`. Neither fault changes the query, the fetch, the pin, the ledger rows or their order. The corpora carry one planted-throw item per entry (the real entry's `ladder[0].decide` replaced and restored in `finally`, R5 P14).

## 5. What does not change
- Which query is searched and read; whether and which URL is fetched; which model is pinned, in what order, with which effort; every ledger row, attempt row, incident and its order; the lane's result and catch-up line; the planner prompt.
- `/status` gains a count line per new id once rows exist. The digest is unchanged.

## 6. The differential
**Harness (a plan task):** a ninth stamped pair `--old-dist-r6` at this branch's merge base, provenance file `core/lanes/lookup-lane.js`; `R6_IDS = ["lookup.rewrite", "lookup.thin", "turn.model"]` added to every pair's `NEW_ROW_IDS` and a new `r6` set. The first task greps for **every exact recorder-call tally or unfiltered `decisions` count on a path that pins a planner child** — every planner turn that reaches `promptTop` with a session consults `turn.model` once, and each retry leg once more. Known: the `supervisor`, `supervision` and `context` corpora; `tests/omp/supervisor-decisions.test.ts`, `tests/omp/supervision-decisions.test.ts`, `tests/omp/context-decisions.test.ts`, `tests/omp/lessons-decisions.test.ts`, `tests/core/supervisor-decision-wiring.test.ts`; the R3, R4, R5 gates; also check `live-gate-omp`, `live-gate-jev-tree`, `live-gate-decisions-2a`, `live-gate-ladder-2b-hooks`. The tally rule, one line: `turn.model` +1 per pin walk that returns other than `ENDED` while `!turn.endSignalled`, after `turn.clarify_cap`/`context.*` on the first leg and after `turn.retry` on a retry leg. `lookup.rewrite` +1 per lookup run reaching the end of `lookupQuery` live; `lookup.thin` +1 per successful first read live. Updated to expect the new calls and rows exactly (R2 P10).

**New lane harness** (`scripts/stage4-lane-fixture.mjs`): `runLookupLane` imported from the given dist, driven with scripted `rewrite`/`search`/`read`/`fetch`/`previousTelegramTurns`, a fixed clock, a recorder that logs calls, and the real `fastChain`/compose deps stubbed. Narrow, ported from `tests/core/lanes/lookup-lane.test.ts`.

**Corpus `lookup`** (lane harness), each item fresh:
- rewrite: no previous line [`bare/no_recent_line`, no rewrite call]; a 41-char unquoted message after a recent line [`bare/long_message`]; a quoted long message after a recent line, the model answers a query [`rewrite/rewritten`, the query searched]; the model answers `SAME` [`bare/same`]; `same。` [`bare/same`]; a two-line answer [`bare/invalid`]; a URL [`bare/invalid`]; the model past its bound [`bare/late`, the late answer never used]; the call throws [`bare/failed`]; `ok: false` [`bare/failed`]; the reserve already reached [`bare/no_time`, no call]; `/kill` while the rewrite is held [no row; `aborted`].
- thin: an answered first read [`none/answered`, no fetch]; a thin read with a listable URL [`fetch/thin`, one fetch]; a thin read whose results have no listable URL [`none/no_url`, no fetch]; a thin read with no time left for the fetch [`fetch/thin`, no fetch — execution, §2]; a failed first read [no row]; `/kill` during the first read [no row].
- faults: each lane entry's rule planted to throw [one `fail`-rung row; the query and fetch unchanged].
Compared: the scripted deps' call log (rewrite prompts, search queries, read objectives and outputs, fetch URLs, ledger calls, in order), the lane's result object, and the recorder's calls minus `R6_IDS`. Required: per item the exact new rows and per-entry call counts; a planted fault (`same` and `invalid` swapped in the rule) shown failing once.

**Corpus `model`** (supervisor fixture), each item on a fresh store and supervisor, with a scripted `roles` (`candidates(role)` lists per role) and a fake session whose `setModel` can refuse (`Model not found`) or throw:
- first leg: the head pinned [no row, one call]; the child already on the head [no row, no `setModel`]; head refused, second leg pinned [`fallback/refused`, one `model_missing` row]; a routed Fast turn whose Fast chain is all refused, Default's head pinned [`fallback/stepped_up`, `routed_escalation`]; an unrouted turn whose chain is all refused [`none/no_leg`, `no_planner_leg`]; `setModel` throws a transport error [`held/pin_failed`, `planner_model_reset_failed`]; the turn aborted while `setModel` is held [no row].
- retry leg: a `quota` error then the next leg pinned [`turn.retry retry/quota`, then `turn.model fallback/next_leg`]; the chain spent on retry, a routed turn steps up [`fallback/stepped_up`]; spent on an unrouted turn [`none/no_leg`]; the retry pin throws [`none/pin_failed`, `retry_failed`].
- faults: the rule planted to throw [one `fail`-rung row; pins unchanged].
- none: a lane turn (no `promptTop`) [zero `turn.model` calls].
Compared as R3–R5: the session's call log (prompts, `setModel` targets in order), the outcome sink's calls, the whole-DB dump (new rows dropped, ids scrubbed). Planted fault: `refused` and `next_leg` swapped, shown failing once.

## 7. Live gate — `scripts/live-gate-ladder-remainder-r6.mjs` (dist, VACUUM copy, refuses outside `.worktrees/`, copy deleted on every exit path, `HOUGE_TELEGRAM_CHAT_ID` stub, tombstone pinned; no real omp child, no real Telegram, no web search, no subscription call)
1. Through `CoreWorker`'s own `lookupLaneDeps` over the copy (real `previousTelegramTurns` over seeded recent lines, network deps scripted): a short follow-up → `lookup.rewrite rewrite/rewritten`, the searched query equal to the scripted answer; the same with the rewrite late → `bare/late`, the bare message searched.
2. Same seam, a thin first read → `lookup.thin fetch/thin`, exactly one fetch of the first listed URL and one `http_fetch_performed` row; an answered read → `none/answered`, no fetch.
3. `turn.model` over the **real `RoleResolver`** on the copy (its `model_tiers`, static and resolved modes; catalog scripted — no omp process): a fake session refusing the resolved Default head → `fallback/refused`, the second `setModel` target equal to `candidates("default")[1]`; head accepted → no row.
4. Through `CoreWorker.submitTurn` (production deps) → line 3's row is written (wiring).
5. A `quota` model error on the first leg → `turn.retry` then `turn.model fallback/next_leg`, in that order on the run.
6. Faults: the insert faulted → `decision_record_failed`, exactly one alert to the stub chat, query and pin unchanged; a throwing recorder → no incident.
7. `/status` count lines for the three ids exact.
Not live: a real Tiny rewrite and a real search (subscription and third-party calls; the lane's arithmetic is pinned by the differential and unit tests). Cost if wrong: a production Tiny answer shape the classifier mislabels shows up in a row, not in the gate.
The slice updates the registry-count literals (36 → 39: `tests/decisions/registry.test.ts`, `scripts/live-gate-ladder-stage4b.mjs`) and reruns the R5, R4, R3, R2, R1, 4C and 4B gates. `live-gate-jev-tree` cases 3 and 7 fail on `main` today (logged follow-up): a rerun compares against `main`, not against green.

## 8. Rollback check — `scripts/check-ladder-remainder-r6-rollback.mjs`
The previous build opens a copy carrying the new rows (all three ids, with run ids), renders `/status` and the digest (digest identical to an untouched copy's; `/status` differs only in the three count lines, asserted exactly), reads every row unchanged (`rung`, `entry_version`, `verdict`, `reason_code`), and refuses `review_ok` naming the new ids. No migration.

## 9. Protected files touched (Tier A under the approved spec)
`src/omp/planner-supervisor.ts` (the `turn.model` consults), `src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `src/decisions/entries/lookup-rewrite.ts`, `lookup-thin.ts`, `turn-model.ts`. `docs/decisions/0030-decision-ladder.md` (amendment drafted, awaiting Paco's signature). Not protected: `src/core/lanes/lookup-lane.ts`, `src/core/lanes/lane-compose.ts`, `src/core/core-worker.ts` (unchanged unless a wiring test needs a seam).

## 10. Risks
- **The classifier refactors.** `needsRewrite` and `validateQuery` move onto classifiers; a slip changes which query is searched. The equivalence tests and the `lookup` corpus (the searched query compared byte for byte against the merge base) pin it.
- **Tally churn.** `turn.model` is consulted on every planner turn, so every exact-call tally on a planner path moves again (R5's experience: the stale item's order). The first task measures, never assumes.
- **`refused` from `legsTried`.** The count relies on one increment per walk iteration; a test pins it on a walk with two refusals and a step-up.
- **Lane liveness.** `!i.signal.aborted` holds only because every turn end during triage aborts the signal first (§3); a test pins `/kill` mid-rewrite and mid-read.

## Decisions needed (Paco, at the spec tap)

**Decision 1 — which `turn.model` consults write a row.**
- **1-A (recommended):** only when the pin left the role's head (`fallback`, `held`, `none`), the default `head` writes none. Today that is the retry legs after a model error (≤5 in 30 days) and nothing else: no pin has ever been refused or stepped up. A `head` row would add one row per planner turn (~112 per 30 days) saying what `turn.gear` (the role) and the turn's `llm_attempt` rows (the model) already hold.
- **1-B:** every consult (`alwaysRecord`), one row per planner turn and per retry leg. An outcome could then attach to "this turn ran on its head", which nothing judges today.

**Decision 2 — which lookup consults write a row.**
- **2-A (recommended):** every consult of both lookup entries (`alwaysRecord`). The lane ran once in its life, so the cost is nil, and both errors are judgeable: a rewrite that searched the wrong thing (`rewrite`) and a bare search that needed the chat's context (`bare/no_recent_line`, `long_message`, `late`); a read judged answered that was not (`none/answered`).
- **2-B:** non-default only (`rewrite`, `fetch`). A missed rewrite and a skipped fetch leave no row.
