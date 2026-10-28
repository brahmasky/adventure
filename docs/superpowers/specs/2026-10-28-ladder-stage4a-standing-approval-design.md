# Decision ladder, stage 4 slice A — standing approval for a scheduled command (Rev 2, against the real clean room)

**Status:** draft Rev 2, awaiting senior + codex review, then Paco's tap (including §Decision needed).
**Date:** 2026-10-28
**Supersedes:** `2026-10-26-ladder-stage4-standing-approval-scheduled-design.md` (Rev 1 draft, written before the clean room existed; its two deviations from ADR 0030 §8.3 are §Decision needed items 1–2).
**Amends:** ADR 0030 §4.3 / §8.3 (adds the storage and the executor-setting path §8.3 left to "stage 4 code"); `docs/ROADMAP.md` Stage 4 #5.
**Depends on:** ADR 0030 §8.3 (`docs/superpowers/specs/2026-10-12-decision-ladder-design.md:907–1020`); clean-room Slice 0 + Slice 1 shipped 2026-10-28 (`2026-10-28-ladder-cleanroom-runtime-slice1-design.md`, §Runtime seam, §Hand-off to Stage 4A); live code map 2026-10-28 (file:line below are from it).

## 1. Goal

Stop re-asking Paco for the **same** gated shell command from the **same** scheduled task once he has approved it three times in a row, by running the fourth approved run in the clean room and, if its report reaches him, granting a standing approval that later byte-identical runs use without a card — **without** loosening approval for any other command, schedule, chat or unscheduled turn, and with one-tap revoke. Everything here is code-owned; no model judgment decides a grant.

## 2. Live facts this spec rests on (2026-10-28, read-only on the live DB)

- Approval fingerprint `a0362e7ddf5a…` (summary `HTTP write`) was **consumed 16 times from one schedule** (`sch_2af53119-…`, chat `8744196214`) between 2026-10-07 and 2026-10-26, byte-identical each day, plus 5 times from Paco's own turns. Every one of those scheduled runs has a `notification_outbox` row `<run_id>:final_report` in state `delivered`. The daily job's **command is written by the planner each run** from the schedule's goal text; byte-identity is empirical, and it held 16/16.
- That schedule is currently **disabled** (since 2026-10-26). The gate therefore seeds its own schedule on a DB copy; nothing here depends on the live row.
- Today the gate sees no run origin: `decideCapability` (`src/policy/capability-policy.ts:25–54`) takes none; the schedule id is reachable in the bridge only as `turn.requester` (`{kind:"schedule", id}`), and the approval row's `requester` is the **operator** (sink `who()`, `src/omp/tool-approval-sink.ts:55`).
- The action fingerprint is computed **inside** `CapabilityRunner.execute` (`src/capabilities/capability-runner.ts:143–148`) after the `TOOL_POLICY` decision (`:111`); the bridge never sees it except on the approval row.
- `ladder_moves` already accepts `granted_by: "auto"` **only** for `entry_id: "tool.policy"` + `granted_via: "approval.standing"` (`src/run/run-store.ts:1063`, `insertLadderMove :5034–5046`); nothing reads `ladder_moves` at runtime yet, and no `approval.standing` entry exists in the registry (`src/decisions/entry-ids.ts:5`).
- `executor: "cleanroom"` exists on `SsrfContext` (`src/tools/tool-registry.ts:13`); the shell adapter honours it only with `run_id` + `tool_call_id`; the bridge builds the two contexts at `src/omp/bridge-handler.ts:392` (first execution) and `:396` (approval resume); the `tool_finished` ledger event carries `executor` + `cleanroom: {ran, torn_down, tampered, escaped}` (shell entries only) but **not** `exit_code`/`truncated`.
- There is no `report_delivered_at`; the durable delivery record is `notification_outbox` (`<run_id>:final_report`, `state = delivered`, `provider_message_id`) plus the ledger event `notification_delivered`.
- `tool.policy` is a single rule rung (`src/decisions/entries/tool-policy.ts`) decided by `decideSync`, which forbids non-rule rungs; reason codes have no `standing`.
- The self-write test gate runs codex-written code as Paco, unsandboxed, until SP3 moves it to an OS user (Paco 2026-10-28, option B). A sealed run and a test gate can overlap in time today.

## 3. Scope

