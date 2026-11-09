import { randomUUID } from "node:crypto";
import { errorCode } from "../domain/error-code.js";
import type { TypedTaskEvent } from "../domain/types.js";
import { pacoAddress, resolveMailEnabled } from "../mail/flag.js";
import { INBOX_REPLY_KEY_PREFIX } from "../mail/retention.js";
import { applySenderRule, inboxAllView, inboxView, mailStatusText, undoSenderRule } from "../mail/inbox.js";
import type { NotificationButton, NotificationPayload } from "../notifications/notification-types.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { TAP_FAILED_TEXT } from "./improvement-commands.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/**
 * `/inbox`, `/mail`, `/mail_undo` and the mail taps (spec 2026-11-09 §3.6). Every handler runs under oncePerTrigger, so a
 * redelivered update replies once, and replies through the outbox. Logs carry error codes only: mail text never reaches a log.
 */
export const MAIL_NO_RULE_TEXT = "Can't make a rule for this sender (no valid address on that mail).";
export const MAIL_NO_ITEM_TEXT = "That mail is no longer tracked.";
export const MAIL_NO_RULE_FOUND_TEXT = "No such rule (it may already be undone).";

const done = (status: "inbox_returned" | "mail_switched" | "mail_rule_undone" | "mail_tapped"): GatewayIntakeResult => ({ ok: true, status, run_id: "" });

/** A reply carrying keyboard rows (replyTo carries only a flat button list). Keyed on the event, so a redelivery never replies twice. True when the outbox holds it (queued, or the same row from a redelivery). */
function replyPayload(store: RunStore, event: TypedTaskEvent, suffix: string, payload: NotificationPayload): boolean {
  // The `mail:inbox:` prefix marks a reply that carries redacted subjects; retention strips it with the items' text (retention.ts).
  const r = store.enqueueNotification({ topic: "reply", target: event.notify, intent_type: "progress", idempotency_key: `${INBOX_REPLY_KEY_PREFIX}${event.idempotency_key}:${suffix}`,
    correlation_id: event.source_reference, payload });
  return r.status === "queued" || r.status === "duplicate";
}

/** Runs `fn`; a fault is logged by code only and answers false. */
function safely(label: string, fn: () => void): boolean {
  try { fn(); return true; } catch (e) { console.error(`[mail] ${label} failed: ${errorCode(e)}`); return false; }
}

export function handleInbox(store: RunStore, event: TypedTaskEvent, now: Date): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const ok = safely("inbox", () => {
      if (event.metadata?.inbox_all === true) replyPayload(store, event, "inbox", inboxAllView(store, now));
      else inboxView(store, 1, now, (p) => replyPayload(store, event, "inbox", p));
    });
    if (!ok) safely("inbox reply", () => replyTo(store, event, "inbox_failed", TAP_FAILED_TEXT));
    return done("inbox_returned");
  });
}

/**
 * `/mail on|off|status`. `on` also clears the poller's stored failure (an `auth` pause, the backoff) so a poller paused on a dead
 * grant resumes once the grant is renewed and the daemon restarted. `off` calls `onMailOff` (the daemon wires it to drop the cached
 * Paco access token in the worker and the poller); with no hook the poller still checks the switch before every request, so the
 * token only idles until it expires.
 */
export function handleMail(store: RunStore, event: TypedTaskEvent, now: Date, hooks: { onMailOff?: () => void } = {}): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    let text = TAP_FAILED_TEXT;
    safely("mail", () => { text = mailReply(store, String(event.program ?? ""), now, hooks); });
    safely("mail reply", () => replyTo(store, event, "mail", text));
    return done("mail_switched");
  });
}

