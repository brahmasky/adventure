import { randomUUID } from "node:crypto";
import type { NotificationPayload } from "../notifications/notification-types.js";
import type { MailItemRow, RunStore } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import { inert, senderLabel } from "./card.js";
import { resolveMailEnabled } from "./flag.js";

/**
 * `/inbox`, `/inbox all`, `/mail status` and the sender rules behind the card taps (spec 2026-11-09 §3.6). Item text on a line is
 * redacted header text made inert (card.ts); a row past retention has no text and renders `sender · date · kind`.
 */
export const INBOX_PAGE = 30;
export const INBOX_ALL_LINES = 50;
export const INBOX_ALL_DAYS = 7;
/** Telegram's message cap is 4096; a view never builds past this, and an item cut for room is neither shown nor marked seen. */
const TEXT_BUDGET = 3600;
const DAY_MS = 86_400_000;
const KIND_ORDER: readonly string[] = ["risk", "action", "fyi", "noise", "mail"];
const BUTTONS_PER_ROW = 5;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const kindOf = (i: MailItemRow): string => i.kind ?? "mail";
const stamp = (iso: string, env: NodeJS.ProcessEnv = process.env): string => formatInstantInZone(iso, resolveDisplayZone(env)).slice(5);

function lineOf(n: number, i: MailItemRow): string {
  const who = i.from_name !== null ? inert(clip(i.from_name, 24)) : senderLabel(i);
  if (i.text_cleared_at !== null || i.subject === null) return `${n}. ${who} · ${stamp(i.received_at)} · ${kindOf(i)}`;
  return `${n}. ${who} · ${inert(clip(i.subject, 40))} · ${stamp(i.received_at)}`;
}

/** Items grouped by kind (risk first), each group keeping its input order; the group a row falls in is the only thing this decides. */
function grouped(items: readonly MailItemRow[]): MailItemRow[] {
  const rank = (i: MailItemRow): number => { const r = KIND_ORDER.indexOf(kindOf(i)); return r === -1 ? KIND_ORDER.length : r; };
  return items.map((item, idx) => ({ item, idx })).sort((a, b) => rank(a.item) - rank(b.item) || a.idx - b.idx).map((x) => x.item);
}

/** The numbered lines that fit the budget, the kind headers between them, and the items they show. */
function renderLines(items: readonly MailItemRow[], budget: number): { lines: string[]; shown: MailItemRow[] } {
  const lines: string[] = [];
  const shown: MailItemRow[] = [];
  let used = 0;
  let lastKind = "";
  for (const item of grouped(items)) {
    const head = kindOf(item) !== lastKind ? [`**${kindOf(item)}**`] : [];
    const line = lineOf(shown.length + 1, item);
    const cost = [...head, line].reduce((n, l) => n + l.length + 1, 0);
    if (used + cost > budget) break;
    used += cost;
    lines.push(...head, line);
    lastKind = kindOf(item);
    shown.push(item);
  }
  return { lines, shown };
}

/** One "should have pinged" tap per shown line, labelled with the line's number, in rows of five. */
function tapRows(shown: readonly MailItemRow[]): Array<Array<{ text: string; data: string }>> {
  const rows: Array<Array<{ text: string; data: string }>> = [];
  shown.forEach((item, idx) => {
    if (idx % BUTTONS_PER_ROW === 0) rows.push([]);
    rows[rows.length - 1]!.push({ text: `🔔 ${idx + 1}`, data: `mail:shp:${item.item_id}` });
  });
  return rows;
}

/**
 * One page of /inbox: the oldest 30 UNSEEN inbox items grouped by kind. `page` only labels it (capped at 9999): every page, and
 * the first, is "the remaining unseen", so a page tapped twice or out of order skips nothing. The reply is queued before the
 * items are marked seen: a crash between replays the same reply (same key and text) and marks them on the retry.
 */
export function inboxView(store: RunStore, page: number, now: Date, enqueue?: (p: NotificationPayload) => boolean): NotificationPayload {
  const label = Math.min(Math.max(1, Math.floor(page)), 9999);
  const unseen = store.listUnseenInbox(INBOX_PAGE);
  if (unseen.length === 0) {
    const empty: NotificationPayload = { text: "📭 Nothing unseen in /inbox." };
    enqueue?.(empty);
    return empty;
  }
  const { lines, shown } = renderLines(unseen, TEXT_BUDGET);
  const left = store.countUnseenInbox() - shown.length;
  const rows = tapRows(shown);
  if (left > 0 && label < 9999) rows.push([{ text: `Next (${left} more)`, data: `mail:page:${label + 1}` }]);
  const payload: NotificationPayload = { text: [`📥 **Inbox** · page ${label} · ${shown.length} unseen`, ...lines].join("\n"), button_rows: rows };
  // items are marked seen only once the page is queued for delivery (codex W2): a rejected enqueue hides nothing
  if (enqueue === undefined || enqueue(payload)) store.markMailSeen(shown.map((i) => i.item_id), now.toISOString());
  else console.error("[mail] inbox page not queued: nothing marked seen");
  return payload;
}

