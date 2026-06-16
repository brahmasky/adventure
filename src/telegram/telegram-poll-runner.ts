import { createLlmAnswerAdapter } from "../capabilities/llm-answer.js";
import { CoreWorker } from "../core/core-worker.js";
import type { TelegramAllowlist } from "../domain/types.js";
import { Gateway } from "../gateway/gateway.js";
import { LocalNotificationAdapter } from "../notifications/local-notification-adapter.js";
import { NotificationDispatcher } from "../notifications/notification-dispatcher.js";
import type { DispatchResult } from "../notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../notifications/notification-outbox.js";
import { TelegramNotificationAdapter } from "../notifications/telegram-notification-adapter.js";
import type { RunStore } from "../run/run-store.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import {
  createTelegramLongPollingAdapter,
  type TelegramGetUpdatesClient
} from "../triggers/telegram-trigger-adapter.js";
import type {
  TelegramSendMessageInput,
  TelegramSendMessageResult
} from "./telegram-client.js";

export interface TelegramPollClient extends TelegramGetUpdatesClient {
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult>;
}

export interface RunTelegramPollOnceOptions {
  store: RunStore;
  projectRoot: string;
  allowlist: TelegramAllowlist;
  telegramClient: TelegramPollClient;
  /** Amendment 1: injectable for tests; defaults to the real Claude adapter. */
  llmAdapter?: (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
}

export interface RunTelegramPollOnceResult {
  processed_updates: number;
  worker_status: string;
  dispatch_results: DispatchResult[];
}

/**
 * Drive one cycle of the Telegram poll loop:
 *   1. Long-poll a batch and intake each event through the Gateway.
 *   2. Execute the worker for any newly created run.
 *   3. Expire stale approvals/prompts.
 *   4. Dispatch the notification outbox until idle.
 */
export async function runTelegramPollOnce(
  options: RunTelegramPollOnceOptions
): Promise<RunTelegramPollOnceResult> {
  const gateway = new Gateway(options.store);
  const worker = new CoreWorker(
    options.store,
    options.projectRoot,
    options.llmAdapter ?? createLlmAnswerAdapter()
  );

  const adapter = createTelegramLongPollingAdapter({
    allowlist: options.allowlist,
    client: options.telegramClient,
    offsetStore: {
      getOffset: (source) => options.store.getOffset(source),
      setOffset: (source, offset) => options.store.setOffset(source, offset)
    },
    skippedUpdateStore: {
      recordSkippedTelegramUpdate: (input) => options.store.recordSkippedTelegramUpdate(input)
    }
  });

  let worker_status = "idle";

  const pollResult = await adapter.pollOnce(async (event) => {
    const intake = gateway.intake(event);

    if (!intake.ok) {
      // Deterministic Gateway denials are handled (offset advances). Thrown
      // store/process errors propagate and stop the batch.
      if (
        intake.error.code === "TELEGRAM_RATE_LIMITED" ||
        intake.error.code === "APPROVAL_NOT_FOUND" ||
        intake.error.code === "TRIGGER_IDEMPOTENCY_CONFLICT"
      ) {
        return;
      }
      throw new Error(`Gateway intake failed: ${intake.error.code} ${intake.error.message}`);
    }

    if (intake.status === "created") {
      const result = await worker.executeRun(intake.run_id, "telegram-poll-worker");
      worker_status = result.status;
    }
  });

  const now = new Date().toISOString();
  options.store.expirePendingApprovals(now);
  options.store.expireUndeliveredApprovalPrompts(now);

  const dispatcher = new NotificationDispatcher(new NotificationOutbox(options.store), {
    local: new LocalNotificationAdapter(),
    telegram: new TelegramNotificationAdapter(options.telegramClient)
  });

  const dispatch_results: DispatchResult[] = [];
  for (;;) {
    const result = await dispatcher.dispatchOnce("telegram-poll-dispatcher");
    if (result.status === "idle") {
      break;
    }
    dispatch_results.push(result);
  }

  return {
    processed_updates: pollResult.processed_updates,
    worker_status,
    dispatch_results
  };
}
