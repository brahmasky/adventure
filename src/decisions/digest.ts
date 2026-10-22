import { memoryUndoButton } from "../capabilities/memory-correct.js";
import { memlaneUndoButton } from "../core/memory-lane-card.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { DecisionRow, ImprovementJobRow, ImprovementProposalRow, RunStore } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import { skillButtons } from "../skills/promote.js";
import { resolveImproveEnabled } from "../improve/flag.js";
import { redactForImprove } from "./egress.js";
import { REGISTRY } from "./registry.js";
import { SETTLE_HEALTH_REASONS, TURN_SETTLE_ID } from "./entries/turn-settle.js";
import { TRUST_ORDER, rankOf, type TrustLevel } from "./entries/turn-trust.js";
import { TRUST_TAP_BUDGET } from "./trust-ask.js";
import type { AnyEntry, DecidedBy } from "./types.js";

/**
 * The daily decision digest (2b-ii §6.1): Improvements today (what the ladder saved or moved, each with its Undo / Revert /
 * Revoke), Proposals waiting (at most 8, with Accept / Dismiss), Unsure (System One judgements near their bar, with the ✅ / ❌ review taps) and Watch (7-day numbers). Counts, health and trust live in
 * `/status`. One message per local date at HOUGE_DECISION_DIGEST_AT, through the outbox and the rich renderer; skipped when all
 * four sections are empty; waits for the day's improve tick (ruling 21). No enable flag (R13): the time is the only knob, and
 * `off` (Paco 2026-10-14) switches the summary off; the ledger under it is unchanged.
 */
export const DEFAULT_DIGEST_AT = "21:00";
export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
export const UNSURE_BAND = 0.15;
export const UNSURE_MAX = 8;
/** The review tap's callback prefix (`dec:rv:<decision_id>:<ok|bad>`); the callback parser imports it, never a second literal. */
export const REVIEW_PREFIX = "dec:rv:";
const RUNG_ORDER: readonly DecidedBy[] = ["rule", "system_one", "model", "paco", "fail"];
/** Entries whose rows settleTriage writes with the turn's verdict (plan ruling 14). */
const FRONT_DOOR: ReadonlySet<string> = new Set(["turn.handler", "turn.gear"]);
/**
 * Ruling R1: the routes a System One row carries when the tree judged at p >= the bar. An allowlist, so a new route reason
 * (or a fallback like `uncalibrated` / `below_bar` / `cascade`, whose p is arbitrary or sub-bar) is never offered by default.
 */
const JUDGEMENT_REASONS: ReadonlySet<string> = new Set(["routed", "bare_ack_guard", "lane_limits", "correction", "two_request", "fix", "memory_other", "jev_kind",
  // turn.settle's Jev answers, offered within UNSURE_BAND of its single bar SETTLE_BAR_P (0.6, the lowest per-question bar): the band is
  // [0.6, 0.75) for every settle row whatever its question. Accepted: claims_done (bar 0.6) gets the true near-bar band; for promise and
  // asks_permission (0.7) only [0.7, 0.75) is offered, and an unverified send-back (bar 0.8) is never offered.
  "jev_claims_done", "jev_unverified", "jev_promise", "jev_asks_permission"]);
/** What Paco reads for each rung in the counts line: display words, never the ledger tags. */
const RUNG_LABEL: Readonly<Record<DecidedBy, string>> = { rule: "code", system_one: "Jev", model: "model", paco: "you", fail: "fallback" };
/** A row's decider as Paco reads it; a rung outside the known set shows as its own tag, never hidden. */
export const deciderLabel = (rung: string): string => (Object.hasOwn(RUNG_LABEL, rung) ? RUNG_LABEL[rung as DecidedBy] : rung);

/** `HOUGE_DECISION_DIGEST_AT=off`, any case: no digest. Only the exact word: a typo keeps the 21:00 default, never silence. */
export function digestOff(env: NodeJS.ProcessEnv): boolean {
  return env.HOUGE_DECISION_DIGEST_AT?.trim().toLowerCase() === "off";
}

export function resolveDigestAt(env: NodeJS.ProcessEnv): string {
  const raw = env.HOUGE_DECISION_DIGEST_AT?.trim();
  return raw !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_DIGEST_AT;
}

