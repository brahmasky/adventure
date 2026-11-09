import { headerValue } from "../capabilities/gmail-read.js";
import type { GoogleApiDeps } from "../capabilities/google-api.js";
import type { GoogleAuthClient } from "../capabilities/google-auth.js";
import { message } from "../decisions/decide.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { MailStateRow, RunStore } from "../run/run-store.js";
import { parseFrom, type GmailMetadata } from "./envelope.js";
import { mailPollMinutes, resolveMailEnabled } from "./flag.js";
import { getMetadata, historyRange, listInbox, profileHistoryId, sentTo, type GmailErr } from "./gmail-client.js";
import { triageOne, type TriageDeps, type TriageOutcome } from "./triage.js";

/**
 * The Gmail poller tick (spec 2026-11-09 §3.2, §7). Gates, then one of: first run (profile id as cursor, 24 h backfill),
 * a history range from the cursor, or a resync when the cursor expired. The cursor advances only when every collected id is
 * stored or skipped as deleted; a tick that hits its deadline leaves it and the next tick re-reads the same range (ids only)
 * and skips what is stored. Single-flight is the daemon's detachedJob; this function has no lock of its own.
 */
export interface PollDeps extends Omit<TriageDeps, "ask"> {
  gmail: { deps: GoogleApiDeps; auth: GoogleAuthClient };
  ask: TriageDeps["ask"];
  /** Whether Paco's refresh token is present (read through the broker by the caller; never the token itself). */
  hasRefreshToken: boolean;
  signal: AbortSignal;
  deadlineMs?: number;
}
export type PollResult = { ran: false; why: "off" | "no_token" | "paused" | "busy" | "not_due" } | { ran: true; stored: number; pinged: number; cursorAdvanced: boolean; error?: "auth" | "unavailable" };

export const MAIL_TICK_DEADLINE_MS = 90_000;
export const MAIL_IN_FLIGHT = 3;
/** §7: the poller or the sweep pages mail_poll_failing once the last successful poll (or the switch-on) is older than this. */
export const MAIL_STALE_MINUTES = 120;
export const MAIL_BACKOFF_CAP_MIN = 30;
export const MAIL_FIRST_RUN_CAP = 200;
export const MAIL_RESYNC_CAP = 500;
export const FIRST_RUN_QUERY = "in:inbox newer_than:1d";
const SENT_CACHE_MS = 30 * 86_400_000;
const POLL_FAILING: ReadonlySet<string> = new Set(["mail_poll_failing"]);

type Ref = { id: string; threadId: string };
type Run = { stored: number; pinged: number; allDone: boolean; error?: "auth" | "unavailable" };
type Progress = Run & { cursorAdvanced: boolean };
const minutesSince = (iso: string, now: Date): number => (now.getTime() - Date.parse(iso)) / 60_000;

/** The one stale predicate (Rev 1.1), used by the poller and the invariant sweep: enabled by both switches and no success for MAIL_STALE_MINUTES since the last ok, or since the switch-on when none ever succeeded. */
export function mailStale(st: MailStateRow, env: NodeJS.ProcessEnv, now: Date): boolean {
  if (!st.enabled || !resolveMailEnabled(env)) return false;
  const since = st.last_ok_at ?? st.enabled_at;
  return since !== null && minutesSince(since, now) > MAIL_STALE_MINUTES;
}

export async function runMailTick(d: PollDeps): Promise<PollResult> {
  const now = d.now();
  const st = d.store.mailState();
  const why = gate(d, st, now);
  if (why !== null) return { ran: false, why };
  d.store.setMailState({ last_attempt_at: now.toISOString() });
  const p = st.history_id === null ? await firstRun(d, now) : await historyRun(d, st.history_id, now);
  settle(d, st, p, now);
  return { ran: true, stored: p.stored, pinged: p.pinged, cursorAdvanced: p.cursorAdvanced, ...(p.error ? { error: p.error } : {}) };
}

/** §3.2 gates in order: both switches, a token, no auth pause, then the cadence (or the backoff while failing). */
function gate(d: PollDeps, st: MailStateRow, now: Date): Exclude<PollResult, { ran: true }>["why"] | null {
  if (!resolveMailEnabled(d.env) || !st.enabled) return "off";
  if (!d.hasRefreshToken) return "no_token";
  if (st.last_error_code === "auth") return "paused";
  return due(d, st, now) ? null : "not_due";
}

