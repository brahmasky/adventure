import type { Identity, TelegramAllowlist, TypedTaskEvent } from "../domain/types.js";
import { buildTypedTaskEvent } from "../domain/types.js";
import { authorizeTelegramUpdate } from "./telegram-auth.js";
import type { TelegramCommand } from "./telegram-command-parser.js";
import { parseTelegramCommand } from "./telegram-command-parser.js";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    forward_date?: number;
    from?: { id: number };
    chat: { id: number };
  };
  channel_post?: unknown;
}

export type TelegramNormalizeResult =
  | { ok: true; event: TypedTaskEvent }
  | { ok: false; error: { code: string; message: string } };

export function normalizeTelegramUpdate(update: TelegramUpdate, allowlist: TelegramAllowlist): TelegramNormalizeResult {
  if (update.channel_post) {
    return { ok: false, error: { code: "TELEGRAM_AUTH_DENIED", message: "Channel posts are not accepted" } };
  }

  const message = update.message;
  if (!message?.text) {
    return { ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message: "Telegram text message is required" } };
  }

  const auth = authorizeTelegramUpdate(
    {
      from_id: message.from?.id,
      chat_id: message.chat.id,
      is_forwarded: typeof message.forward_date === "number",
      is_channel_post: false
    },
    allowlist
  );
  if (!auth.ok) return auth;

  const parsed = parseTelegramCommand(message.text);
  if (!parsed.ok) return parsed;

  return { ok: true, event: buildTelegramEvent(parsed.command, buildEventBase(update, message, auth.identity)) };
}

type TelegramMessage = NonNullable<TelegramUpdate["message"]>;

interface TelegramEventBase {
  source: "telegram";
  requested_by: Identity;
  notify: { kind: "telegram"; chat_id: string };
  idempotency_key: string;
  source_reference: string;
  metadata: { telegram_update_id: number; telegram_message_id: number };
}

function buildEventBase(update: TelegramUpdate, message: TelegramMessage, identity: Identity): TelegramEventBase {
  return {
    source: "telegram",
    requested_by: identity,
    notify: { kind: "telegram", chat_id: String(message.chat.id) },
    idempotency_key: `telegram:${update.update_id}:${message.message_id}`,
    source_reference: `telegram:update:${update.update_id}:message:${message.message_id}`,
    metadata: { telegram_update_id: update.update_id, telegram_message_id: message.message_id }
  };
}

function buildTelegramEvent(command: TelegramCommand, base: TelegramEventBase): TypedTaskEvent {
  switch (command.type) {
    case "ask":
      return buildTypedTaskEvent({ ...base, type: "ask", program: "ask", goal: command.goal });
    case "run":
      return buildTypedTaskEvent({ ...base, type: "run", program: command.program, goal: command.goal });
    case "status":
      return buildTypedTaskEvent({ ...base, type: "status", metadata: { ...base.metadata, run_id: command.run_id } });
    case "approve":
    case "deny":
      return buildTypedTaskEvent({ ...base, type: command.type, approval_id: command.approval_id });
  }
}
