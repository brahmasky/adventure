import { escapeForTelegram, sanitizeVenueText } from "../capabilities/text-hygiene.js";
import type { NotificationPayload } from "../notifications/notification-types.js";
import type { MailItemRow } from "../run/run-store.js";

const FIELD_CAP = 200;

/** Untrusted header text rendered inert: hygiene, then markdown-escape (same as gmail-read's inertLine). */
const inert = (v: string): string => escapeForTelegram(sanitizeVenueText(v, FIELD_CAP));

export function openUrl(pacoAddress: string, threadId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(pacoAddress)}#inbox/${threadId}`;
}

export function mailCardPayload(i: { item: MailItemRow; pacoAddress: string; quiet: boolean; jevUnavailable: boolean }): NotificationPayload {
  const { item } = i;
  const name = inert(item.from_name ?? item.from_address);
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

export function foldCardPayload(): NotificationPayload {
  return { text: "More urgent mail this hour — see /inbox", silent: true };
}

/** True when the Sydney wall-clock hour falls in [start, end), wrapping past midnight when start > end. */
export function inQuietHours(now: Date, w: { start: number; end: number }, tz: "Australia/Sydney"): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now));
  return w.start <= w.end ? hour >= w.start && hour < w.end : hour >= w.start || hour < w.end;
}
