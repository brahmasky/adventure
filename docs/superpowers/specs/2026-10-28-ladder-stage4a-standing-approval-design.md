# Decision ladder, stage 4 slice A — standing approval for a scheduled command (Rev 3, against the real clean room)

**Status:** draft Rev 3 — Rev 2 reviewed by senior (Opus, live DB read-only: 4 blockers, 9 warnings) and codex (6 blockers, 7 warnings), all folded in; awaiting a scoped re-review, then Paco's tap (**§Decision needed has one Tier C item**).
**Date:** 2026-10-28
**Supersedes:** `2026-10-26-ladder-stage4-standing-approval-scheduled-design.md` (Rev 1).
**Amends:** ADR 0030 §4.3 / §8.3 (storage, the executor-setting path, the grant criterion — see §Decision needed 1); `docs/ROADMAP.md` Stage 4 #5.
**Depends on:** ADR 0030 §8.3 (`docs/superpowers/specs/2026-10-12-decision-ladder-design.md:907–1020`), §4.3; clean-room Slices 0+1 (shipped 2026-10-28; `2026-10-28-ladder-cleanroom-runtime-slice1-design.md` §Runtime seam, §Hand-off to Stage 4A).

## 1. Goal

Stop re-asking Paco for the **same** gated shell command from the **same** scheduled task after he has approved it on three distinct runs, by running the next approved run in the clean room and, once that run's facts and report are in, letting later byte-identical runs of that schedule proceed without a card — with one-tap revoke, no loosening for any other command, schedule, chat or unscheduled turn, and every transition owned by code.

## 2. Live facts (2026-10-28, read-only on the live DB; corrected by the senior review)

- Fingerprint `a0362e7ddf…` (`HTTP write`): **14 consumed** approvals from schedule `sch_2af53119-…` (chat `8744196214`, 2026-10-11 → 10-26), **2 expired** (10-09, 10-10), plus 4 consumed + 1 expired from Paco's own turns. Byte-identical 14/14 consumed. The runs on 10-13 and 10-14 produced **no approval** (truncated goal; `houge_status` only) — the command is written by the planner each run from the goal text; identity is empirical and goal-dependent.
- Every scheduled run has a `notification_outbox` row `<run_id>:final_report` in state `delivered` — **including 6 failed runs** whose "I hit an error" notice was delivered, and the approval-expired run of 10-09 whose report says the command did not run. The success and failure paths share the key and the `intent_type` (`run-store.ts ~6983`, `~7012`). **Delivery proves receipt, not success.**
- The schedule is `disabled` since 2026-10-26T23:30Z. `ladder_moves` has 0 rows. The daemon is live.
- The approval row's `requester` is the operator on scheduled runs (`tool-approval-sink.ts:55`); the schedule id lives only on `turn.requester`/`runs.requested_by_json`; the approval tap is authenticated by identity, not by chat (`gateway.ts ~1004`, `run-store.ts ~7847`).
- The action fingerprint is computed in `CapabilityRunner.execute` (`capability-runner.ts:143–148`) **after** `decideCapability` + `decideSync(TOOL_POLICY)` (`:111–127`); it is `stableHash` over `{capability, side_effect_level, risk_level, affected_resources, adapter_input_hash}` with `adapter_input_hash = stableHash(input.input)` — canonical JSON, so a byte change in the command string changes it; object-key order does not.
- `insertLadderMove` accepts `granted_by: "auto"` only for `tool.policy` + `approval.standing` (`run-store.ts:1063`, `:5034`). No `approval.standing` entry exists; `approval.bind` (B14) is a locked id with no module. `tool.policy` is a single rule rung (v2); `decideSync` forbids non-rule rungs; the `decisions` table has no evidence column.
- `consumeToolApproval` (`:6825–6852`) is a read + one CAS UPDATE with **no transaction**; `markNotificationDelivered` (`:7255`) and `processApprovalTrigger` (`:6704`) open raw `BEGIN IMMEDIATE` without `outerTxDepth`, so `joinTransaction` inside them throws.
- `tool_finished` carries `executor` + `cleanroom:{ran,torn_down,tampered,escaped}` but not `exit_code`, `truncated`, `check_error`, `room`. `getLedgerEvents(run_id)` exists (`:1500`); `tool_finished` is one per call.
- Contract budget `max_tool_calls` is 40 per run; today each identical call asks again.
- Trust asks come from `effectiveAsk` (level, `settleAsk`, masked reads), not only from `hostile`; `decideCapability` checks gated before `trust_ask`.
- The self-write test gate runs as Paco until SP3 (option B); a sealed run and a test gate can overlap.

