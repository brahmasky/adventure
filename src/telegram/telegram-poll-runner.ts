import { CoreWorker, type OmpWorkerOptions } from "../core/core-worker.js";
import { resolveOmpConfig } from "../omp/omp-config.js";
import type { PlannerSupervisor } from "../omp/planner-supervisor.js";
import { evolutionLaneSettled } from "../core/evolution-lane.js";
import type { TelegramAllowlist } from "../domain/types.js";
import { Gateway } from "../gateway/gateway.js";
import { resolveMediaIngestEnabled } from "../media/media-config.js";
import { LocalNotificationAdapter } from "../notifications/local-notification-adapter.js";
import { NotificationDispatcher } from "../notifications/notification-dispatcher.js";
import type { DispatchResult } from "../notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../notifications/notification-outbox.js";
import { TelegramNotificationAdapter } from "../notifications/telegram-notification-adapter.js";
import type { RunStore } from "../run/run-store.js";
import type { SecretBroker } from "../config/secret-broker.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import {
  createTelegramLongPollingAdapter,
  isSelfWriteActionEvent,
  type TelegramGetUpdatesClient
} from "../triggers/telegram-trigger-adapter.js";
import { handleSelfWriteAction, type SelfWriteActionTelegramClient } from "./self-write-action-handler.js";
import type {
  TelegramFileClient,
  TelegramSendMessageInput,
  TelegramSendMessageResult
} from "./telegram-client.js";

export interface TelegramPollClient extends TelegramGetUpdatesClient, SelfWriteActionTelegramClient {
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult>;
  /** Multimodal ingest (spec 2026-09-29): present on the real client; tests may omit it. */
  downloadFile?: TelegramFileClient["downloadFile"];
}

/**
 * Gateway intake error codes that are DETERMINISTIC denials: the update was
 * understood and refused, so advance the offset, keep polling, and let any alert
 * the Gateway enqueued ship. Any OTHER code is an unexpected store/process error
 * that should stop the batch. Single source of truth for both the one-shot poll
 * and the always-on daemon (a missing code here is what stalled the daemon once).
 */
export const HANDLED_INTAKE_DENIAL_CODES: ReadonlySet<string> = new Set([
  "TELEGRAM_RATE_LIMITED",
  "APPROVAL_NOT_FOUND",
  "TRIGGER_IDEMPOTENCY_CONFLICT",
  "GLOBAL_BUDGET_FUSE"
]);

export function isHandledIntakeDenial(code: string): boolean {
  return HANDLED_INTAKE_DENIAL_CODES.has(code);
}

export interface RunTelegramPollOnceOptions {
  store: RunStore;
  projectRoot: string;
  allowlist: TelegramAllowlist;
  telegramClient: TelegramPollClient;
  /** Amendment 1: injectable for tests; defaults to the real LLM adapter. */
  llmAdapter?: (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
  /** Secrets firewall broker (ADR 0015) — passed at boot when armed; else undefined (firewall OFF). */
  broker?: SecretBroker;
  /** omp planner turns: the data dir (houge.sqlite's directory, default projectRoot) and dist dir. Tests use tmp dirs. */
  omp?: OmpWorkerOptions;
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
/** The worker's omp options plus the operator — the allowlist's Telegram user — who answers schedule-born approvals (B2). */
export function ompOptionsWithOperator(omp: OmpWorkerOptions | undefined, allowlist: TelegramAllowlist): OmpWorkerOptions {
  const user = allowlist.users[0];
  return { ...(omp ?? {}), ...(user ? { operator: { kind: "user", id: user.identity_id } } : {}) };
}

export async function runTelegramPollOnce(
  options: RunTelegramPollOnceOptions
): Promise<RunTelegramPollOnceResult> {
  const gateway = new Gateway(options.store, undefined, options.projectRoot);
  const worker = new CoreWorker(
    options.store,
    options.projectRoot,
    // RAW optional (undefined in prod) so CoreWorker builds + INSTRUMENTS its own cheap-chain
    // adapter per role — a pre-built adapter here sets llmAdapterIsDefault=false and disables all
    // conversational telemetry (answer/classify/… never recorded). Tests inject and get it verbatim.
    options.llmAdapter,
    undefined,
    undefined,
    undefined,
    undefined,
    options.broker,
    undefined,
    undefined,
    undefined,
    // Multimodal ingest: the Telegram client is the only thing that can fetch a file. A client
    // without downloadFile (tests) yields no downloader, so every media turn fails loudly.
    options.telegramClient.downloadFile
      ? { downloadFile: options.telegramClient.downloadFile.bind(options.telegramClient) }
      : undefined,
    ompOptionsWithOperator(options.omp, options.allowlist)
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
    },
    mediaIngestEnabled: () => resolveMediaIngestEnabled(process.env),
    // No-ghost reply for a text-less message: enqueue on the existing outbox; the
    // dispatch flush at the end of this cycle delivers it. Deterministic key → idempotent.
    acknowledgeSink: (ack) => {
      new NotificationOutbox(options.store).enqueue({
        target: { kind: "telegram", chat_id: ack.chat_id },
        intent_type: "progress",
        idempotency_key: ack.idempotency_key,
        correlation_id: ack.idempotency_key,
        payload: { text: ack.text }
      });
    }
  });

