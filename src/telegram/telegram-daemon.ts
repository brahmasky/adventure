import { createLlmAnswerAdapter } from "../capabilities/llm-answer.js";
import { CoreWorker } from "../core/core-worker.js";
import type { TelegramAllowlist } from "../domain/types.js";
import { Gateway } from "../gateway/gateway.js";
import { LocalNotificationAdapter } from "../notifications/local-notification-adapter.js";
import { NotificationDispatcher } from "../notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../notifications/notification-outbox.js";
import { TelegramNotificationAdapter } from "../notifications/telegram-notification-adapter.js";
import type { RunStore } from "../run/run-store.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import {
  createTelegramLongPollingAdapter,
  isSelfWriteActionEvent
} from "../triggers/telegram-trigger-adapter.js";
import { handleSelfWriteAction } from "./self-write-action-handler.js";
import { isHandledIntakeDenial, type TelegramPollClient } from "./telegram-poll-runner.js";

export const DEFAULT_LONGPOLL_TIMEOUT_SECONDS = 30;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 60_000;

export interface DaemonBackoff {
  baseMs: number;
  maxMs: number;
}

export interface RunTelegramDaemonOptions {
  store: RunStore;
  projectRoot: string;
  allowlist: TelegramAllowlist;
  telegramClient: TelegramPollClient;
  /** Abort to stop the loop AND cancel an idle long-poll for a prompt shutdown. */
  stopSignal: AbortSignal;
  llmAdapter?: (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
  longPollTimeoutSeconds?: number;
  backoff?: DaemonBackoff;
  /** Injectable for tests; default sleeps but resolves early if stopSignal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable clock for deterministic heartbeats in tests. */
  now?: () => string;
}

export interface RunTelegramDaemonResult {
  cycles: number;
  consecutive_failures: number;
}

/** Sleep that resolves early when the signal aborts (so shutdown isn't delayed). */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * The always-on daemon: a continuous long-poll loop that holds a Telegram
 * connection and answers commands in near-real-time. Resilient by construction —
 * the durable offset means a restart resumes (no message lost or double-consumed),
 * Telegram errors back off exponentially, and a heartbeat records liveness. Stops
 * cleanly when `stopSignal` aborts: an idle long-poll is cancelled immediately,
 * while a run already executing finishes (and its notification is flushed) before
 * the loop exits.
 */
export async function runTelegramDaemon(
  options: RunTelegramDaemonOptions
): Promise<RunTelegramDaemonResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const sleep = options.sleep ?? interruptibleSleep;
  const timeout_seconds = options.longPollTimeoutSeconds ?? DEFAULT_LONGPOLL_TIMEOUT_SECONDS;
  const baseMs = options.backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxMs = options.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;

  const gateway = new Gateway(options.store, undefined, options.projectRoot);
  const worker = new CoreWorker(
    options.store,
    options.projectRoot,
    options.llmAdapter ?? createLlmAnswerAdapter()
  );
  const adapter = createTelegramLongPollingAdapter({
    allowlist: options.allowlist,
    client: options.telegramClient,
    timeout_seconds,
    offsetStore: {
      getOffset: (source) => options.store.getOffset(source),
      setOffset: (source, offset) => options.store.setOffset(source, offset)
    },
    skippedUpdateStore: {
      recordSkippedTelegramUpdate: (input) => options.store.recordSkippedTelegramUpdate(input)
    }
  });
  const dispatcher = new NotificationDispatcher(new NotificationOutbox(options.store), {
    local: new LocalNotificationAdapter(),
    telegram: new TelegramNotificationAdapter(options.telegramClient)
  });

  let cycles = 0;
  let failures = 0;

  while (!options.stopSignal.aborted) {
    try {
      await adapter.pollOnce(async (event) => {
        if (isSelfWriteActionEvent(event)) {
          // M4: execute the authorized self-write action via the SHARED handler (identical to
          // the poll runner). Auth was enforced upstream (M2); this never re-derives it.
          await handleSelfWriteAction({
            event,
            telegramClient: options.telegramClient,
            projectRoot: options.projectRoot,
            store: options.store
          });
          return;
        }
        const intake = gateway.intake(event);
        if (!intake.ok) {
          if (isHandledIntakeDenial(intake.error.code)) return;
          throw new Error(`Gateway intake failed: ${intake.error.code} ${intake.error.message}`);
        }
        // Execute synchronously so a shutdown signal can't interrupt a run
        // mid-flight: the await completes the in-flight run before the loop exits.
        if (intake.status === "created") {
          await worker.executeRun(intake.run_id, "telegram-daemon-worker");
        }
      }, { signal: options.stopSignal });

      const t = now();
      options.store.expirePendingApprovals(t);
      options.store.expireUndeliveredApprovalPrompts(t);
      for (;;) {
        const result = await dispatcher.dispatchOnce("telegram-daemon-dispatcher");
        if (result.status === "idle") break;
      }

      options.store.recordPollHeartbeat({ now: now(), ok: true });
      failures = 0;
      cycles += 1;
    } catch (err) {
      // A shutdown that cancels the in-flight long-poll surfaces as an abort —
      // that's a clean stop, not an error.
      if (options.stopSignal.aborted || isAbortError(err)) break;

      const message = err instanceof Error ? err.message : String(err);
      options.store.recordPollHeartbeat({ now: now(), ok: false, error: message });
      failures += 1;
      const delay = Math.min(maxMs, baseMs * 2 ** (failures - 1));
      await sleep(delay, options.stopSignal);
    }
  }

  return { cycles, consecutive_failures: failures };
}
