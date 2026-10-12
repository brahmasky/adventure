import type { NotificationButton } from "../notifications/notification-types.js";
import type { RunStore } from "../run/run-store.js";

/**
 * Spec §8.2: an urgent card goes straight to the outbox (the telegram adapter renders it with the rich renderer). The key
 * makes it idempotent: a redelivered event never sends the card twice. Stage 1 sends `decision_fallback:<entry>`; later
 * stages add skill authoring, standing grants, hostile turns and unverified settles.
 */
export interface UrgentCard { chat_id: string; key: string; text: string; buttons?: NotificationButton[] }

export function enqueueUrgentCard(store: RunStore, c: UrgentCard): void {
  store.enqueueNotification({
    target: { kind: "telegram", chat_id: c.chat_id }, intent_type: "progress", idempotency_key: `urgent:${c.key}`, correlation_id: c.key,
    payload: { text: c.text, ...(c.buttons && c.buttons.length > 0 ? { buttons: c.buttons } : {}) }
  });
}