In: candidacy by consecutive consumed approvals; the sealed fourth run; the automatic grant with an urgent Revoke card; automatic `allow` for later byte-identical scheduled runs through the clean room; revoke, expiry, deny-reset; `/schedule` listing with Revoke; the ledger rows; a live gate on a DB copy.

Out: endpoint allowlists; cross-schedule or cross-command standing; any effect on unscheduled turns; trust-ledger autonomy; the other Stage 4 items; moving the test gate (SP3); changing what §8.3 means.

## 4. Key and eligibility (code-owned, every call)

**Key** = `(schedule_id, chat_id, action_fingerprint)`. The fingerprint is the runner's existing `stableHash({capability, side_effect_level, risk_level, affected_resources, adapter_input_hash})` over the exact adapter input bytes — no normalisation, one byte changes the key. `schedule_id` comes only from `turn.requester` when `kind === "schedule"`; `chat_id` from `turn.chat_id`.

**Eligible action** (checked when a candidacy is opened and again on every standing use): capability `shell_external` only (`src/omp/capability-map.ts:20–24`; the label set is what the three approvals carried — e.g. `HTTP write`); never `shell_destructive`, never `memory_correct_write`, never a command whose label set contains `unseen shell script`.

**Eligible call** (all, before any automatic allow): `turn.requester.kind === "schedule"` with the key's `schedule_id`; `turn.chat_id` equals the key's; `turn.trust.level() !== "hostile"` (`src/decisions/trust-ask.ts`); posture not killed (already refused earlier in `handleCall`); the clean room available (`cfg.sandbox`, `sandbox-exec` present — otherwise the match is void and the call asks, per §8.3 fail-closed); the standing record `state = standing`, not expired, not revoked. Any failed check → the normal approval path, and a decision row with the failing reason.

## 5. Storage (one additive migration, `2026-10-28-standing-approval`)

```sql
CREATE TABLE IF NOT EXISTS standing_approvals (
  standing_id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL, chat_id TEXT NOT NULL, action_fingerprint TEXT NOT NULL,
  capability TEXT NOT NULL, label TEXT NOT NULL,              -- command-matcher label, never the command bytes
  state TEXT NOT NULL CHECK (state IN ('streak','candidate','sealing','standing','ended')),
  streak INTEGER NOT NULL DEFAULT 0,                          -- consecutive consumed approvals (resets on deny)
  approval_ids_json TEXT NOT NULL DEFAULT '[]',               -- the consumed approval ids that built the streak
  sealed_run_id TEXT, sealed_tool_call_id TEXT,               -- the fourth run and its sealed call
  move_id TEXT,                                               -- ladder_moves row once granted
  denied_until TEXT,                                          -- 30-day block after a denial
  expires_at TEXT,                                            -- grant + 30 days
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT, ended_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS standing_key_live ON standing_approvals(schedule_id, chat_id, action_fingerprint) WHERE state <> 'ended';
```
Ended rows stay for audit. No command text anywhere (the fingerprint, label and summary already exist on the approval row). Rollback: additive and idempotent; the previous build ignores the table; `scripts/check-standing-rollback.mjs` follows `check-ladder-2b-hooks-rollback.mjs` (VACUUM copy → migrate with the new build → seed → open with the old build → exercise `/schedule`, an approval resolve and a schedule tick).

## 6. The state machine (all transitions by code, in one transaction each)

```
(no row) --consumed approval, eligible action, scheduled, non-hostile--> streak(1)
streak(n) --consumed approval, same key, consecutive--> streak(n+1)   ; n+1 == 3 → candidate
candidate --4th run asks, Paco approves--> sealing (sealed_run_id, sealed_tool_call_id set; executor = cleanroom on the resume)
sealing --seal facts OK ∧ final report delivered--> standing (ladder move inserted, urgent card with Revoke)
sealing --seal facts not OK ∨ report never delivered (run ended)--> ended(sealed_trial_failed) + digest note; asking continues
standing --byte-identical scheduled call--> (no card; decision row rung=rule reason=standing; executor = cleanroom)
standing --Revoke tap ∨ expiry ∨ schedule cancelled/disabled ∨ denial on this key--> ended(reason), move ended
any --Paco denies this key--> ended(denied), denied_until = now + 30 d (no new streak until then)
```
"Consecutive" = every scheduled run of this schedule since the streak started that produced this key consumed its approval; an `expired` approval neither counts nor resets (§8.3); a run that produced a **different** key does not reset this streak (a changed command simply starts its own key). `streak` rows that see no activity for 30 days are ended (`stale`).