  let worker_status = "idle";
  const turns: string[] = [];

  const pollResult = await adapter.pollOnce(async (event) => {
    if (isSelfWriteActionEvent(event)) {
      // M4: execute the authorized self-write action (view/discard/merge+reload) via the shared
      // handler — the SAME implementation the daemon uses. Auth was enforced upstream (M2).
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
      // Deterministic Gateway denials are handled (offset advances, the loop
      // continues, and any alert the Gateway enqueued is dispatched below).
      // Thrown store/process errors propagate and stop the batch.
      if (isHandledIntakeDenial(intake.error.code)) {
        return;
      }
      throw new Error(`Gateway intake failed: ${intake.error.code} ${intake.error.message}`);
    }

    if (intake.status === "created") {
      // A turn runs on the chat's planner supervisor, exactly as in the daemon; anything else runs here.
      if (worker.submitTurn(intake.run_id)) turns.push(intake.run_id);
      else worker_status = (await worker.executeRun(intake.run_id, "telegram-poll-worker")).status;
    }
  });

  // One-shot: the caller closes the store right after this returns, so every submitted turn must
  // finish (its reply queued) and every planner child must stop BEFORE the dispatch flush below.
  await settlePlannerTurns(worker.plannerSupervisors(), resolveOmpConfig(process.env).turnTimeoutMs);
  await worker.shutdownPlanners();
  worker_status = lastTurnState(options.store, turns) ?? worker_status;

  // ⓪·3g: a turn may have kicked off a background evolution pipeline. The ONE-SHOT
  // runner exits (and its caller closes the store) right after this function returns,
  // so finish the pipeline here — its completion notification then rides the dispatch
  // flush below. (The always-on daemon interleaves instead and only waits on shutdown.)
  await evolutionLaneSettled();

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

/**
 * Wait for every submitted turn, bounded by the turn timeout: a planner that never goes idle must
 * not hang the one-shot runner. On timeout every supervisor is aborted with the `guard` posture
 * (its turn fails with the code-owned reply) before the caller stops the children.
 */
export async function settlePlannerTurns(
  supervisors: Array<Pick<PlannerSupervisor, "whenIdle" | "abortAll">>,
  timeoutMs: number
): Promise<"idle" | "aborted"> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"aborted">((resolve) => { timer = setTimeout(() => resolve("aborted"), timeoutMs); timer.unref(); });
  const idle = Promise.all(supervisors.map((s) => s.whenIdle())).then(() => "idle" as const);
  const outcome = await Promise.race([idle, expired]).finally(() => clearTimeout(timer));
  if (outcome === "aborted") await Promise.all(supervisors.map((s) => s.abortAll("guard")));
  return outcome;
}

/** The last submitted turn's run state, for the runner's result (undefined when no turn ran). */
function lastTurnState(store: RunStore, turns: string[]): string | undefined {
  const last = turns.at(-1);
  return last ? store.getRunState(last) : undefined;
}
