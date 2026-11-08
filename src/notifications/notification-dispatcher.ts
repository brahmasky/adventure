import { decideSync } from "../decisions/decide.js";
import { ATTACH_PATH } from "../decisions/entries/attach-path.js";
import type { DecisionRecorder } from "../decisions/types.js";
import { errorCode } from "../domain/error-code.js";
import type { NotificationRecord } from "../run/run-store.js";
import type { AttachCheck } from "./attachment-check.js";
import type { NotificationOutbox } from "./notification-outbox.js";
import {
  NOTIFICATION_MAX_ATTEMPTS,
  type NotificationAdapter,
  type NotificationDispatchRecord
} from "./notification-types.js";

export interface NotificationAdapters {
  local: NotificationAdapter;
  telegram: NotificationAdapter;
}

export interface NotificationDispatcherOptions {
  lease_ttl_seconds?: number;
  max_attempts?: number;
  /** Called after markDelivered committed (Stage 4A settles a sealed run here). A throw is logged and never reclassifies the delivered message. */
  onDelivered?: (record: NotificationRecord) => void;
  /** attach.path at send (spec R7 §4.0): consulted per attachment check after markDelivered committed; absent → no rows. */
  recorder?: DecisionRecorder;
}

export type DispatchResult =
  | { status: "idle" }
  | { status: "delivered"; notification_id: string }
  | { status: "failed"; notification_id: string; retryable: boolean };

const DEFAULT_LEASE_TTL_SECONDS = 30;

export class NotificationDispatcher {
  private readonly leaseTtlSeconds: number;
  private readonly maxAttempts: number;
  private readonly onDelivered: ((record: NotificationRecord) => void) | undefined;
  private readonly recorder: DecisionRecorder | undefined;

  constructor(
    private readonly outbox: NotificationOutbox,
    private readonly adapters: NotificationAdapters,
    options: NotificationDispatcherOptions = {}
  ) {
    this.leaseTtlSeconds = options.lease_ttl_seconds ?? DEFAULT_LEASE_TTL_SECONDS;
    this.maxAttempts = options.max_attempts ?? NOTIFICATION_MAX_ATTEMPTS;
    this.onDelivered = options.onDelivered;
    this.recorder = options.recorder;
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
      this.afterDelivered(claimed);
      this.recordAttach(claimed, sent.attach_checks);
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

  /** Its own catch: the row is already delivered, so nothing here may reach the markFailed arm below. */
  private afterDelivered(record: NotificationRecord): void {
    if (!this.onDelivered) return;
    try { this.onDelivered(record); }
    catch (error) { console.error(`[notification-dispatcher] onDelivered failed for ${record.notification_id}: ${errorCode(error)}`); } // a code: an fs message carries paths
  }

  /** Spec R7 §4.0: after the delivery committed, outside the lease, with the outbox row's run_id; its own catch, so it can neither reach markFailed nor skip afterDelivered. */
  private recordAttach(record: NotificationRecord, checks: readonly AttachCheck[] | undefined): void {
    const recorder = this.recorder;
    if (!recorder || !checks || checks.length === 0) return;
    try {
      for (const check of checks) decideSync(ATTACH_PATH, { seam: "send", check }, { run_id: record.run_id, tool_call_id: null, recorder });
    } catch (error) {
      console.error(`[notification-dispatcher] attach_path_record_failed for ${record.notification_id}: ${errorCode(error)}`);
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
