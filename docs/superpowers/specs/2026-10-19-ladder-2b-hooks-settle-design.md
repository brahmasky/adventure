# Decision ladder stage 2b-i: extension hooks and `turn.settle`

Rev 1, 2026-10-19. Parent: [the decision-ladder spec](2026-10-12-decision-ladder-design.md) §7.1 (built-in reads),
§7.3 (`turn.settle`), §13 (stage 2b row). ADR: [0030](../decisions/0030-decision-ladder.md). Code at `05168ba` (memory
write merged). omp installed: 18.10.4 (the parent spec's probes P1–P4 ran on 18.7.0).

## 0. Scope and rulings

Stage 2b of the ladder spec names two builds in one row: the extension hooks with `turn.settle`, and `improve.route` with
its signal producers, `improvement_jobs` and proposal surface. Paco split them on 2026-10-19 (ruling 2b-R1): **this spec
is the hooks and settle half (2b-i)**; `improve.route` is 2b-ii, its own spec after this ships. The reasons: `turn.settle`
fixes a defect seen in the memory-write gate (the planner claimed a save without calling `lesson_write`, case 5), it
produces the `settle_sent_back` signal that `improve.route` consumes, and of the ten `improve.route` signals only four have
producers today (`src/decisions/outcomes.ts:28-34`: `correction`, `rating`, `recurrence`, `approval_*`,
`settle_sent_back`, `planner_failed`, `abandoned`, `lesson_unfollowed` have none; six throw on insert).

Rulings taken in this design:

| # | Ruling | By |
|---|---|---|
| 2b-R1 | Split 2b: hooks + settle first (this spec), `improve.route` second | Paco, 2026-10-19 |
| 2b-R2 | Keep the todo check: enable omp's todo tool for the planner with reminders off | Paco, 2026-10-19 |
| 2b-R3 | `turn.settle` is decided through the extension's `session_stop` hook (parent §7.3), not by a supervisor-side `steer`; a steer would be a second omp turn with two settles and a weaker "replace your reply" | design |
| 2b-R4 | A built-in `read` stays omp's tool, judged through the extension; replacing it with a Houge bridge tool would run the read in Houge's process, outside the planner's Seatbelt | design |
| 2b-R5 | A late verdict still raises trust by its own outcome (a withhold found late makes the turn `hostile`), it only skips the rewrite | design |
| 2b-R6 | The todo check fires only on a list that changed during this turn: `todoPhases` is session state and a stale list from an earlier turn in the same transcript must not send back an unrelated reply | design |

What this spec does not change: lane turns (no planner, nothing to settle), the trust ladder's levels and causes
(`src/decisions/trust.ts`), the five existing bridge kinds' shapes, the rich renderer path, `improve.route`.

## 1. What exists today (read at `05168ba`)

- **Extension** (`src/omp/extension/`): `houge.ts:7` loads `hougePolicy` then `hougeTools`. `PiLike.on` is typed for
  `tool_call` and `tool_result` only (`houge-tools.ts:5`). `tool_call` (`houge-policy.ts:84-102`) gates `read`/`edit`/
  `write` by path through a bridge `gate` and blocks every other tool not in `registered` and the manifest
  (`tool_not_allowed`). `tool_result` (`:103-108`) sends a `report` with outcome, bytes and duration for built-ins only;
  **the content is never sent or judged**. There is no `session_stop`, `judge_read` or `judge_timeout` anywhere in `src`.
- **Bridge** (`bridge-protocol.ts:1-7`): kinds `hello`, `manifest`, `call`, `gate`, `report`. `bridge-client.ts:28-29`: a
  request has **no timeout**; it fails only on socket error or close. `bridge-handler.ts:133-138` dispatches; `call` and
  `gate` are memoised per `toolCallId`; `handleReport` (`:520`) writes the built-in outcome row from `turn.unreported`.
- **Injection judge**: `judged()` (`bridge-handler.ts:349`) over `InjectionSource = shell | web_search | http_fetch |
  gmail_read | google_api` (`injection-judge.ts:23`); `raiseFor` (`:377`) maps a judgement to trust causes
  (`injection_withheld` → hostile; `unjudged_local` (framed) → untrusted; `judge_timeout` → untrusted).
- **Supervisor** (`planner-supervisor.ts`): `settlesTurn` (`:256`) = aborted ∨ `isTerminal !== false` ∨ async-only;
  `Turn` (`:163-208`) keeps `lastText` only (`onAssistant`, `:1232`), has no send-back flag; `parseAttachments` runs once
  on `lastText` in `finishSuccess` (`:1331`). RPC commands (`planner-session.ts:80-110`): `open_session`, `prompt`,
  `steer`, `abort`, `set_model`, `set_thinking_level`, `new_session`; no `get_state`.
- **omp config** (`planner-supervisor.ts:149-152`, `HOUGE_CONFIG_YML`, written to `<data>/omp/houge-config.yml`,
  protected at `protected-paths.ts:130`): no `todo.*` key; `--tools read,edit,write` (`planner-session.ts:18-19`).
- **omp 18.10.4 types** (`@oh-my-pi/pi-coding-agent/dist/types`): `session_stop` handler with `SessionStopEvent
  { messages, turn_id, last_assistant_message?, stop_hook_active, signal }` and `SessionStopEventResult { continue?,
  additionalContext? }` (`extensibility/shared-events.d.ts:95-105, 395-404`); `ToolResultEventResult { content?, details?,
  isError? }` (`:314-320`); settings `todo.enabled`, `todo.reminders`, `todo.remindersMax`, `todo.eager`
  (`tools/settings.d.ts:20-23`), with `todo.enabled` among the session tool gates (`:102, :128`); RPC `get_state` returning
  `todoPhases: TodoPhase[]` (`modes/rpc/rpc-types.d.ts:81, 346, 582, 648`; `TodoPhase { name, tasks: TodoItem[] }`).
- **Ledger events** usable as settle evidence (`run-ledger.ts`): `tool_finished` (with `tool`, `status`, `tool_call_id`),
  `lesson_saved`, `fact_saved`, `external_work_published`, `approval_resolved` (`decision: denied | expired`).
- **Outcomes**: `decision_outcomes` rows need a value check per signal (`outcomes.ts:28-34`); `settle_sent_back` has
  `null`, so inserting it throws today.

## 2. Extension and bridge contract

### 2.1 New bridge kinds

All three are validated and authenticated like the five existing kinds (`bridge-handler.ts:124-126` style checks;
unknown fields refused; `hello` token required). `judge_read` and `settle` are memoised per id exactly as `gate`/`call`
are (`memo(turn, …)`), so a replayed request never double-judges or double-sends-back.

| Kind | Request | Reply |
|---|---|---|
| `judge_read` | `{ id, kind, toolCallId, text }` — the canonical read text, ≤ 32 KiB | `{ verdict: "unchanged" }` or `{ verdict: "rewritten", text }` |
| `judge_timeout` | `{ id, kind, toolCallId }` — sent without awaiting the reply | `{ ok: true }` |
| `settle` | `{ id, kind, turn_id, stop_hook_active, text }` — omp's `last_assistant_message` text, ≤ 32 KiB | `{ sendBack: false }` or `{ sendBack: true, note }` |

`report` gains `applied: boolean`: true only when the `judge_read` reply arrived inside the extension's timer and was
applied to the result. A `report` without `applied` (an old extension) is treated as `applied: false`.

Frame size: a `judge_read` or `settle` line is at most 32 KiB + envelope, inside `MAX_BUFFERED` (16 MB).

### 2.2 `tool_result` for `read`

`edit` and `write` keep today's bare `report`. For `read`:

1. Build one canonical text from `content` (text blocks joined; images untouched), capped at 32 KiB with the truncation
   note `[truncated by Houge at 32 KiB]`.
2. Set **both** `content` (one text block) and `details.displayContent` to the canonical text **before** asking, so what
   is judged is exactly what is shown (parent §7.1 step 1; probe P1 confirms `displayContent` is still the shown field
   on 18.10.4).
3. Send `judge_read`. On `rewritten`, replace both fields with `text`.
4. Send `report` with `applied: true` when step 3 completed inside the timer, else `false`.

On timer expiry or a bridge error in step 3: apply the **phrase floor locally** (§2.4), send `judge_timeout` without
awaiting it, send `report { applied: false }`, return the floored fields. The model never sees raw text past a failed
judge; it sees the floored text at once (never waits for omp's 30 s hook limit).

### 2.3 `session_stop`

Registered beside `tool_call` and `tool_result` (`PiLike.on` type widened). Handler:

- `stop_hook_active === true` (omp's second fire after a continuation): return `undefined`. Houge's own per-turn flag
  (§3.4) is the first net; this is the second.
- Otherwise send `settle { turn_id, stop_hook_active, text }`, with `text` from `last_assistant_message` (text blocks
  joined, capped 32 KiB; empty when absent).
- `{ sendBack: true, note }` → return `{ continue: true, additionalContext: note }`.
- `{ sendBack: false }`, timer expiry, bridge error, or `event.signal` aborted → return `undefined` (the turn settles as
  today). Fail open.

### 2.4 Timers and the floor copy

`bridge-client.ts` `request(msg, opts?: { timeoutMs })`: a per-request timer that rejects with `bridge_timeout` and
removes the pending entry; a reply arriving later is dropped. `judge_read` and `settle` use 5 000 ms (`JUDGE_READ_TIMEOUT_MS`,
`SETTLE_TIMEOUT_MS`), under omp's 30 s hook bound (probe P4). `gate`, `call`, `report`, `manifest` keep no timeout
(unchanged behaviour).

The extension imports nothing from Houge (`houge-policy.ts:1`), so the phrase floor ships as a copy:
`src/omp/extension/injection-floor.ts` exporting the phrase list and `applyFloor(text): string`, which replaces each
passage matching a floor phrase with the same withheld note Houge's floor renders. A test asserts the extension's list
and note equal `injection-judge.ts`'s (`tests/omp/extension/injection-floor.test.ts`), so the two cannot drift silently.

### 2.5 `todo` in the extension

`BUILTIN_TOOLS` gains `todo`: allowed with **no** `gate` request (no path, no body that leaves the machine), a bare
`report` on result (counts only). Every other unregistered tool stays blocked `tool_not_allowed`.

## 3. `turn.settle`

### 3.1 Entry (`src/decisions/entries/turn-settle.ts`, protected)

| Field | Value |
|---|---|
| id, version, stage | `turn.settle`, 1, `settle` |
| input | `mixed` (the reply is model text; the evidence is code) |
| verdicts | `settle` < `send_back` (monotone: more verification, never a shorter reply) |
| ladder | rule (`settle-judge` claims and todo checks) → `system_one` (`DecisionPoint` `settle`, provisional bar 0.5, 1 500 ms) → `settle` |
| fail, defaultVerdict | `settle` |
| alwaysRecord | true |
| effects | `send_back` from the rule rung: `tighten` under normal gates; from the Jev rung: `tighten` with `settleAsk` (§3.3) |
| outcomes | `settle_sent_back` (value: the reason code), `review_*` from the digest |
| reasonCodes | `hostile`, `already_sent_back`, `last_call_denied`, `steer_queued`, `deadline_short`, `aborting`, `claim_scheduled`, `claim_saved`, `claim_attached`, `claim_sent`, `todo_pending`, `jev_claims_done`, `jev_unverified`, `jev_promise`, `jev_asks_permission`, `budget`, `settled` |

`ENTRY_IDS` gains `turn.settle`; `DecisionPoint` gains `settle`; `outcomes.ts` gives `settle_sent_back` a value check
(one of the reason codes above).

### 3.2 Code before any rung: never send back when

Checked in this order by the supervisor before the entry runs; each writes a `settle` row with its reason code:

1. the turn's trust level is `hostile` (it already asks for everything risky);
2. the turn already sent back (`Turn.sentBack`);
3. the last tool call of the turn was denied or expired (`approval_resolved` with `denied` / `expired` as the newest
   tool event, or a `gate` deny as the newest built-in outcome);
4. a steer is queued for this turn (the supervisor's steer queue is non-empty for the run);
5. under 60 s of the turn's deadline remains (`deadlineAt - now < 60_000`);
6. an abort is in progress (`Turn.aborting`).

### 3.3 Rungs

**Rule rung** (`src/omp/settle-judge.ts`, glue outside the protected directory, as `src/jev/tree-policy.ts` is):

- *Claims check.* A fixed verb list, zh and en, each mapped to evidence in this run's ledger events:

  | Claim | Verbs | Evidence |
  |---|---|---|
  | scheduled | scheduled, 已安排, 已设置提醒, 安排好了 | `tool_finished` `succeeded` for `schedule_task` |
  | saved | saved, remembered, 已保存, 记住了, 记下来了 | `lesson_saved` or `fact_saved`, or `tool_finished` `succeeded` for `lesson_write` |
  | attached | attached, 附上, 已附 | an `[[attach:]]` line in any pass of this turn |
  | sent | sent, 已发送, 发出去了 | `external_work_published`, or `tool_finished` `succeeded` for a capability whose kind is `external_write` |

  A verb match requires the claim form (first person, past: "I scheduled", "已安排"), not a negation ("I could not
  schedule", "没有安排"). The list is code-owned, tested per verb with and without evidence, in both languages. A claim
  with no evidence → `send_back`, reason `claim_<kind>`, and the note names the missing call.
- *Todo check.* `get_state.todoPhases` (§5) compared with the snapshot taken before the prompt: when the list changed
  during this turn **and** holds a task with status `pending` or `in_progress` → `send_back`, reason `todo_pending`,
  the note listing the open items (names only). A failed or slow `get_state` records `fail` on this check and the other
  checks decide.

A rule-rung send-back runs its continuation under the turn's normal gates (parent §4.1: code rungs may cause effects).

**Jev rung** (`src/jev/settle-ask.ts`, its own request, like `memory-kind-ask.ts`): four `noul` questions on the reply
text (plus a code-built one-line tool summary: the tools called this turn and their outcomes), one request, bar 0.5:

1. Does the reply claim the task is done?
2. Did the assistant act or edit but verify nothing?
3. Does the reply end on a promise of further work ("next I'll…")?
4. Does the reply ask permission for work Paco already asked for?

Any question with p > 0.5 → `send_back` with its reason code; all four below → `settle`. All-or-nothing answer
validation as `jev-client.ts:196-202`; a missing or malformed answer is `fail` on this rung (→ `settle`). A Jev-rung
send-back sets `Turn.settleAsk = true`: for the rest of the turn every side effect asks (the ask path `turn.trust`
uses at `hostile` for writes, external writes and off-list shell, applied without changing the trust level). ADR 0030's
R12 holds: a Jev verdict over mixed input causes one more pass with every effect asking, never a tap-free action.

**Budget.** Houge answers `settle` within 4 000 ms (`SETTLE_BUDGET_MS`): ledger read, `get_state` (1 s), Jev (1.5 s).
On overrun the reply is `{ sendBack: false }` and the row is `fail` with reason `budget`. Fail open.

### 3.4 The note, the passes, and the reply

Note (code-owned, English): `<reason line>` then `Your reply will replace the previous one: restate your complete final
answer. Do not start a step that needs Paco's approval; say what is pending.` Reason lines: `You said you scheduled it,
but no schedule_task succeeded this turn.`, `You said you saved it, but nothing was saved this turn.`, `You said you
attached a file, but no [[attach:]] line was given.`, `You said you sent it, but no send succeeded this turn.`, `Your
todo list still has open items: <names>.`, and for the Jev rung `Your reply reads as unfinished: <question>.`

Supervisor (`planner-supervisor.ts`, protected):

- `Turn.texts: string[]` holds every non-empty assistant text of the turn in order (`onAssistant` appends); `lastText`
  becomes the last element.
- `Turn.sentBack: boolean`, `Turn.settleAsk: boolean`, `Turn.todoBefore: TodoPhase[] | null`.
- `finishSuccess` parses attachments from **every** pass and de-duplicates by path; a first-pass attachment survives a
  complete second-pass restatement.
- **Code fallback** (parent senior #1): if the final pass's text is empty or shorter than a third of the first pass's
  length, Paco's reply is the first text, a blank line, then the final text.
- The turn still settles on one terminal `agent_end` (2a P7 rule, unchanged): omp's continuation is inside the same run.
- A continuation that **still** fails the claims check settles anyway (once-only) and queues the urgent card
  "⚠️ Settled unverified" through the outbox (parent §8.2) with the reason; the row's reason is `already_sent_back`.
- An abort during the second pass: `texts` already holds the first pass; the abort path delivers it as today's abort
  path delivers `lastText`.

### 3.5 Recording

Every settle writes one `decisions` row (`alwaysRecord`), linked by `run_id`; a send-back also writes a
`decision_outcomes` row `settle_sent_back` with the reason code (source `code`). `/status decisions` shows the rows;
the digest's unsure list includes Jev settle answers within 0.15 of 0.5 when the digest is on.

## 4. `judge_read`

- `InjectionSource` gains `read`, label "a file the assistant read". `handleJudgeRead` (`bridge-handler.ts`) runs
  `judged(deps, turn, toolCallId, "read", text, { outside: false, paths: [gatedPath] })`: the same floor, content check,
  path deny-list, redactor and passage split as shell; a withheld passage → `hostile`, a framed passage → `untrusted`
  (local read), a lost judgement → `untrusted`, as `raiseFor` does today. Houge re-caps `text` at 32 KiB.
- Only a `toolCallId` the gate allowed is accepted (`turn.unreported` holds it, `FsEntry` `fs_read`); any other is refused
  `unknown_call` and logged. Memoised per call.
- **Pending judge state.** `ActiveTurn.judgePending: Map<toolCallId, { since: number; done: boolean }>` is set at `gate`
  for `read` and cleared by `report { applied: true }`. The turn is raised with cause `judge_timeout` (→ `untrusted`)
  when: a `judge_timeout` request arrives for the call; its `report` arrives with `applied: false`; any later bridge
  request from the turn (`call`, `gate`, `settle`) finds a read pending longer than 5 000 ms without `applied: true`
  (parent senior round 5 W24: later calls never run under `clean` gates); or a read is still pending at
  `flushUnreported`, before `trust.finalize()`.
- **Late verdict** (2b-R5): if `judged()` completes after the call was marked timed out (`judge_timeout` or
  `applied: false` seen first), the `tool.injection` row is written with `armed_mode: late`, the rewrite is not returned
  as applied (the floor already reached the model), and the trust raise follows the judgement's own outcome.
- `edit` and `write` results stay unjudged; their `report` is unchanged.
- Volume: about 6 built-in reads a day on the DB copy (parent P5); within the TypeSafe bound at 10×.

## 5. The todo tool

- `HOUGE_CONFIG_YML` gains `todo: { enabled: true, reminders: false, eager: "default" }`. Probe P3b decides whether
  `--tools read,edit,write` must also list `todo` (omp's `cfgSessionToolGates` suggests the setting alone adds the tool;
  the probe, not the type, decides). No Houge prompt text about todos is added.
- `planner-session.ts` gains the RPC command `get_state` returning the wire frame's `todoPhases` (and `isSettled`,
  unused here); bounded at 1 000 ms (`GET_STATE_TIMEOUT_MS`); a timeout rejects with a fixed code, never omp's text.
- The supervisor calls it once before `prompt` (snapshot `Turn.todoBefore`; a failure leaves `null`, which disables the
  todo check for this turn and records nothing) and once inside the settle decision.
- A `todo_reminder` frame reaching the supervisor is logged (`todo_reminder_seen`) and counted as a gate failure: with
  `reminders: false` none may appear. No reminder text is ever rendered to Paco.
- `tasks.todoClearDelay` and `todo.remindersMax` stay at omp's defaults.

## 6. Probes before code (the spec review runs these on omp 18.10.4)

| # | Question | Pass |
|---|---|---|
| P1' | `tool_result` for built-in `read` in RPC mode: fires, awaits an async handler, applies `content` and `details.displayContent` rewrites; `displayContent` is the shown field | both fields show the rewritten text in the RPC `tool_execution_end` frame |
| P2' | `session_stop`: fires once on a terminal stop; `{continue:true, additionalContext}` runs one continuation inside the same `agent_end`; the second fire carries `stop_hook_active: true`; `signal` aborts on `abort` | frame capture becomes a supervisor fixture, as P7's did |
| P3' | RPC `get_state` answers while a `session_stop` handler is awaiting (the todo check runs inside the hook) | `todoPhases` returned within 1 s mid-hook |
| P3b' | `todo.enabled: true, reminders: false` in the `--config` overlay: the planner has the tool; a pending item produces no `todo_reminder` frame; whether `--tools` must list `todo` | recorded; picks the §5 form |
| P4' | hook bounds on 18.10.4: `tool_result` and `session_stop` fail open at 30 s | unchanged, or the 5 s timers are re-derived |

## 7. Gate, tests, rollback, docs

**Schema.** No migration. New rows only (`decisions` `turn.settle`, `tool.injection` source `read`,
`decision_outcomes` `settle_sent_back`). Rollback check (`scripts/check-ladder-2b-hooks-rollback.mjs`): the previous build
boots on a DB copy holding those rows, and its digest and `/status decisions` render them without throwing.

**Golden set.** `turn.settle` joins the daily sweep: four replies with planted unsupported claims or promises (expect
`send_back`) and four clean replies (expect `settle`), their own audit role, drift pages
`decision_golden_drift:turn.settle` and never disarms (R13).

**Pre-merge sanity** (`scripts/settle-sanity.mjs`, parent §4.2): the last 30 days' planner replies with their ledger rows
from a DB copy through both rungs (real Jev). PASS at ≤ 10% send-backs; it prints 20 sampled send-backs with reasons,
and Paco's read of them is recorded in the build ledger before merge.

**Live gate** (`scripts/live-gate-ladder-2b-hooks.mjs`; real omp, real Jev, DB copy; exit 0 PASS / 1 FAIL / 2 setup /
3 INCONCLUSIVE; a skipped Jev call is INCONCLUSIVE, never PASS):

1. a planted file past 32 KiB with an injection after the cap: both fields show the truncated, withheld text; turn `hostile`;
2. a bridge that delays `judge_read` past 5 s: the model saw the floored text; `judge_timeout` row; turn `untrusted`;
3. a reply claiming "scheduled" with no `schedule_task`: sent back exactly once; the second pass replaces; a first-pass
   `[[attach:]]` survives;
4. abort mid-second pass: Paco receives the first pass's text;
5. once-only: a second pass that still claims settles and the "Settled unverified" card is queued;
6. todo: a pending item added this turn → `todo_pending` send-back; a list unchanged since the previous turn → no
   send-back; no `todo_reminder` frame in either;
7. a `hostile` turn, and separately a turn with a queued steer: no send-back, reason recorded;
8. a settle past Houge's 4 s budget (injected delay): `{ sendBack: false }`, row `fail` `budget`;
9. golden set: 8 of 8.

**Unit tests** (`tests/` mirroring `src/`): extension hooks with a fake bridge (timers, `applied`, floor on timeout,
`stop_hook_active`, `signal`), floor copy equality, bridge handler (`judge_read` refusal and memoisation, pending-read
raises on later requests and at flush, late verdict), `turn-settle` entry shape and ladder, `settle-judge` (every §3.2
rule; every verb with and without evidence, zh and en; negations; the changed-list todo rule), `settle-ask` parsing,
supervisor (`texts[]`, attachments across passes, the one-third fallback, `settleAsk` asking on each effect kind, the
P2' fixture settling exactly once), `planner-session` `get_state`, golden items, outcomes value check.

**Docs on ship:** ADR 0030 amendment (Paco's hand): `turn.settle` armed at a provisional 0.5, `read` as a judged source,
`armed_mode: late`, `settleAsk`, the todo tool; `docs/reference/decision-map.md` (`turn.settle` live; `improve.route`
→ 2b-ii); `docs/reference/jev-decision-layer.md` (new point and bar); README row; `tasks/todo.md` state block;
`tasks/lessons.md`; `sessions.md`; ROADMAP delta. `configuration.md` is unchanged: no new env var, and R13 forbids an
off switch.

**Protected files (Paco's merge):** `src/decisions/` (`entries/turn-settle.ts`, `entry-ids.ts`, `registry.ts`,
`injection-judge.ts`, `trust.ts` if a cause is added, `golden.ts`, `outcomes.ts`), `src/jev/decide.ts`,
`src/omp/extension/*`, `src/omp/bridge-handler.ts`, `src/omp/bridge-protocol.ts`, `src/omp/planner-supervisor.ts`,
`src/omp/planner-session.ts`, `docs/decisions/0030-decision-ladder.md`.

## 8. Risks

| Risk | Mitigation |
|---|---|
| omp 18.10.4 hook semantics differ from 18.7.0 | P1'–P4' before code; fixtures from the real frames |
| Send-backs annoy more than they fix | once per turn; ≤ 10% on 30 days' replies; Paco reads 20; every row reviewable; `improve.route` (2b-ii) measures `settle_sent_back` against corrections |
| The todo tool changes planner behaviour on simple turns | `todo.eager: default`; reminders off and gated; the check fires only on a list changed this turn; `/status decisions` shows `todo_pending` rows |
| A judged read slows every file read by up to 5 s on a Jev outage | the extension floors at 5 s and continues; the outage opens the existing Jev incident |
| `settleAsk` after a Jev send-back blocks a scheduled turn's writes | scheduled runs keep their 10-minute deadline and the trust-card TTL rules; a card that cannot wait is refused as in 2a |

## 9. Revisit when

- the send-back rate on the DB copy exceeds 10% for 14 days (lower the Jev questions to the code rung only);
- `turn.settle`'s golden set drifts twice in 30 days;
- omp emits a settle verdict event of its own (ledger it instead of asking Jev);
- `improve.route` (2b-ii) shows `settle_sent_back` rows never followed by a correction in 30 days (the check is paying
  for nothing: revisit the bar).
