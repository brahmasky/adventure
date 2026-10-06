import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Generic Jev replay loop (ADR 0029 §3.6), lifted from `replay.ts`: source → prepare → dispatch → append-only JSONL of
 * ids and numbers. Sequential (one reservation at a time keeps --max-usd exact), resumable (latest row per key wins), and
 * a dry run writes nothing. `replay.ts` keeps its own loop; this one serves the lane replays.
 */
export interface ReplayRowBase { key: string; status: string; est_usd: number; attempt?: number; usd?: number; stop?: "auth" | "fused" }
export interface ReplayCoreDeps<Row extends ReplayRowBase> {
  source: () => Array<{ key: string }>;
  prepare: (src: { key: string }) => Promise<Row | { skip: Row }>;
  dispatch: (row: Row) => Promise<Row>;
  estimateUsd: (row: Row) => number;
  outPath: string;
  maxUsd: number;
  dryRun: boolean;
  doneStatuses: ReadonlySet<string>;
  log?: (line: string) => void;
}
export interface ReplayCoreOutcome<Row> {
  rows: Row[]; spentUsd: number; estimatedUsd: number; stopped?: "budget" | "auth" | "fused";
  /** Source size, keys this run would send (dry run) or sent, keys already done in the file, keys newly skipped. */
  universe: number; wouldDispatch: number; alreadyDone: number; skipped: number;
}

interface ReplayLog { done: Map<string, Record<string, unknown>>; attempts: Map<string, number> }

function readLog(outPath: string, doneStatuses: ReadonlySet<string>): ReplayLog {
  const done = new Map<string, Record<string, unknown>>();
  const attempts = new Map<string, number>();
  if (!existsSync(outPath)) return { done, attempts };
  for (const line of readFileSync(outPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; } // a torn last line is re-done, not fatal
    if (typeof row.key !== "string" || typeof row.status !== "string") continue;
    attempts.set(row.key, (attempts.get(row.key) ?? 0) + 1);
    if (doneStatuses.has(row.status)) done.set(row.key, row);
    else done.delete(row.key); // latest row wins: a later failure re-opens the key (replay.ts readDone)
  }
  return { done, attempts };
}

/** Keys whose LATEST row has a done status, with that row. Append-only, torn-line tolerant. */
export function readDone(outPath: string, doneStatuses: ReadonlySet<string>): Map<string, Record<string, unknown>> {
  return readLog(outPath, doneStatuses).done;
}

function emit(outPath: string, row: unknown): void {
  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, `${JSON.stringify(row)}\n`);
}

export async function runReplayCore<Row extends ReplayRowBase>(d: ReplayCoreDeps<Row>): Promise<ReplayCoreOutcome<Row>> {
  const { done, attempts } = readLog(d.outPath, d.doneStatuses);
  const sources = d.source();
  const o: ReplayCoreOutcome<Row> = { rows: [], spentUsd: 0, estimatedUsd: 0, universe: sources.length, wouldDispatch: 0, alreadyDone: 0, skipped: 0 };
  for (const src of sources) {
    const prior = done.get(src.key);
    if (prior) { o.rows.push(prior as unknown as Row); o.alreadyDone += 1; continue; }
    const prepared = await d.prepare(src);
    if ("skip" in prepared) {
      if (!d.dryRun) emit(d.outPath, prepared.skip);
      o.rows.push(prepared.skip); o.skipped += 1; continue;
    }
    const est = d.estimateUsd(prepared);
    o.estimatedUsd += est; o.wouldDispatch += 1;
    if (d.dryRun) { o.rows.push({ ...prepared, status: "dry_run", est_usd: est }); continue; }
    if (o.spentUsd + est > d.maxUsd) { o.wouldDispatch -= 1; o.stopped = "budget"; d.log?.(`stopping: next request would exceed --max-usd ${d.maxUsd}`); break; }
    const out = await d.dispatch({ ...prepared, est_usd: est, attempt: (attempts.get(src.key) ?? 0) + 1 });
    emit(d.outPath, out); o.rows.push(out);
    o.spentUsd += out.usd ?? est; // every dispatched attempt counts against the cap: a failed call may still bill
    d.log?.(`${o.rows.length}/${o.universe} ${src.key} ${out.status}`);
    if (out.stop) { o.stopped = out.stop; break; }
  }
  return o;
}
