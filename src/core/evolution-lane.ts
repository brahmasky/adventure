import type { NotificationButton } from "../notifications/notification-types.js";

/**
 * The evolution lane (⓪·3g "THE LANE FIX", ADR 0012). The daemon is single-threaded and
 * evolution pipelines (self_write_propose / self_diagnose / skill_author) take minutes;
 * ⓪·3g backgrounds them so the poll loop keeps answering. This module is the SINGLETON
 * lane state: at most ONE pipeline runs at a time, tracked as one background promise.
 *
 *  - The tool adapter tries to CLAIM the lane; a busy lane refuses the kickoff.
 *  - The claimed pipeline runs under a wall-clock cap (its sub-contract time budget,
 *    Promise.race). Completion/failure/timeout delivers exactly ONE code-owned outcome
 *    (the durable completion notification — the "evolution outcome always reaches the
 *    user" guarantee moved here from the turn's withEvolutionNotices).
 *  - The lane is ALWAYS released in finally; the daemon awaits `evolutionLaneSettled()`
 *    on shutdown so an in-flight self-write is never killed mid-pipeline.
 *
 * On a timeout the lane is released and the failure outcome delivered, but the orphaned
 * pipeline promise is not (cannot be) cancelled — its own spawn timeouts bound it, its
 * worktree teardown stays in its own finally, and a late completion delivers NOTHING
 * (the once-only guard below).
 */

export interface EvolutionLaneCurrent {
  run_id: string;
  tool: string;
  started_at: string;
}

/** A pipeline's user-facing completion outcome: publish text + buttons, or failure text. */
export interface EvolutionLaneOutcome {
  text: string;
  buttons?: NotificationButton[];
}

interface LaneState {
  busy: boolean;
  current?: EvolutionLaneCurrent;
  promise?: Promise<void>;
}

const lane: LaneState = { busy: false };

/** Busy-refusal digest the tool adapter returns when a second evolution ask arrives. */
export const EVOLUTION_LANE_BUSY_DIGEST = "已有一个自我修改在进行中，等它完成再说 🐒";

/** Read-only snapshot for /status and the daemon's shutdown path. */
export function evolutionLaneSnapshot(): { busy: boolean; current?: EvolutionLaneCurrent } {
  return { busy: lane.busy, ...(lane.current ? { current: { ...lane.current } } : {}) };
}

/** Resolves when the in-flight pipeline (if any) has fully settled; immediate when idle. */
export async function evolutionLaneSettled(): Promise<void> {
  const p = lane.promise;
  if (p) await p;
}

/** Test seam: force the lane back to idle (never used in production wiring). */
export function resetEvolutionLaneForTests(): void {
  lane.busy = false;
  delete lane.current;
  delete lane.promise;
}

/**
 * Try to start a pipeline on the lane. Returns false (nothing launched) when the lane is
 * busy. Otherwise claims the lane, launches `run` as ONE tracked background promise under
 * the `capMs` wall clock, delivers exactly one outcome via `deliver` (success outcome,
 * `onTimeout()` on cap expiry, `onError(detail)` on a throw), and releases the lane in
 * finally. `deliver` errors are swallowed + logged — the lane must always come free.
 */
export function tryStartEvolutionPipeline(opts: {
  current: EvolutionLaneCurrent;
  capMs: number;
  run: () => Promise<EvolutionLaneOutcome>;
  onTimeout: () => EvolutionLaneOutcome;
  onError: (detail: string) => EvolutionLaneOutcome;
  deliver: (outcome: EvolutionLaneOutcome) => void;
}): boolean {
  if (lane.busy) return false;
  lane.busy = true;
  lane.current = { ...opts.current };

  let delivered = false;
  const deliverOnce = (outcome: EvolutionLaneOutcome): void => {
    if (delivered) return; // a late orphan completion after a timeout delivers nothing
    delivered = true;
    try {
      opts.deliver(outcome);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[evolution-lane] failed to deliver ${opts.current.tool} outcome (non-fatal): ${detail}`);
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.capMs);
    timer.unref?.();
  });

  lane.promise = (async () => {
    try {
      const raced = await Promise.race([
        opts.run().then(
          (outcome) => ({ kind: "done" as const, outcome }),
          (error) => ({ kind: "error" as const, detail: error instanceof Error ? error.message : String(error) })
        ),
        timeout.then(() => ({ kind: "timeout" as const }))
      ]);
      if (raced.kind === "timeout") deliverOnce(opts.onTimeout());
      else if (raced.kind === "error") deliverOnce(opts.onError(raced.detail));
      else deliverOnce(raced.outcome);
    } finally {
      if (timer) clearTimeout(timer);
      lane.busy = false;
      delete lane.current;
      delete lane.promise;
    }
  })();

  return true;
}
