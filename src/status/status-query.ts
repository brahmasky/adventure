import {
  GLOBAL_BUDGET_WINDOW_HOURS,
  resolveGlobalBudgetCaps,
  type GlobalBudgetCaps,
  type GlobalBudgetHeadroom
} from "../budget/global-budget-ledger.js";
import type { PollHeartbeat, RatingStatus, RunStatusRow, RunStore } from "../run/run-store.js";
import { resolveRatingPendingMinutes } from "../capabilities/session-rating.js";

/** Rolling-window operational summary shown when no specific run is requested. */
export interface StatusOverview {
  window_hours: number;
  runs_by_state: Record<string, number>;
  last_error: string | null;
  budget: GlobalBudgetHeadroom[];
  /** Daemon poll heartbeat, or null if the always-on daemon has never run. */
  poller: PollHeartbeat | null;
  /** Session-rating state (⓪·3 S2c): an open ask + the last capture. */
  rating: RatingStatus;
  /** Invariant-sweep self-check (ADR 0024): when it last swept + how many incidents are open. */
  sweep: { last_swept_at: string | null; open_incidents: number };
}

export type StatusQueryResult =
  | {
      ok: true;
      status: {
        run_id: string;
        state: string;
        program: string | null;
        goal: string | null;
        event_count: number;
      };
    }
  | { ok: true; status: { runs: RunStatusRow[]; overview: StatusOverview } }
  | { ok: false; error: { code: "RUN_NOT_FOUND"; message: string } };

export interface StatusQueryOptions {
  now?: string;
  caps?: GlobalBudgetCaps;
}

export function queryStatus(
  store: RunStore,
  run_id?: string,
  options: StatusQueryOptions = {}
): StatusQueryResult {
  if (!run_id) {
    const now = options.now ?? new Date().toISOString();
    const caps = options.caps ?? resolveGlobalBudgetCaps(process.env);
    return {
      ok: true,
      status: {
        runs: store.listRecentRunStatuses(10),
        overview: {
          window_hours: GLOBAL_BUDGET_WINDOW_HOURS,
          runs_by_state: store.runCountsByStateSince(now),
          last_error: store.lastRunError(),
          budget: store.globalBudgetUsage(caps, now),
          poller: store.getPollHeartbeat(),
          rating: store.getRatingStatus(now, resolveRatingPendingMinutes(process.env) * 60_000),
          sweep: {
            last_swept_at: store.getInvariantSweepState()?.last_swept_at ?? null,
            open_incidents: store.listOpenIncidents().length
          }
        }
      }
    };
  }

  const row = store.getRunStatus(run_id);
  if (!row) {
    return { ok: false, error: { code: "RUN_NOT_FOUND", message: `Run not found: ${run_id}` } };
  }

  return {
    ok: true,
    status: {
      run_id: row.run_id,
      state: row.state,
      program: row.program,
      goal: row.goal,
      event_count: row.event_count
    }
  };
}
