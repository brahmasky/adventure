# Decision ladder, remainder slice R2 — `intake.sender` and `turn.contract` on the ladder (Rev 1.2)

**Status:** **APPROVED by Paco 2026-11-01: Decisions 1-B, 2-A, 3-A.** Rev 1.2 — codex scoped re-review of Rev 1.1: every prior finding closed (crash window open by explicit acceptance), one new blocker (fuse-call count) and one warning (call order in the block), both applied. Rev 1.1 — after the senior review (Sonnet 5.5; Fable rate-limited, 429; probed source, `decide.ts` semantics and the live DB read-only: 0 blockers, 5 warnings, 5 suggestions) and the codex design pass (2 blockers, 4 warnings, 1 suggestion), every finding verified first-hand and applied (§Rev 1.1 changes).
**Date:** 2026-11-01
**Amends:** `docs/ROADMAP.md` (the remainder line); ADR 0030 gets an amendment row (drafted under the approved spec, awaiting Paco's signature).
**Depends on:** ADR 0030 §4.1 (entry), §6.1 (inventory rows A1, A7), §6.2 (move, don't improve); ladder design `docs/superpowers/specs/2026-10-12-decision-ladder-design.md` §6.1 (`:366`); remainder slice R1 (`2026-10-30-ladder-remainder-r1-gateway-intake-design.md`, shipped `0a8d294`) for the pattern, §2 (the re-walk and seam order, Decision 1-A), the stamped merge-base differential, the whole-DB dump and the rollback check.

## 1. Goal

Put the two remaining pre-run rows on the registry as rule-only entries that **record and never steer**:

- `intake.sender` (A1, **locked**): the Telegram sender allowlist, forward refusal and channel-post refusal, for messages and button taps;
- `turn.contract` (A7): the task-contract compile — a refusal, or a contract whose envelope a schedule-born turn narrows.

Each wraps today's code unchanged; the raw answer keeps driving the branch (Stage 4B ruling R1). Proof: the stamped merge-base differential, extended with two corpora, zero behaviour differences.

The probe for this spec also found a pre-existing defect on the same seam (a `/run` with an unknown program wedges Telegram intake, §3.3). It is not this slice's change; Decision 2 places its fix.

## 2. Scope

In: the two entries, their recorder seams (the Telegram long-poll adapter's options; `Gateway`'s existing lazy recorder), a reason enum beside each existing error, two differential corpora, a live gate, a rollback check.

Out: every other remainder id (R3–R7, R1 §2); any change to who is allowed, what a contract contains, or any reply; the `channel_post` pre-check's position (it stays ahead of the callback branch, `telegram-trigger-adapter.ts:105`; "move, don't improve").

## 3. Live facts (`main@0a8d294`, read first-hand by the orchestrator)

### 3.1 `intake.sender` (A1)

**Three denial origins, one result code.**
1. `normalizeTelegramUpdate` (`telegram-trigger-adapter.ts:101`): `update.channel_post` → `TELEGRAM_AUTH_DENIED` "Channel posts are not accepted" (`:105`), before any auth call.
2. Message path: `authorizeTelegramUpdate` (`:123`), evidence `from_id`, `chat_id`, `is_forwarded` (`forward_date` or `forward_origin`), `is_channel_post: false`. Runs **before** text/media resolution, so a stranger's bare photo is denied, never acknowledged (comment `:118–122`).
3. Callback path: `normalizeCallbackQuery` → `authorizeTelegramUpdate` (`:258`), `is_forwarded: false`, `is_channel_post: false`.

**The check** (`triggers/telegram-auth.ts:14–31`), first match wins: channel post, forwarded, no `from_id` (anonymous), no `chat_id`, user not in `allowlist.users`, chat not in `allowlist.chats`, the user's identity not in the chat's `allowed_identity_ids`. Each denial is `{ ok: false, error: { code: "TELEGRAM_AUTH_DENIED", message } }`; the reason lives only in the message string today.

**What a denial does** (`createTelegramLongPollingAdapter.pollOnce`, `:604–631`): `recordSkippedTelegramUpdate({ update_id, reason_code: error.code, reason_message: error.message, skipped_at })`, offset to `update_id + 1`, `skipped += 1`; no acknowledgement (only unsupported-media and invalid-command results carry one); `emit` is never called, so the gateway never sees the update. Silence to a stranger is the invariant.

**Callers.** `pollOnce` has two constructors: `telegram/telegram-poll-runner.ts:162` and `telegram/telegram-daemon.ts:231`, each passing a store-backed `skippedUpdateStore`. `normalizeTelegramUpdate` has a third caller, `eval/eval-runner.ts:160` (parser-auth eval cases), which records nothing and stays untouched.

**Protection.** Neither `triggers/telegram-auth.ts` nor `triggers/telegram-trigger-adapter.ts` is in `PROTECTED_FILES` (`capabilities/self-write-guard.ts:76`); `src/decisions/` is a protected dir (`:72`). Decision 3.

**Reachability.** `no_chat` cannot come from the adapter with a real Telegram update (the message path reads `message.chat.id` before the call, `:125`; `chat` is always present); it is tested at `authorizeTelegramUpdate` directly. Auth order fixes precedence: a stranger's forward records `forwarded`, not `user_not_allowlisted`.

**Live traffic** (read-only query of the live DB, 2026-11-01): `skipped_telegram_updates` holds **one** `TELEGRAM_AUTH_DENIED` row in its whole history (2026-10-18) and 7 `TELEGRAM_COMMAND_INVALID`.

### 3.2 `turn.contract` (A7)

**One call site.** `Gateway.handleTaskIntake` (`gateway.ts:1093`) → `compileTaskContract(event)` (`contracts/task-contract.ts:19`, a protected file) at `:1094`, then the budget fuse (`:1102`), then `createOrGet` (`:1140`), then `attachAndQueue` (`:1166`). `handleTaskIntake` is reached from the end of `intake` (`:311`), the rating `forward` path (`:302`), and `admitMemLaneAsk` inside its transaction (`:1210`).

**The compile** branches on `event.type`: `ask` → `compileAskContract`; `turn` → `compileTurnContract` (`:155`); `run` → `research-brief` / `web-research`; anything else → refusal. Refusals (`TASK_CONTRACT_INVALID`, `:8`): empty goal ("Message is required", "Goal is required", "Question is required"), unknown `/run` program ("Unknown program: …"), an `ask` with a foreign program, an unsupported type. The gateway returns `{ ok: false, error: contract.error }` (`:1096`) with no audit row and no reply.

**The one path-changing branch of a successful compile:** a turn born from a schedule fire (`event.source === "schedule"`) loses `schedule_task` from `allowed_actions` (`task-contract.ts:166`; the 2026-07-19 duplicate-schedule incident). Everything else in the envelope (budget 10 min / 40 calls, gates, forbidden list) is a constant: mechanics. The compiled contract is already stored on the run with its `contract_hash` (inventory A7).

**Live traffic** (live DB, 30 days): every run is `type: "turn"`: 121 Telegram, 58 scheduled (~2 a day).

**Replays and fuse cycles.** A scheduled fire re-intakes the same occurrence on every poll cycle while the fuse holds (`schedule-tick.ts:128–138` leaves `next_run_at` untouched; `maybeFireScheduledTasks` runs each cycle, `telegram-daemon.ts:679`), and a crash replay re-intakes it as a `duplicate`. The compile runs before both checks, so a row written at the compile would repeat once per cycle per due schedule for the whole fuse episode. §4.2 places the row after `createOrGet` for that reason.

### 3.3 A pre-existing wedge on this seam (not caused by this slice)

`/run nosuch x` from Paco parses (`telegram-command-parser.ts:91–97` checks only that a program and a goal exist), reaches `handleTaskIntake`, and returns `TASK_CONTRACT_INVALID` — confirmed on `dist/` at `0a8d294` with a scratch store (`{"ok":false,"error":{"code":"TASK_CONTRACT_INVALID","message":"Unknown program: nosuch"}}`). `TASK_CONTRACT_INVALID` is not in `HANDLED_INTAKE_DENIAL_CODES` (`telegram-poll-runner.ts:45–67`), so both the poll runner (`:209`) and the daemon (`telegram-daemon.ts:308`) throw `Gateway intake failed`; the offset never advances and Telegram redelivers the update every cycle — the 2026-10-01 shape the 2026-10-28 lesson names ("a new denial code must also join the poll loop's handled-denial set"). A scheduled turn with an empty goal hits the same refusal through `schedule-tick.ts`, which retries and parks the schedule after three (not a wedge). Decision 2.

## 4. The entries (pattern: R1's `intake-budget-fuse.ts` locked, `intake-rating-reply.ts` unlocked)

Both: `version: 1`, one `rule` rung, `armed: { rule: "on" }`, `outcomes: []`, no Jev or model rung, no `alwaysRecord`. A row's content is `rowOf` (`decisions/record.ts:63–69`): entry id and version, run and tool-call id, stage, rung, verdict, reason code, fallback fields, armed mode, latency, time — **no input payload**, so no sender id, chat id, goal text or program name is ever stored.

### 4.1 `intake.sender` (locked)

- `stage: "intake"`, `input: "tool"` (Telegram's metadata about a possibly foreign sender, not Paco's words), `locked: true` (in `LOCKED_ENTRY_IDS` since stage 1, `entry-ids.ts:14`); verdicts `allow | deny`; `defaultVerdict: "allow"`; `fail: "deny"`.
- Input `{ denied: SenderDenialReason | null }`; the rule maps a reason → `deny` with that reason, and throws on `null` (below). `allow` is only ever the default, never a rule answer.
- `reasonCodes` (= `SenderDenialReason`, in check order): `channel_post`, `forwarded`, `anonymous`, `no_chat`, `user_not_allowlisted`, `chat_not_allowlisted`, `identity_not_for_chat`.
- Effects: `allow` none; `deny` `tighten`, reversible, announced none (silence is the invariant, §3.1).
- **The reason.** `denied()` in `telegram-auth.ts` gains the reason as an argument and returns it **beside** `error` — `{ ok: false, error: { code, message }, reason }` — and the `:105` channel-post pre-check returns `reason: "channel_post"` the same way. `error`'s code and message stay byte-identical, so `skipped_telegram_updates` rows do not change. The reason is optional on `TelegramNormalizeResult`'s failure variant; only `TELEGRAM_AUTH_DENIED` failures carry it.
- **Seam.** `TelegramLongPollingAdapterOptions` gains `decisionRecorder?: DecisionRecorder` (beside `skippedUpdateStore`). Both constructors pass `storeRecorder(options.store)` (no `env` option, as in R1: a `decision_record_failed` alert pages `process.env.HOUGE_TELEGRAM_CHAT_ID`; its incident `detail` is `{ entry }` only, `record.ts:75`). `normalizeTelegramUpdate` stays pure; `eval-runner.ts` is untouched.
- **Call site: one.** In `pollOnce`'s `!normalized.ok` branch, when `normalized.error.code === "TELEGRAM_AUTH_DENIED"` and a recorder is set: `decideSync(INTAKE_SENDER, { denied: normalized.reason ?? null }, { run_id: null, tool_call_id: null, recorder })`, **after** `recordSkippedTelegramUpdate` and the offset advance. Reason for after: the skip row and the offset are the durable truth that keeps the loop moving (a stranger's update must never be redelivered); the decision row is an audit of a decision already made. `decideSync` never throws (§4.3), so it cannot skip the acknowledgement block that follows (which a denial never reaches anyway). A crash between the offset write and the row loses the row, never the denial. **A missing reason never records `allow`:** the entry is consulted only on a denial, so the rule throws on `null`; `decide.ts`'s `safeRule` catches it and the runner writes `deny` at rung `fail`, `fallback_reason = "threw"`, `reason_code` null — loud (logged, and it counts toward `decision_fallback`, which pages at 3 an hour; `intake.sender` is not in `JEV_PAGED_ELSEWHERE`) rather than an `allow` row for a refused sender. The plan adds a test that every `TELEGRAM_AUTH_DENIED` the adapter can produce carries a reason (the seven auth branches + the pre-check), and `denied()` takes the reason as a required argument.
- An allowed sender is never consulted (the update proceeds to `emit`); no row, no call. Positive evidence that the allowed path ran is the emitted event (§6).

### 4.2 `turn.contract`

- `stage: "pre_model"` (the first `pre_model` row with a null `run_id` — the refusals), `input: "tool"` (the rule reads the event's type, source and the compiled contract, never the goal's words); verdicts `compile | restrict | refuse`; `defaultVerdict: "compile"`; `fail: "refuse"`.
- Input `{ refused: ContractRefusal | null; restricted: boolean }`. Rule: a refusal → `refuse` with its reason; else `restricted` → `restrict` / `schedule_born`; else `compile`.
- `reasonCodes`: `schedule_born`, `goal_missing`, `unknown_program`, `unsupported_type`.
- Effects: `compile` none; `restrict` `tighten`, reversible, announced none; `refuse` `tighten`, reversible, announced none.
- **The reason.** `invalid()` in `task-contract.ts` gains the reason as a required argument and returns it **beside** `error` (`{ ok: false, error, reason }`); every refusal names one — all seven `invalid(` sites (`:28`, `:37`, `:42`, `:61`, `:157`, `:186`, `:188`), enumerated by the plan's totality test: empty goal/message/question/topic → `goal_missing`; unknown or foreign program (`run`, `ask`) → `unknown_program`; unsupported type → `unsupported_type`. `handleTaskIntake` keeps returning `{ ok: false, error: contract.error }`, so `GatewayIntakeResult` is byte-identical.
- **`restricted` is read off the raw answer**, not re-derived from the event: `event.type === "turn" && !contract.allowed_actions.includes("schedule_task")` (`TURN_ACTIONS` contains it, `task-contract.ts:147`). If the strip ever moves, the row follows the contract the run actually got.
- **Call sites: two.**
  1. Refusal: at `:1095`, before `return { ok: false, … }`, `run_id: null`.
  2. Compile / restrict: on a fresh run only (`createOrGet` → `created`), as the **first** statement of the `if (queued.ok)` block, ahead of `recordGlobalBudgetRun`, `disarmGlobalFuse` and `recordTelegramAccepted` (`gateway.ts:1168–1180`; a throw from any of those cannot then cost the row), with `run_id: created.run_id`. Reason (§3.2): one row per admitted, queued run, linked to it; a fuse cycle (refused at `:1102`, before `createOrGet`), a `duplicate` (returns at `:1154`), a `conflict`, and a failed attach (`CONTRACT_ATTACH_FAILED` / `RUN_TRANSITION_FAILED`) write nothing. A `compile` verdict is consulted and records nothing (default, `shouldRecord`, `record.ts:28`); the injected counting recorder sees the call (§6).
  **Accepted loss (crash window):** a crash after `createOrGet` and before the row leaves the run without one; the replay arrives as `duplicate`, `resumeDuplicate` (`:1368–1376`) attaches and queues it, and no row is written. The row is an audit; the run's `contract_json` stays the truth. Inside `admitMemLaneAsk`'s transaction the row commits or rolls back with the run.
- **Recorder seam.** `Gateway`'s lazy recorder (`:153`) is private with no injection, so a call that writes no row cannot be counted. The constructor's `options` gains `decisionRecorder?: DecisionRecorder`; when absent, the lazy `storeRecorder(this.runStore)` as today (both production constructors pass none). The differential and the gate inject a counting wrapper over `storeRecorder`.
- **Volume:** `restrict` ~2 rows a day (58 scheduled runs in 30 days); `refuse` near zero (none in 30 days; but see §3.3: until the wedge is fixed, a wedged `/run` would write one `refuse` row per poll cycle — Decision 2).
- Not consulted for control commands or taps (they never reach `handleTaskIntake`).

### 4.3 Failure behaviour (R1 §4.4 carried over)

(a) the store insert fails inside `storeRecorder` → `decision_record_failed` opens, and `openAlertedIncident` enqueues **one alert row to the operator chat** (`HOUGE_TELEGRAM_CHAT_ID`) — the stated delta since stage 1, the only outbox change any fault may make; (b) a recorder that throws past itself → `decideSync` catches and logs, no incident. Neither changes the normalize result, the skip row, the offset, the intake result, the run, its contract, the ledger, or any other outbox row; nothing is ever addressed to a denied sender's chat.

## 5. What does not change

- Who is admitted. Every `TelegramNormalizeResult`'s `error` (code and message), every `skipped_telegram_updates` row (it stores code and message only, `:613`), every offset advance, and the absence of any reply or acknowledgement to a denied sender — byte-identical. A denied update still never reaches `emit` or the gateway.
- Every `GatewayIntakeResult` (the gateway returns `{ ok: false, error: contract.error }`, so the sibling `reason` never leaves it), every compiled contract and `contract_hash`, every run row, ledger event and outbox row, and their order. **In-memory shapes do change:** the denied `TelegramAuthResult` / `TelegramNormalizeResult` and the refused `TaskContractResult` gain `reason` (`if (!auth.ok) return auth;` passes it through, `:134`, `:258`). Their only consumers are `pollOnce`, `eval-runner.ts:166` (reads `error.code` only), the gateway and tests; the four exact-shape tests are updated to include `reason`: `tests/triggers/telegram-auth.test.ts:32`, `tests/triggers/telegram-trigger-adapter.test.ts:446`, `tests/contracts/task-contract.test.ts:33`, `:83`.
- `normalizeTelegramUpdate`'s signature and its eval caller.
- `/status` gains a count line per new id once rows exist (`countLines`, `status-view.ts:30`). The digest's Unsure section lists only `system_one` rows with a `p` (`digest.ts:62–68`), so `turn.contract` rows that carry a `run_id` are never offered for review; `run_id`-null rows are skipped by the chat-bound readers as in R1.

## 6. The differential (extends `scripts/check-ladder-stage4-differential.mjs`)

**Harness work (a plan task):** a stamped pair `--old-dist-r2` whose provenance file is `gateway/gateway.js` (this slice changes it; lesson 2026-10-28); the two ids added to **every** pair's `NEW_ROW_IDS` (the branch build is the new side of every pair; the corpora that intake scheduled turns through `Gateway` and would now write `restrict` rows are R1's `intake.mjs` — its `source: "schedule"` items, `:42`, `:46`, `:55` — and 4B's `memadmit.mjs:135`; 4C's `schedule.mjs` never touches `Gateway`), and the r1 and s4b pairs' required-new-row assertions checked to stay exact with those rows filtered; a new `r2` set; export-map entries for `triggers/telegram-trigger-adapter.js` (and the store-backed recorder the sender corpus wires). The existing pairs and corpora rerun unchanged; each gate keeps its own old build (lesson 2026-10-30).

