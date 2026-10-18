import type { NotificationButton } from "../notifications/notification-types.js";
import type { DecisionRow, RunStore } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import { REGISTRY } from "./registry.js";
import { TRUST_ORDER, rankOf, type TrustLevel } from "./entries/turn-trust.js";
import { TRUST_TAP_BUDGET } from "./trust-ask.js";
import type { AnyEntry, DecidedBy } from "./types.js";

/**
 * The daily decision digest (spec §8.1), stage 1 content: unsure verdicts with ✅/❌ taps, counts per entry by rung, and
 * per-entry health. Improvements, proposals and the gaming watch join in stage 2b. One message per local date at
 * HOUGE_DECISION_DIGEST_AT, through the outbox and the rich renderer; skipped when the day has no decisions and no health failures (a day with only health failures sends a Health-only digest). No enable
 * flag (R13): the time is the only knob, and `off` (Paco 2026-10-14) switches the summary off; the ledger under it is unchanged.
 */
export const DEFAULT_DIGEST_AT = "21:00";
export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
export const UNSURE_BAND = 0.15;
export const UNSURE_MAX = 8;
/** The review tap's callback prefix (`dec:rv:<decision_id>:<ok|bad>`); the callback parser imports it, never a second literal. */
export const REVIEW_PREFIX = "dec:rv:";
const SNIPPET_CHARS = 40;
const RUNG_ORDER: readonly DecidedBy[] = ["rule", "system_one", "model", "paco", "fail"];
/** Entries decided over Paco's own message: their unsure line may quote his words (never tool text, plan ruling 10). */
const PACO_TEXT_STAGES: ReadonlySet<string> = new Set(["intake", "pre_model"]);
/** Entries whose rows settleTriage writes with the turn's verdict (plan ruling 14). */
const FRONT_DOOR: ReadonlySet<string> = new Set(["turn.handler", "turn.gear"]);
/**
 * Ruling R1: the routes a System One row carries when the tree judged at p >= the bar. An allowlist, so a new route reason
 * (or a fallback like `uncalibrated` / `below_bar` / `cascade`, whose p is arbitrary or sub-bar) is never offered by default.
 */
const JUDGEMENT_REASONS: ReadonlySet<string> = new Set(["routed", "bare_ack_guard", "lane_limits", "correction", "two_request", "fix", "memory_other", "jev_kind"]);
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

