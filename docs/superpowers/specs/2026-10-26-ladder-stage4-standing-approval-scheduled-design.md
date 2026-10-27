# Decision ladder, stage 4 slice A — standing approval for a scheduled command

- **Date:** 2026-10-26
- **Status:** draft for Paco's review
- **Amends:** ADR 0030 §4.3 (standing approval already named as the only automatic ladder move), `docs/ROADMAP.md`.
- **Build cut:** 2026-10-07 short build (the one explicitly queued there), pulled forward.
- **Spec series:** decision ladder 0030 stage 4.

## 1. Goal

Stop re-asking Paco for approval of the **same** gated shell command from the **same** scheduled task (e.g. the daily Ali Shan `curl` POST), after Paco has approved it on three consecutive runs — **without** loosening approval for any other command, any other schedule, or any turn outside a scheduled run. Standing approval is keyed so narrowly that a change of even one character in the command asks again.

## 2. Scope

In scope:
- An **"Always allow this exact command for this schedule"** option on the approval card, only when the call originates from a scheduled run (the gate already carries `requested_by.kind === "schedule"` + schedule id).
- A **standing-approval record** keyed by `(schedule_id, command_fingerprint)`.
- Automatic `allow` (no card) when an incoming **scheduled** request's command fingerprint matches an active standing approval for that schedule.
- A streak tracker that requires **three consecutive approved runs** before a user-granted standing candidate appears as an option on the card (so one accidental approval does not grant forever).
- `/schedule` surfaces active standing approvals with a revoke action.
- Revoke and expiry (streak break when the command changes, or Paco denies).

Out of scope:
- endpoint-based allowlists (explicitly excluded in the 2026-10-07 note),
- cross-schedule or cross-command standing approval,
- any action on an unscheduled (Telegram-originated) turn,
- trust-ledger autonomy promotion / overall autonomy flip (Milestone A),
- all other Stage 4 mechanics (verifier + outcome memory, proposal artefact, scratch worktree …).

## 3. Why three taps

A single accidental approve is cheap to recover from; three consecutive is strong evidence the command is a stable scheduled routine. This matches the decision ladder's trust-the-streak promotion rule. Streak resets on any denial, command infingerprint change, change of `cmdhash`, or outcome abandon.

## 4. Keying

- Fingerprint: `sha256(normalized command)`. The command is split and token-normalized the same way `command-matcher.ts` already normalizes whitespace, then hashed. **schedule_id** comes from the scheduler's run metadata (never a guessed value).
- `(schedule_id, fingerprint)` composite is the only grant key.
- Standing approvals are inert on any turn without a `requested_by.schedule` source. The gate checks this hard, not the user-facing note.

## 5. Storage and surface

- A new `standing_approvals` table: `schedule_id`, `fingerprint`, `label` (never the command text or any secret), `grants` counter (only bumped on a real approval), `consecutive_approvals` (reset on denial), `threshold` (3 in code, configurable but defaults locked), `state` (`candidate | standing | revoked | expired`), `granted_at`, `last_used`, `expires_at` (reuse-viability window; 30 days default).
- `granted_via` in the corresponding ladder move is `approval.standing`, per ADR 0030 §4.3, only for `tool.policy`.
- `/schedule` adds a "Standing approvals" line per schedule with a `Revoke` tap. No card text echoes command text beyond `$label` (the command-matcher label already shown).

## 6. Decision-edge (code-owned, monotone)

The streak is a rule rung before the paco rung. On each scheduled run:
1. compute fingerprint and lookup standing row.
2. if `state === standing` and fingerprint matches → `allow` (decision ladder row, `decided_by: rule`, reason `approval.standing`); else
3. if `consecutive_approvals >= threshold` → raise candidate card *in addition* to the normal Approve, "Always allow this exact command for this schedule"; Paco may Approve once or grant standing.
4. otherwise → normal Approve card.

If Paco denies, set `state=revoked`, reset the streak, and a ladder move rows the denial.
Houge never promotes on its own without Paco's tap; a candidate is a proposal only.

## 7. Safety and adverse-impact

- The streak lives only for this `(schedule, command)` key. Changing a single byte resets it.
- Posture/kill-switch floors on every pass still ask if a safety condition changes.
- Stand-up is revocable from `/schedule` at any time.
- A denied scheduled run writes an audit/incident? Possibly an alert after 3 revocations. For now just a log.

## 8. Success criteria

- The Ali Shan scheduled `curl`-POST command stops asking after 3 manual approvals; any changed byte asks again; a `/schedule` revoke immediately restores asking; unscheduled turns still ask.
- `shouldRecord` rows show `approval.standing` as the decider.
- `entryProblems` remains clean.

## 9. Open items

- Whether the threshold should be per-schedule or global — per spec, per-schedule is simpler. Paco chooses.
- Cross-approval standing at the `tool.policy` level rather than command-level — deferred to later stage 4 trust-ledger slice.
- The earlier "standing approval for a scheduled command" mini-build and the ladder stage 4 promotion rules merge here or stay adjacent? Either an amendment.

Spec self-review: scope tight; reason codes must be closed (use `approval.standing`, no extra free text); test-only via charisation/real scheduled run replay. Live gate requires a scheduled run series + Telegram approval taps.