import { randomUUID } from "node:crypto";
import { decide } from "../decisions/decide.js";
import { jevMailAnswer, MAIL_TRIAGE, MAIL_TRIAGE_ID, perItemRouting, type MailTriageDetail, type MailTriageState, type MailVerdict } from "../decisions/entries/mail-triage.js";
import { afterStrictRecord, recordStrict } from "../decisions/record.js";
import type { AnyDecideResult, AnyEntry, DecideResult, DecisionRecorder } from "../decisions/types.js";
import { errorCode } from "../domain/error-code.js";
import type { MailAsk } from "../jev/mail-ask.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import type { MailItemInsert, MailLane, MailReason, NotificationQueueResult, RunStore } from "../run/run-store.js";
import { foldCardPayload, inQuietHours, mailCardPayload } from "./card.js";
import { buildItemState, jevStateOf, type GmailMetadata, type MailItemState, type MailJevState } from "./envelope.js";
import { mailQuietWindow } from "./flag.js";

/**
 * The mail write path (spec 2026-11-09 §3.4, §7). One new mail: build the envelope, run `mail.triage` with a queuing recorder
 * (the Jev call happens before any write), apply the fold and thread rules in code, then ONE transaction stores the item, its
 * decision row (strict flush) and, for a ping, its card. A throw inside rolls everything back: the cursor has not moved, the
 * next tick re-decides the mail. A mail is never stored without its decision row, nor pinged without its row.
 */
export interface TriageDeps {
  store: RunStore; chatId: string; pacoAddress: string; env: NodeJS.ProcessEnv; now: () => Date;
  /** The secret broker's redactor (identity when the firewall is off); every untrusted text field passes through it before the row write. */
  brokerRedact: (s: string) => string;
  ask: (state: MailJevState) => Promise<MailAsk>;
}
export type TriageOutcome = { stored: true; lane: MailLane; reason: MailReason; notified: boolean } | { stored: false; error: "decision" | "write" };

/** §3.4 fold: this many `ping` items stored in the last hour send the next ones to /inbox. */
export const MAIL_FOLD_LIMIT = 6;
const FOLD_WINDOW_MS = 60 * 60_000;
const THREAD_WINDOW_MS = 6 * 60 * 60_000;
const ENTRY = MAIL_TRIAGE as unknown as AnyEntry;
/** The entry's own reason codes as item reasons; `jev_unavailable` is the runner's `fail` rung, `folded` and `routing_refused` are code's. */
const ENTRY_REASONS: ReadonlySet<string> = new Set<MailReason>(["own_output", "rule_never", "rule_always", "backfill", "jev_now", "jev_later", "jev_unsure"]);

/** A failed decision insert inside the transaction; the only error that opens decision_record_failed (Rev 1.1). Its message carries the cause's code, never its text (a thrown error may quote mail). */
export class DecisionFlushFailed extends Error {
  constructor(cause: unknown) {
    super(`mail.triage decision flush failed: ${errorCode(cause)}`, { cause });
    this.name = "DecisionFlushFailed";
  }
}

type Decision = DecideResult<MailVerdict, MailTriageDetail>;
type Queued = { r: AnyDecideResult; ctx: { run_id: string | null; tool_call_id: string | null } };
type Routed = { lane: MailLane; reason: MailReason; foldDue: boolean; thread_followup: boolean; refused: boolean };
const ago = (now: Date, ms: number): string => new Date(now.getTime() - ms).toISOString();

export async function triageOne(d: TriageDeps, m: GmailMetadata, x: { known_sender: boolean; backfill: boolean }): Promise<TriageOutcome> {
  const now = d.now();
  const item_id = `mi_${randomUUID()}`;
  const thread_pinged_6h = d.store.threadPingedSince(m.threadId, ago(now, THREAD_WINDOW_MS));
  const item = buildItemState(m, { item_id, known_sender: x.known_sender, thread_pinged_6h, backfill: x.backfill, brokerRedact: d.brokerRedact, now });
  const s: MailTriageState = { item, rule: d.store.senderRule(item.from_address)?.action ?? null };
  const { r, queued } = await decideItem(d, s);
  return writeItem(d, s, r, queued, routeOf(d.store, s, r, now), now);
}

