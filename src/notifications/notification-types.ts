import type { NotifyTarget } from "../domain/types.js";

/**
 * A single inline button on a notification (Phase 3.3). `text` is the visible label;
 * `data` is the Telegram `callback_data` sent back on tap (e.g. `selfwrite:merge:run_x`).
 * Adapters that support inline keyboards render these; others ignore them.
 */
export interface NotificationButton {
  text: string;
  data: string;
}

/** A notification payload: the text plus optional inline buttons (Phase 3.3). */
export interface NotificationPayload {
  text: string;
  buttons?: NotificationButton[];
  [key: string]: unknown;
}

export type NotificationIntentType =
  | "progress"
  | "final_report"
  | "approval_prompt"
  | "approval_resolved";

export interface NotificationIntent {
  target: NotifyTarget;
  intent_type: NotificationIntentType;
  idempotency_key: string;
  run_id?: string;
  approval_id?: string;
  correlation_id: string;
  payload: NotificationPayload;
}

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
}

export interface NotificationAdapter {
  send(notification: NotificationDispatchRecord): Promise<NotificationSendResult>;
}

export function notificationTargetKey(target: NotifyTarget): string {
  return target.kind === "local" ? "local" : `telegram:${target.chat_id}`;
}