/** Code points, not UTF-16 units: a split surrogate pair would make Telegram reject the HTML send. */
const snippetOf = (text: string): string => Array.from(text.replace(/[*_`[\]<>]/g, " ").replace(/\s+/g, " ").trim()).slice(0, SNIPPET_CHARS).join("");

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

function unsureLine(store: RunStore, r: DecisionRow, n: number, tz: string, registry: readonly AnyEntry[]): string {
  const entry = registry.find((e) => e.id === r.entry_id);
  const words = entry && PACO_TEXT_STAGES.has(entry.stage) && r.run_id ? store.userTurnTextForRun(r.run_id) : undefined;
  const at = formatInstantInZone(r.created_at, tz).slice(11);
  return `${n}. ${r.entry_id} → ${r.verdict} · p ${(r.p ?? 0).toFixed(2)} · ${at}${words ? ` · «${snippetOf(words)}»` : ""}`;
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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Per entry over the whole window (spec §5.2): Jev skips by the store's own rule (`countDecisionJevSkips`, ruling M1: a
 * failure ON the System One rung, stale_bar and budget excluded), named fallbacks (`fail` rows, budget excluded), and rows
 * run in the configured triage shadow when there are any; entries with nothing to report are left out.
 */
function healthLines(store: RunStore, rows: readonly DecisionRow[], since: string, until: string): string[] {
  const ids = [...new Set(rows.map((r) => r.entry_id))].sort();
  return ids.flatMap((id) => {
    const mine = rows.filter((r) => r.entry_id === id);
    const skips = store.countDecisionJevSkips(id, since, until).failed;
    const fallbacks = mine.filter((r) => r.rung === "fail" && r.fallback_reason !== null && r.fallback_reason !== "budget").length;
    const shadowed = mine.filter((r) => r.armed_mode === "shadow").length;
    if (skips + fallbacks + shadowed === 0) return [];
    return [`· ${id}: ${plural(skips, "Jev skip")} · ${plural(fallbacks, "fallback")}${shadowed > 0 ? ` · ${shadowed} in configured shadow` : ""}`];
  });
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

/** The golden set's model-move page (spec 4.2): a provisional bar measured on one model, judged by another, until Paco looks. */
function staleBarLines(store: RunStore): string[] {
  return store.listOpenIncidents().filter((i) => i.kind === "decision_bar_stale").map((i) => {
    const d = JSON.parse(i.detail_json) as { model?: unknown; bar_model?: unknown };
    return `· ${i.subject}: the bar was measured on ${String(d.bar_model)}, Jev now reports ${String(d.model)}`;
  });
}

/** The two stage 2a sections; each is left out when it has nothing to say, so a stage 1 day renders as before. */
function stage2aSections(store: RunStore, rows: readonly DecisionRow[], now: string, env: NodeJS.ProcessEnv): string[] {
  const trust = trustLines(store, rows, now, env);
  const reasks = reaskLines(rows);
  return [...(trust.length > 0 ? [["**Injection & trust (24 h)**", ...trust].join("\n")] : []),
    ...(reasks.length > 0 ? [["**Noise band (24 h)**", ...reasks].join("\n")] : [])];
}

export interface Digest { text: string; button_rows: NotificationButton[][]; offered: string[] }

/** The 24 h before `now`: every row (health reads orphans too) and the settled rows the counts read. */
export function decisionWindow(store: RunStore, now: string): { since: string; all: DecisionRow[]; rows: DecisionRow[] } {
  const since = new Date(Date.parse(now) - DIGEST_WINDOW_MS).toISOString();
  const all = store.listDecisionsBetween(since, now);
  return { since, all, rows: settledRows(store, all) };
}

export function buildDecisionDigest(store: RunStore, now: string, env: NodeJS.ProcessEnv = process.env, registry: readonly AnyEntry[] = REGISTRY): Digest | null {
  const { since, all, rows } = decisionWindow(store, now);
  // Health reads every row in the window, orphans included: a day of only unsettled rows still reports its failures.
  const health = healthLines(store, all, since, now);
  const stale = staleBarLines(store);
  if (rows.length === 0 && health.length === 0 && stale.length === 0) return null;
  const tz = resolveDisplayZone(env);
  const unsure = unsureOf(rows, registry);
  const sections = [`🪜 **Decisions — ${formatInstantInZone(now, tz).slice(0, 10)}**`];
  if (unsure.length > 0) sections.push(["**Unsure** (✅ right · ❌ wrong)", ...unsure.map((r, k) => unsureLine(store, r, k + 1, tz, registry))].join("\n"));
  if (rows.length > 0) sections.push(["**Counts (24 h)**", ...countLines(rows)].join("\n"));
  sections.push(...stage2aSections(store, rows, now, env));
  if (stale.length > 0) sections.push(["**Bar stale**", ...stale].join("\n"));
  if (health.length > 0) sections.push(["**Health**", ...health].join("\n"));
  return { text: sections.join("\n\n"), button_rows: unsure.map((r, k) => reviewButtons(r.decision_id, k + 1)), offered: unsure.map((r) => r.decision_id) };
}

export interface DigestTickInput { store: RunStore; chatId: string | null; now: string; env?: NodeJS.ProcessEnv }
export type DigestTickResult = { ran: false } | { ran: true; sent: boolean };

/** Due once per local date at or after HOUGE_DECISION_DIGEST_AT; the latch row and the message commit together. */
export function runDecisionDigestTick(i: DigestTickInput): DigestTickResult {
  const env = i.env ?? process.env;
  if (!i.chatId || digestOff(env)) return { ran: false };
  const chatId = i.chatId;
  const [date, time] = formatInstantInZone(i.now, resolveDisplayZone(env)).split(" ") as [string, string];
  if (time < resolveDigestAt(env) || i.store.getDecisionDigest(date)) return { ran: false };
  const digest = buildDecisionDigest(i.store, i.now, env);
  return i.store.inTransaction((): DigestTickResult => {
    if (i.store.getDecisionDigest(date)) return { ran: false };
    const sent = digest !== null && enqueueDigest(i.store, chatId, date, digest);
    i.store.recordDecisionDigest({ local_date: date, sent, offered: digest && sent ? digest.offered : [], created_at: i.now });
    return { ran: true, sent };
  });
}

/** False on an idempotency conflict (another payload already holds today's key): the day latches sent 0, logged, never a silent "sent". */
function enqueueDigest(store: RunStore, chatId: string, date: string, digest: Digest): boolean {
  const r = store.enqueueNotification({ target: { kind: "telegram", chat_id: chatId }, intent_type: "progress", idempotency_key: `decision_digest:${date}`,
    correlation_id: "decision-digest", payload: { text: digest.text, ...(digest.button_rows.length > 0 ? { button_rows: digest.button_rows } : {}) } });
  if (r.status !== "conflict") return true;
  console.error(`decisions: digest for ${date} not queued (${r.error})`);
  return false;
}
