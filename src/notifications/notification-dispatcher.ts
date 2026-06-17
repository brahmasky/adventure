import type { NotificationRecord } from "../run/run-store.js";
import type { NotificationOutbox } from "./notification-outbox.js";
import type {
  NotificationAdapter,
  NotificationDispatchRecord
} from "./notification-types.js";

export interface NotificationAdapters {
  local: NotificationAdapter;
  telegram: NotificationAdapter;
}

export interface NotificationDispatcherOptions {
  lease_ttl_seconds?: number;
  max_attempts?: number;
}

export type DispatchResult =
  | { status: "idle" }
  | { status: "delivered"; notification_id: string }
  | { status: "failed"; notification_id: string; retryable: boolean };

const DEFAULT_LEASE_TTL_SECONDS = 30;
const DEFAULT_MAX_ATTEMPTS = 5;

export class NotificationDispatcher {
  private readonly leaseTtlSeconds: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly outbox: NotificationOutbox,
    private readonly adapters: NotificationAdapters,
    options: NotificationDispatcherOptions = {}
  ) {
    this.leaseTtlSeconds = options.lease_ttl_seconds ?? DEFAULT_LEASE_TTL_SECONDS;
    this.maxAttempts = options.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async dispatchOnce(lease_owner: string): Promise<DispatchResult> {
    const claimed = this.outbox.claimNext(lease_owner, this.leaseTtlSeconds);
    if (!claimed) {
      return { status: "idle" };
    }

    const adapter = this.selectAdapter(claimed);
    try {
      const sent = await adapter.send(toDispatchRecord(claimed));
      this.outbox.markDelivered(claimed.notification_id, sent.provider_message_id);
      return { status: "delivered", notification_id: claimed.notification_id };
    } catch (error) {
      const error_ref = error instanceof Error ? error.message : String(error);
      this.outbox.markFailed(
        claimed.notification_id,
        error_ref,
        true,
        new Date().toISOString(),
        this.maxAttempts
      );
      const after = this.outbox.get(claimed.notification_id);
      return {
        status: "failed",
        notification_id: claimed.notification_id,
        retryable: after?.state === "retry_wait"
      };
    }
  }

  private selectAdapter(record: NotificationRecord): NotificationAdapter {
    return record.target.kind === "telegram" ? this.adapters.telegram : this.adapters.local;
  }
}

function toDispatchRecord(record: NotificationRecord): NotificationDispatchRecord {
  return {
    notification_id: record.notification_id,
    target: record.target,
    intent_type: record.intent_type,
    idempotency_key: record.idempotency_key,
    payload: record.payload,
    state: record.state,
    attempt_count: record.attempt_count,
    provider_message_id: record.provider_message_id
  };
}
