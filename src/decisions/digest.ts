import type { NotificationButton } from "../notifications/notification-types.js";
import type { DecisionRow, RunStore } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import { REGISTRY } from "./registry.js";
import type { AnyEntry, DecidedBy } from "./types.js";

/**
 * The daily decision digest (spec §8.1), stage 1 content: unsure verdicts with ✅/❌ taps, counts per entry by rung, and
 * per-entry health. Improvements, proposals and the gaming watch join in stage 2b. One message per local date at
 * HOUGE_DECISION_DIGEST_AT, through the outbox and the rich renderer; skipped when the day has no decisions. No enable
 * flag (R13): the time is the only knob.
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
/** Ruling R1: routes a System One row can carry that are fallbacks, not judgements (their p is arbitrary). */
const NOT_A_JUDGEMENT: ReadonlySet<string> = new Set(["uncalibrated", "cascade_failed"]);

export function resolveDigestAt(env: NodeJS.ProcessEnv): string {
  const raw = env.HOUGE_DECISION_DIGEST_AT?.trim();
  return raw !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_DIGEST_AT;
}

/** The entry's single probability bar (its System One rung's), when it has one. */
export function barOf(entry: AnyEntry): number | undefined {
  const rung = entry.ladder.find((r) => r.kind === "system_one");
  return rung?.kind === "system_one" ? rung.bars.p : undefined;
}

/** Applied System One judgements within UNSURE_BAND of their entry's bar, newest first, at most UNSURE_MAX. */
export function unsureOf(rows: readonly DecisionRow[], registry: readonly AnyEntry[] = REGISTRY): DecisionRow[] {
  const bars = new Map(registry.map((e) => [e.id, barOf(e)] as const));
  return rows.filter((r) => {
    const bar = bars.get(r.entry_id);
    return r.rung === "system_one" && r.armed_mode === "on" && !NOT_A_JUDGEMENT.has(r.reason_code ?? "") && r.p !== null && bar !== undefined
      && Math.abs(r.p - bar) <= UNSURE_BAND + 1e-9;
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

function countLines(rows: readonly DecisionRow[]): string[] {
  const by = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = by.get(r.entry_id) ?? new Map<string, number>();
    m.set(r.rung, (m.get(r.rung) ?? 0) + 1);
    by.set(r.entry_id, m);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, m]) => {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const known = RUNG_ORDER.filter((k) => m.has(k)).map((k) => `${k} ${m.get(k)}`);
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

export interface Digest { text: string; button_rows: NotificationButton[][]; offered: string[] }

export function buildDecisionDigest(store: RunStore, now: string, env: NodeJS.ProcessEnv = process.env, registry: readonly AnyEntry[] = REGISTRY): Digest | null {
  const since = new Date(Date.parse(now) - DIGEST_WINDOW_MS).toISOString();
  const all = store.listDecisionsBetween(since, now);
  const rows = settledRows(store, all);
  if (rows.length === 0) return null;
  const tz = resolveDisplayZone(env);
  const unsure = unsureOf(rows, registry);
  const sections = [`🪜 *Decisions — ${formatInstantInZone(now, tz).slice(0, 10)}*`];
  if (unsure.length > 0) sections.push(["*Unsure* (✅ right · ❌ wrong)", ...unsure.map((r, k) => unsureLine(store, r, k + 1, tz, registry))].join("\n"));
  sections.push(["*Counts (24 h)*", ...countLines(rows)].join("\n"));
  const health = healthLines(store, all, since, now);
  if (health.length > 0) sections.push(["*Health*", ...health].join("\n"));
  return { text: sections.join("\n\n"), button_rows: unsure.map((r, k) => reviewButtons(r.decision_id, k + 1)), offered: unsure.map((r) => r.decision_id) };
}

export interface DigestTickInput { store: RunStore; chatId: string | null; now: string; env?: NodeJS.ProcessEnv }
export type DigestTickResult = { ran: false } | { ran: true; sent: boolean };

/** Due once per local date at or after HOUGE_DECISION_DIGEST_AT; the latch row and the message commit together. */
export function runDecisionDigestTick(i: DigestTickInput): DigestTickResult {
  const env = i.env ?? process.env;
  if (!i.chatId) return { ran: false };
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