## 3. Scope

In: streak by distinct consumed runs; the sealed next run; the grant (per §Decision needed 1); automatic allow for later byte-identical scheduled runs in the clean room (one per run); revoke, expiry, deny-reset; `/schedule` section with Revoke; ledger facts and rows; migration + rollback check; live gate on a DB copy.
Out: endpoint allowlists; cross-schedule/command standing; unscheduled turns; the other Stage 4 items; moving the test gate (SP3); changing §8.3's meaning except where §Decision needed says so.

## 4. Key and eligibility

**Key** = `(schedule_id, chat_id, action_fingerprint)`. `schedule_id` = `turn.requester.id` when `kind === "schedule"`; `chat_id` = `runs.notify_json.chat_id` (the same source in the bridge and the store, so they cannot drift). The fingerprint is the runner's; the bridge obtains it from the exported helper `actionFingerprint(entry, metadata, input)` (same inputs as `capability-runner.ts:143–148`; a test asserts equality with the runner on the Alishan shape). The runner computes the fingerprint **before** the policy decision from now on (pure reorder; a test pins that the value is unchanged).

**Eligible action:** capability `shell_external` only; label set without `unseen shell script`; never `shell_destructive`, never `memory_correct_write`.

**Eligible call** (all true, else the normal approval path with the failing reason on the decision row): `turn.requester.kind === "schedule"` with the key's `schedule_id`; the run's notify chat equals the key's `chat_id`; `turn.trust` defined and `effectiveAsk(...)` says **no ask** (level not `hostile`, no `settleAsk`, no masked-read ask) — standing never turns an ask into an allow; posture not killed; the clean room available (`cleanroomAvailable(cfg)`, one exported predicate shared with `runCleanroomShell` step 1); no standing use yet in this run for this key (one per run — Paco approved one POST a day, not forty); the row `state = standing`, not expired, its move active, the schedule enabled.

## 5. Storage (one additive migration, `2026-10-28-standing-approval`)

```sql
CREATE TABLE IF NOT EXISTS standing_approvals (
  standing_id TEXT PRIMARY KEY,                          -- "sa_" + uuid
  schedule_id TEXT NOT NULL, chat_id TEXT NOT NULL, action_fingerprint TEXT NOT NULL,
  capability TEXT NOT NULL, label TEXT NOT NULL,         -- command-matcher label; never command bytes
  state TEXT NOT NULL CHECK (state IN ('streak','candidate','sealing','sealed','standing','ended')),
  credited_runs_json TEXT NOT NULL DEFAULT '[]',         -- distinct run ids whose approval was consumed (streak)
  approval_ids_json TEXT NOT NULL DEFAULT '[]',          -- the consumed approval ids, incl. the sealing one
  sealing_approval_id TEXT, sealed_run_id TEXT, sealed_tool_call_id TEXT, sealing_started_at TEXT,
  move_id TEXT, grant_notification_id TEXT,
  denied_until TEXT, expires_at TEXT, last_used_run_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT, ended_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS standing_key_live ON standing_approvals(schedule_id, chat_id, action_fingerprint) WHERE state <> 'ended';
CREATE INDEX IF NOT EXISTS standing_deny_idx ON standing_approvals(chat_id, action_fingerprint, denied_until);
```
Ended rows stay (audit, and `denied_until` is looked up over them). Ledger events (code-owned, no bodies): `standing_streak {standing_id, run_id, approval_id, streak}`, `standing_sealing {standing_id, run_id, tool_call_id, approval_id}`, `standing_sealed {standing_id, facts…}`, `standing_granted {standing_id, move_id}`, `standing_used {standing_id, move_id, run_id, tool_call_id, action_fingerprint}`, `standing_ended {standing_id, reason}`. Rollback: additive + idempotent; the old build never reads the table and keeps asking; `scripts/check-standing-rollback.mjs` follows `check-ladder-2b-hooks-rollback.mjs` **in full** (old-build status, digest, invariants, `/schedule`, an approval resolve, a schedule tick, and an omp resume on a run holding `standing_*` events and a `standing` decision reason — the old build must ask again and must not use the grant).

