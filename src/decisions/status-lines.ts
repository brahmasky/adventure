import type { DecisionRow, RunStore } from "../run/run-store.js";
import { resolveImproveEnabled } from "../improve/flag.js";
import { ATTACH_PATH_ID } from "./entries/attach-path.js";
import { SETTLE_HEALTH_REASONS, TURN_SETTLE_ID } from "./entries/turn-settle.js";
import { TRUST_ORDER, rankOf, type TrustLevel } from "./entries/turn-trust.js";
import type { DecidedBy } from "./types.js";

/** The counting code `/status` reads (spec 2026-11-07 §8), moved out of the digest unchanged. */
export const DECISION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A Jev verdict within 0.15 of 0.5 is "near the bar". */
export const NEAR_BAR_BAND = 0.15;
const RUNG_ORDER: readonly DecidedBy[] = ["rule", "system_one", "model", "paco", "fail"];
/** Entries whose rows settleTriage writes with the turn's verdict (plan ruling 14). */
const FRONT_DOOR: ReadonlySet<string> = new Set(["turn.handler", "turn.gear"]);
/** What Paco reads for each rung in the counts line: display words, never the ledger tags. */
const RUNG_LABEL: Readonly<Record<DecidedBy, string>> = { rule: "code", system_one: "Jev", model: "model", paco: "you", fail: "fallback" };
/** A row's decider as Paco reads it; a rung outside the known set shows as its own tag, never hidden. */
export const deciderLabel = (rung: string): string => (Object.hasOwn(RUNG_LABEL, rung) ? RUNG_LABEL[rung as DecidedBy] : rung);

/**
 * Plan ruling 14: a front-door row counts only when its run's verdict links it. Stage 1 writes the two atomically, so this
 * only guards a future path that leaves a row behind (a lost or killed turn must never be offered for review).
 */
function settledRows(store: RunStore, rows: readonly DecisionRow[]): DecisionRow[] {
  return rows.filter((r) => {
    if (!FRONT_DOOR.has(r.entry_id)) return true;
    const linked = r.run_id ? store.getJevVerdictForRun(r.run_id)?.decision_id ?? null : null;
    return linked !== null && (r.entry_id !== "turn.handler" || linked === r.decision_id);
  });
}

/** Spec R7 §4.3: attach.path's refusals per seam — a fail-rung row names no seam (failed), marker_outside is parse, every other refusal is send; accepted rows are not counted. */
// a fail-rung row's reason_code is null (decide.ts: { failed: "threw" } carries no reason), so `rung !== "fail"` below is belt and braces; kept so a future reason on fail rows cannot leak into parse
function attachSuffix(rows: readonly DecisionRow[]): string {
  const refused = rows.filter((r) => r.entry_id === ATTACH_PATH_ID && r.verdict === "refuse");
  const failed = refused.filter((r) => r.rung === "fail").length;
  const parse = refused.filter((r) => r.rung !== "fail" && r.reason_code === "marker_outside").length;
  return ` (parse ${parse} · send ${refused.length - failed - parse} · failed ${failed})`;
}

/** Per entry, counts by decider under the display labels; `/status` prints these lines. */
export function countLines(rows: readonly DecisionRow[]): string[] {
  const by = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = by.get(r.entry_id) ?? new Map<string, number>();
    m.set(r.rung, (m.get(r.rung) ?? 0) + 1);
    by.set(r.entry_id, m);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, m]) => {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const known = RUNG_ORDER.filter((k) => m.has(k)).map((k) => `${RUNG_LABEL[k]} ${m.get(k)}`);
    const other = [...m.keys()].filter((k) => !(RUNG_ORDER as readonly string[]).includes(k)).sort().map((k) => `${k} ${m.get(k)}`);
    return `· ${id} ${total} — ${[...known, ...other].join(" · ")}${id === "secret.redact" ? " (final, failure and evolution reports only)" : ""}${id === ATTACH_PATH_ID ? attachSuffix(rows) : ""}`;
  });
}

/** R0': turn.settle's unfinished settles per health reason over the window; null when there are none. */
export function settleHealthLine(rows: readonly DecisionRow[]): string | null {
  const counts = SETTLE_HEALTH_REASONS.map((r) => [r, rows.filter((x) => x.entry_id === TURN_SETTLE_ID && x.reason_code === r).length] as const);
  if (counts.every(([, n]) => n === 0)) return null;
  return `· ${TURN_SETTLE_ID} unfinished: ${counts.map(([r, n]) => `${r} ${n}`).join(" · ")}`;
}

export interface InjectionCounts { results: number; withheld: number; withheldByJev: number; framed: number; near: number; lost: number }

/** tool.injection, counted (Ruling 19: never offered for a blind tap). "Near the bar": a Jev verdict within NEAR_BAR_BAND of 0.5. */
export function injectionCounts(rows: readonly DecisionRow[]): InjectionCounts {
  const inj = rows.filter((r) => r.entry_id === "tool.injection");
  const held = inj.filter((r) => r.verdict === "withhold");
  return { results: inj.length, withheld: held.length, withheldByJev: held.filter((r) => r.rung === "system_one").length,
    framed: inj.filter((r) => r.verdict === "frame").length,
    near: inj.filter((r) => r.rung === "system_one" && r.p !== null && Math.abs(r.p - 0.5) < NEAR_BAR_BAND).length,
    lost: inj.filter((r) => r.fallback_rung === "system_one").length };
}

