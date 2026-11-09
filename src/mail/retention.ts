import type { RunStore } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import { mailTextDays } from "./flag.js";

/**
 * Mail text retention (spec 2026-11-09 §4). Subject, snippet and sender name live `HOUGE_MAIL_TEXT_DAYS` (30); after that the
 * row keeps its envelope facts and loses the text, and the card in the outbox (whatever state it is in) is reduced to a bare
 * kind line so the text is not left behind in a payload. Once a local date; `purgeMail` is the same without the age cut.
 */
const DAY_MS = 86_400_000;
/** Idempotency-key prefix of every /inbox reply (they carry redacted subjects); stripped with the items' text. */
export const INBOX_REPLY_KEY_PREFIX = "mail:inbox:";
const INBOX_CLEARED = { text: "📧 /inbox page (cleared)", buttons: [] };
export type RetentionResult = { cleared: number; stripped: number };

/**
 * Reduces each item's card to `📧 · <kind>` (recomputed hash) first, then clears the text: a crash between leaves the items
 * uncleared and unlatched, so the next tick repeats both steps (both idempotent).
 */
function strip(store: RunStore, ids: readonly string[], now: Date): RetentionResult {
  let stripped = 0;
  for (const id of ids) {
    const kind = store.getMailItem(id)?.kind ?? "mail";
    for (const n of store.mailCardNotificationIds([id])) { store.replaceNotificationPayload(n, { text: `📧 · ${kind}`, buttons: [] }); stripped += 1; }
  }
  if (ids.length > 0) store.clearMailItemText(ids, now.toISOString());
  return { cleared: ids.length, stripped };
}

/** Reduces /inbox replies created before `cutoff` to a bare line (recomputed hash); returns how many. */
function stripInboxReplies(store: RunStore, cutoffIso: string): number {
  const ids = store.mailInboxReplyIds(INBOX_REPLY_KEY_PREFIX, cutoffIso);
  for (const n of ids) store.replaceNotificationPayload(n, INBOX_CLEARED);
  return ids.length;
}

export function runMailRetention(store: RunStore, now: Date, env: NodeJS.ProcessEnv): RetentionResult {
  const today = formatInstantInZone(now.toISOString(), resolveDisplayZone(env)).slice(0, 10);
  if (store.mailState().retention_on === today) return { cleared: 0, stripped: 0 };
  const ids = store.mailItemsTextBefore(new Date(now.getTime() - mailTextDays(env) * DAY_MS).toISOString());
  const r = strip(store, ids, now);
  r.stripped += stripInboxReplies(store, new Date(now.getTime() - mailTextDays(env) * DAY_MS).toISOString());
  store.setMailState({ retention_on: today });
  return r;
}

/** `/mail purge`: every item's text and card text now, and the known-sender cache. */
export function purgeMail(store: RunStore, now: Date): RetentionResult {
  const r = strip(store, store.mailItemsTextBefore(new Date(now.getTime() + DAY_MS).toISOString()), now);
  r.stripped += stripInboxReplies(store, new Date(now.getTime() + DAY_MS).toISOString());
  store.clearMailSenders();
  return r;
}