/** `/inbox all`: the last 7 days, seen or not, at most 50 lines and "and N more"; nothing is marked seen. */
export function inboxAllView(store: RunStore, now: Date): NotificationPayload {
  const since = new Date(now.getTime() - INBOX_ALL_DAYS * DAY_MS).toISOString();
  const items = store.listInboxSince(since, 5000);
  if (items.length === 0) return { text: `📭 Nothing in /inbox from the last ${INBOX_ALL_DAYS} days.` };
  const { lines, shown } = renderLines(items.slice(0, INBOX_ALL_LINES), TEXT_BUDGET);
  const more = items.length - shown.length;
  const tail = more > 0 ? [`…and ${more} more`] : [];
  return { text: [`📥 **Inbox, last ${INBOX_ALL_DAYS} days** · ${items.length}`, ...lines, ...tail].join("\n"), button_rows: tapRows(shown) };
}

/** `/mail status`: the switches, the last good poll, the last 24 hours in counts, and the Jev state. Counts only, never mail text. */
export function mailStatusText(store: RunStore, env: NodeJS.ProcessEnv, now: Date): string {
  const st = store.mailState();
  const day = new Date(now.getTime() - DAY_MS).toISOString();
  const hour = new Date(now.getTime() - 3_600_000).toISOString();
  const pings = store.countMailPingsSince(day);
  const inbox = store.listInboxSince(day, 5000);
  const folded = store.listInboxSince(hour, 5000).filter((i) => i.reason_code === "folded").length;
  const rungs = store.countMailDecisionRungs(hour);
  const jev = store.meteredFuseLatched() ? "fused (metered cap latched)" : rungs.fail > 0 ? `degraded (${rungs.fail} fell back, ${rungs.system_one} answered, last hour)` : "ok";
  return [
    `📧 **Mail** · ${st.enabled && resolveMailEnabled(env) ? "on" : "off"} (switch ${st.enabled ? "on" : "off"}, env ${resolveMailEnabled(env) ? "on" : "off"})`,
    `last successful poll: ${st.last_ok_at ? stamp(st.last_ok_at, env) : "never"}${st.last_error_code ? ` · last error: ${st.last_error_code}` : ""}`,
    `last 24h: ${pings + inbox.length} items · ${pings} pings · ${folded} folded this hour · ${store.countUnseenInbox()} unseen in /inbox`,
    `Jev: ${jev}`
  ].join("\n");
}

/** first character + `***` + `@domain`; an address that is not one is never echoed. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 1 ? "***" : `${address.slice(0, 1)}***${address.slice(at)}`;
}

export type SenderRuleResult = { ok: true; rule_id: string; masked: string } | { ok: false; why: "invalid_address" | "no_item" };

/**
 * A rule keyed by the item's validated address. The row and its `/changes` line (topic `mail_log`) are one transaction; a repeat of
 * the same rule changes and logs nothing.
 */
export function applySenderRule(store: RunStore, item_id: string, action: "always" | "never", now: Date): SenderRuleResult {
  const item = store.getMailItem(item_id);
  if (!item) return { ok: false, why: "no_item" };
  if (item.from_address === "invalid") return { ok: false, why: "invalid_address" };
  const masked = maskAddress(item.from_address);
  const existing = store.senderRule(item.from_address);
  if (existing?.action === action) return { ok: true, rule_id: existing.rule_id, masked };
  const rule_id = existing?.rule_id ?? `mr_${randomUUID()}`; // a flip keeps the id, so the earlier line's undo command still works
  const nowIso = now.toISOString();
  store.inTransaction(() => {
    store.upsertSenderRule({ rule_id, address: item.from_address, action, source_item_id: item_id, created_at: nowIso });
    const verb = action === "never" ? "never ping from" : "always ping from";
    logRule(store, rule_id, action, `Mail rule ${rule_id} — ${verb} ${masked}. Undo: /mail_undo ${rule_id}`, nowIso);
  });
  return { ok: true, rule_id, masked };
}

/** Removes a rule and logs it in one transaction (codex W1: a deletion is never left unannounced); false when there was no such rule (already undone). */
export function undoSenderRule(store: RunStore, rule_id: string, now: Date): boolean {
  return store.inTransaction(() => {
    const gone = store.deleteSenderRule(rule_id);
    if (!gone) return false;
    logRule(store, rule_id, "undo", `Mail rule ${rule_id} removed — ${maskAddress(gone.address)} is triaged normally again.`, now.toISOString());
    return true;
  });
}

function logRule(store: RunStore, rule_id: string, key: string, text: string, now: string): void {
  const res = store.enqueueNotification({ topic: "mail_log", idempotency_key: `mail:rule:${rule_id}:${key}:${now}`, correlation_id: rule_id, text, now });
  if (res.status !== "logged" && res.status !== "duplicate_log") throw Object.assign(new Error("mail_log line not recorded"), { code: `MAIL_RULE_LOG_${res.status.toUpperCase()}` });
}
