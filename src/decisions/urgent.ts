import type { NotificationButton } from "../notifications/notification-types.js";
import type { RunStore } from "../run/run-store.js";

/**
 * Spec §8.2: an urgent card goes straight to the outbox (the telegram adapter renders it with the rich renderer). The key
 * makes it idempotent: a redelivered event never sends the card twice. Stage 1 sends `decision_fallback:<entry>`; later
 * stages add skill authoring, standing grants, hostile turns and unverified settles.
 */
export interface UrgentCard { chat_id?: string; key: string; text: string; buttons?: NotificationButton[] }

/**
 * The outbox row id (a redelivered key returns the first row's): Stage 4A stores the grant card's id on the standing row. Null on a payload conflict — the grant treats that as fatal: no grant without its Revoke card.
 * A `decision_internal` card goes to the change log instead (no chat, no buttons) and returns the change id.
 */
export function enqueueUrgentCard(store: RunStore, c: UrgentCard, topic: "urgent" | "decision_internal"): string | null {
  if (topic === "decision_internal") {
    const r = store.enqueueNotification({ topic, idempotency_key: `urgent:${c.key}`, correlation_id: c.key, text: c.text });
    return r.status === "logged" || r.status === "duplicate_log" ? r.change_id : null;
  }
  if (!c.chat_id) throw new Error(`urgent card ${c.key} has no chat_id`);
  const r = store.enqueueNotification({
    topic, target: { kind: "telegram", chat_id: c.chat_id }, intent_type: "progress", idempotency_key: `urgent:${c.key}`, correlation_id: c.key,
    payload: { text: c.text, ...(c.buttons && c.buttons.length > 0 ? { buttons: c.buttons } : {}) }
  });
  return r.status === "queued" || r.status === "duplicate" ? r.record.notification_id : null;
}