**Corpus `sender`** — each item through `createTelegramLongPollingAdapter({ allowlist, client: stub getUpdates, offsetStore, skippedUpdateStore, acknowledgeSink: counter, decisionRecorder: counting wrapper over storeRecorder })`.pollOnce on a fresh DB copy, `emit` a recording stub (no gateway: a sender item never intakes, so an allowed `/kill` cannot write `houge.kill`; the corpus still pins `HOUGE_TOMBSTONE_PATH` / `HOUGE_DISARM_PATH` per lesson 2026-10-30). Items: each reason reachable on a message (`channel_post`, `forwarded`, `anonymous`, `user_not_allowlisted`, `chat_not_allowlisted`, `identity_not_for_chat`; `no_chat` only at the auth seam, §3.1); the reachable ones on a callback tap (`anonymous`, `user_not_allowlisted`, `chat_not_allowlisted`, `identity_not_for_chat`); a stranger's forward (precedence: `forwarded`); a callback with no `message` (`TELEGRAM_COMMAND_INVALID`, no sender row); a stranger's bare photo with ingest on (denied, no ack); an allowlisted text, photo, callback, and a malformed command (invalid-command ack, not a sender row); a batch mixing a denial between two allowed updates (offset and order). Compared: the normalize-visible outputs (emitted events in order, skip rows, final offset, ack count) and the whole-DB dump. New rows asserted separately: per item, count, verdict, reason, `run_id` null; zero rows and zero recorder calls for allowed items, with the emitted event as positive evidence.

