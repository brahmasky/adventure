import type { AttachCheck } from "./attachment-check.js";
import type { NotifyTarget } from "../domain/types.js";
import type { ChatTopic, LogTopic } from "./topics.js";

/**
 * A single inline button on a notification (Phase 3.3). `text` is the visible label;
 * `data` is the Telegram `callback_data` sent back on tap (e.g. `selfwrite:merge:run_x`). A link button is a
 * `NotificationUrlButton`. Adapters that support inline keyboards render these; others ignore them.
 */
export interface NotificationButton {
  text: string;
  data: string;
}

/** A button that opens a link instead of calling back (the mail card's "Open"). Typed for `button_rows` only; flat `buttons` tolerates it at runtime (stored JSON) but is not typed for it. */
export interface NotificationUrlButton {
  text: string;
  url: string;
}

/** A notification payload: the text plus optional inline buttons (Phase 3.3). */
export interface NotificationPayload {
  text: string;
  buttons?: NotificationButton[];
  /** Several keyboard rows (one button pair per row); when present the adapter renders these instead of `buttons`. */
  button_rows?: Array<Array<NotificationButton | NotificationUrlButton>>;
  /** Send without a notification sound (Telegram `disable_notification`). Absent/false → a normal send. */
  silent?: boolean;
  [key: string]: unknown;
}

export type NotificationIntentType =
  | "progress"
  | "final_report"
  | "approval_prompt"
  | "approval_resolved";

/** A notice for Paco's chat: queued in the outbox and delivered to `target`. */
export interface ChatIntent {
  topic: ChatTopic;
  target: NotifyTarget;
  intent_type: NotificationIntentType;
  idempotency_key: string;
  run_id?: string;
  approval_id?: string;
  correlation_id: string;
  payload: NotificationPayload;
}

/** A background notice: written to the change log, never to chat (spec 2026-11-03 §4). */
export interface LogIntent {
  topic: LogTopic;
  idempotency_key: string;
  correlation_id: string;
  text: string;
  now?: string;
}

export type NotificationIntent = ChatIntent | LogIntent;

/** The attempt cap for one notification: the dispatcher's default, and what crash recovery honours too. */
export const NOTIFICATION_MAX_ATTEMPTS = 5;

export type NotificationState =
  | "queued"
  | "sending"
  | "delivered"
  | "retry_wait"
  | "failed_terminal";

/**
 * Minimal projection of a notification handed to an adapter for sending.
 * Adapters must not depend on outbox bookkeeping columns (lease, timestamps).
 */
export interface NotificationDispatchRecord {
  notification_id: string;
  target: NotifyTarget;
  intent_type: NotificationIntentType;
  idempotency_key: string;
  payload: NotificationPayload;
  state: string;
  attempt_count: number;
  provider_message_id: string | null;
}

export interface NotificationSendResult {
  provider_message_id: string;
  /** The attachment checks this delivery made (spec R7 §4.2): enums only, never a path; absent when the payload carried none. */
  attach_checks?: readonly AttachCheck[];
}

export interface NotificationAdapter {
  send(notification: NotificationDispatchRecord): Promise<NotificationSendResult>;
}

export function notificationTargetKey(target: NotifyTarget): string {
  return target.kind === "local" ? "local" : `telegram:${target.chat_id}`;
}
