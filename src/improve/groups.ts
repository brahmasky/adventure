import { resolveWikiEnabled } from "../capabilities/wiki.js";
import { cosineSimilarity } from "../llm/embeddings.js";
import type { ImproveState } from "../decisions/entries/improve-route.js";
import type { DecisionSignal } from "../decisions/types.js";
import type { Category } from "../jev/questions/tree.js";
import type { LedgerEvent } from "../run/run-ledger.js";
import type { ImproveSignalRow, JevVerdictRow, RunStore } from "../run/run-store.js";
import type { SkillStore } from "../skills/skill-store.js";

/** 2b-ii §3.2 grouping and §4.2 the state. Everything here is code-built; the only text is Paco's, through the redactor. */
export const PACO_TEXT_CAP = 500;
export const JOB_OVERLAP_DAYS = 30;
/** Final fix D6: a habit re-drafted every two weeks is the same theme; a job of the category this recent with a like origin turn counts. */
export const JOB_THEME_DAYS = 90;
export const RECURRENCE_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const CATEGORY_SCOPED: ReadonlySet<DecisionSignal> = new Set(["correction", "think_harder", "dig_deeper", "lesson_undone"]);

export interface RecurrenceInfo { clusterId: string; turnIds: string[]; idempotencyKey: string; texts: string[]; category: Category; spanDays: number }
export interface SignalGroup { key: string; signal: DecisionSignal; value: string; scope: string; rows: ImproveSignalRow[]; newest: ImproveSignalRow; stale: boolean; recurrence: RecurrenceInfo | null }

/** The scope of a row (codex D13: a rating's value is part of it; a recurrence row's cluster id is in its source id). */
export function scopeOf(row: ImproveSignalRow, verdict: JevVerdictRow | undefined): string {
  const category = verdict?.category ?? "other";
  if (CATEGORY_SCOPED.has(row.signal)) return category;
  if (row.signal === "rating") return `${category}:${row.value}`;
  if (row.signal === "recurrence") return (row.source_outcome_id ?? "rec:unknown").replace(/:\d+$/, "");
  return row.value;
}

/** Groups in the order of their oldest row; a row older than `staleBefore` (and a recurrence row whose cluster is gone) is its own stale group (ruling 10). */
export function groupSignals(rows: readonly ImproveSignalRow[], lookup: (run_id: string) => JevVerdictRow | undefined, clusters: ReadonlyMap<string, RecurrenceInfo>, staleBefore: string): SignalGroup[] {
  const groups = new Map<string, SignalGroup>();
  for (const r of rows) {
    const scope = scopeOf(r, r.about_run_id ? lookup(r.about_run_id) : undefined);
    const recurrence = r.signal === "recurrence" ? clusters.get(scope) ?? null : null;
    const stale = r.created_at < staleBefore || (r.signal === "recurrence" && recurrence === null);
    const key = stale ? `stale|${r.signal_id}` : `${r.signal}|${scope}`;
    const g = groups.get(key) ?? { key, signal: r.signal, value: r.value, scope, rows: [], newest: r, stale, recurrence };
    g.rows.push(r);
    if (r.created_at >= g.newest.created_at) g.newest = r;
    groups.set(key, g);
  }
  // oldest group first (its oldest row), so the 40-group cap defers the newest work, never the backlog (senior B5)
  return [...groups.values()].sort((a, b) => oldest(a).localeCompare(oldest(b)));
}
const oldest = (g: SignalGroup): string => g.rows.reduce((m, r) => (r.created_at < m ? r.created_at : m), g.rows[0]!.created_at);

/** Code-built: tool names and counts of the turn, never tool text (ruling 15). */
export function toolSummaryOf(events: readonly LedgerEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.event_type !== "tool_finished" || typeof e.payload.tool !== "string") continue;
    counts.set(e.payload.tool, (counts.get(e.payload.tool) ?? 0) + 1);
  }
  return counts.size === 0 ? "none" : [...counts].map(([t, n]) => `${t} ${n}`).join(" · ");
}

