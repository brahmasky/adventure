import type { SenderDenialReason } from "../decisions/entries/intake-sender.js";
import type { Identity, TelegramAllowlist } from "../domain/types.js";

export interface TelegramAuthEvidence {
  from_id?: number | undefined;
  chat_id?: number | undefined;
  is_forwarded?: boolean;
  is_channel_post?: boolean;
}

export type TelegramAuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; error: { code: "TELEGRAM_AUTH_DENIED"; message: string }; reason: SenderDenialReason };

export function authorizeTelegramUpdate(evidence: TelegramAuthEvidence, allowlist: TelegramAllowlist): TelegramAuthResult {
  if (evidence.is_channel_post) return denied("channel_post", "Channel posts are not accepted");
  if (evidence.is_forwarded) return denied("forwarded", "Forwarded commands are not accepted");
  if (typeof evidence.from_id !== "number") return denied("anonymous", "Anonymous Telegram senders are not accepted");
  if (typeof evidence.chat_id !== "number") return denied("no_chat", "Telegram chat id is required");

  const user = allowlist.users.find((entry) => entry.telegram_user_id === evidence.from_id);
  if (!user) return denied("user_not_allowlisted", "Telegram user is not allowlisted");

  const chat = allowlist.chats.find((entry) => entry.telegram_chat_id === evidence.chat_id);
  if (!chat) return denied("chat_not_allowlisted", "Telegram chat is not allowlisted");

  if (!chat.allowed_identity_ids.includes(user.identity_id)) {
    return denied("identity_not_for_chat", "Telegram identity is not allowlisted for this chat");
  }

  return { ok: true, identity: { kind: "user", id: user.identity_id } };
}

/** The reason rides beside `error` (spec 2026-11-01 R2 §4.1): `error` and the skip row it becomes are unchanged. */
function denied(reason: SenderDenialReason, message: string): TelegramAuthResult {
  return { ok: false, error: { code: "TELEGRAM_AUTH_DENIED", message }, reason };
}
