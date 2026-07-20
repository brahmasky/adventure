# ADR 0017: Scheduler v1 — a new trigger source, the same spine

- **Status:** accepted
- **Date:** 2026-07-15
- **Deciders:** Paco
- **Relates to:** consumes the blast-radius net [ADR 0003](0003-global-budget-breaker.md)
  anticipated ("any future trigger source rides the same admission breaker"); rides
  [ADR 0004](0004-long-poll-daemon.md)'s poll loop and [ADR 0013](0013-llm-inner-composition.md)'s
  loop-tool pattern; roadmap backlog #1 (「等我确认后告诉你」, scheduled wiki refresh)

## Context

Houge could only ever act when spoken to: every run entered through a Telegram message or a
CLI invocation. Recurring intents ("AI 周报每周一早上8点", "remind me tomorrow 9am") had no
mechanical home — the model could only apologize or fake it. Meanwhile the type system had
carried **vestigial schedule types since Milestone 1** — `TriggerSource "schedule"`, the
`Identity {kind:"schedule"}`, the `ScheduleState` machine, and the `schedule_fired` /
`schedule_skipped_duplicate` ledger events — wired to nothing. The forces:

- A scheduled fire is a **self-initiated run**: no human is in the loop at fire time, so the
  safety story cannot be "Paco will notice" — it must be mechanical (charter: safety nets,
  not approvals).
- The daemon is single-process and single-threaded around the poll loop; the scheduler must
  not add a second process, a cron dependency, or an npm package (`dependencies: {}`).
- Wall-clock schedules are stated in a HUMAN timezone ("08:00 Sydney"), and Sydney changes
  offset twice a year — naive UTC-offset math fires an hour off after every DST transition.

## Decision

Scheduler v1 wires the vestigial types live, as **a new trigger source feeding the exact same
gateway→worker path** a Telegram message takes. Nothing downstream is scheduler-aware.

1. **Store:** a `scheduled_tasks` table (schedule_id, chat_id, goal, spec_json, tz, state,
   next_run_at, consecutive_failures…). Row state is the durable subset of `ScheduleState` —
   `enabled|disabled|failed`; `fired/enqueued/skipped_duplicate` are **per-fire ledger
   events**, not row states. Rows are never deleted (cancel = `disabled`).
2. **Spec v1** (`src/run/schedule-spec.ts`): `{kind:"weekly",day,at}` | `{kind:"daily",at}` |
   `{kind:"once",at_iso}`, with an IANA `tz` stored beside. Next-run math reuses the
   DST-correct fixed-point solver (`wallClockToInstant`, now exported from
   `src/prompt/tz-convert.ts`) and walks calendar dates — a weekly 08:00 Sydney schedule
   lands 08:00 local on both sides of the Oct 2026 DST start (encoded as a test).
3. **Creation from conversation:** a `schedule_task` loop tool (armed-listed behind
   `HOUGE_SCHEDULER_ENABLED`, default OFF), mirroring `lesson_write`'s `none/low` side-effect
   class — creating a schedule is local sqlite bookkeeping; the FIRE is where real cost
   happens, and that rides the gated normal path. Everything model-supplied is validated or
   sanitized in code; creation is capped per chat (`HOUGE_SCHEDULER_MAX_PER_CHAT`, default 10).
4. **Firing:** a per-cycle daemon tick (`maybeFireScheduledTasks`, on the signal-path tick)
   queries due enabled rows, caps 3 fires/tick, and builds a `turn` event with
   `source:"schedule"`, `requested_by:{kind:"schedule",id}`, and
   `idempotency_key: schedule:<id>:<next_run_at>` → `gateway.intake` → `worker.executeRun`.
   **Misfire policy: fire-then-advance from NOW.** The cursor advances via
   `markScheduleFired` BEFORE the run executes (a crash mid-run must not re-fire; the
   idempotency key also dedupes a crash replay into `schedule_skipped_duplicate`), and a
   `next_run_at` found in the past (daemon downtime) fires ONCE with the next occurrence
   computed from now — missed periods never burst-fire. Three consecutive fire failures park
   the row as `failed` — except a global-budget-fuse refusal, which PAUSES the schedule
   (no failure count, cursor kept): the breaker is this feature's designed net and a fuse is
   an hours-long episode, not a schedule defect. Known at-most-once window (accepted v1):
   a crash between the advance and `executeRun` leaves that occurrence's run queued and
   unexecuted — a `once` schedule can die unfired. Residual: sweep queued schedule-sourced
   runs at boot.