/** Step 2–3: the runner with a queuing recorder, so the async Jev call completes before any row is written. */
async function decideItem(d: TriageDeps, s: MailTriageState): Promise<{ r: Decision; queued: Queued }> {
  let queued: Queued | undefined;
  const recorder: DecisionRecorder = { record: (_entry, r, ctx) => { queued = { r, ctx }; return null; } };
  const r = await decide(MAIL_TRIAGE, s, { run_id: null, tool_call_id: s.item.item_id, recorder,
    exec: { system_one: async () => jevMailAnswer(await d.ask(jevStateOf(s.item))) } });
  if (queued === undefined) throw new Error("mail.triage: the runner recorded nothing");
  return { r, queued };
}

/** Steps 4–5: the routing gate, then lane and reason from the verdict, then the fold and the thread follow-up (code, not a decision). */
function routeOf(store: RunStore, s: MailTriageState, r: Decision, now: Date): Routed {
  const base = { foldDue: false, thread_followup: false, refused: false };
  const refused: Routed = { ...base, lane: "inbox", reason: "routing_refused", refused: true };
  if (!perItemRouting(s, r.verdict)) return refused;
  const reason = reasonOf(r);
  if (reason === null) return refused;
  if (r.verdict === "inbox") return { ...base, lane: "inbox", reason };
  if (store.countMailPingsSince(ago(now, FOLD_WINDOW_MS)) >= MAIL_FOLD_LIMIT) return { ...base, lane: "inbox", reason: "folded", foldDue: true };
  // re-read after the Jev await: two mails of one thread in flight together must not both sound (one sound per thread per 6 h, §7)
  return { ...base, lane: "ping", reason, thread_followup: s.item.thread_pinged_6h || store.threadPingedSince(s.item.thread_id, ago(now, THREAD_WINDOW_MS)) };
}

/** A `fail` rung is `jev_unavailable`; otherwise the row's reason must be one of the entry's own, or the item is refused (a code bug, never a cast). */
function reasonOf(r: Decision): MailReason | null {
  if (r.rung === "fail") return "jev_unavailable";
  return r.reason !== null && ENTRY_REASONS.has(r.reason) ? (r.reason as MailReason) : null;
}

/** Steps 6–7: the one transaction, then the recorder's bookkeeping after the commit. */
function writeItem(d: TriageDeps, s: MailTriageState, r: Decision, queued: Queued, routed: Routed, now: Date): TriageOutcome {
  const nowIso = now.toISOString();
  try {
    d.store.inTransaction(() => {
      const decision_id = flush(d.store, queued, nowIso);
      const row = rowOf(s.item, r, routed, decision_id, nowIso);
      d.store.insertMailItem(row);
      if (routed.refused) logRefused(d.store, row.item_id, nowIso);
      if (routed.lane === "ping") enqueueCard(d, row, r.rung === "fail", now);
      if (routed.foldDue) enqueueFold(d, now);
    });
  } catch (e) {
    return writeFailed(d, s.item.item_id, e, nowIso);
  }
  afterStrictRecord(d.store, ENTRY, queued.r, nowIso, d.env);
  return { stored: true, lane: routed.lane, reason: routed.reason, notified: routed.lane === "ping" };
}

function flush(store: RunStore, queued: Queued, nowIso: string): string | null {
  try {
    return recordStrict(store, ENTRY, queued.r, queued.ctx, nowIso);
  } catch (e) {
    throw new DecisionFlushFailed(e);
  }
}

function rowOf(item: MailItemState, r: Decision, routed: Routed, decision_id: string | null, nowIso: string): MailItemInsert {
  return {
    item_id: item.item_id, gmail_message_id: item.gmail_message_id, gmail_thread_id: item.thread_id, from_address: item.from_address, from_name: item.from_name,
    known_sender: item.known_sender, labels: item.labels, important: item.important, received_at: item.received_at, subject: item.subject, snippet: item.snippet,
    lane: routed.lane, kind: r.detail?.kind ?? null, reason_code: routed.reason, thread_followup: routed.thread_followup, decision_id, notification_id: null, created_at: nowIso
  };
}