/** §7: while failing, retry 1, 2, 4 … MAIL_BACKOFF_CAP_MIN minutes after the last attempt (checked instead of the cadence, since last_ok_at stays old). */
function due(d: PollDeps, st: MailStateRow, now: Date): boolean {
  if (st.failing_since !== null) {
    const wait = Math.min(MAIL_BACKOFF_CAP_MIN, 2 ** Math.max(0, st.backoff_n - 1));
    return st.last_attempt_at === null || minutesSince(st.last_attempt_at, now) >= wait;
  }
  return st.last_ok_at === null || minutesSince(st.last_ok_at, now) >= mailPollMinutes(d.env);
}

/** No cursor: the profile's id is read first (so anything arriving during the list is in history after it), then the 24 h backfill. */
async function firstRun(d: PollDeps, now: Date): Promise<Progress> {
  const g = d.gmail;
  const prof = await profileHistoryId(g.deps, g.auth);
  if (!prof.ok) return failed(prof);
  const list = await listInbox(FIRST_RUN_QUERY, MAIL_FIRST_RUN_CAP, g.deps, g.auth);
  if (!list.ok) return failed(list);
  return advance(d, await processIds(d, list.ids, true, now), prof.historyId);
}

async function historyRun(d: PollDeps, cursor: string, now: Date): Promise<Progress> {
  const h = await historyRange(cursor, d.gmail.deps, d.gmail.auth);
  if (!h.ok) return h.kind === "not_found" ? resync(d, cursor, now) : failed(h);
  return advance(d, await processIds(d, h.ids, false, now), h.historyId);
}

/** §3.2 cursor expired: list since the last received mail (the 24 h query before any), store as backfill (an `always` rule still pings), one mail_log line, cursor := profile id. */
async function resync(d: PollDeps, expired: string, now: Date): Promise<Progress> {
  const g = d.gmail;
  const prof = await profileHistoryId(g.deps, g.auth);
  if (!prof.ok) return failed(prof);
  const list = await listInbox(resyncQuery(d.store), MAIL_RESYNC_CAP, g.deps, g.auth);
  if (!list.ok) return failed(list);
  const p = advance(d, await processIds(d, list.ids, true, now), prof.historyId);
  if (p.cursorAdvanced) logResync(d.store, expired, list.ids.length, list.more, now.toISOString());
  return p;
}

function resyncQuery(store: RunStore): string {
  const last = store.latestMailReceivedAt();
  return last === null ? FIRST_RUN_QUERY : `in:inbox after:${Math.floor(Date.parse(last) / 1000)}`;
}

/** Gmail's list reports only that the cap was hit, not how many lie beyond it, so the line says so without a count. */
function logResync(store: RunStore, expired: string, n: number, more: boolean, nowIso: string): void {
  const text = `Mail caught up: ${n} in /inbox${more ? "; list capped, older not listed, see Gmail" : ""}`;
  const res = store.enqueueNotification({ topic: "mail_log", idempotency_key: `mail:resync:${expired}`, correlation_id: "mail-resync", text, now: nowIso });
  if (res.status === "conflict") console.error(`mail: resync log line not written: ${res.error}`);
}

/** The cursor moves only when every id of the range is stored or skipped as deleted, and no Gmail error cut the range short. */
function advance(d: PollDeps, run: Run, historyId: string): Progress {
  const cursorAdvanced = run.allDone && run.error === undefined;
  if (cursorAdvanced) d.store.setMailState({ history_id: historyId });
  return { ...run, cursorAdvanced };
}

function failed(e: GmailErr): Progress {
  return { stored: 0, pinged: 0, allDone: false, cursorAdvanced: false, error: e.kind === "auth" ? "auth" : "unavailable" };
}