5. **Safety nets, not new gates:** the **global 24h budget breaker (ADR 0003) is the blast
   radius net** — a runaway schedule exhausts its admission budget and fuses exactly like a
   runaway human. The schedule source deliberately **skips the Telegram rate limiter** (that
   limiter models a human actor's command window; a schedule's discipline is the per-tick
   fire cap + per-chat creation cap + breaker) and **skips rating capture** (a stored goal
   that is a bare digit is a task, not a rating reply — guarded in `captureRatingReply`).
6. **Owner controls:** `/schedule` lists the requesting chat's schedules; `/schedule cancel
   <id>` disables one — scoped to the requesting chat (a cross-chat cancel reads exactly like
   not-found). The `schedule_task` tool accepts `{"cancel":"sch_…"}` with the same scoping.

## Consequences

- Houge gains proactive, self-initiated runs with zero new processes, packages, or approval
  gates; scheduling precision is one poll cycle (~30s long-poll), which is ample for
  human-scale schedules.
- Every fire is fully audited (`schedule_fired`/`schedule_skipped_duplicate` + the normal run
  ledger) and idempotent; the vestigial types are now live, so the type system matches
  reality again.
- The breaker becomes the real backstop for autonomous load — if scheduled traffic ever
  crowds out interactive runs, the fix is a per-source budget split (a future ADR), not a
  weaker scheduler.
- Delivery is Telegram-only in v1 (`notify {kind:"telegram", chat_id}` stored per schedule);
  a `local`-target schedule is not representable. Fine for the Telegram-first daemon.
- `once` schedules disable themselves after firing; recurring rows live until cancelled or
  failed. The `/schedule` list shows `failed` rows loudly (⚠) so a parked schedule is never
  silently dead.

## Alternatives considered

- **OS cron / launchd per schedule:** an external mutation surface outside the ledger and the
  breaker; violates single-source-of-truth (sqlite) and adds ops surface. Rejected.
- **A separate scheduler process:** real isolation, but a second daemon to babysit and an IPC
  seam for zero benefit at this scale. Rejected.
- **Catch-up (burst) misfire semantics:** firing every missed period after downtime floods
  the chat and the budget with stale runs; a user wants the LATEST weekly report once, not
  four of them. Rejected for fire-once-then-advance-from-now.
- **Storing next_run_at as a UTC offset computed at creation:** breaks at every DST edge;
  the wall-clock + tz pair with per-occurrence conversion is the user's actual contract.
  Rejected.
- **An approval gate on schedule creation:** creation is reversible bookkeeping; the charter
  says mechanical nets over human approvals, and the fire path already carries every gate a
  normal run has. Rejected.

## Amendment — Scheduler v2 (2026-07-20)

Incident: the 2026-07-19 weekly AI周报 fire replayed its goal as a fresh turn; the model
misread the goal text as a request to CREATE the schedule and minted a duplicate row
(`sch_b6095c61`). Separately, user feedback refining the report ("以后加上悉尼AI工作机会")
had no durable landing — the tool had no update verb, so the promise lived only in chat.

Four changes, each independently shippable:

1. **Provenance strip** — `compileTurnContract` removes `schedule_task` from
   `allowed_actions` when `event.source === "schedule"`. A run born from a schedule fire
   cannot create/mutate schedules; the manifest derives from the contract, so the tool
   never reaches the model's menu. Enforcement, not prompt advice.
2. **`{list:true}` verb** — own-chat discovery for the model, same renderer as `/schedule`
   (moved to `schedule-spec.ts`, re-exported from gateway).
3. **`{update:"sch_…"}` verb** — partial in-place edit (goal/spec/tz), own-chat scoped
   with not-found-identical refusals, goal through the same sanitizer as create,
   `next_run_at` recomputed only when spec/tz change. Updating a `failed` row re-enables
   it (repair path). Re-enable may exceed the per-chat cap: accepted — the cap remains a
   creation guard, not an invariant.
4. **Dedup-on-create** — an enabled row with identical chat+spec+tz+goal makes creation
   an idempotent no-op returning the existing id (checked before the cap, so idempotent
   retries never bounce off a full cap).

Verb precedence is a spec'd invariant: first match wins, `list → cancel → update → create`.

Unchanged: fire path, fire idempotency, per-chat cap semantics on genuine creates,
`/schedule` command behavior, `none/low` side-effect class (all four verbs are local
sqlite bookkeeping).