## 6. State machine (each transition one store transaction; `candidate` is `streak` with three credited runs)

```
(no row, not denied) --approval CONSUMED on a scheduled run, eligible action--> streak (credited_runs=[run])
streak --consumed on a DIFFERENT run, same key--> streak(+1); third distinct run → candidate
candidate --next scheduled run asks; the approval is CONSUMED (the fourth) with the bridge's cleanroom selector set--> sealing
sealing --sealed call finished with every seal fact true ∧ run completed ∧ success report delivered--> sealed
sealed --(Decision 1) automatic grant | Paco's ✅ on the grant card--> standing (ladder move, card with Revoke)
sealing --a seal fact false ∨ facts missing ∨ run not completed ∨ delivery terminal-failed ∨ 24 h TTL--> ended(sealed_trial_failed)
sealing --the sealed call never spawned (ran:false, pre-spawn cleanroom_* reason)--> candidate (next run asks again)
standing --eligible byte-identical scheduled call, authorised by the store CAS--> use (no card; decision reason standing; executor cleanroom)
standing --Revoke tap ∨ expires_at ∨ schedule cancelled/disabled ∨ deny on (chat, fingerprint) from ANY run--> ended(reason), move ended
any live row --deny on (chat, fingerprint) from ANY run--> ended(denied), denied_until = now + 30 d
(no row) --deny on (chat, fingerprint) on a scheduled run--> ended(denied) row inserted carrying denied_until
streak/candidate idle 30 d --> ended(stale)
```
Rules: one credit per **distinct run** (a second consumed approval in the same run adds nothing; a denial in that run ends the row); expired approvals neither credit nor reset; a different fingerprint is a different key and does not touch this one; the consume hook acts only on (no row) and `streak`/`candidate`→`sealing`; it is a no-op for `sealing`, `sealed`, `standing`.

## 7. Where each piece lands (hooks, transactions, ownership)

