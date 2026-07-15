import { buildTypedTaskEvent } from "../domain/types.js";
import type { TypedTaskEvent } from "../domain/types.js";
import type { GatewayIntakeResult } from "../gateway/gateway.js";
import {
  computeNextRunAt,
  parseScheduleSpec,
  resolveSchedulerEnabled,
  type ScheduleSpec
} from "./schedule-spec.js";
import type { RunStore, ScheduledTaskRow } from "./run-store.js";

/**
 * The scheduler's fire tick (B10b, ADR 0017): rides the daemon's per-cycle signal-path
 * tick, queries due enabled schedules, and replays each schedule's goal as a fresh `turn`
 * through the SAME gateway→worker path a Telegram message takes — the breaker, contracts,
 * and policy all apply unchanged. Flag-gated OFF (`HOUGE_SCHEDULER_ENABLED`); fires are
 * capped per tick; every fire is idempotent on `schedule:<id>:<next_run_at>` so a crash
 * replay dedupes into `schedule_skipped_duplicate` instead of a second run.
 */

/** Cap on fires per tick — a backlog drains across cycles instead of starving the poll loop. */
export const SCHEDULE_TICK_MAX_FIRES_PER_TICK = 3;

/** Consecutive fire failures before a schedule's row flips to 'failed' (stops retrying). */
export const SCHEDULE_MAX_CONSECUTIVE_FAILURES = 3;

/** worker_id stamped on runs the tick executes (lease audit trail). */
export const SCHEDULE_TICK_WORKER_ID = "schedule-tick";

/** Structural seams (the daemon passes the real Gateway/CoreWorker; tests inject fakes). */
export interface ScheduleTickGateway {
  intake(event: TypedTaskEvent, now?: string): GatewayIntakeResult;
}

export interface ScheduleTickWorker {
  executeRun(run_id: string, worker_id: string): Promise<unknown>;
}

export interface ScheduleTickInput {
  store: RunStore;
  gateway: ScheduleTickGateway;
  worker: ScheduleTickWorker;
  now: string;
  env?: NodeJS.ProcessEnv;
}

export interface ScheduleTickResult {
  fired: number;
  skipped_duplicates: number;
  failures: number;
}

/**
 * Fire due schedules (at most {@link SCHEDULE_TICK_MAX_FIRES_PER_TICK}). Per task:
 * intake → on created: advance next_run_at (fire-then-run — a crash mid-run must not
 * re-fire this occurrence), append `schedule_fired`, execute; on duplicate: advance +
 * append `schedule_skipped_duplicate`; on refusal/throw: do NOT advance (retry next
 * tick), count a failure — three consecutive flip the row to 'failed'. MISFIRE policy:
 * a `next_run_at` in the past (daemon was down) fires ONCE now and the advance computes
 * from NOW, so missed periods never burst-fire.
 */