function mailReply(store: RunStore, action: string, now: Date, hooks: { onMailOff?: () => void }): string {
  if (action === "on") {
    if (pacoAddress(process.env) === undefined) return "📧 Mail triage stays off: HOUGE_PACO_GMAIL_ADDRESS is not set to a valid address in the daemon's env.";
    store.setMailState({ enabled: true, enabled_at: now.toISOString(), last_error_code: null, backoff_n: 0, failing_since: null });
    return resolveMailEnabled(process.env) ? "📧 Mail triage is on." : "📧 Mail triage switch is on, but the daemon's env switch is off, so nothing is read until it is set.";
  }
  if (action === "off") {
    store.setMailState({ enabled: false });
    safely("onMailOff", () => hooks.onMailOff?.());
    return "📧 Mail triage is off. The poller stops and Paco's cached access token is dropped; revoke the grant at myaccount.google.com/permissions to end it.";
  }
  return mailStatusText(store, process.env, now);
}

export function handleMailUndo(store: RunStore, event: TypedTaskEvent, now: Date): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    let text = TAP_FAILED_TEXT;
    safely("undo", () => { text = undoSenderRule(store, String(event.program ?? ""), now) ? "↩️ Rule removed." : MAIL_NO_RULE_FOUND_TEXT; });
    safely("undo reply", () => replyTo(store, event, "mail_undo", text));
    return done("mail_rule_undone");
  });
}

const rulesOffer = (item_id: string): NotificationButton[] => [
  { text: "Never ping from this sender", data: `mail:never:${item_id}` },
  { text: "Always ping from this sender", data: `mail:always:${item_id}` }
];

function label(store: RunStore, item_id: string, which: "wrong_urgency" | "should_have_pinged", now: Date): boolean {
  if (!store.getMailItem(item_id)) return false;
  store.insertMailLabel({ label_id: `ml_${randomUUID()}`, item_id, label: which, created_at: now.toISOString() });
  return true;
}

/** The text and buttons answering one tap; throws only on a store fault (the handler turns it into the failed-tap text). */
function tapReply(store: RunStore, event: TypedTaskEvent, now: Date): { text: string; buttons?: NotificationButton[] } {
  const action = String(event.metadata?.mail_action ?? "");
  const item_id = String(event.metadata?.item_id ?? "");
  if (action === "wu") {
    return label(store, item_id, "wrong_urgency", now)
      ? { text: "Noted: wrong urgency. Want a rule for this sender?", buttons: rulesOffer(item_id) } : { text: MAIL_NO_ITEM_TEXT };
  }
  if (action === "shp") {
    return label(store, item_id, "should_have_pinged", now)
      ? { text: "Noted: that one should have pinged. Always ping from this sender?", buttons: [{ text: "Always ping from this sender", data: `mail:always:${item_id}` }] }
      : { text: MAIL_NO_ITEM_TEXT };
  }
  if (action !== "always" && action !== "never") return { text: TAP_FAILED_TEXT };
  const r = applySenderRule(store, item_id, action, now);
  if (!r.ok) return { text: r.why === "invalid_address" ? MAIL_NO_RULE_TEXT : MAIL_NO_ITEM_TEXT };
  return { text: `✅ ${action === "always" ? "Always ping" : "Never ping"} from ${r.masked}. Takes effect from the next mail. Undo: /mail_undo ${r.rule_id}` };
}

export function handleMailTap(store: RunStore, event: TypedTaskEvent, now: Date): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    if (event.metadata?.mail_action === "page") {
      const ok = safely("page", () => inboxView(store, Number(event.metadata?.mail_page ?? 1), now, (p) => replyPayload(store, event, "mail_page", p)));
      if (!ok) safely("page reply", () => replyTo(store, event, "mail_tap", TAP_FAILED_TEXT));
      return done("mail_tapped");
    }
    let reply: { text: string; buttons?: NotificationButton[] } = { text: TAP_FAILED_TEXT };
    safely("tap", () => { reply = tapReply(store, event, now); });
    safely("tap reply", () => replyTo(store, event, "mail_tap", reply.text, reply.buttons));
    return done("mail_tapped");
  });
}