- **Consume hook** — `RunStore.consumeToolApproval` (`:6825`) becomes: `joinTransaction(() => { read row; CAS approved→consumed; if the run is source='schedule' → standingCredit(...) })`. `standingCredit` reads `runs.requested_by_json.id`, `runs.notify_json.chat_id`, the approval's `capability`/`action_fingerprint`/summary label on the same connection; it credits (§6) or, when the row is `candidate` **and** the consuming call carries the bridge's `sealing_intent {tool_call_id}`, transitions to `sealing` with `sealing_approval_id = this approval`, `sealed_run_id`, `sealed_tool_call_id`. So `sealing` exists **only** behind a successful fourth-approval CAS; a failed consume (expired, lease lost, mismatch, replay) leaves the row `candidate` and the runner returns before the adapter — nothing runs sealed. The `sealing_intent` reaches the store through the sink's consume call (`capability-runner.ts:181–205` → `tool-approval-sink.ts:68–72`), carried on `CapabilityExecutionInput` as `standing_trial: { standing_id }` (outside `input.input`).
- **Deny hook** — `resolveToolApprovalWithinTransaction` (`:7841`) on `denied`: plain statements, total (never throws; a failure opens an incident): end every live row for `(chat, fingerprint)` and set `denied_until`; insert the ended row if none exists and the run is scheduled. The key's chat is the run's notify chat. **Chat binding of the tap:** `processApprovalTrigger` gains, for scheduled runs, a check that the tap's originating chat (the callback query's message chat, carried on the approval tap event — `buildApprovalTapEvent` adds `chat_id` if it does not already) equals the run's notify chat; a mismatch resolves nothing and credits nothing.
- **Bridge, before the first execute** (`executeWithApproval:392`): `fp = actionFingerprint(entry, turn.registry.get(entry), req.input)`; `row = store.standingFor(schedule_id, chat_id, fp)`.
  - `row.state === "standing"` ∧ §4 eligible → `base.standing = { standing_id }`, ctx `executor: "cleanroom"`.
  - `row.state === "candidate"` ∧ clean room available → `base.standing_trial = { standing_id }` and the sink's `card_detail`/reason gains the line in §8; the ctx for the **resume** (`:396`) gets `executor: "cleanroom"`; the first call asks as today.
  - otherwise: nothing (today's path).
- **Runner** (`capability-runner.ts`): the fingerprint moves before policy. `decideCapability` gains an input `standing?: { standing_id }` and the order is pinned: forbidden / not-allowed / cli denies → **trust ask** → gated: if `standing` present, call `approvals.standingUse({ standing_id, action_fingerprint, run_id, tool_call_id })` on the sink; the sink's store method is one CAS transaction that checks `state = standing`, not expired, move active, schedule enabled, chat and schedule equal the key, fingerprint equal, `last_used_run_id ≠ run_id`, then sets `last_used_run_id` and appends `standing_used` → verdict `allowed`, reason `standing`; any failure → `requires_approval` with reason `standing_mismatch` (and the sink ends the row on a fingerprint mismatch). This is the atomic authorisation at the execution boundary: a Revoke that lands before it wins; one that lands after it lets the in-flight call finish (bounded by the shell timeout) and blocks the next. A forged `standing` on a direct runner call without a valid row gets `requires_approval` (test). `TOOL_POLICY` v3 adds `standing` and `standing_mismatch` to `reasonCodes` and `REASON_MAP`.
- **Seal facts at the source** — `cleanroomFacts` in the bridge and the `tool_finished` event gain `exit_code` (int), `truncated` (bool), `check_failed` (bool — `check_error` present), `room` (basename; code-owned random name); still no bodies. `settleSealing(run_id)` is idempotent and total, runs in its own transaction **after** `NotificationOutbox.markDelivered` returns (never inside the delivery transaction) and from the daemon's per-minute sweep (placed before the scheduler-flag early return in `schedule-tick.ts`, or its own hook) for rows in `sealing`. It reads `getLedgerEvents(sealed_run_id)` for the `tool_finished` with `tool_call_id = sealed_tool_call_id` and the outbox row `<run_id>:final_report`. **Seal conjunction:** `status = succeeded ∧ exit_code = 0 ∧ ¬truncated ∧ ran ∧ torn_down ∧ ¬tampered ∧ ¬escaped ∧ ¬check_failed ∧ runs.state = completed ∧ outbox delivered`. All true → `sealed`; any false, facts missing (cancelled/timed-out without output = unsealed, ran unknown, **never** re-run), run `failed`, outbox terminal-failed, or 24 h since `sealing_started_at` → `ended(sealed_trial_failed)` + digest line. Outbox still `queued`/`sending` → wait.
- **Grant** (`sealed` → `standing`): per §Decision needed 1 either immediately in `settleSealing` or on Paco's ✅ tap. Both: `insertLadderMove({ entry_id: "tool.policy", scope: standing_id, from_rung: "paco", to_rung: "rule", granted_by: "auto", granted_via: "approval.standing", evidence: [the three credited approval ids, sealing_approval_id, the sealed call's decision id, sealed_run_id, sealed_tool_call_id], revocable: 1 })` (§4.3: decision/approval ids first, execution ids after), row → `standing`, `expires_at = now + 30 d`, `standing_granted` event, urgent card (§8) with `dec:sa:<standing_id>:revoke`, `grant_notification_id` stored; if that card ends `failed_terminal` the existing undelivered sweep pages and `/schedule` still lists the row.
- **Revoke** — `dec:sa:sa_<uuid>:revoke` (53 bytes): a parser family beside `DEC_MOVE` (`telegram-command-parser.ts:344–362`) with a fixed regex; handler in `improvement-commands.ts` that does **not** use `TAP_STALE_DAYS` (the button must work for the full 30 days), checks the tapping chat against the row's `chat_id`, and ends the row + `endLadderMove(move_id)` in one transaction; reply via the rich renderer. `/schedule` gains a "常驻批准" section (`#N label · schedule name · 到期 date`, one Revoke button each; buttons already render on any intent).
- **Expiry / schedule end / stale** — the sweep ends `standing` rows past `expires_at` or whose schedule is cancelled/disabled (and `cancelScheduledTask` ends them at once), and `streak`/`candidate` rows idle 30 days.
- **Sealed call outcomes to the planner** — a `cleanroom_*` pre-spawn failure returns `ok:false` to the planner like any adapter failure (no unsealed re-run in the same call; the fourth approval is spent; the next scheduled run asks again). A post-run failure, missing facts or a timeout/cancel never re-runs the command.
- **Kill switch** — unchanged (`postureOk()` first).

