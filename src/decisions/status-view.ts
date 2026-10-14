import type { DecisionRow, RunStore } from "../run/run-store.js";
import { JEV_NOT_ATTEMPT_REASONS } from "../run/invariant-sweep.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import { countLines, decisionWindow, deciderLabel, injectionCounts, trustTops } from "./digest.js";

/**
 * The decision ladder in `/status` (Paco 2026-10-14): a short section over the digest's own counting code, so the two never
 * disagree, and `/status decisions`, the newest rows. Code-built from ids, closed enums and numbers; never tool or user text.
 */
export const RECENT_DECISIONS = 10;

/** Logged Jev failures (his ruling: skipped rows, no alert), by reason; skips that were never a call are left out. */
function jevFailureLine(store: RunStore, since: string, now: string): string {
  const by = store.countJevSkipsByReason(since, now, JEV_NOT_ATTEMPT_REASONS);
  const total = by.reduce((a, r) => a + r.n, 0);
  return total === 0 ? "Jev failures: none" : `Jev failures: ${total} (${by.map((r) => `${r.skip_reason} ${r.n}`).join(" · ")})`;
}

/**
 * The `/status` block, led by a blank line, or nothing when the last 24 h hold no settled decision. "Not checked": a
 * tool.injection judgement whose Jev rung was lost (the digest's "judgement lost"; an outside passage is then framed).
 */
export function decisionStatusLines(store: RunStore, now: string): string[] {
  const { since, rows } = decisionWindow(store, now);
  if (rows.length === 0) return [];
  const inj = injectionCounts(rows);
  const hostile = [...trustTops(rows).values()].filter((l) => l === "hostile").length;
  return ["", "🪜 DECISIONS (24h)", ...countLines(rows), jevFailureLine(store, since, now),
    `Injection: withheld ${inj.withheld} · framed ${inj.framed} · not checked ${inj.lost}`, `Hostile turns: ${hostile}`];
}

/** `run_<uuid>` → its first 8 characters after the prefix; a run-less row shows "–". */
const shortRun = (run_id: string | null): string => (run_id ? run_id.replace(/^run_/, "").slice(0, 8) : "–");

function recentLine(r: DecisionRow, tz: string): string {
  const at = formatInstantInZone(r.created_at, tz).slice(5);
  const p = r.p === null ? "–" : r.p.toFixed(2);
  return `${at} · ${r.entry_id} · ${deciderLabel(r.rung)} → ${r.verdict} · p ${p} · run ${shortRun(r.run_id)}`;
}

/** `/status decisions`: the newest RECENT_DECISIONS rows in the display zone, newest first. */
export function decisionListText(store: RunStore, env: NodeJS.ProcessEnv = process.env): string {
  const rows = store.listRecentDecisions(RECENT_DECISIONS);
  const tz = resolveDisplayZone(env);
  const head = `🪜 Last ${RECENT_DECISIONS} decisions`;
  return rows.length === 0 ? `${head}\nNo decisions recorded yet.` : [head, ...rows.map((r) => recentLine(r, tz))].join("\n");
}