/** Each turn's highest trust level over its turn.trust rows (merged and nudge runs share the parent's trust, so one turn counts once). */
export function trustTops(rows: readonly DecisionRow[]): Map<string, TrustLevel> {
  const top = new Map<string, TrustLevel>();
  for (const r of rows) {
    const level = r.verdict as TrustLevel;
    if (r.entry_id !== "turn.trust" || !TRUST_ORDER.includes(level) || !r.run_id) continue;
    if (rankOf(level) > rankOf(top.get(r.run_id) ?? "clean")) top.set(r.run_id, level);
  }
  return top;
}

/** The 24 h before `now`: every row (health reads orphans too) and the settled rows the counts read. */
export function decisionWindow(store: RunStore, now: string): { since: string; all: DecisionRow[]; rows: DecisionRow[] } {
  const since = new Date(Date.parse(now) - DECISION_WINDOW_MS).toISOString();
  const all = store.listDecisionsBetween(since, now);
  return { since, all, rows: settledRows(store, all) };
}

export const IMPROVE_WINDOW_DAYS = 7;
const SILENT_FAMILIES = ["review_unsure", "lesson_unfollowed", "dig_deeper"] as const;
const LESSON_NOT_HOLDING = "lesson did not hold";
const sumDetail = (ticks: readonly { detail: Record<string, unknown> }[], key: string): number => ticks.reduce((a, t) => a + (typeof t.detail[key] === "number" ? (t.detail[key] as number) : 0), 0);

/** Tick faults over the window (the page improve_tick_degraded points here): failed or abandoned-while-running dates, record failures, dates the embedder was down. */
function tickFaults(ticks: readonly { local_date: string; result: string; detail: Record<string, unknown> }[]): Array<[number, string]> {
  const newest = ticks.reduce((m, t) => (t.local_date > m ? t.local_date : m), "");
  const failed = ticks.filter((t) => t.result === "failed" || (t.result === "running" && t.local_date < newest)).length;
  const record = sumDetail(ticks, "record_failed");
  const embed = ticks.filter((t) => sumDetail([t], "embed_unavailable") > 0).length;
  return [[failed, `ticks failed ${failed}`], [record, `record failed ${record}`], [embed, `embeddings unavailable ${embed} d`]];
}

/** Spec 2026-11-07 §8: the diagnostic counts (a failing tick also pages improve_tick_degraded, which points here) as one /status line; null when every part is zero and the tick is on. */
export function improvementLine(store: RunStore, now: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const since = new Date(Date.parse(now) - IMPROVE_WINDOW_DAYS * 86_400_000).toISOString();
  const signals = store.listImproveSignalsSince(since);
  const ticks = store.listImproveTicksSince(since);
  const route = store.listDecisionsBetween(since, now).filter((r) => r.entry_id === "improve.route");
  const skipped = new Map<string, number>();
  for (const e of store.listLedgerEventsByTypeSince("improve_signal_skipped", since)) { const k = typeof e.payload.signal === "string" ? e.payload.signal : "unknown"; skipped.set(k, (skipped.get(k) ?? 0) + 1); }
  // with no signal at all in the window "silent" would be every week's line
  const silent = signals.length === 0 ? [] : SILENT_FAMILIES.filter((f) => !signals.some((r) => r.signal === f));
  const made = new Map([...store.listOpenProposals(), ...store.listProposalsResolvedSince(since)].map((p) => [p.proposal_id, p] as const));
  const holding = [...made.values()].filter((p) => p.created_at > since && p.evidence.startsWith(LESSON_NOT_HOLDING)).length;
  const reasons = (code: string): number => route.filter((r) => r.reason_code === code).length;
  const parts: Array<[number, string]> = [
    [resolveImproveEnabled(env) ? 0 : 1, "tick off"],
    ...tickFaults(ticks),
    [skipped.size, `unattached ${[...skipped].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(", ")}`],
    [silent.length, `silent ${silent.join(", ")}`],
    [sumDetail(ticks, "deferred"), `deferred ${sumDetail(ticks, "deferred")}`],
    [sumDetail(ticks, "deferred_outage"), `deferred on an outage ${sumDetail(ticks, "deferred_outage")}`],
    [reasons("wiki_disarmed"), `wiki disarmed ${reasons("wiki_disarmed")}`],
    [reasons("inapplicable_top"), `inapplicable top ${reasons("inapplicable_top")}`],
    [holding, `lessons not holding ${holding}`]
  ];
  const shown = parts.filter(([n]) => n > 0).map(([, t]) => t);
  return shown.length === 0 ? null : `Improvement (${IMPROVE_WINDOW_DAYS} d): ${shown.join(" · ")}`;
}
