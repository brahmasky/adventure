# Decision ladder, stage 4 slice A — standing approval for a scheduled command

- **Date:** 2026-10-26
- **Status:** draft for Paco's review
- **Amends:** ADR 0030 §4.3 (standing approval already named as the only automatic ladder move), `docs/ROADMAP.md`.
- **Build cut:** 2026-10-07 standing-approval build (explicitly queued), pulled forward, corrected after codex review.
- **Spec series:** decision ladder 0030 stage 4.

## 1. Goal

Stop re-asking Paco for approval of the **same** gated shell command from the **same** scheduled task (e.g. the daily Ali Shan `curl` POST), after Paco has approved it on three consecutive runs — **without** loosening approval for any other command, schedule, or turn outside a scheduled run. Standing approval is keyed so exactly that a change of even one character asks again.

## 2. Scope

In scope:
- An **"Always allow this exact command for this schedule"** option on the approval card, only when `requested_by.kind === "schedule"` (the gate already supplies `schedule_id`).
- A **standing-approval record** keyed byte-exactly by `(schedule_id, sha256(command bytes))` with **no normalization**.
- Automatic `allow` (no card) only when byte key + a **cleanroom-sealed trial** + hard eligibility checks all pass.
- A **three-tap streak** requirement (Paco grants candidate → cleanroom trial → one further tap → standing).
- `/schedule` surfaces active standing approvals with a revoke action.
- Revoke (Paco tap), expiry (30 days default), and streak reset on any denial/change.

Out of scope:
- endpoint-based allowlists (explicitly excluded by the 2026-10-07 note),
- cross-schedule or cross-command standing approval,
- any action on an unscheduled (Telegram) turn,
- trust-ledger autonomy promotion / the overall autonomy flip (Milestone A),
- all other Stage 4 mechanics (verifier + outcome memory, proposal artefact, scratch worktree …).

## 3. Byte-exact keying (codex-reported constraint)

- The standing key is `(schedule_id, sha256` over the adapter's canonical input (exact command bytes, quoting and separator preserved). Any character change in the command resets the key. No normalization.
- `schedule_id` comes only from the scheduler's run metadata (never guessed).

## 4. Eligibility for automatic allow (codex-reported)

Every invocation performs all hard checks **before** returning allow:
- originating chat id equals the granting chat,
- run origin is a scheduled run (`requested_by.kind === "schedule"`),
- turn trust is non-hostile,
- posture is not killed,
- turn approval cap not breached,
- fingerprint byte-identical to the granted one,
- the standing record has `state === standing` **and** a successful cleanroom-sealed trial earlier (ADR 0030 §8.3).

Any failed check falls back to a request and records the denial for the run.

## 5. Storage

- `standing_approvals`: `schedule_id`, `fingerprint`, but no command text/Pavo [redacted] — only the sealed `label` (command-matcher reason label).
- Ladder move records `entry_id: "tool.policy"`, `granted_via: "approval.standing"`, `granted_by: "paco"`, callback id = the granting approval id.
- `granted_via` only; `paco_callback_id` is the promoted approval's id.
- Retention 30 days default (configurable, Paco hand to change).
- Revoked/expired states retained for audit.

## 6. Sequenced grant path

1. sched run executes the command; it hits `requires_approval`. Paco taps Approve (or the standing candidate choice) **three times**.
2. Only after the proposal is accepted, a sealed trial runs under simulation (isolated temp dir/same Gates, no extra egress) with a final Paco tap on a signed report; a true cleanroom profile (cleanroom.sb) arrives only in Stage 4 #6 and is then required for promotes.
3. On trial success, one final Paco tap publishes the standing move.
4. Further scheduled runs whose exact fingerprint matches → automatic `allow` with a ladder row (`decided_by: rule`, reason `approval.standing`).
5. Deny/tamper/expired resets the streak and revokes standing, writes a revert.
6. `/schedule` lists active standing approvals with revoke/unseal actions.

`approval.standing` may only insert an auto move for `tool.policy`; all other moves carry a Paco callback (existing ADR §4.3).

## 7. Safety and adverse-impact

- Key exact; one byte change reset.
- Floors (posture/kill/SSRF/budget) still evaluated on automatic runs; if changed, asks.
- Revoke is immediate.
- Stand-up is never automatic without Paco's final tap after sealed proof.

## 8. Success criteria

- The Ali Shan scheduled POST command stops asking after three consecutive approvals plus one sealed run plus final tap.
- Any character change asks again.
- `/schedule` revoke restores asking next run.
- Unscheduled turns still ask.
- `entryProblems` clean; standing rows appear as `approval.standing` ladder moves.

## 9. Open items

- Cleanroom trial runtime and report staffing: does reuse the stage-4 proposal artefact (docs-only) count? Later.
- Per-schedule vs global threshold: stay per-schedule (simpler); Paco may opt global.
- Whether the old 2026-10-07 "standing approval" build remains adjacent instead of merged here; keep parallel and not duplicate.