/** The entry's single probability bar (its System One rung's), when it has one. */
export function barOf(entry: AnyEntry): number | undefined {
  const rung = entry.ladder.find((r) => r.kind === "system_one");
  return rung?.kind === "system_one" ? rung.bars.p : undefined;
}

/** Applied System One judgements at or above their entry's bar and under bar + UNSURE_BAND, newest first, at most UNSURE_MAX. */
export function unsureOf(rows: readonly DecisionRow[], registry: readonly AnyEntry[] = REGISTRY): DecisionRow[] {
  const bars = new Map(registry.map((e) => [e.id, barOf(e)] as const));
  return rows.filter((r) => {
    const bar = bars.get(r.entry_id);
    return r.rung === "system_one" && r.armed_mode === "on" && JUDGEMENT_REASONS.has(r.reason_code ?? "") && r.p !== null && bar !== undefined
      && r.p >= bar && r.p < bar + UNSURE_BAND;
  }).slice(-UNSURE_MAX).reverse();
}

export function reviewButtons(decision_id: string, n: number): NotificationButton[] {
  const ok = `${REVIEW_PREFIX}${decision_id}:ok`;
  const bad = `${REVIEW_PREFIX}${decision_id}:bad`;
  if (Buffer.byteLength(bad, "utf8") > 64) throw new Error("review callback_data exceeds 64 bytes");
  return [{ text: `✅ ${n}`, data: ok }, { text: `❌ ${n}`, data: bad }];
}

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

/** Per entry, counts by decider under the display labels; the digest and `/status` both print these lines. */
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
    return `· ${id} ${total} — ${[...known, ...other].join(" · ")}`;
  });
}

/** R0': turn.settle's unfinished settles per health reason over the window; null when there are none. */
export function settleHealthLine(rows: readonly DecisionRow[]): string | null {
  const counts = SETTLE_HEALTH_REASONS.map((r) => [r, rows.filter((x) => x.entry_id === TURN_SETTLE_ID && x.reason_code === r).length] as const);
  if (counts.every(([, n]) => n === 0)) return null;
  return `· ${TURN_SETTLE_ID} unfinished: ${counts.map(([r, n]) => `${r} ${n}`).join(" · ")}`;
}

export interface InjectionCounts { results: number; withheld: number; withheldByJev: number; framed: number; near: number; lost: number }

/** tool.injection, counted (Ruling 19: never offered for a blind tap). "Near the bar": a Jev verdict within UNSURE_BAND of 0.5. */
export function injectionCounts(rows: readonly DecisionRow[]): InjectionCounts {
  const inj = rows.filter((r) => r.entry_id === "tool.injection");
  const held = inj.filter((r) => r.verdict === "withhold");
  return { results: inj.length, withheld: held.length, withheldByJev: held.filter((r) => r.rung === "system_one").length,
    framed: inj.filter((r) => r.verdict === "frame").length,
    near: inj.filter((r) => r.rung === "system_one" && r.p !== null && Math.abs(r.p - 0.5) < UNSURE_BAND).length,
    lost: inj.filter((r) => r.fallback_rung === "system_one").length };
}

