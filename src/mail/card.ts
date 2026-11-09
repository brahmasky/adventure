import { HEADER_FIELD_CAP } from "../capabilities/gmail-read.js";
import { escapeForTelegram, sanitizeVenueText } from "../capabilities/text-hygiene.js";
import type { NotificationPayload } from "../notifications/notification-types.js";
import type { MailItemRow } from "../run/run-store.js";

/** Untrusted header text rendered inert: hygiene, then markdown-escape (same as gmail-read's inertLine). */
export const inert = (v: string): string => escapeForTelegram(sanitizeVenueText(v, HEADER_FIELD_CAP));

/**
 * The sender line when no name was given: the validated address in a code span (escapeForTelegram would strip its `_`, and a
 * code span keeps the converter from reading `_x_` as italics); the `invalid` sentinel is never shown as a name.
 */
export function senderLabel(item: Pick<MailItemRow, "from_name" | "from_address">): string {
  if (item.from_name !== null) return inert(item.from_name);
  return item.from_address === "invalid" ? "(unknown sender)" : `\`${sanitizeVenueText(item.from_address, HEADER_FIELD_CAP)}\``;
}

export function openUrl(pacoAddress: string, threadId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(pacoAddress)}#inbox/${encodeURIComponent(threadId)}`;
}

export function mailCardPayload(i: { item: MailItemRow; pacoAddress: string; quiet: boolean; jevUnavailable: boolean }): NotificationPayload {
  const { item } = i;
  const name = senderLabel(item);
  const head = item.thread_followup ? `↪ +1 in this thread · ${name}` : `📧 ${name} · ${item.kind ?? "mail"}`;
  const lines = [head, item.subject ? inert(item.subject) : "(no subject)"];
  if (i.jevUnavailable) lines.push("(Jev unavailable)");
  return {
    text: lines.join("\n"),
    button_rows: [
      [{ text: "Open", url: openUrl(i.pacoAddress, item.gmail_thread_id) }],
      [{ text: "Wrong urgency", data: `mail:wu:${item.item_id}` }]
    ],
    silent: i.quiet || item.thread_followup
  };
}

/** The once-an-hour fold card (spec §3.4); silent only in quiet hours, like every other mail card (Task 7 review). */
export function foldCardPayload(quiet: boolean): NotificationPayload {
  return { text: "More urgent mail this hour — see /inbox", silent: quiet };
}

/** True when the Sydney wall-clock hour falls in [start, end), wrapping past midnight when start > end. */
export function inQuietHours(now: Date, w: { start: number; end: number }, tz: "Australia/Sydney"): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now));
  return w.start <= w.end ? hour >= w.start && hour < w.end : hour >= w.start || hour < w.end;
}
