import type { NotificationRecord, RunStore } from "../run/run-store.js";
import type { NotificationIntent } from "./notification-types.js";

/**
 * Thin wrapper over the RunStore notification_outbox methods. Provides a
 * focused surface for the dispatcher and CLI without exposing the rest of the
 * store. All durability, idempotency, and ledger bookkeeping lives in RunStore.
 */
export class NotificationOutbox {
  constructor(private readonly store: RunStore) {}

  enqueue(intent: NotificationIntent): NotificationRecord {
    const result = this.store.enqueueNotification(intent);
    if (result.status === "conflict") {
      throw new Error(result.error);
    }
    return result.record;
  }

  claimNext(lease_owner: string, lease_ttl_seconds: number): NotificationRecord | null {
    return this.store.claimNextNotification(lease_owner, lease_ttl_seconds);
  }

  markDelivered(notification_id: string, provider_message_id: string): void {
    this.store.markNotificationDelivered(notification_id, provider_message_id);
  }

  markFailed(
    notification_id: string,
    error_ref: string,
    retryable: boolean,
    now: string,
    max_attempts: number
  ): void {
    this.store.markNotificationFailed(notification_id, error_ref, retryable, now, max_attempts);
  }

  get(notification_id: string): NotificationRecord | undefined {
    return this.store.getNotification(notification_id);
  }
}
