import type { Identity, TelegramAllowlist, TypedTaskEvent } from "../domain/types.js";
import { buildTypedTaskEvent } from "../domain/types.js";
import { authorizeTelegramUpdate } from "./telegram-auth.js";
import type { SelfWriteCallbackAction, TelegramCommand } from "./telegram-command-parser.js";
import { parseSelfWriteCallback, parseTelegramCommand } from "./telegram-command-parser.js";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    forward_date?: number;
    forward_origin?: unknown;
    reply_to_message?: { message_id: number };
    from?: { id: number };
    chat: { id: number };
  };
  /**
   * An inline-button tap (Phase 3.3). `data` is the button's `callback_data`,
   * `message` points at the message the buttons are attached to.
   */
  callback_query?: {
    id: string;
    from?: { id: number };
    message?: {
      message_id: number;
      chat: { id: number };
    };
    data?: string;
  };
  channel_post?: unknown;
}

/**
 * A normalized self-write inline-button action (Phase 3.3). NOT a `TypedTaskEvent`:
 * the Gateway does not dispatch it — M4 wires the handler at the poll-loop seam. It
 * carries enough Telegram context for the action module (M3) to answer the callback,
 * disable the buttons, and run the merge action. `source_reference`/`idempotency_key`
 * mirror the message event so the long-polling adapter's offset bookkeeping is uniform.
 */
export interface SelfWriteActionEvent {
  type: "selfwrite_action";
  action: SelfWriteCallbackAction;
  runId: string;
  callback_id: string;
  chat_id: string;
  message_id: number;
  from: Identity;
  source_reference: string;
  idempotency_key: string;
}

/** The poll loop processes either a task event (message) or a self-write action (callback). */
export type TelegramNormalizedEvent = TypedTaskEvent | SelfWriteActionEvent;

export function isSelfWriteActionEvent(event: TelegramNormalizedEvent): event is SelfWriteActionEvent {
  return (event as { type?: string }).type === "selfwrite_action";
}

export type TelegramNormalizeResult =
  | { ok: true; event: TelegramNormalizedEvent }
  | { ok: false; error: { code: string; message: string } };

export function normalizeTelegramUpdate(update: TelegramUpdate, allowlist: TelegramAllowlist): TelegramNormalizeResult {
  if (update.channel_post) {
    return { ok: false, error: { code: "TELEGRAM_AUTH_DENIED", message: "Channel posts are not accepted" } };
  }

  if (update.callback_query) {
    return normalizeCallbackQuery(update, update.callback_query, allowlist);
  }

  const message = update.message;
  if (!message?.text) {
    return { ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message: "Telegram text message is required" } };
  }

  const auth = authorizeTelegramUpdate(
    {
      from_id: message.from?.id,
      chat_id: message.chat.id,
      is_forwarded: typeof message.forward_date === "number" || message.forward_origin !== undefined,
      is_channel_post: false
    },
    allowlist
  );
  if (!auth.ok) return auth;

  const parsed = parseTelegramCommand(message.text);
  if (!parsed.ok) return parsed;

  return { ok: true, event: buildTelegramEvent(parsed.command, buildEventBase(update, message, auth.identity)) };
}

type TelegramCallbackQuery = NonNullable<TelegramUpdate["callback_query"]>;

function normalizeCallbackQuery(
  update: TelegramUpdate,
  callback: TelegramCallbackQuery,
  allowlist: TelegramAllowlist
): TelegramNormalizeResult {
  const message = callback.message;
  if (!message) {
    return { ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message: "Callback query is missing its message" } };
  }

  // SECURITY FLOOR: the tapping user is checked against the allowlist exactly like a
  // message sender. A non-allowlisted `from` is rejected and never produces an action.
  // (A button tap is never forwarded/channel-posted, so those guards are inert here.)
  const auth = authorizeTelegramUpdate(
    {
      from_id: callback.from?.id,
      chat_id: message.chat.id,
      is_forwarded: false,
      is_channel_post: false
    },
    allowlist
  );
  if (!auth.ok) return auth;

  const parsed = parseSelfWriteCallback(callback.data);
  if (!parsed) {
    return { ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message: "Unrecognized callback data" } };
  }

  return {
    ok: true,
    event: {
      type: "selfwrite_action",
      action: parsed.action,
      runId: parsed.runId,
      callback_id: callback.id,
      chat_id: String(message.chat.id),
      message_id: message.message_id,
      from: auth.identity,
      source_reference: `telegram:update:${update.update_id}:callback:${callback.id}`,
      idempotency_key: `telegram:${update.update_id}:callback:${callback.id}`
    }
  };
}

type TelegramMessage = NonNullable<TelegramUpdate["message"]>;

interface TelegramEventBase {
  source: "telegram";
  requested_by: Identity;
  notify: { kind: "telegram"; chat_id: string };
  idempotency_key: string;
  source_reference: string;
  metadata: {
    telegram_update_id: number;
    telegram_message_id: number;
    reply_to_message_id?: number;
  };
}