export async function maybeFireScheduledTasks(input: ScheduleTickInput): Promise<ScheduleTickResult> {
  const env = input.env ?? process.env;
  const result: ScheduleTickResult = { fired: 0, skipped_duplicates: 0, failures: 0 };
  if (!resolveSchedulerEnabled(env)) return result;

  for (const task of input.store.listDueScheduledTasks(input.now, SCHEDULE_TICK_MAX_FIRES_PER_TICK)) {
    try {
      await fireScheduledTask(task, input, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[schedule-tick] ${task.schedule_id} fire failed: ${message}`);
      input.store.recordScheduleFailure(task.schedule_id, input.now, SCHEDULE_MAX_CONSECUTIVE_FAILURES);
      result.failures += 1;
    }
  }
  return result;
}

async function fireScheduledTask(
  task: ScheduledTaskRow,
  input: ScheduleTickInput,
  result: ScheduleTickResult
): Promise<void> {
  const spec = parseScheduleSpec(task.spec_json);
  if (!spec) {
    // A corrupt stored spec can never fire — count it toward 'failed' instead of throwing.
    console.error(`[schedule-tick] ${task.schedule_id} has an unparseable spec — skipping`);
    input.store.recordScheduleFailure(task.schedule_id, input.now, SCHEDULE_MAX_CONSECUTIVE_FAILURES);
    result.failures += 1;
    return;
  }

  // The stored cursor names the OCCURRENCE: it keys idempotency, so a crash between
  // intake and the advance below replays into the SAME run (duplicate), never a second.
  const scheduled_time = task.next_run_at;
  const event = buildTypedTaskEvent({
    source: "schedule",
    type: "turn",
    program: "turn",
    goal: task.goal,
    requested_by: { kind: "schedule", id: task.schedule_id },
    notify: { kind: "telegram", chat_id: task.chat_id },
    idempotency_key: `schedule:${task.schedule_id}:${scheduled_time}`,
    source_reference: `scheduled_tasks.${task.schedule_id}`,
    created_at: input.now
  });

  const intake = input.gateway.intake(event, input.now);
  if (!intake.ok) {
    if (intake.error.code === "GLOBAL_BUDGET_FUSE") {
      // The breaker is this feature's designed blast-radius net (ADR 0003/0017): a fuse
      // is an hours-long PAUSE, not a schedule defect. Don't count it toward 'failed' —
      // leave next_run_at untouched and the misfire policy delivers exactly one catch-up
      // fire when the fuse lifts. (Verifier F3: counting fuse refusals bricked every
      // schedule that came due during a fuse, in about three poll cycles.)
      console.error(`[schedule-tick] ${task.schedule_id} paused by global budget fuse`);
      return;
    }
    // Other refusals (contract failure etc.): leave next_run_at untouched so the next
    // tick retries this same occurrence; three consecutive refusals park the row as 'failed'.
    console.error(`[schedule-tick] ${task.schedule_id} intake refused: ${intake.error.code}`);
    input.store.recordScheduleFailure(task.schedule_id, input.now, SCHEDULE_MAX_CONSECUTIVE_FAILURES);
    result.failures += 1;
    return;
  }

  advanceSchedule(task, spec, input);

  if (intake.status === "duplicate") {
    input.store.recordScheduleSkippedDuplicate({
      schedule_id: task.schedule_id,
      scheduled_time,
      idempotency_key: event.idempotency_key,
      existing_run_id: intake.run_id
    });
    result.skipped_duplicates += 1;
    return;
  }

  if (intake.status !== "created") {
    // Defensive: a turn intake only ever returns created/duplicate (the rating-capture
    // path skips schedule events by design — gateway.ts). Anything else is a wiring bug.
    console.error(`[schedule-tick] ${task.schedule_id} unexpected intake status: ${intake.status}`);
    return;
  }

  input.store.recordScheduleFired({
    run_id: intake.run_id,
    schedule_id: task.schedule_id,
    scheduled_time,
    command_hash: event.payload_hash
  });
  result.fired += 1;
  await input.worker.executeRun(intake.run_id, SCHEDULE_TICK_WORKER_ID);
}

/**
 * Advance the fire cursor for a consumed occurrence. `once` schedules fire exactly once —
 * the row flips to 'disabled' (reversible, never deleted). Recurring schedules recompute
 * from NOW (the misfire policy's single-catch-up guarantee); a row whose next occurrence
 * cannot be computed (e.g. a stored tz that no longer resolves) flips straight to 'failed'
 * rather than staying due forever.
 */
function advanceSchedule(task: ScheduledTaskRow, spec: ScheduleSpec, input: ScheduleTickInput): void {
  if (spec.kind === "once") {
    input.store.markScheduleFired(task.schedule_id, input.now, task.next_run_at);
    input.store.cancelScheduledTask(task.schedule_id, input.now);
    return;
  }
  const next = computeNextRunAt(spec, task.tz, input.now);
  if (next) {
    input.store.markScheduleFired(task.schedule_id, input.now, next);
  } else {
    console.error(`[schedule-tick] ${task.schedule_id} next occurrence uncomputable — parking as failed`);
    input.store.markScheduleFired(task.schedule_id, input.now, task.next_run_at);
    input.store.recordScheduleFailure(task.schedule_id, input.now, 1);
  }
}
