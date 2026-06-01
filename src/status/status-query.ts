import type { RunStatusRow, RunStore } from "../run/run-store.js";

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
  | { ok: true; status: { runs: RunStatusRow[] } }
  | { ok: false; error: { code: "RUN_NOT_FOUND"; message: string } };

export function queryStatus(store: RunStore, run_id?: string): StatusQueryResult {
  if (!run_id) return { ok: true, status: { runs: store.listRecentRunStatuses(10) } };

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