function injectionLine(rows: readonly DecisionRow[]): string | null {
  const c = injectionCounts(rows);
  if (c.results === 0) return null;
  return `· tool.injection: ${c.results} tool results · withheld ${c.withheld} (code ${c.withheld - c.withheldByJev} · Jev ${c.withheldByJev}) · framed ${c.framed} (kept local) · near the bar ${c.near} · judgement lost ${c.lost}`;
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

/**
 * Spec 7.1-7.2 in one block: what tool.injection did, and how many turns asked for more taps. turn.trust rows carry the
 * turn's own run id (merged and nudge runs share the parent's trust), and a turn counts once, at its highest level.
 */
export function trustLines(store: RunStore, rows: readonly DecisionRow[], now: string, env: NodeJS.ProcessEnv): string[] {
  const trust = rows.filter((r) => r.entry_id === "turn.trust");
  const top = trustTops(trust);
  const at = (level: TrustLevel): number => [...top.values()].filter((l) => l === level).length;
  const taps = store.trustTapCount(formatInstantInZone(now, resolveDisplayZone(env)).slice(0, 10));
  const inj = injectionLine(rows);
  // senior S-R2-2: turns pushed to hostile because unjudged outside text was withheld (an attacker can do this at will)
  const outside = new Set(trust.filter((r) => r.reason_code === "unjudged_outside" && r.run_id && top.get(r.run_id) === "hostile").map((r) => r.run_id)).size;
  const turns = `· turns: untrusted ${at("untrusted")} · hostile ${at("hostile")}${outside > 0 ? ` (${outside} by unjudged outside text)` : ""} · trust taps today ${taps} of ${TRUST_TAP_BUDGET}`;
  return [...(inj ? [inj] : []), ...(top.size > 0 || taps > 0 ? [turns] : [])];
}

/** Addition B: how often each entry re-asked inside its noise band. Gear shares the handler's call, so only the handler row carries it. */
export function reaskLines(rows: readonly DecisionRow[]): string[] {
  const by = new Map<string, { mean: number; max: number; failed: number }>();
  for (const r of rows) {
    if (r.reask === null) continue;
    const c = by.get(r.entry_id) ?? { mean: 0, max: 0, failed: 0 };
    c[r.reask] += 1;
    by.set(r.entry_id, c);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([id, c]) => `· ${id}: re-asked ${c.mean + c.max + c.failed} (mean ${c.mean} · max ${c.max} · failed ${c.failed})`);
}

/** The 24 h before `now`: every row (health reads orphans too) and the settled rows the counts read. */
export function decisionWindow(store: RunStore, now: string): { since: string; all: DecisionRow[]; rows: DecisionRow[] } {
  const since = new Date(Date.parse(now) - DIGEST_WINDOW_MS).toISOString();
  const all = store.listDecisionsBetween(since, now);
  return { since, all, rows: settledRows(store, all) };
}


export const DIGEST_PROPOSALS_MAX = 8;
export const DRAFT_LINE_CHARS = 120;
export const WATCH_WINDOW_DAYS = 7;
/** Ruling 21: the improve tick runs before the digest; a running or budget-stopped tick younger than this defers the digest to the next cycle. */
export const DIGEST_WAIT_FOR_TICK_MS = 30 * 60_000;
/** The callback prefixes of telegram-command-parser.ts (`PR_PREFIX` / `LM_PREFIX`); that file imports this one, so they are literals here and a test pins the pair. */
export const DIGEST_PR_PREFIX = "dec:pr:";
export const DIGEST_LM_PREFIX = "dec:lm:";
const LESSON_NOT_HOLDING = "lesson did not hold";
const SILENT_FAMILIES = ["review_unsure", "lesson_unfollowed", "dig_deeper"] as const;

export interface Digest { text: string; button_rows: NotificationButton[][]; offered: { proposal_ids: string[]; job_ids: string[]; decision_ids: string[] } }
interface Section { lines: string[]; button_rows: NotificationButton[][] }

/** Code points, not UTF-16 units: a split surrogate pair would make Telegram reject the HTML send. */
const clip = (text: string, n: number): string => Array.from(text.replace(/\s+/g, " ").trim()).slice(0, n).join("");
const daysBefore = (now: string, n: number): string => new Date(Date.parse(now) - n * 24 * 60 * 60 * 1000).toISOString();

function button(text: string, data: string): NotificationButton {
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("digest callback_data exceeds 64 bytes");
  return { text, data };
}

/** A stored JSON object, or {} for anything else: a corrupt row never breaks the digest. */
function parsed(json: string | null): Record<string, unknown> {
  try { const v: unknown = JSON.parse(json ?? "{}"); return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What a proposal's draft says in one line (redacted before the cut so a secret is never half-shown). */
function draftSummary(store: RunStore, p: ImprovementProposalRow, chars: number): string {
  const d = parsed(p.draft_json);
  const raw = p.target === "lesson" || p.target === "fact" ? str(d.text)
    : p.target === "schedule" ? `move ${str(d.schedule_id).slice(0, 12)} to ${String(d.hour_to ?? "?")}:00`
    : p.target === "ladder" ? `${str(d.move)} on ${str(d.entry_id)}` : str(d.text);
  return clip(redactForImprove(store, raw), chars);
}

/** Final fix A2: a lesson's AVOID enters every planner prompt, so the waiting line shows it, redacted then clipped like the text. */
function avoidSummary(store: RunStore, p: ImprovementProposalRow, chars: number): string {
  const avoid = p.target === "lesson" ? str(parsed(p.draft_json).avoid) : "";
  return avoid ? ` · AVOID: ${clip(redactForImprove(store, avoid), chars)}` : "";
}

function jobLine(job: ImprovementJobRow): string | null {
  const turns = parsed(job.origin_json).turn_ids;
  const n = `${Array.isArray(turns) ? turns.length : 0} requests`;
  if (job.state === "pending_review") return `· skill ${job.pending_name ?? "draft"} drafted · ${n}`;
  if (job.state === "suggested") return `· suggested: ${job.gate_a ?? "lesson"} · ${n}`;
  if (job.state === "promoted") return `· skill ${job.pending_name ?? "draft"} promoted`;
  return null;
}

/** An accepted proposal as one Improvements line with its undo; null for a target whose acceptance the digest does not show. */
function acceptedLine(store: RunStore, p: ImprovementProposalRow): { line: string; button?: NotificationButton } | null {
  const result = parsed(p.result_json);
  const d = parsed(p.draft_json);
  const change = str(result.change_id);
  if (p.target === "lesson") return { line: `· lesson saved: ${draftSummary(store, p, 80)} · ${p.evidence}`, ...(change ? { button: memlaneUndoButton(change) } : {}) };
  // draft.text, not evidence.quote: the quote is Paco's own words; the text is the redacted line the proposal drafted
  if (p.target === "fact") return { line: `· fact saved · ${draftSummary(store, p, 40)}`, ...(change ? { button: memoryUndoButton(change) } : {}) };
  if (p.target === "schedule") {
    const goal = store.getScheduledTask(str(d.schedule_id))?.goal;
    const name = goal ? clip(redactForImprove(store, goal), 40) : str(d.schedule_id).slice(0, 12);
    return { line: `· schedule ${name} moved to ${String(d.hour_to ?? "?").padStart(2, "0")}:00 · ${p.evidence}`, button: button("↩️ Revert", `${DIGEST_PR_PREFIX}${p.proposal_id}:rev`) };
  }
  if (p.target === "ladder") {
    const move = store.getLadderMove(str(result.move_id));
    const live = move !== undefined && move.state === "active" && move.revocable === 1;
    return { line: `· ladder move ${str(d.move)} on ${str(d.entry_id)} · ${p.evidence}`, ...(live ? { button: button("⏪ Revoke", `${DIGEST_LM_PREFIX}${move.move_id}:revoke`) } : {}) };
  }
  return null;
}

/** Jobs finished since the last digest and proposals Paco accepted since, each with the tap that undoes it. */
export function improvementsToday(store: RunStore, since: string, chatId?: string): Section & { job_ids: string[] } {
  const mine = (row: { chat_id: string | null }): boolean => chatId === undefined || row.chat_id === chatId;
  const lines: string[] = []; const button_rows: NotificationButton[][] = []; const job_ids: string[] = [];
  for (const job of store.listJobsFinishedSince(since).filter(mine)) {
    const line = jobLine(job);
    if (!line) continue;
    lines.push(line);
    if (job.state === "pending_review") { button_rows.push(skillButtons(job.job_id, "review")); job_ids.push(job.job_id); }
  }
  for (const p of store.listProposalsResolvedSince(since).filter(mine)) {
    const a = p.state === "accepted" ? acceptedLine(store, p) : null;
    if (!a) continue;
    lines.push(a.line);
    if (a.button) button_rows.push([a.button]);
  }
  return { lines, button_rows, job_ids };
}

/**
 * The open proposals, oldest first, at most DIGEST_PROPOSALS_MAX, each with Accept / Dismiss; `ids` are the rendered ones only.
 * Taps are bound to the originating chat (ruling 19), so a row of another chat (or none) is neither shown nor offered.
 */
export function proposalsWaiting(store: RunStore, chatId?: string): Section & { ids: string[] } {
  const open = store.listOpenProposals().filter((p) => chatId === undefined || p.chat_id === chatId);
  const shown = open.slice(0, DIGEST_PROPOSALS_MAX);
  const lines = shown.map((p, k) => `${k + 1}. ${p.target} · ${draftSummary(store, p, DRAFT_LINE_CHARS)}${avoidSummary(store, p, DRAFT_LINE_CHARS)} · ${p.evidence}`);
  if (open.length > shown.length) lines.push(`+${open.length - shown.length} more`);
  const button_rows = shown.map((p, k) => [button(`✅ ${k + 1}`, `${DIGEST_PR_PREFIX}${p.proposal_id}:acc`), button(`🗑 ${k + 1}`, `${DIGEST_PR_PREFIX}${p.proposal_id}:dis`)]);
  return { lines, button_rows, ids: shown.map((p) => p.proposal_id) };
}

/**
 * The Unsure section: System One judgements within UNSURE_BAND of their bar over the 24 h window, each with ✅ / ❌ (the review
 * taps; `ids` are the rendered decisions, the only ones a tap is accepted for). A line is code-built (entry, verdict, p): never
 * model or Paco text. Taps are chat-bound like the proposals', so a decision whose run belongs to another chat is not shown.
 */
export function unsureSection(store: RunStore, now: string, chatId?: string): Section & { ids: string[] } {
  const mine = decisionWindow(store, now).rows.filter((r) => chatId === undefined || (r.run_id !== null && store.chatIdOfRun(r.run_id) === chatId));
  const shown = unsureOf(mine);
  const lines = shown.map((r, k) => `${k + 1}. ${r.entry_id} → ${r.verdict} · p ${(r.p ?? 0).toFixed(2)}`);
  return { lines, button_rows: shown.map((r, k) => reviewButtons(r.decision_id, k + 1)), ids: shown.map((r) => r.decision_id) };
}

const countOf = (rows: readonly { signal: string }[], signal: string): number => rows.filter((r) => r.signal === signal).length;
const sumDetail = (ticks: readonly { detail: Record<string, unknown> }[], key: string): number =>
  ticks.reduce((a, t) => a + (typeof t.detail[key] === "number" ? t.detail[key] : 0), 0);

/** Seven days of numbers that show the loop gaming or starving itself (§6.1); a line with only zeros is left out. */
export function watchLines(store: RunStore, now: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const since = daysBefore(now, WATCH_WINDOW_DAYS);
  const signals = store.listImproveSignalsSince(since);
  const ticks = store.listImproveTicksSince(since);
  const route = store.listDecisionsBetween(since, now).filter((r) => r.entry_id === "improve.route");
  const { clarify, total } = store.clarifyCounts(since);
  const skipped = new Map<string, number>();
  for (const e of store.listLedgerEventsByTypeSince("improve_signal_skipped", since)) { const k = str(e.payload.signal) || "unknown"; skipped.set(k, (skipped.get(k) ?? 0) + 1); }
  // With no signal at all in the window "silent" would be every day's line and an empty day would never be skipped.
  const silent = signals.length === 0 ? [] : SILENT_FAMILIES.filter((f) => countOf(signals, f) === 0);
  const made = new Map([...store.listOpenProposals(), ...store.listProposalsResolvedSince(since)].map((p) => [p.proposal_id, p] as const));
  const holding = [...made.values()].filter((p) => p.created_at > since && p.evidence.startsWith(LESSON_NOT_HOLDING)).length;
  const reasons = (code: string): number => route.filter((r) => r.reason_code === code).length;
  const tickBad = { failed: ticks.filter((x) => x.result === "failed").length, stopped: ticks.filter((x) => x.result === "stopped").length, record: sumDetail(ticks, "record_failed") };
  const tickParts = ([["ticks failed", tickBad.failed], ["stopped", tickBad.stopped], ["record failed", tickBad.record]] as const).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
  const embedDays = ticks.filter((t) => sumDetail([t], "embed_unavailable") > 0).length;
  const c = { corrections: countOf(signals, "correction"), abandoned: countOf(signals, "abandoned"), rate: total > 0 ? Math.round((100 * clarify) / total) : 0 };
  const lines: Array<[number, string]> = [
    [resolveImproveEnabled(env) ? 0 : 1, "· improvement tick off"], // HOUGE_IMPROVE_ENABLED=false: the loop is stopped, never silently
    [c.corrections + c.abandoned + c.rate, `· corrections ${c.corrections} · abandoned ${c.abandoned} · clarify rate ${c.rate}%`],
    [skipped.size, `· unattached: ${[...skipped].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(", ")}`],
    [sumDetail(ticks, "deferred"), `· deferred ${sumDetail(ticks, "deferred")}`],
    [sumDetail(ticks, "deferred_outage"), `· deferred on an outage ${sumDetail(ticks, "deferred_outage")}`], // final fix D1: kept for retry, never dropped
    [silent.length, `· silent: ${silent.join(", ")}`],
    [reasons("wiki_disarmed"), `· wiki disarmed: ${reasons("wiki_disarmed")} topics`],
    [embedDays, `· embeddings unavailable: ${embedDays} days`],
    [reasons("inapplicable_top"), `· inapplicable top ${reasons("inapplicable_top")}`],
    [holding, `· lessons not holding ${holding}`]
  ];
  // a failing tick must reach Paco (nothing else tells him), so this line alone keeps an otherwise empty day from being skipped
  lines.push([tickParts.length, `· ${tickParts.join(" · ")}`]);
  return lines.filter(([n]) => n > 0).map(([, line]) => line);
}

export function buildDecisionDigest(store: RunStore, now: string, env: NodeJS.ProcessEnv = process.env, chatId?: string): Digest | null {
  const tz = resolveDisplayZone(env);
  const today = improvementsToday(store, new Date(Date.parse(now) - DIGEST_WINDOW_MS).toISOString(), chatId);
  const waiting = proposalsWaiting(store, chatId);
  const unsure = unsureSection(store, now, chatId);
  const watch = watchLines(store, now, env);
  if (today.lines.length + waiting.lines.length + unsure.lines.length + watch.length === 0) return null;
  const sections = [`🪜 **Decisions — ${formatInstantInZone(now, tz).slice(0, 10)}**`];
  if (today.lines.length > 0) sections.push(["**Improvements today**", ...today.lines].join("\n"));
  if (waiting.lines.length > 0) sections.push(["**Proposals waiting**", ...waiting.lines].join("\n"));
  if (unsure.lines.length > 0) sections.push(["**Unsure** (✅ right · ❌ wrong)", ...unsure.lines].join("\n"));
  if (watch.length > 0) sections.push([`**Watch (${WATCH_WINDOW_DAYS} d)**`, ...watch].join("\n"));
  return { text: sections.join("\n\n"), button_rows: [...today.button_rows, ...waiting.button_rows, ...unsure.button_rows],
    offered: { proposal_ids: waiting.ids, job_ids: today.job_ids, decision_ids: unsure.ids } };
}

export interface DigestTickInput { store: RunStore; chatId: string | null; now: string; env?: NodeJS.ProcessEnv }
export type DigestTickResult = { ran: false } | { ran: true; sent: boolean };

/** Due once per local date at or after HOUGE_DECISION_DIGEST_AT; the latch row, the message and the offers commit together. */
export function runDecisionDigestTick(i: DigestTickInput): DigestTickResult {
  const env = i.env ?? process.env;
  if (!i.chatId || digestOff(env)) return { ran: false };
  const chatId = i.chatId;
  const [date, time] = formatInstantInZone(i.now, resolveDisplayZone(env)).split(" ") as [string, string];
  if (time < resolveDigestAt(env) || i.store.getDecisionDigest(date)) return { ran: false };
  const tick = i.store.getImproveTick(date);
  if (tick && tick.result !== "done" && tick.result !== "failed" && Date.parse(i.now) - Date.parse(tick.started_at) < DIGEST_WAIT_FOR_TICK_MS) return { ran: false };
  const digest = buildDecisionDigest(i.store, i.now, env, chatId);
  return i.store.inTransaction((): DigestTickResult => {
    if (i.store.getDecisionDigest(date)) return { ran: false };
    const queued = digest !== null && enqueueDigest(i.store, chatId, date, digest) === "queued";
    if (queued && digest) { i.store.markProposalsOffered(digest.offered.proposal_ids, i.now); i.store.markJobsOffered(digest.offered.job_ids, i.now); }
    i.store.recordDecisionDigest({ local_date: date, sent: queued, offered: queued && digest ? digest.offered.decision_ids : [], created_at: i.now });
    return { ran: true, sent: queued };
  });
}

/** The queue's verdict; a conflict (another payload holds today's key) is logged, never a silent "sent", and a duplicate sets no offers. */
function enqueueDigest(store: RunStore, chatId: string, date: string, digest: Digest): "queued" | "duplicate" | "conflict" {
  const r = store.enqueueNotification({ target: { kind: "telegram", chat_id: chatId }, intent_type: "progress", idempotency_key: `decision_digest:${date}`,
    correlation_id: "decision-digest", payload: { text: digest.text, ...(digest.button_rows.length > 0 ? { button_rows: digest.button_rows } : {}) } });
  if (r.status === "conflict") console.error(`decisions: digest for ${date} not queued (${r.error})`);
  return r.status;
}