**Production wiring.** The corpora build the adapter and the gateway with an injected recorder, so they cannot see a constructor that forgets it. Two tests close that: one through `runTelegramPollOnce` (the poll runner's constructor, `telegram-poll-runner.ts:162`) and one through the daemon's existing test harness (its constructor, `telegram-daemon.ts:231`), each feeding a stranger's update and **requiring** the `intake.sender` row in the store.

**Corpus `contract`** — each item through `new Gateway(store, caps, …, { decisionRecorder: counting wrapper over storeRecorder })`.intake(event, now) (R1's harness, counting clock, `HOUGE_TELEGRAM_CHAT_ID` cleared); the new side injects the recorder, the old side has no such option and takes none. Items: a Telegram turn (consulted, no row); a scheduled turn (`restrict`, `run_id` = the new run); the same occurrence replayed (`duplicate`, no second row); a scheduled turn under a tripped fuse, intaken twice (no row); an `ask` and each `/run` program (compile, no row); empty goal on a Telegram turn and a scheduled turn (`goal_missing`); `/run nosuch` (`unknown_program`); an unsupported type (`unsupported_type`, built directly); a rating `forward` and a memory-lane Ask (compile through the other two entry paths). Recorder-call counts asserted per item **for `turn.contract` only** (the wrapper counts by entry id; the same recorder also sees `intake.budget_fuse`, `gateway.ts:1104`): one per fresh run or refusal, zero for a fuse refusal or duplicate. A planted early return (no `decideSync` at the created point) is shown failing the count assertion once.

PASS: 0 differences across all pairs, every expected new row present with exact values, the coverage and determinism self-tests fail on their mutated copies.

## 7. Live gate — `scripts/live-gate-ladder-remainder-r2.mjs` (on `dist/`, a VACUUM copy, refuses outside `.worktrees/`, deletes the copy on every exit path; `HOUGE_TELEGRAM_CHAT_ID` pinned to a stub chat)

1. A stranger's message through `runTelegramPollOnce` (the production constructor, stub client) → skip row `TELEGRAM_AUTH_DENIED`, offset advanced, one `intake.sender` row `deny/user_not_allowlisted`, `run_id` null, **zero** outbox rows, **zero** `sendMessage` calls, no run.
2. Paco forwards a message → `deny/forwarded`, same silence; a channel post → `deny/channel_post`.
3. A stranger taps an approval button → `deny/user_not_allowlisted`; no approval state changes.
4. Paco's own text → emitted once, no `intake.sender` row, recorder calls 0.
5. A scheduled turn fires through `maybeFireScheduledTasks` → run created, `allowed_actions` without `schedule_task` (unchanged), exactly one `turn.contract` row `restrict/schedule_born` whose `run_id` is that run; the replayed occurrence → still one row.
6. Fuse tripped, a due schedule over two cycles → zero `turn.contract` rows; a Telegram turn → `turn.contract` consulted once (counted by entry id), zero rows; `/run nosuch x` through `Gateway.intake` → `refuse/unknown_program`, `run_id` null.
7. Store insert faulted, on a stranger's update and on a scheduled fire → `decision_record_failed` opened, exactly one outbox row and it is the incident alert to the stub operator chat, zero rows to the sender's chat, every other result above unchanged (silent-degradation line); a throwing recorder → logged, no incident, zero outbox rows, results unchanged.
8. `/status` shows a count line for each id; `insertLadderMove` naming `intake.sender` → refused (locked).
Every line names its exact expected value (lesson 2026-10-30). The slice updates `tests/decisions/registry.test.ts:132`, `:142`, `:153` and `scripts/live-gate-ladder-stage4b.mjs:172` (26 → 28), extends the locked-entries test with `intake.sender`, and reruns the 4B, 4C and R1 live gates with their recorded invocations.

## 8. Rollback check — `scripts/check-ladder-remainder-r2-rollback.mjs`

The previous build (stamped `0a8d294`, or the 2-A hotfix head) opens a copy carrying the new rows — `intake.sender` (intake, `run_id` null), `turn.contract` `restrict` (pre_model, with a run) and `refuse` (pre_model, `run_id` null, the first such row) — runs its readers (`/status`, digest, `decisions` readers) without error, every stored row still present and unchanged, and its `ENTRY_IDS`-validated writer (`review_ok`) refuses a new id cleanly. No migration.

## 9. Protected files touched (Tier A under the approved spec)

`src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `src/decisions/entries/intake-sender.ts`, `src/decisions/entries/turn-contract.ts`, `src/contracts/task-contract.ts` (the reason beside `error`), and `src/capabilities/self-write-guard.ts` under Decision 3-A. Not protected: `src/gateway/gateway.ts`, `src/triggers/telegram-auth.ts` (until 3-A), `src/triggers/telegram-trigger-adapter.ts`, `src/telegram/telegram-poll-runner.ts`, `src/telegram/telegram-daemon.ts`. `docs/decisions/0030-decision-ladder.md` (amendment, drafted, awaiting Paco's signature).

## 10. Risks

- **A stranger flood.** Each denial already writes one skip row; the entry adds one row each. Bounded by the denials, with no content stored; live rate is one in history.
- **Recording on the security floor.** The recorder runs after the denial is durable and never throws; a recorder fault cannot admit a sender or reply to one (fault lines in §7).
- **A wedged `/run` before Decision 2 lands** writes a `refuse` row every poll cycle (§4.2). 2-A removes it by fixing the wedge first.
- **Reason drift.** A new auth or contract branch without a reason would record the wrong verdict; the plan's totality tests enumerate every `denied()` / `invalid()` call and fail on one without a reason (TypeScript makes the argument required).
- **`input: "tool"` for the contract.** The rule reads only type, source and the compiled contract; a later rung over the goal's words would have to declare `paco` or `mixed` and pass R12 — out of this slice.

## Decisions needed (Paco, at the spec tap)

**Decision 1 — what `turn.contract` records.** §6.1 names A7 an entry; the compile is mostly mechanics.
- **1-A:** refusals only (`compile | refuse`). Near-zero rows; the strip stays unrecorded (it is already visible as the run's `contract_json`).
- **1-B (recommended):** refusals **and** the schedule-provenance strip as its own verdict (`restrict`, ~2 rows a day, each linked to its run). The strip is the one branch that changes a successful turn's `allowed_actions`, so it passes §6.1's test (it changes the turn's path; a scheduled turn that needed `schedule_task` and was refused at the bridge is the outcome that would show it wrong).
- **1-C:** `alwaysRecord` — one row per admitted run. Duplicates `runs.contract_json`; not recommended.

**Decision 2 — the `/run` wedge (§3.3), pre-existing.**
- **2-A (recommended):** a hotfix commit on `main` before the R2 branch is cut, so R2's merge base carries it and the differential stays behaviour-identical: `TASK_CONTRACT_INVALID` joins `HANDLED_INTAKE_DENIAL_CODES`, and for any Telegram-source refusal (a `/run`, and the rating-forward and memory-lane Ask paths, which reach the same compile) the gateway enqueues `invalidCommandReply(error.message)` (`telegram-trigger-adapter.ts:207`, the 2026-10-01 precedent: an allowlisted sender's malformed command is answered, never ghosted), keyed `<idempotency_key>:contract_invalid`. The reply is code-built but echoes the program name Paco typed (`task-contract.ts:37`), only to Paco's own allowlisted chat. Test through `runTelegramPollOnce` (lesson 2026-10-28): one reply, and the **following** update in the same batch is processed (the offset moves past the refusal). A scheduled source is unchanged (empty-goal schedules still retry three times and park; R2 then writes up to three `refuse` rows per such schedule, bounded). After the fix, a `/run nosuch` writes one `refuse` row per update. Hotfix flow: reviews and a live line on the poll loop, no spec.
- **2-B:** record it as a follow-up; R2 ships first. The wedge stays reachable by one mistyped `/run`, and R2's `refuse` row would repeat per cycle while it holds.

**Decision 3 — protect the sender check.** `intake.sender` is locked, but its raw answer comes from `src/triggers/telegram-auth.ts`, which a self-write may change (human merge still gates it). R1's `intake.budget_fuse` wraps unprotected code too, so the lock does not require it.
- **3-A (recommended):** add `src/triggers/telegram-auth.ts` to `PROTECTED_FILES` under this spec (the body of a locked rule, the allowlist floor; one array line, a guard test). **Its limit, stated:** it protects the predicate only. The evidence it reads is built in the self-writable adapter (`is_forwarded` at `:125`, the `:105` channel-post pre-check, both call sites); protecting the adapter wholesale would block self-writes of new commands. The slice adds a pinning test of that derivation (a forward, a channel post and a callback each map to their fixed evidence and reason), so a self-write that loosens it fails the check stack before Paco's merge.
- **3-B:** leave it self-writable; the lock covers the entry and the ladder only.

## Rev 1.1 changes (senior review, Sonnet 5.5, and codex; each verified first-hand)
- Codex B1 / production wiring: the corpora inject recorders, so a constructor that forgets one would pass → two tests through `runTelegramPollOnce` and the daemon harness require the row; gate line 1 goes through `runTelegramPollOnce` (§6, §7).
- Codex B2 / no recorder seam on `Gateway`: `options.decisionRecorder` added for injection, default unchanged (§4.2).
- Senior W3 + codex W / row placement: moved into `if (queued.ok)`, so a failed attach writes no row; the crash-window loss is stated and accepted (§4.2).
- Senior W1 + codex W / "byte-identical": restricted to persisted rows and `GatewayIntakeResult`; the in-memory `reason` and the four exact-shape tests named (§5).
- Senior W2 / `NEW_ROW_IDS` rationale: the exposure is `intake.mjs` and `memadmit.mjs`, not 4C's `schedule.mjs` (§6).
- Senior W4 + codex W / fault vs silence: the alert to the operator chat is the stated delta; gate line 7 asserts exactly that row and nothing to the sender (§4.3, §7).
- Senior W5 + codex S / 3-A partial: the limit stated, an evidence-derivation pinning test added (Decision 3).
- Codex W / `no_chat` unreachable via the adapter: tested at the auth seam (§3.1, §6).
- Senior S1 / throw semantics: the fail row is `deny`, rung `fail`, `fallback_reason "threw"`, `reason_code` null (§4.1).
- Senior S2 / corpus: a stranger's forward, a message-less callback added (§6).
- Senior S3 + codex S / Decision 2: covers the rating-forward and memory-lane paths; echoed program named; the following-update line; bounded schedule `refuse` rows.
- Senior S5 / "Topic is required" (`:61`): mapped to `goal_missing`; all seven `invalid(` sites enumerated (§4.2).

## Rev 1.2 changes (codex scoped re-review)
- B / a fuse refusal calls the shared recorder for `intake.budget_fuse`, so "zero recorder calls" would fail → counts are per entry id, `turn.contract` only (§6, §7).
- W / a throw from a later write in `queued.ok` could cost the row → the call is the block's first statement (§4.2).