/** Rev 1.1: a chat enqueue inside the transaction is `queued` or `duplicate`; anything else (a conflict) throws and rolls the item back. */
function chatQueued(res: NotificationQueueResult, what: string): Extract<NotificationQueueResult, { status: "queued" | "duplicate" }> {
  if (res.status === "queued" || res.status === "duplicate") return res;
  throw new Error(`mail ${what} enqueue: ${res.status}`);
}

function enqueueCard(d: TriageDeps, row: MailItemInsert, jevUnavailable: boolean, now: Date): void {
  const payload = mailCardPayload({ item: { ...row, seen_at: null, text_cleared_at: null }, pacoAddress: d.pacoAddress, quiet: quietNow(d, now), jevUnavailable });
  const res = chatQueued(d.store.enqueueNotification({ topic: "mail_card", target: { kind: "telegram", chat_id: d.chatId }, intent_type: "progress",
    idempotency_key: `mail:${row.gmail_message_id}`, correlation_id: row.item_id, payload }), "card");
  d.store.setMailItemNotification(row.item_id, res.record.notification_id);
}

/**
 * One fold card per UTC hour bucket; the key doubles as correlation id and the payload is fixed for the bucket (`quiet` is read
 * at the bucket's first instant, so a quiet-hours edge inside the hour cannot change it), so the second fold is `duplicate`. A
 * `conflict` (a card for this hour already exists with another build's text) also means "already sent": the item is kept
 * (codex B2); the fold card is a courtesy, never a reason to roll a folded item back.
 */
function enqueueFold(d: TriageDeps, now: Date): void {
  const bucket = now.toISOString().slice(0, 13);
  const key = `mail:fold:${bucket}`;
  const res = d.store.enqueueNotification({ topic: "mail_card", target: { kind: "telegram", chat_id: d.chatId }, intent_type: "progress",
    idempotency_key: key, correlation_id: key, payload: foldCardPayload(quietNow(d, new Date(`${bucket}:00:00.000Z`))) });
  if (res.status !== "queued" && res.status !== "duplicate" && res.status !== "conflict") throw new Error(`mail fold card enqueue: ${res.status}`);
}

const quietNow = (d: TriageDeps, now: Date): boolean => inQuietHours(now, mailQuietWindow(d.env), "Australia/Sydney");

/** §3.4: a refused routing is stored and logged inside the same transaction (a log intent answers `logged` or `duplicate_log`). */
function logRefused(store: RunStore, item_id: string, nowIso: string): void {
  const res = store.enqueueNotification({ topic: "decision_internal", idempotency_key: `mail:refused:${item_id}`, correlation_id: item_id, text: "mail.triage: routing refused for one item", now: nowIso });
  if (res.status !== "logged" && res.status !== "duplicate_log") throw new Error(`mail refused log: ${res.status}`);
}

/**
 * After the rollback: only a failed decision flush is the recorder's incident (subject = entry id, so afterRecord resolves it on the
 * next success); anything else is a write error, retried next tick. Log lines carry codes and the item id only (codex round 1):
 * an exception message may quote the sender, subject or snippet.
 */
function writeFailed(d: TriageDeps, item_id: string, e: unknown, nowIso: string): TriageOutcome {
  if (!(e instanceof DecisionFlushFailed)) {
    console.error(`mail: item write failed, rolled back: ${errorCode(e)} item=${item_id}`);
    return { stored: false, error: "write" };
  }
  console.error(`mail: ${e.message} item=${item_id}`);
  try {
    openAlertedIncident(d.store, { kind: "decision_record_failed", subject: MAIL_TRIAGE_ID, detail: { entry: MAIL_TRIAGE_ID, item: item_id }, chat_id: d.chatId, env: d.env, now: nowIso });
  } catch (e2) {
    console.error(`mail: decision_record_failed could not open: ${errorCode(e2)}`);
  }
  return { stored: false, error: "decision" };
}