/** Ids not yet stored (each once, whatever the listing repeated), at most MAIL_IN_FLIGHT at a time. The first id always dispatches; every later one is held back once the deadline passed or the daemon is stopping. */
async function processIds(d: PollDeps, ids: readonly Ref[], backfill: boolean, now: Date): Promise<Run> {
  const seen = new Set<string>();
  const pending = ids.filter((x) => !seen.has(x.id) && seen.add(x.id) && !d.store.hasMailItem(x.id));
  const run: Run = { stored: 0, pinged: 0, allDone: true };
  const deadline = d.deadlineMs ?? MAIL_TICK_DEADLINE_MS;
  let next = 0;
  const take = (): Ref | undefined => {
    if (next >= pending.length || run.error !== undefined) return undefined;
    if (next > 0 && (d.signal.aborted || d.now().getTime() - now.getTime() >= deadline)) { run.allDone = false; return undefined; }
    return pending[next++];
  };
  const worker = async (): Promise<void> => { for (let ref = take(); ref !== undefined; ref = take()) await processOne(d, ref, backfill, now, run); };
  await Promise.all(Array.from({ length: Math.min(MAIL_IN_FLIGHT, pending.length) }, worker));
  return run;
}

/** One id: metadata (a 404 is a deleted mail, skipped and done), the known-sender lookup, then the write path. */
async function processOne(d: PollDeps, ref: Ref, backfill: boolean, now: Date, run: Run): Promise<void> {
  const meta = await getMetadata(ref.id, d.gmail.deps, d.gmail.auth);
  if (!meta.ok) { if (meta.kind !== "not_found") fail(run, meta); return; }
  const known = await knownSender(d, meta.m, now);
  if (!known.ok) { fail(run, known); return; }
  const t = await triageOne(d, meta.m, { known_sender: known.found, backfill }).catch((e: unknown): TriageOutcome => {
    console.error(`mail: triage threw: ${message(e)}`);
    return { stored: false, error: "write" };
  });
  if (!t.stored) { run.allDone = false; return; }
  run.stored += 1;
  if (t.notified) run.pinged += 1;
}

function fail(run: Run, e: GmailErr): void {
  run.allDone = false;
  run.error = e.kind === "auth" ? "auth" : "unavailable";
}

/** §3.3: an `always` rule, else Paco's Sent mail to the address (one query per address per 30 days, cached); an invalid address is never queried. */
async function knownSender(d: PollDeps, m: GmailMetadata, now: Date): Promise<{ ok: true; found: boolean } | GmailErr> {
  const address = parseFrom(headerValue(m as unknown as Record<string, unknown>, "From")).address;
  if (address === "invalid") return { ok: true, found: false };
  if (d.store.senderRule(address)?.action === "always") return { ok: true, found: true };
  const cached = d.store.senderInSent(address, new Date(now.getTime() - SENT_CACHE_MS).toISOString());
  if (cached !== undefined) return { ok: true, found: cached };
  const r = await sentTo(address, d.gmail.deps, d.gmail.auth);
  if (r.ok) d.store.cacheSenderInSent(address, r.found, now.toISOString());
  return r;
}

/** §7 after the range: success stamps last_ok_at and clears the failure state; auth pauses and pages once; unavailable backs off and pages through mailStale. */
function settle(d: PollDeps, st: MailStateRow, p: Progress, now: Date): void {
  const nowIso = now.toISOString();
  if (p.error === undefined) {
    d.store.setMailState({ last_ok_at: nowIso, last_error_code: null, failing_since: null, backoff_n: 0 });
    resolveOpenIncidents(d.store, POLL_FAILING, undefined, nowIso);
    return;
  }
  if (p.error === "auth") {
    d.store.setMailState({ last_error_code: "auth" });
    openAlertedIncident(d.store, { kind: "mail_auth_lost", subject: "paco", detail: {}, chat_id: d.chatId, env: d.env, now: nowIso });
    return;
  }
  d.store.setMailState({ last_error_code: "unavailable", failing_since: st.failing_since ?? nowIso, backoff_n: st.backoff_n + 1 });
  if (mailStale(d.store.mailState(), d.env, now)) {
    openAlertedIncident(d.store, { kind: "mail_poll_failing", subject: "paco", detail: { last_ok_at: st.last_ok_at, failing_since: st.failing_since ?? nowIso }, chat_id: d.chatId, env: d.env, now: nowIso });
  }
}