/** Step 0 of authorAndWriteSkill (core-worker.ts): a skill name mentioned word-bounded (the slug alphabet's complement), case-folded. */
export function skillMentioned(metas: readonly { name: string }[], texts: readonly string[]): boolean {
  const lowered = texts.map((t) => t.toLowerCase());
  return metas.some((m) => { const re = new RegExp(`(^|[^a-z0-9_-])${m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_-]|$)`); return lowered.some((t) => re.test(t)); });
}

/** Final fix D6: any origin turn of a same-category job in JOB_THEME_DAYS embeds at or over the gate with any turn of the cluster. */
function likeRecentJob(d: StateDeps, rec: RecurrenceInfo): boolean {
  if (d.recurrenceGate === undefined) return false;
  const since = new Date(Date.parse(d.now) - JOB_THEME_DAYS * DAY_MS).toISOString();
  const past = [...d.store.getTurnEmbeddings(d.store.jobOriginTurnIds(rec.category, since)).values()];
  if (past.length === 0) return false;
  const mine = [...d.store.getTurnEmbeddings(rec.turnIds).values()];
  return mine.some((v) => past.some((p) => p.length === v.length && cosineSimilarity(v, p) >= d.recurrenceGate!));
}

export interface StateDeps { store: RunStore; env: NodeJS.ProcessEnv; now: string; skills: SkillStore; redact: (text: string) => string;
  scheduleHints: ReadonlyMap<string, { schedule_id: string; hour: number }>; since14: readonly ImproveSignalRow[];
  /** The recurrence cosine gate; with it, a cluster like a recent job's origin is already authored (final fix D6). Unset: turn-id overlap only. */
  recurrenceGate?: number }

const capPoints = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

export function buildImproveState(g: SignalGroup, d: StateDeps): ImproveState {
  const about = g.newest.about_run_id;
  const verdict = about ? d.store.getJevVerdictForRun(about) : undefined;
  const lookup = (id: string) => d.store.getJevVerdictForRun(id);
  const count14d = d.since14.filter((r) => r.signal === g.signal && scopeOf(r, r.about_run_id ? lookup(r.about_run_id) : undefined) === g.scope).length;
  // Paco's text is the SIGNAL turn's (a correction's correcting run; an approval's or failure's own run); only a rating has none, then the about run's (senior B8, codex B8)
  const textRun = g.newest.run_id ?? about;
  const pacoText = textRun ? capPoints(d.redact(d.store.userTurnTextForRun(textRun) ?? ""), PACO_TEXT_CAP) : "";
  const last = d.store.lastAcceptedImprovement(g.scope);
  const overlapSince = new Date(Date.parse(d.now) - JOB_OVERLAP_DAYS * DAY_MS).toISOString();
  return {
    signal: g.signal, value: g.value, scope: g.scope, count: g.rows.length, count14d,
    category: g.recurrence?.category ?? verdict?.category ?? null, lane: verdict?.lane ?? null,
    capability: g.signal === "approval_denied" || g.signal === "approval_expired" ? g.value : null,
    pacoText, toolSummary: about ? toolSummaryOf(d.store.getLedgerEvents(about)) : "none",
    lastImprovement: last ? { target: last.target, ageDays: Math.floor((Date.parse(d.now) - Date.parse(last.at)) / DAY_MS) } : null,
    recurrence: g.recurrence ? { clusterId: g.recurrence.clusterId, turnIds: g.recurrence.turnIds, idempotencyKey: g.recurrence.idempotencyKey, spanDays: g.recurrence.spanDays } : null,
    alreadyAuthored: g.recurrence ? d.store.jobOverlapsTurns(g.recurrence.turnIds, overlapSince) || likeRecentJob(d, g.recurrence) : false,
    skillExists: g.recurrence ? skillMentioned(d.skills.list(), g.recurrence.texts) : false,
    wikiArmed: resolveWikiEnabled(d.env),
    scheduleHint: g.signal === "approval_expired" ? d.scheduleHints.get(g.value) ?? null : null,
    stale: g.stale, statedRuleSaved: g.signal === "correction" && g.newest.run_id !== null && d.store.memorySaveTriggered(g.newest.run_id),
    redacted: { pacoText }
  };
}