## 8. Cards and digest (reading A, Paco 2026-10-28)

- Fourth-run approval card, extra line (added through the sink's reason/card_detail when `standing_trial` is set): "You've approved this exact command on three runs. Approving this one runs it in a sealed folder; if it completes and its report reaches you, I stop asking for it on this schedule." (Only when the clean room is available at that moment; otherwise the plain card.)
- Grant card: the conditions — empty folder, fresh home, TCP egress only, no background processes (a condition, not a guarantee), one byte changed asks again, one run per fire, expires in 30 days — and the Revoke button; under Decision 1-B also "✅ It worked, stop asking" / "❌ Keep asking".
- Digest: one line per `sealed_trial_failed`, `ended(denied|expired|stale|mismatch)`.

## 9. Safety

- No model path opens, advances or grants anything: credits come from consumed approval rows Paco tapped in the right chat; `sealing` rides the fourth approval's CAS; the grant reads code-owned ledger facts; standing use is a store CAS.
- The fingerprint of the sealed fourth call and of every standing call equals the three approvals' (asserted).
- Standing never converts a trust ask, a masked read, a destructive label, a hostile turn, a killed posture, an unavailable clean room, a different chat/schedule, or a second call in the same run into an allow.
- Denial anywhere on the bytes blocks for 30 days; Revoke stops the next use; an in-flight use is bounded by the shell timeout.
- **Open window (stated):** a concurrent self-write test gate can write into `<cache>/cleanroom/` as Paco until SP3; the post-run tamper check catches a plant that persists.

## 10. Tests and the live gate

Unit: every §6 transition incl. distinct-run credit, same-run second approval, expired neutrality, different-key independence, deny-from-user-turn ending a schedule's row, deny-with-no-row, stale; `actionFingerprint` ≡ runner; policy order (trust ask beats standing); `standingUse` CAS matrix (revoked / expired / disabled schedule / wrong chat / wrong schedule / fingerprint mismatch / second use in run); `settleSealing` truth table over the ten facts × outbox states × TTL; forged `standing` on a direct runner call → `requires_approval`; revoke parser + handler (chat check, no stale window, one transaction); `/schedule` section; migration idempotency; `cleanroomAvailable`.
Bridge: fourth approved call carries the selector on the resume context, fifth on the first call, unscheduled same bytes never, hostile scheduled call asks, sandbox off → asks.
Live gate `scripts/live-gate-standing-approval.mjs` on a **VACUUM copy** with a seeded schedule reproducing the Alishan shape (`curl … -c cj.txt -b cj.txt -X POST https://httpbin.org/post`; a third-party endpoint, as Slice 1's gate — stated so it is not read as Tier B), the real bridge, wrapper and clean room; taps through the same seam `live-gate-ladder-2b-hooks.mjs:220` uses (`resolveToolApprovalForTest` + waiter), delivery through claim → `markDelivered` with a stub adapter. Lines: three approvals on three runs → candidate; the fourth asks and, approved, runs sealed (`tool_finished` facts, room under `cleanroom/`); completed run + delivered report → `sealed` → grant (per Decision 1) with move + card; **the fifth run: no `approval_requested`, decision reason `standing`, `cleanroom.sb` selected** (a PASS line that fails on silent degradation); a sixth call in the same run asks; one byte changed asks; Revoke → next run asks; deny from a user turn on the bytes → ended + `denied_until`; sandbox off → asks; non-zero exit through the real bridge → no seal; teardown failure (`rm` seam) → no seal; `check_error` (lsof seam) → no seal; a failed run with a delivered failure notice → no seal; a planted `.curlrc` mid-run (`afterSpawn` seam) → `tampered` → no seal. Plus `check-standing-rollback.mjs`.

## Decision needed (Paco, at the spec tap)

1. **What stands a command up (Tier C — this changes what §8.3's "its report reaches Paco" means).** Measured: a delivered report proves only that you received a message; failed runs and "the command did not run" reports are delivered the same way. So "delivered" cannot carry the success judgement §8.3 assumed (probe (d), the empty cookie jar).
   - **A — automatic, as §8.3 wrote it, with the strongest code-owned conjunction:** `sealed` (every seal fact true ∧ run completed ∧ success report delivered) grants immediately; you read that run's report (it arrives before the grant card) and have Revoke. Residual: a sealed run with exit 0 and a wrong-but-plausible report stands up until you revoke.
   - **B (recommended) — one confirmation tap, once per command:** `sealed` sends the grant card with "✅ It worked, stop asking" / "❌ Keep asking"; standing only on ✅ (`granted_by` stays `auto` under §4.3: the sealed run and the facts are the authority; your tap is the success judgement code cannot make). Cost: one extra tap per command lifetime; it also replaces Rev 1's "final tap" with a judgement code genuinely lacks.
2. **Rev 1's "Always allow" option on the card** — dropped; candidacy is automatic after three distinct consumed runs (§8.3). Recommended: keep dropped.
3. **Rev 1's "sealed trial under simulation"** — replaced by the real fourth run in the real clean room. Recommended: the real run.
4. Durations kept: expiry 30 days, deny block 30 days, `sealing` TTL 24 h, stale 30 days.

## Rulings in this Rev (overturnable by review)

- Delivery = the run's `final_report` outbox row `delivered` **and** `runs.state = completed` (the failure path shares the key); the sealed call is identified on the standing row (`sealed_run_id`, `sealed_tool_call_id`) and in the ledger, which satisfies "keyed to run id + execution id" without a new column on the outbox.
- Ledger facts gain `exit_code`, `truncated`, `check_failed`, `room` — bounded code-owned values, no bodies.
- The fingerprint helper is exported from the runner; the runner computes it before policy.
- Authorisation of a standing use is a store CAS through the sink, mirroring `consumeToolApproval`; the bridge's lookup is a selector only.
- B14's standing case lives in `tool.policy`'s rule + the sink CAS; `approval.bind` stays a locked id without a module (as today).
- `standing_id = sa_<uuid>`; callback `dec:sa:<standing_id>:revoke` (§8.3 wrote `dec:sa:<move_id>`; the row id is the stable handle, the move id is on the row).