## 7. Where each piece lands

- **Streak accounting** — in `RunStore.consumeToolApproval`'s transaction (`:6825–6852`), when the row's run is `source = 'schedule'`: upsert the key's row (needs the approval's `capability`, `action_fingerprint`, the run's `requested_by_json.id`, the run's notify chat). Denials: in `resolveToolApprovalWithinTransaction` (`:7841–7864`) on `denied` for a scheduled run → `ended(denied)` + `denied_until`.
- **Candidacy → sealing** — in the bridge's `executeWithApproval`: before the resume call (`:396`), `store.standingFor(schedule_id, chat_id, fingerprint)` (fingerprint read from the approval row `getToolApproval(approval_id).action_fingerprint` — the row the runner just created); if `state = candidate` and the call is eligible (§4) and the clean room is available → set `executor: "cleanroom"` on the resume context and move the row to `sealing` with `sealed_run_id`/`sealed_tool_call_id`. If the clean room is unavailable the resume runs as today and the row stays `candidate` (the next approved run tries again). An **ask-as-normal** result from the sealed call (`cleanroom_*` pre-spawn reasons, `ran: false`) moves the row back to `candidate` with a digest note; a post-run failure or a seal fact false → `ended(sealed_trial_failed)`.
- **Standing use** — in `handleCall` before the first `runner.execute` (`:392`): the bridge needs the fingerprint **before** the runner computes it. Export the runner's fingerprint function as a pure helper (`actionFingerprint(capability, metadata, input)`, same inputs as `:143–148`; a test asserts the exported helper and the runner agree byte for byte on the Alishan shape). If `standingFor(...)` returns `state = standing` and §4 holds: pass `standing: { standing_id, move_id, action_fingerprint }` on `CapabilityExecutionInput` (outside `input.input`, like `trust_ask`) and `executor: "cleanroom"` on the context. In the runner: `decideCapability` gains `standing` → the `TOOL_POLICY` rule returns `allowed` with new reason code `standing` **only if** the runner's own fingerprint equals `standing.action_fingerprint` (that is B14's extra case: the standing move stands in for the same-run approval, for this fingerprint and chat only); a mismatch → `requires_approval` with reason `standing_mismatch` and the row `ended(mismatch)`. A ladder/decision row is written as today (`rung: rule`, `reason_code: standing`, `move_id` in the evidence).
- **Grant** — a code-owned check `settleSealing(run_id)` runs from two places: `markNotificationDelivered` (`:7253–7288`) when the delivered row is `<run_id>:final_report`, and the schedule tick's sweep (`src/run/schedule-tick.ts`, each tick) for rows in `sealing` whose run has ended. It reads the sealed call's `tool_finished` event (`executor = cleanroom`, `cleanroom.ran ∧ torn_down ∧ ¬tampered ∧ ¬escaped`, **plus `exit_code = 0` and `truncated = false`, which this slice adds to the event's `cleanroom` facts** — Slice 1 left them in memory only) and the outbox row's `state = delivered`. All true → `insertLadderMove({ entry_id: "tool.policy", scope: standing_id, from_rung: "paco", to_rung: "rule", granted_by: "auto", granted_via: "approval.standing", evidence: [standing_id, sealed_run_id, sealed_tool_call_id], revocable: 1 })`, row → `standing`, `expires_at = now + 30 d`, urgent card "From now on I'll run *<label>* for *<schedule name>* without asking — in a sealed folder, no background processes, TCP only" with `dec:sa:<standing_id>:revoke`. Any fact false or the run ended without delivery → `ended(sealed_trial_failed)` + digest line "this command needs files outside a sealed folder; it will keep asking". **Missing facts** (cancelled/timed-out call without `output`) = not a seal, never `ran: false`.
- **Revoke** — `dec:sa:<id>:revoke`: new parser family beside `dec:lm` (`src/triggers/telegram-command-parser.ts:344–362`), handler in `improvement-commands.ts` that ends the row and `endLadderMove(move_id)` (the move's chat comes from the standing row, not from a proposal — ruling 19's lookup does not apply here); reply through the rich renderer. `/schedule` (`src/gateway/gateway.ts:570–611`) gains a "常驻批准" section listing `standing` rows (`#N label · schedule name · expires`) with one Revoke button each (buttons already supported on the progress notification).
- **Expiry / schedule end** — the schedule tick ends `standing` rows past `expires_at` and rows whose schedule is cancelled or disabled; a cancelled schedule ends them immediately in `cancelScheduledTask`.
- **Kill switch** — unchanged: `postureOk()` refuses before any of this runs.

## 8. What the approval card and the digest say (reading A, Paco 2026-10-28)

- The fourth-run card (still a normal approval card) gains one line: "⏳ Third approval in a row — if you approve, this run goes in a sealed folder; if its report reaches you, I stop asking for this exact command."
- The grant card states the conditions: empty folder, fresh home, TCP egress only, no background processes (unenforced — a condition, not a guarantee), one byte changed asks again, Revoke any time.
- Digest: one line per `sealed_trial_failed` and per `ended(denied|expired|stale|mismatch)`.

## 9. Safety

- No model path can open, advance or grant: every transition is in code, keyed by consumed approval rows Paco tapped, and the grant reads the ledger's code-owned seal facts.
- The flag is set on the resume/first-execution context only after the store lookup; nothing on the adapter input changes, so the sealed fourth call and the standing calls have the **same fingerprint** as the three approvals (asserted by a test).
- Clean room unavailable → asks. Hostile turn → asks. Different chat/schedule → asks. Denial → 30-day block. Revoke → immediate.
- **Open window (stated, not closed):** a self-write test gate running concurrently can write into `<cache>/cleanroom/` as Paco until SP3; the post-run tamper check catches a plant that persists; the card does not claim otherwise.
- Posture `killed`, `houge.kill`, `/rearm` unchanged.

## 10. Tests and the live gate

Unit: state machine (every transition incl. expired-approval neutrality, different-key independence, deny block, stale); fingerprint helper ≡ runner; `TOOL_POLICY` `standing` reason only on fingerprint equality; `settleSealing` truth table over the six facts × delivery; revoke parser + handler; `/schedule` section rendering; migration idempotency.
Bridge: the fourth approved call carries `executor: "cleanroom"` on the resume context and the fifth carries it on the first call; an unscheduled call with the same bytes never does; a hostile scheduled call asks.
Live gate `scripts/live-gate-standing-approval.mjs` on a **VACUUM copy** of the live DB with a seeded schedule whose goal reproduces the Alishan shape (`curl -X POST … -c cj.txt -b cj.txt https://httpbin.org/post`), the real bridge, wrapper and clean room: three approvals (stubbed taps) → candidate; the fourth asks, approved → runs sealed (room, env, `tool_finished` facts) → report delivered → grant row + move + card payload; the fifth runs with **no card** through `cleanroom.sb`; a one-byte change asks; Revoke → the next run asks; sandbox off → the fifth asks; a planted `.curlrc` in a fresh home mid-run → `tampered` → no grant. Plus `scripts/check-standing-rollback.mjs`.

## Decision needed (Paco, at the spec tap)

1. **Card option + final tap (Rev 1) vs §8.3's automatic grant + Revoke card (this Rev).** Rev 1 added an "Always allow this exact command" option and a final tap after the sealed trial. §8.3, which ADR 0030 signed, makes candidacy automatic after three consumed approvals and grants automatically after the sealed fourth run, with an urgent Revoke card. **Recommended: §8.3** (one tap fewer; the fourth approval *is* the consent; Revoke is one tap).
2. **"Sealed trial under simulation" (Rev 1) vs the real fourth run in the real clean room (this Rev).** Recommended: the real run — the clean room exists now and the seal facts ride the ledger.
3. **Expiry 30 days** (Rev 1) kept; **deny block 30 days** (§8.3) kept.

## Rulings in this Rev (overturnable by review)

- Delivery = the run's `final_report` outbox row delivered (keyed by run; the sealed call's id is on the standing row), not a new `report_delivered_at` column.
- `exit_code`/`truncated` join the ledger's `cleanroom` facts (small Slice 1 follow-up inside this build).
- The fingerprint helper is exported from the runner, not reimplemented in the bridge.
- Streak accounting lives in the store's consume/resolve transactions (the only places that know "consumed" atomically).