function buildEventBase(update: TelegramUpdate, message: TelegramMessage, identity: Identity): TelegramEventBase {
  // Carry the reply pointer when the user replied to a prior message — Stage B uses
  // it as the feedback target hint; Stage A just preserves it.
  const reply_to_message_id = message.reply_to_message?.message_id;
  return {
    source: "telegram",
    requested_by: identity,
    notify: { kind: "telegram", chat_id: String(message.chat.id) },
    idempotency_key: `telegram:${update.update_id}:${message.message_id}`,
    source_reference: `telegram:update:${update.update_id}:message:${message.message_id}`,
    metadata: {
      telegram_update_id: update.update_id,
      telegram_message_id: message.message_id,
      ...(typeof reply_to_message_id === "number" ? { reply_to_message_id } : {})
    }
  };
}

function buildTelegramEvent(command: TelegramCommand, base: TelegramEventBase): TypedTaskEvent {
  switch (command.type) {
    case "turn":
      return buildTypedTaskEvent({ ...base, type: "turn", program: "turn", goal: command.goal });
    case "run":
      return buildTypedTaskEvent({ ...base, type: "run", program: command.program, goal: command.goal });
    case "status":
      return buildTypedTaskEvent({ ...base, type: "status", metadata: { ...base.metadata, run_id: command.run_id } });
    case "lessons":
      // scope (optional) rides `program`; absent → list all scopes.
      return buildTypedTaskEvent({ ...base, type: "lessons", ...(command.scope ? { program: command.scope } : {}) });
    case "skills":
      // scope (optional) rides `program`; absent → list all scopes.
      return buildTypedTaskEvent({ ...base, type: "skills", ...(command.scope ? { program: command.scope } : {}) });
    case "forget":
      // scope rides `program`.
      return buildTypedTaskEvent({ ...base, type: "forget", program: command.scope });
    case "approve":
    case "deny":
      return buildTypedTaskEvent({ ...base, type: command.type, approval_id: command.approval_id });
  }
}

export interface TelegramOffsetStore {
  getOffset(source: string): number;
  setOffset(source: string, offset: number): void;
}

export interface TelegramSkippedUpdateStore {
  recordSkippedTelegramUpdate(input: {
    update_id: number;
    reason_code: string;
    reason_message: string;
    skipped_at: string;
  }): void;
}

export interface TelegramGetUpdatesClient {
  getUpdates(input: {
    offset: number;
    timeout_seconds: number;
    /** Update types to receive. The adapter requests message + callback_query (Phase 3.3). */
    allowed_updates?: string[];
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]>;
}

/**
 * Update types the poller subscribes to. `callback_query` (Phase 3.3) is required for
 * inline-button taps; `message` is the existing text path. Telegram defaults to all
 * types EXCEPT `callback_query` unless `allowed_updates` is supplied, so it must be
 * listed explicitly or button taps would never be delivered.
 */
export const TELEGRAM_ALLOWED_UPDATES: readonly string[] = ["message", "callback_query"];

export type TelegramEmit = (event: TelegramNormalizedEvent) => Promise<void>;

export interface TelegramLongPollingAdapterOptions {
  allowlist: TelegramAllowlist;
  client: TelegramGetUpdatesClient;
  offsetStore: TelegramOffsetStore;
  skippedUpdateStore?: TelegramSkippedUpdateStore;
  timeout_seconds?: number;
}

export interface TelegramPollResult {
  processed_updates: number;
  skipped_updates: number;
}

export interface TelegramLongPollingAdapter {
  pollOnce(emit: TelegramEmit, options?: { signal?: AbortSignal }): Promise<TelegramPollResult>;
}

const TELEGRAM_OFFSET_SOURCE = "telegram";

/**
 * Long-polling adapter. Each `pollOnce` fetches a batch of updates and processes
 * them in ascending `update_id` order. Offset rules:
 *   - deterministic parse/auth rejection: record the skipped update and advance
 *     offset to `update_id + 1`.
 *   - successful emit: advance offset to `update_id + 1`.
 *   - emit throws: stop the batch, leave the offset at the last success so
 *     Telegram redelivers the failing update on the next poll.
 */
export function createTelegramLongPollingAdapter(
  options: TelegramLongPollingAdapterOptions
): TelegramLongPollingAdapter {
  const timeout_seconds = options.timeout_seconds ?? 0;

  return {
    async pollOnce(
      emit: TelegramEmit,
      pollOptions?: { signal?: AbortSignal }
    ): Promise<TelegramPollResult> {
      const offset = options.offsetStore.getOffset(TELEGRAM_OFFSET_SOURCE);
      const updates = [...await options.client.getUpdates({
        offset,
        timeout_seconds,
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
        ...(pollOptions?.signal ? { signal: pollOptions.signal } : {})
      })].sort((left, right) => left.update_id - right.update_id);

      let processed = 0;
      let skipped = 0;

      for (const update of updates) {
        const normalized = normalizeTelegramUpdate(update, options.allowlist);
        if (!normalized.ok) {
          options.skippedUpdateStore?.recordSkippedTelegramUpdate({
            update_id: update.update_id,
            reason_code: normalized.error.code,
            reason_message: normalized.error.message,
            skipped_at: new Date().toISOString()
          });
          options.offsetStore.setOffset(TELEGRAM_OFFSET_SOURCE, update.update_id + 1);
          skipped += 1;
          continue;
        }

        // If emit throws, propagate without advancing the offset for this
        // update so Telegram redelivers it. Earlier successes already advanced.
        await emit(normalized.event);
        options.offsetStore.setOffset(TELEGRAM_OFFSET_SOURCE, update.update_id + 1);
        processed += 1;
      }

      return { processed_updates: processed, skipped_updates: skipped };
    }
  };
}
